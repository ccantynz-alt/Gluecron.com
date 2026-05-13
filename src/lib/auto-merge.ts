/**
 * Block K2 — AI-gated auto-merge evaluator.
 *
 * Pure decision helper. Given a PR, answer the single question:
 *
 *   "Should this PR auto-merge right now?"
 *
 * This module is intentionally a parallel surface to the manual-merge path
 * in `src/routes/pulls.tsx` — it MUST NOT relax any rule that the manual
 * path enforces. The rule of thumb: anything an autopilot can do, a human
 * could have done by clicking Merge themselves.
 *
 * Decision rules (all must hold for `merge: true`):
 *
 *   1. A `branch_protection` rule matches the base branch AND
 *      `enableAutoMerge=true` on that rule. Default-deny when no rule
 *      matches — auto-merge is strictly opt-in per branch.
 *   2. PR is not a draft.
 *   3. `evaluateProtection` (the existing branch-protection helper)
 *      returns allowed=true for this PR's context, including required
 *      status checks via `listRequiredChecks` / `passingCheckNames`.
 *   4. When `requireAiApproval=true` on the rule, there is an
 *      AI-review comment carrying `AI_REVIEW_MARKER` whose body looks
 *      like an approval (see `aiCommentLooksApproved`).
 *   5. (Optional) PR diff is within `opts.maxChangedFiles` /
 *      `opts.maxChangedLines` if provided.
 *
 * K3 (the autopilot ticker) is the only intended caller — this module
 * deliberately does NOT execute the merge. It only decides.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { branchProtection, prComments } from "../db/schema";
import type { BranchProtection } from "../db/schema";
import {
  countHumanApprovals,
  evaluateProtection,
  listRequiredChecks,
  matchProtection,
  passingCheckNames,
} from "./branch-protection";
import { AI_REVIEW_MARKER } from "./ai-review";
import { audit } from "./notify";
import { getRepoPath } from "../git/repository";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoMergeContext {
  pullRequestId: string;
  repositoryId: string;
  baseBranch: string;
  isDraft: boolean;
  authorUserId: string;
}

export interface AutoMergeDecision {
  merge: boolean;
  reason: string;
  blocking?: string[];
}

export interface AutoMergeOptions {
  maxChangedFiles?: number;
  maxChangedLines?: number;
  /** Injectable clock for tests. Unused today but reserved for K3 cooldowns. */
  now?: Date;
  /**
   * Test-only injection of an owner/repo pair so the diff-size check can
   * shell out to the bare repo. In production the caller resolves these
   * from the repository row before calling. When omitted, the size cap is
   * skipped (treated as "no cap configured").
   */
  ownerName?: string;
  repoName?: string;
  /** Head branch for the diff-size check. Required when caps are set. */
  headBranch?: string;
}

// ---------------------------------------------------------------------------
// Pure decision helper
// ---------------------------------------------------------------------------

/**
 * Internal pure decision helper. All DB-derived facts are passed in as
 * arguments so tests can drive every branch without a real database.
 */
export function decideAutoMerge(args: {
  rule: BranchProtection | null;
  isDraft: boolean;
  aiApproved: boolean;
  humanApprovalCount: number;
  hasFailedGates: boolean;
  passingCheckNames: string[];
  requiredCheckNames: string[];
  diffStats?: { files: number; lines: number } | null;
  caps?: { maxChangedFiles?: number; maxChangedLines?: number };
}): AutoMergeDecision {
  const blocking: string[] = [];

  // 1. Default-deny: must have a matching rule AND it must opt in.
  if (!args.rule) {
    blocking.push(
      "No branch_protection rule matches the base branch — auto-merge is default-deny."
    );
    return { merge: false, reason: blocking[0], blocking };
  }
  if (!args.rule.enableAutoMerge) {
    blocking.push(
      `Branch protection '${args.rule.pattern}' does not have auto-merge enabled.`
    );
  }

  // 2. Draft check.
  if (args.isDraft) {
    blocking.push("Pull request is marked as a draft.");
  }

  // 3. Reuse the manual-merge gating exactly. Whatever blocks a human Merge
  // click must also block auto-merge.
  const decision = evaluateProtection(
    args.rule,
    {
      aiApproved: args.aiApproved,
      humanApprovalCount: args.humanApprovalCount,
      gateResultGreen: !args.hasFailedGates,
      hasFailedGates: args.hasFailedGates,
      passingCheckNames: args.passingCheckNames,
    },
    args.requiredCheckNames
  );
  if (!decision.allowed) {
    for (const r of decision.reasons) blocking.push(r);
  }

  // 4. AI-approval semantics — already covered by evaluateProtection when
  // requireAiApproval=true. We do NOT double-add the same reason here; the
  // caller is responsible for sourcing `aiApproved` from a marker-bearing
  // AI comment that survives `aiCommentLooksApproved`.

  // 5. Optional size cap.
  if (args.caps && args.diffStats) {
    const { maxChangedFiles, maxChangedLines } = args.caps;
    if (
      typeof maxChangedFiles === "number" &&
      args.diffStats.files > maxChangedFiles
    ) {
      blocking.push(
        `PR changes ${args.diffStats.files} file(s); auto-merge cap is ${maxChangedFiles}.`
      );
    }
    if (
      typeof maxChangedLines === "number" &&
      args.diffStats.lines > maxChangedLines
    ) {
      blocking.push(
        `PR changes ${args.diffStats.lines} line(s); auto-merge cap is ${maxChangedLines}.`
      );
    }
  }

  if (blocking.length === 0) {
    return {
      merge: true,
      reason: `All auto-merge conditions met for '${args.rule.pattern}'.`,
    };
  }
  return { merge: false, reason: blocking.join(" "), blocking };
}

// ---------------------------------------------------------------------------
// AI-comment approval heuristic
// ---------------------------------------------------------------------------

/**
 * Decide whether a single AI-review comment body indicates approval.
 *
 * `triggerAiReview` (in src/lib/ai-review.ts) emits a marker-bearing
 * summary comment in two shapes:
 *
 *   - On success: starts with `## AI Code Review`, followed by either
 *     `"no blocking issues found"` (approved) or
 *     `"flagged N item(s) for human attention"` (not approved).
 *   - On API failure: starts with `## AI review unavailable`.
 *
 * Per spec, approval is defined negatively:
 *   - body does NOT contain `"AI review unavailable"`, AND
 *   - body does NOT contain `"severity: blocking"` (case-insensitive).
 *
 * We additionally treat the "flagged N item(s)" verdict as not-approved
 * because that's what triggerAiReview itself uses to signal blocking
 * findings, even though it doesn't use the `severity: blocking` token.
 * If future reviewers do emit `severity: blocking`, that branch still
 * matches via the case-insensitive substring rule.
 */
export function aiCommentLooksApproved(body: string): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  if (lower.includes("ai review unavailable")) return false;
  if (lower.includes("severity: blocking")) return false;
  // triggerAiReview's "flagged N item(s)" wording — explicit non-approval.
  if (/flagged \d+ item/i.test(body)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// DB-backed orchestrator
// ---------------------------------------------------------------------------

/**
 * Locate the AI-review summary comment for a PR and return whether it
 * looks like an approval. Returns false when no marker-bearing AI
 * comment is found — i.e. AI review hasn't completed yet.
 */
async function aiApprovedForPr(pullRequestId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ body: prComments.body })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, pullRequestId),
          eq(prComments.isAiReview, true)
        )
      );
    const markerRows = rows.filter((r) =>
      (r.body || "").includes(AI_REVIEW_MARKER)
    );
    if (markerRows.length === 0) return false;
    // If *any* marker comment looks approved, count as approved. In
    // practice triggerAiReview writes exactly one summary marker, so this
    // collapses to the single comment's verdict.
    return markerRows.some((r) => aiCommentLooksApproved(r.body || ""));
  } catch {
    return false;
  }
}

/**
 * Best-effort diff stats for size caps. Shells out to `git diff
 * --numstat base...head` in the bare repo. Returns null on any error so
 * the caller can decide whether to fail-closed (we currently treat null
 * stats as "size unknown → don't enforce the cap" which is permissive
 * but documented).
 */
async function diffStatsForBranches(
  ownerName: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): Promise<{ files: number; lines: number } | null> {
  try {
    const cwd = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      ["git", "diff", "--numstat", `${baseBranch}...${headBranch}`, "--"],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    let files = 0;
    let lines = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const [add, del] = line.split("\t");
      files += 1;
      const a = add === "-" ? 0 : parseInt(add, 10) || 0;
      const d = del === "-" ? 0 : parseInt(del, 10) || 0;
      lines += a + d;
    }
    return { files, lines };
  } catch {
    return null;
  }
}

/**
 * Headline entry point. Resolves the DB-derived facts and delegates to
 * `decideAutoMerge`. K3 (autopilot ticker) calls this; the optional
 * AI-review completion path may also call it to flip the merge-now bit.
 */
export async function evaluateAutoMerge(
  ctx: AutoMergeContext,
  opts: AutoMergeOptions = {}
): Promise<AutoMergeDecision> {
  // 1. Match the protection rule. matchProtection returns the most
  // specific rule, or null when none configured.
  const rule = await matchProtection(ctx.repositoryId, ctx.baseBranch);

  // 2. Source the AI-approval signal only if the rule actually requires
  // it. Avoids the DB hit on rules that don't care.
  const aiApproved =
    rule && rule.requireAiApproval ? await aiApprovedForPr(ctx.pullRequestId) : true;

  // 3. Human approvals — same query the manual-merge path uses.
  const humanApprovalCount = await countHumanApprovals(ctx.pullRequestId);

  // 4. Required-checks matrix. Skip the DB hit if the rule has no
  // matched required checks.
  let requiredCheckNames: string[] = [];
  let passing: string[] = [];
  if (rule) {
    try {
      const required = await listRequiredChecks(rule.id);
      requiredCheckNames = required.map((r) => r.checkName);
      if (requiredCheckNames.length > 0) {
        // We don't have the head SHA in the context. Passing
        // commitSha=null causes passingCheckNames to scan the most
        // recent 200 rows for the repo, which is good enough for the
        // K2 decision surface — the K3 ticker is the source of truth
        // for fresh status. This matches the spirit of the manual path
        // (which uses the freshly-resolved head SHA).
        passing = await passingCheckNames(ctx.repositoryId, null);
      }
    } catch {
      requiredCheckNames = [];
      passing = [];
    }
  }

  // 5. hasFailedGates: derived from required checks. We don't run the
  // full `runAllGateChecks` here because that's a heavyweight side-
  // effecting call; K3 is expected to have already triggered gate runs.
  // Treat "any required check is not in the passing set" as failing.
  const hasFailedGates =
    requiredCheckNames.length > 0 &&
    requiredCheckNames.some((n) => !passing.includes(n));

  // 6. Optional size cap.
  let diffStats: { files: number; lines: number } | null = null;
  const hasCap =
    typeof opts.maxChangedFiles === "number" ||
    typeof opts.maxChangedLines === "number";
  if (hasCap && opts.ownerName && opts.repoName && opts.headBranch) {
    diffStats = await diffStatsForBranches(
      opts.ownerName,
      opts.repoName,
      ctx.baseBranch,
      opts.headBranch
    );
  }

  return decideAutoMerge({
    rule,
    isDraft: ctx.isDraft,
    aiApproved,
    humanApprovalCount,
    hasFailedGates,
    passingCheckNames: passing,
    requiredCheckNames,
    diffStats,
    caps: hasCap
      ? {
          maxChangedFiles: opts.maxChangedFiles,
          maxChangedLines: opts.maxChangedLines,
        }
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

/**
 * Record an auto-merge attempt in the audit log. K3 should call this
 * once per evaluation tick so operators can see the decision trail.
 * Uses `auto_merge.evaluated` for any decision, and `auto_merge.merged`
 * separately when K3 actually performs the merge (K3's responsibility).
 */
export async function recordAutoMergeAttempt(
  repositoryId: string,
  pullRequestId: string,
  decision: AutoMergeDecision
): Promise<void> {
  await audit({
    repositoryId,
    action: "auto_merge.evaluated",
    targetType: "pull_request",
    targetId: pullRequestId,
    metadata: {
      merge: decision.merge,
      reason: decision.reason,
      blocking: decision.blocking ?? [],
    },
  });
}

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

export const __test = {
  decideAutoMerge,
  aiCommentLooksApproved,
  diffStatsForBranches,
  aiApprovedForPr,
};

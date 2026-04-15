/**
 * Block D5 — Branch-protection enforcement helpers.
 *
 * The `branch_protection` table lets owners configure per-pattern rules. Until
 * now those rules were mostly advisory — `runAllGateChecks` read the repo-
 * global `repoSettings` for enable flags, and the merge handler only rejected
 * on gate-level hard failures. This module:
 *
 *   1. Matches a branch name against the list of protection rules for a repo
 *      (supports `*` / `**` globs via shared matcher).
 *   2. Evaluates the matched rule against merge-time context (AI approval,
 *      human approvals, gate result) and returns a pass/fail decision with
 *      human-readable reasons.
 *
 * Kept minimal: no throwing, no side effects.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  branchProtection,
  branchRequiredChecks,
  gateRuns,
  prComments,
  workflowRuns,
  workflows,
} from "../db/schema";
import type { BranchProtection, BranchRequiredCheck } from "../db/schema";
import { matchGlob } from "./environments";

export interface ProtectionEvalContext {
  aiApproved: boolean;
  humanApprovalCount: number;
  gateResultGreen: boolean;
  hasFailedGates: boolean;
  /** Names of checks whose latest run passed. Used by E6 required-checks. */
  passingCheckNames?: string[];
}

export interface ProtectionDecision {
  allowed: boolean;
  rule: BranchProtection | null;
  reasons: string[];
  missingChecks?: string[];
}

/**
 * Find the most specific branch-protection rule that matches `branch`.
 * Rules with exact string matches win over glob rules; among globs the first
 * alphabetical pattern wins (deterministic). Returns null if nothing matches.
 */
export async function matchProtection(
  repositoryId: string,
  branch: string
): Promise<BranchProtection | null> {
  let rules: BranchProtection[];
  try {
    rules = await db
      .select()
      .from(branchProtection)
      .where(eq(branchProtection.repositoryId, repositoryId));
  } catch {
    return null;
  }
  if (!rules || rules.length === 0) return null;

  // Exact match wins.
  const exact = rules.find((r) => r.pattern === branch);
  if (exact) return exact;

  // Otherwise first glob match (deterministic order).
  const globs = rules
    .filter((r) => r.pattern.includes("*"))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
  for (const rule of globs) {
    if (matchGlob(branch, rule.pattern)) return rule;
  }
  return null;
}

/**
 * Evaluate a protection rule against merge-time context. Does not block on
 * a missing rule — callers can treat that as "no protection configured".
 */
export function evaluateProtection(
  rule: BranchProtection | null,
  ctx: ProtectionEvalContext,
  requiredChecks: string[] = []
): ProtectionDecision {
  if (!rule) {
    return { allowed: true, rule: null, reasons: [] };
  }
  const reasons: string[] = [];

  if (rule.requireAiApproval && !ctx.aiApproved) {
    reasons.push(
      `Branch protection '${rule.pattern}' requires AI approval, but no AI review comment is approving this PR.`
    );
  }
  if (rule.requireGreenGates && ctx.hasFailedGates) {
    reasons.push(
      `Branch protection '${rule.pattern}' requires green gates, but at least one gate is failing.`
    );
  }
  if (rule.requireHumanReview && ctx.humanApprovalCount < 1) {
    reasons.push(
      `Branch protection '${rule.pattern}' requires at least one human review approval.`
    );
  }
  if (
    rule.requiredApprovals > 0 &&
    ctx.humanApprovalCount < rule.requiredApprovals
  ) {
    reasons.push(
      `Branch protection '${rule.pattern}' requires ${rule.requiredApprovals} approvals (have ${ctx.humanApprovalCount}).`
    );
  }

  // E6 — required status checks matrix
  let missingChecks: string[] | undefined;
  if (requiredChecks.length > 0) {
    const passing = new Set(ctx.passingCheckNames || []);
    const missing = requiredChecks.filter((n) => !passing.has(n));
    if (missing.length > 0) {
      missingChecks = missing;
      reasons.push(
        `Branch protection '${rule.pattern}' requires these checks to pass: ${missing.join(", ")}.`
      );
    }
  }

  return {
    allowed: reasons.length === 0,
    rule,
    reasons,
    ...(missingChecks ? { missingChecks } : {}),
  };
}

/**
 * Count human (non-AI) approving PR comments. "Approval" is defined as a
 * comment containing LGTM / ":+1:" / "approved" tokens. Best-effort; callers
 * should treat a zero here as "unknown", not "rejected".
 */
export async function countHumanApprovals(pullRequestId: string): Promise<number> {
  try {
    const comments = await db
      .select({ body: prComments.body, isAi: prComments.isAiReview })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, pullRequestId),
          eq(prComments.isAiReview, false)
        )
      );
    return comments.filter((c) => {
      const b = (c.body || "").toLowerCase();
      return (
        b.includes("lgtm") ||
        b.includes(":+1:") ||
        b.includes("approved") ||
        b.includes("👍")
      );
    }).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// E6 — Required status checks matrix
// ---------------------------------------------------------------------------

/**
 * List required check names for a branch protection rule. Empty array when
 * nothing is required (the default; same semantics as "no matrix configured").
 */
export async function listRequiredChecks(
  branchProtectionId: string
): Promise<BranchRequiredCheck[]> {
  try {
    return await db
      .select()
      .from(branchRequiredChecks)
      .where(eq(branchRequiredChecks.branchProtectionId, branchProtectionId));
  } catch {
    return [];
  }
}

/**
 * Compute the set of check names that have a passing latest result for this
 * repo + commit. A "check" is either:
 *   - a `gate_runs` row where `status IN ('passed','repaired')` (matched by
 *     gateName), or
 *   - a `workflow_runs` row where `status = 'success'` (matched by workflow
 *     name, joined through the workflows table).
 *
 * Passing names are aggregated across the last N rows to survive re-runs.
 */
export async function passingCheckNames(
  repositoryId: string,
  commitSha: string | null
): Promise<string[]> {
  const names = new Set<string>();

  try {
    const whereClause = commitSha
      ? and(
          eq(gateRuns.repositoryId, repositoryId),
          eq(gateRuns.commitSha, commitSha)
        )
      : eq(gateRuns.repositoryId, repositoryId);
    const gRows = await db
      .select({ name: gateRuns.gateName, status: gateRuns.status })
      .from(gateRuns)
      .where(whereClause)
      .orderBy(desc(gateRuns.createdAt))
      .limit(200);
    for (const r of gRows) {
      if (r.status === "passed" || r.status === "repaired") {
        names.add(r.name);
      }
    }
  } catch {
    // ignore
  }

  try {
    const whereWf = commitSha
      ? and(
          eq(workflowRuns.repositoryId, repositoryId),
          eq(workflowRuns.commitSha, commitSha)
        )
      : eq(workflowRuns.repositoryId, repositoryId);
    const wRows = await db
      .select({
        name: workflows.name,
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .where(whereWf)
      .orderBy(desc(workflowRuns.createdAt))
      .limit(200);
    for (const r of wRows) {
      if (r.status === "success") {
        names.add(r.name);
      }
    }
  } catch {
    // ignore
  }

  return Array.from(names);
}

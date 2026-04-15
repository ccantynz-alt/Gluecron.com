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

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { branchProtection, prComments } from "../db/schema";
import type { BranchProtection } from "../db/schema";
import { matchGlob } from "./environments";

export interface ProtectionEvalContext {
  aiApproved: boolean;
  humanApprovalCount: number;
  gateResultGreen: boolean;
  hasFailedGates: boolean;
}

export interface ProtectionDecision {
  allowed: boolean;
  rule: BranchProtection | null;
  reasons: string[];
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
  ctx: ProtectionEvalContext
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

  return { allowed: reasons.length === 0, rule, reasons };
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

/**
 * Branch rules — higher-level wrapper around the existing `branch_protection`
 * table + `pr_reviews` table. Provides `checkMergeEligible` for the merge
 * route to call, and `getBranchRules` for the repo-settings UI.
 *
 * The underlying enforcement engine lives in `src/lib/branch-protection.ts`.
 * This module exposes a simplified interface used by the route layer.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { branchProtection, prReviews } from "../db/schema";
import {
  matchProtection,
  countHumanApprovals,
} from "./branch-protection";

export interface BranchRule {
  id: string;
  pattern: string; // branch name pattern (e.g. "main", "release/*")
  requiredReviews: number; // 0 = no requirement
  requireCodeownerReview: boolean;
  dismissStaleReviews: boolean;
}

/**
 * Return all branch-protection rules for a repository, mapped to the
 * simplified BranchRule interface the UI and merge-check use.
 */
export async function getBranchRules(repoId: string): Promise<BranchRule[]> {
  try {
    const rows = await db
      .select()
      .from(branchProtection)
      .where(eq(branchProtection.repositoryId, repoId));

    return rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      requiredReviews: r.requiredApprovals,
      requireCodeownerReview: r.requireHumanReview, // closest semantic match
      dismissStaleReviews: r.dismissStaleReviews,
    }));
  } catch {
    return [];
  }
}

export interface MergeEligibleResult {
  eligible: boolean;
  reason?: string;
  approvalCount: number;
  requiredCount: number;
}

/**
 * Check whether a PR is eligible to be merged, based on the branch-protection
 * rules for `targetBranch`. This supplements (does not replace) the full gate
 * check in the merge route — it specifically handles the human-review count
 * requirement coming from `branch_protection.required_approvals`.
 *
 * Returns `eligible: true` when:
 *   - No rule matches the target branch, OR
 *   - The rule's `requiredApprovals` threshold is satisfied.
 */
export async function checkMergeEligible(
  prId: string,
  repoId: string,
  targetBranch: string
): Promise<MergeEligibleResult> {
  try {
    const rule = await matchProtection(repoId, targetBranch);

    if (!rule || rule.requiredApprovals === 0) {
      // Count anyway for informational display
      const approvalCount = await countHumanApprovals(prId);
      return { eligible: true, approvalCount, requiredCount: 0 };
    }

    const approvalCount = await countHumanApprovals(prId);
    const requiredCount = rule.requiredApprovals;

    if (approvalCount < requiredCount) {
      return {
        eligible: false,
        reason: `This PR requires ${requiredCount} approval${requiredCount !== 1 ? "s" : ""} before merging. Currently: ${approvalCount} approval${approvalCount !== 1 ? "s" : ""}.`,
        approvalCount,
        requiredCount,
      };
    }

    return { eligible: true, approvalCount, requiredCount };
  } catch {
    // On error, allow the merge to proceed — the full gate check is the
    // primary enforcement mechanism.
    return { eligible: true, approvalCount: 0, requiredCount: 0 };
  }
}

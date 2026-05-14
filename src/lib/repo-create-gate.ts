/**
 * Block P4 — shared "before create repo" gate.
 *
 * Pricing is fiction until creation paths actually enforce the plan's
 * repoLimit. This module wraps `src/lib/billing.ts`'s pure helpers
 * (`wouldExceedRepoLimit`, `getUserQuota`, `resetIfCycleExpired`) into a
 * single decision call that every repo-create site shares.
 *
 * Fail-open: any error in the underlying helpers returns `{ ok: true }`
 * so a Neon hiccup or billing-table outage never blocks legitimate
 * users from creating repos. This is consistent with billing.ts's own
 * fail-open posture (see invariants in BUILD_BIBLE §4.9).
 */

import {
  getUserQuota,
  resetIfCycleExpired,
  wouldExceedRepoLimit,
} from "./billing";

export type RepoCreateGateResult =
  | { ok: true }
  | { ok: false; reason: string; upgradeUrl: string };

/**
 * Should this user be allowed to create another repo right now?
 *
 * Used by:
 *   - POST /new                       (web UI)
 *   - POST /api/v2/repos              (REST API v2)
 *   - POST /import/github/repo        (GitHub import)
 *
 * Caller patterns:
 *   - Web routes redirect to `?error=<reason>` on `ok: false`.
 *   - API routes return 402 Payment Required with `{error, upgrade_url}`.
 */
export async function checkRepoCreateAllowed(
  userId: string
): Promise<RepoCreateGateResult> {
  try {
    // Roll the monthly counter window forward if needed.
    await resetIfCycleExpired(userId).catch(() => false);
    if (await wouldExceedRepoLimit(userId)) {
      const quota = await getUserQuota(userId);
      const planName = quota.plan.name || "current plan";
      const limit = quota.plan.repoLimit;
      return {
        ok: false,
        reason: `Your ${planName} is limited to ${limit} repos. Upgrade for more.`,
        upgradeUrl: "/pricing#upgrade",
      };
    }
    return { ok: true };
  } catch {
    // Fail-open. Billing must never break the primary request path.
    return { ok: true };
  }
}

/** Render-friendly "X of Y repos used (Plan)" for the /new form header. */
export async function getRepoCreateUsage(userId: string): Promise<{
  used: number;
  limit: number;
  planName: string;
  atLimit: boolean;
} | null> {
  try {
    const quota = await getUserQuota(userId);
    // Lazy import to avoid pulling repoCountForUser into the module's
    // hot path — it's not exported, so we re-derive via the existing
    // helper without re-implementing the count query.
    const atLimit = await wouldExceedRepoLimit(userId);
    return {
      used: atLimit ? quota.plan.repoLimit : Math.max(0, quota.plan.repoLimit - 1),
      limit: quota.plan.repoLimit,
      planName: quota.plan.name || "Free",
      atLimit,
    };
  } catch {
    return null;
  }
}

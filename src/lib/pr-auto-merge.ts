/**
 * Block J16 — PR auto-merge.
 *
 * Owners opt a PR into auto-merge. Whenever a commit status lands against the
 * head SHA we re-evaluate combined state and — if green — post a readiness
 * comment + notification to the PR author. The actual merge click remains
 * manual (the full merge path has many guardrails the owner should see);
 * auto-merge is about surfacing "ready now" without manual polling.
 *
 * Pure helper `computeAutoMergeAction` is exposed so unit tests can drive
 * every state-machine path without touching the DB.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { prAutoMerge, pullRequests } from "../db/schema";
import type { StatusState } from "./commit-statuses";

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export function isValidMergeMethod(m: unknown): m is MergeMethod {
  return typeof m === "string" && (MERGE_METHODS as readonly string[]).includes(m);
}

export type AutoMergeAction =
  | { action: "wait"; reason: "checks_pending" | "no_checks" }
  | { action: "merge"; reason: "checks_passed" }
  | {
      action: "skip";
      reason: "not_enabled" | "pr_closed" | "pr_draft" | "checks_failed";
    };

/**
 * Pure: what should happen for a given PR / combined-status snapshot?
 *
 *   - If auto-merge isn't enabled → skip (not_enabled)
 *   - PR draft or not open → skip
 *   - No status reports yet → wait (no_checks)
 *   - Any pending → wait (checks_pending)
 *   - Any failure/error → skip (checks_failed) — owner needs to intervene
 *   - All success → merge (checks_passed)
 */
export function computeAutoMergeAction(opts: {
  autoMergeEnabled: boolean;
  prState: string;
  isDraft: boolean;
  combinedState: StatusState | "success" | null;
  totalChecks: number;
}): AutoMergeAction {
  if (!opts.autoMergeEnabled) return { action: "skip", reason: "not_enabled" };
  if (opts.prState !== "open") return { action: "skip", reason: "pr_closed" };
  if (opts.isDraft) return { action: "skip", reason: "pr_draft" };
  if (!opts.combinedState || opts.totalChecks === 0) {
    return { action: "wait", reason: "no_checks" };
  }
  if (opts.combinedState === "pending") {
    return { action: "wait", reason: "checks_pending" };
  }
  if (opts.combinedState === "failure" || opts.combinedState === "error") {
    return { action: "skip", reason: "checks_failed" };
  }
  return { action: "merge", reason: "checks_passed" };
}

/** Enable auto-merge for a PR — idempotent (delete-then-insert). */
export async function enableAutoMerge(opts: {
  pullRequestId: string;
  enabledBy: string;
  mergeMethod?: MergeMethod;
  commitTitle?: string | null;
  commitMessage?: string | null;
}): Promise<boolean> {
  const method: MergeMethod = isValidMergeMethod(opts.mergeMethod)
    ? opts.mergeMethod
    : "merge";
  try {
    await db
      .delete(prAutoMerge)
      .where(eq(prAutoMerge.pullRequestId, opts.pullRequestId));
    await db.insert(prAutoMerge).values({
      pullRequestId: opts.pullRequestId,
      enabledBy: opts.enabledBy,
      mergeMethod: method,
      commitTitle: opts.commitTitle || null,
      commitMessage: opts.commitMessage || null,
    });
    return true;
  } catch (err) {
    console.error("[pr-auto-merge] enableAutoMerge failed:", err);
    return false;
  }
}

export async function disableAutoMerge(pullRequestId: string): Promise<boolean> {
  try {
    const rows = await db
      .delete(prAutoMerge)
      .where(eq(prAutoMerge.pullRequestId, pullRequestId))
      .returning({ id: prAutoMerge.id });
    return rows.length > 0;
  } catch (err) {
    console.error("[pr-auto-merge] disableAutoMerge failed:", err);
    return false;
  }
}

export async function getAutoMergeForPr(
  pullRequestId: string
): Promise<{
  enabled: boolean;
  mergeMethod: MergeMethod;
  enabledBy: string | null;
  lastStatus: string | null;
  notifiedReady: boolean;
} | null> {
  try {
    const [row] = await db
      .select()
      .from(prAutoMerge)
      .where(eq(prAutoMerge.pullRequestId, pullRequestId))
      .limit(1);
    if (!row) return { enabled: false, mergeMethod: "merge", enabledBy: null, lastStatus: null, notifiedReady: false };
    return {
      enabled: true,
      mergeMethod: (isValidMergeMethod(row.mergeMethod)
        ? row.mergeMethod
        : "merge") as MergeMethod,
      enabledBy: row.enabledBy,
      lastStatus: row.lastStatus,
      notifiedReady: row.notifiedReady,
    };
  } catch (err) {
    console.error("[pr-auto-merge] getAutoMergeForPr failed:", err);
    return { enabled: false, mergeMethod: "merge", enabledBy: null, lastStatus: null, notifiedReady: false };
  }
}

/**
 * Record the latest evaluation (status + timestamp) against a PR's auto-merge
 * row. `notifiedReady=true` is set when action transitions to "merge" for the
 * first time so we don't spam the PR with duplicate ready comments.
 */
export async function recordEvaluation(
  pullRequestId: string,
  action: AutoMergeAction,
  combinedState: StatusState | "success" | null
): Promise<{ wasAlreadyReady: boolean }> {
  try {
    const [existing] = await db
      .select()
      .from(prAutoMerge)
      .where(eq(prAutoMerge.pullRequestId, pullRequestId))
      .limit(1);
    if (!existing) return { wasAlreadyReady: false };
    const wasAlreadyReady = existing.notifiedReady;
    await db
      .update(prAutoMerge)
      .set({
        lastStatus: combinedState || null,
        lastCheckedAt: new Date(),
        notifiedReady:
          action.action === "merge" ? true : existing.notifiedReady,
      })
      .where(eq(prAutoMerge.pullRequestId, pullRequestId));
    return { wasAlreadyReady };
  } catch (err) {
    console.error("[pr-auto-merge] recordEvaluation failed:", err);
    return { wasAlreadyReady: false };
  }
}

/**
 * Find all auto-merge rows for open PRs in a given repo. The caller resolves
 * each PR's head branch SHA and dispatches evaluation where the SHA matches
 * the one that just received a new status.
 */
export async function listAutoMergePrsForRepo(
  repositoryId: string
): Promise<
  Array<{
    pullRequestId: string;
    number: number;
    headBranch: string;
    baseBranch: string;
    state: string;
    isDraft: boolean;
    authorId: string;
  }>
> {
  try {
    const rows = await db
      .select({
        pullRequestId: pullRequests.id,
        number: pullRequests.number,
        headBranch: pullRequests.headBranch,
        baseBranch: pullRequests.baseBranch,
        state: pullRequests.state,
        isDraft: pullRequests.isDraft,
        authorId: pullRequests.authorId,
      })
      .from(prAutoMerge)
      .innerJoin(pullRequests, eq(pullRequests.id, prAutoMerge.pullRequestId))
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.state, "open")
        )
      );
    return rows;
  } catch (err) {
    console.error("[pr-auto-merge] listAutoMergePrsForRepo failed:", err);
    return [];
  }
}

export const __internal = {
  computeAutoMergeAction,
  isValidMergeMethod,
  MERGE_METHODS,
};

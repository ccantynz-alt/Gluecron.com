/**
 * Block J11 — PR review requests (auto-assign + manual).
 *
 * Manages the set of users who have been asked to review a pull request.
 * Rows are idempotent per (pr, reviewer) — calling `requestReviewers` twice
 * with the same reviewer is a no-op. Sources:
 *   - 'codeowners' — auto-assigned from the repo's CODEOWNERS rules on PR open
 *   - 'manual'     — a maintainer added the reviewer by hand
 *   - 'ai'         — PR triage suggested them
 *
 * State transitions:
 *   pending → approved | changes_requested | dismissed
 *
 * All DB helpers swallow errors and return safe defaults — never throw — so
 * review-request failures can never block PR creation or merge flows.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { prReviewRequests, users } from "../db/schema";
import { reviewersForChangedFiles } from "./codeowners";
import { notify } from "./notify";

export type ReviewSource = "codeowners" | "manual" | "ai";
export type ReviewState =
  | "pending"
  | "approved"
  | "changes_requested"
  | "dismissed";

export const REVIEW_SOURCES: ReviewSource[] = ["codeowners", "manual", "ai"];
export const REVIEW_STATES: ReviewState[] = [
  "pending",
  "approved",
  "changes_requested",
  "dismissed",
];

export function isValidSource(s: string): s is ReviewSource {
  return (REVIEW_SOURCES as string[]).includes(s);
}

export function isValidState(s: string): s is ReviewState {
  return (REVIEW_STATES as string[]).includes(s);
}

/**
 * Deterministic merger: given an existing request state and a fresh review
 * outcome, return what the new state should be. Dismissed is terminal unless
 * someone explicitly re-requests.
 */
export function nextState(
  prev: ReviewState,
  incoming: "approved" | "changes_requested" | "commented" | "dismissed"
): ReviewState {
  if (prev === "dismissed") return "dismissed";
  if (incoming === "commented") return prev; // comment doesn't resolve the request
  return incoming;
}

/**
 * Filter helper — remove author + duplicates + empties from a candidate
 * reviewer ID set. Pure; safe with null/undefined inputs.
 */
export function sanitiseCandidates(
  candidateIds: Array<string | null | undefined>,
  authorId: string | null | undefined
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of candidateIds) {
    if (!id) continue;
    if (id === authorId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Request reviews from a set of users. Idempotent — existing (pr, reviewer)
 * rows are left alone (we preserve their state, which may be non-pending
 * from a prior review cycle). Returns the list of reviewer IDs that were
 * newly inserted.
 */
export async function requestReviewers(
  pullRequestId: string,
  reviewerIds: string[],
  requestedBy: string | null,
  source: ReviewSource
): Promise<string[]> {
  const cleaned = sanitiseCandidates(reviewerIds, null);
  if (cleaned.length === 0) return [];
  try {
    const existing = await db
      .select({ reviewerId: prReviewRequests.reviewerId })
      .from(prReviewRequests)
      .where(
        and(
          eq(prReviewRequests.pullRequestId, pullRequestId),
          inArray(prReviewRequests.reviewerId, cleaned)
        )
      );
    const have = new Set(existing.map((r) => r.reviewerId));
    const fresh = cleaned.filter((id) => !have.has(id));
    if (fresh.length === 0) return [];
    await db.insert(prReviewRequests).values(
      fresh.map((reviewerId) => ({
        pullRequestId,
        reviewerId,
        requestedBy,
        source,
        state: "pending" as const,
      }))
    );
    return fresh;
  } catch (err) {
    console.error("[review-requests] requestReviewers failed:", err);
    return [];
  }
}

/** List all requested reviewers for a PR with username joined. */
export async function listForPr(
  pullRequestId: string
): Promise<
  Array<{
    id: string;
    reviewerId: string;
    username: string;
    source: ReviewSource;
    state: ReviewState;
    requestedAt: Date;
    resolvedAt: Date | null;
  }>
> {
  try {
    const rows = await db
      .select({
        id: prReviewRequests.id,
        reviewerId: prReviewRequests.reviewerId,
        username: users.username,
        source: prReviewRequests.source,
        state: prReviewRequests.state,
        requestedAt: prReviewRequests.requestedAt,
        resolvedAt: prReviewRequests.resolvedAt,
      })
      .from(prReviewRequests)
      .innerJoin(users, eq(users.id, prReviewRequests.reviewerId))
      .where(eq(prReviewRequests.pullRequestId, pullRequestId))
      .orderBy(prReviewRequests.requestedAt);
    return rows.map((r) => ({
      ...r,
      source: r.source as ReviewSource,
      state: r.state as ReviewState,
    }));
  } catch (err) {
    console.error("[review-requests] listForPr failed:", err);
    return [];
  }
}

/** Dismiss a request (e.g. reviewer removed by maintainer). Idempotent. */
export async function dismissRequest(
  pullRequestId: string,
  reviewerId: string
): Promise<boolean> {
  try {
    const res = await db
      .update(prReviewRequests)
      .set({ state: "dismissed", resolvedAt: new Date() })
      .where(
        and(
          eq(prReviewRequests.pullRequestId, pullRequestId),
          eq(prReviewRequests.reviewerId, reviewerId)
        )
      )
      .returning({ id: prReviewRequests.id });
    return res.length > 0;
  } catch (err) {
    console.error("[review-requests] dismissRequest failed:", err);
    return false;
  }
}

/**
 * Mark a reviewer's request as resolved when they submit a review. Called
 * by the PR review handler. `commented` leaves the request in `pending`.
 */
export async function recordReviewOutcome(
  pullRequestId: string,
  reviewerId: string,
  outcome: "approved" | "changes_requested" | "commented" | "dismissed"
): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(prReviewRequests)
      .where(
        and(
          eq(prReviewRequests.pullRequestId, pullRequestId),
          eq(prReviewRequests.reviewerId, reviewerId)
        )
      )
      .limit(1);
    if (!row) return; // reviewer wasn't requested — nothing to update
    const newState = nextState(row.state as ReviewState, outcome);
    if (newState === row.state) return;
    await db
      .update(prReviewRequests)
      .set({
        state: newState,
        resolvedAt: newState === "pending" ? null : new Date(),
      })
      .where(eq(prReviewRequests.id, row.id));
  } catch (err) {
    console.error("[review-requests] recordReviewOutcome failed:", err);
  }
}

/**
 * Core helper used by PR creation. Given a PR + changed file list, resolves
 * CODEOWNERS to usernames, maps to user IDs, and requests reviews. Never
 * throws; logs + skips on failure.
 */
export async function autoAssignFromCodeowners(opts: {
  repositoryId: string;
  pullRequestId: string;
  authorId: string;
  changedPaths: string[];
  prUrl?: string;
  prTitle?: string;
}): Promise<string[]> {
  try {
    if (opts.changedPaths.length === 0) return [];
    const usernames = await reviewersForChangedFiles(
      opts.repositoryId,
      opts.changedPaths
    );
    if (usernames.length === 0) return [];
    // Resolve usernames → user IDs in one query.
    const rows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.username, usernames));
    const reviewerIds = rows
      .map((r) => r.id)
      .filter((id) => id !== opts.authorId);
    if (reviewerIds.length === 0) return [];
    const fresh = await requestReviewers(
      opts.pullRequestId,
      reviewerIds,
      null,
      "codeowners"
    );
    // Fire-and-forget notifications.
    for (const rid of fresh) {
      notify(rid, {
        kind: "review_requested",
        title: opts.prTitle
          ? `Review requested: ${opts.prTitle}`
          : "Review requested",
        body: "CODEOWNERS auto-assigned you to review this pull request.",
        url: opts.prUrl,
      }).catch(() => {});
    }
    return fresh;
  } catch (err) {
    console.error("[review-requests] autoAssignFromCodeowners failed:", err);
    return [];
  }
}

/**
 * Count pending review requests for a user. Useful for dashboard badges.
 */
export async function countPendingForUser(userId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(prReviewRequests)
      .where(
        and(
          eq(prReviewRequests.reviewerId, userId),
          eq(prReviewRequests.state, "pending")
        )
      );
    return Number(row?.n || 0);
  } catch {
    return 0;
  }
}

export const __internal = { sanitiseCandidates, nextState };

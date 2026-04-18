/**
 * Block E5 — Merge queue helpers.
 *
 * A merge queue serialises merges on `(repository_id, base_branch)`: instead
 * of merging a PR immediately, it's enqueued. A worker (or the manual
 * "process next" button surfaced on the queue UI) pops the head of the queue,
 * re-runs gates against the latest base, and — if green — performs the merge.
 *
 * This module is deliberately minimal: no side-effects on gate execution or
 * the actual git merge (those are owned by `pulls.tsx`). We just manage
 * the queue state + ordering. Every DB path is wrapped to never throw.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { mergeQueueEntries, pullRequests } from "../db/schema";
import type { MergeQueueEntry } from "../db/schema";

export interface EnqueueArgs {
  repositoryId: string;
  pullRequestId: string;
  baseBranch: string;
  enqueuedBy?: string | null;
}

export interface EnqueueResult {
  ok: boolean;
  entry?: MergeQueueEntry;
  reason?: string;
}

/**
 * Append a PR to the end of the queue for its `(repo, baseBranch)`. No-op
 * (returns ok:false with a reason) if the PR is already queued or running.
 */
export async function enqueuePr(args: EnqueueArgs): Promise<EnqueueResult> {
  try {
    // Check for existing active entry for this PR.
    const existing = await db
      .select()
      .from(mergeQueueEntries)
      .where(eq(mergeQueueEntries.pullRequestId, args.pullRequestId));
    const active = existing.find(
      (e) => e.state === "queued" || e.state === "running"
    );
    if (active) {
      return { ok: false, reason: "Pull request is already in the queue." };
    }

    // Compute next position in this (repo, base) queue.
    const rows = await db
      .select({ maxPos: sql<number>`COALESCE(MAX(${mergeQueueEntries.position}), -1)` })
      .from(mergeQueueEntries)
      .where(
        and(
          eq(mergeQueueEntries.repositoryId, args.repositoryId),
          eq(mergeQueueEntries.baseBranch, args.baseBranch),
          sql`${mergeQueueEntries.state} IN ('queued','running')`
        )
      );
    const nextPos = (rows[0]?.maxPos ?? -1) + 1;

    const [entry] = await db
      .insert(mergeQueueEntries)
      .values({
        repositoryId: args.repositoryId,
        pullRequestId: args.pullRequestId,
        baseBranch: args.baseBranch,
        position: nextPos,
        enqueuedBy: args.enqueuedBy || null,
        state: "queued",
      })
      .returning();
    return { ok: true, entry };
  } catch (err) {
    console.error("[merge-queue] enqueue:", err);
    return { ok: false, reason: "Failed to enqueue pull request." };
  }
}

/**
 * Remove an active entry from the queue (user-initiated cancel, or a PR
 * closed while queued). Marks it `dequeued` rather than deleting for audit.
 */
export async function dequeueEntry(entryId: string): Promise<boolean> {
  try {
    const res = await db
      .update(mergeQueueEntries)
      .set({ state: "dequeued", finishedAt: new Date() })
      .where(
        and(
          eq(mergeQueueEntries.id, entryId),
          sql`${mergeQueueEntries.state} IN ('queued','running')`
        )
      )
      .returning({ id: mergeQueueEntries.id });
    return res.length > 0;
  } catch (err) {
    console.error("[merge-queue] dequeue:", err);
    return false;
  }
}

/**
 * Peek the head of the queue for a `(repo, baseBranch)` pair. Returns the
 * oldest `queued` entry — the one that would be popped next by processNext.
 */
export async function peekHead(
  repositoryId: string,
  baseBranch: string
): Promise<MergeQueueEntry | null> {
  try {
    const rows = await db
      .select()
      .from(mergeQueueEntries)
      .where(
        and(
          eq(mergeQueueEntries.repositoryId, repositoryId),
          eq(mergeQueueEntries.baseBranch, baseBranch),
          eq(mergeQueueEntries.state, "queued")
        )
      )
      .orderBy(asc(mergeQueueEntries.position), asc(mergeQueueEntries.enqueuedAt))
      .limit(1);
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * List queue entries for a repo, newest-first per base branch. Includes
 * terminal states so the queue UI can show recent merges/failures.
 */
export async function listQueue(
  repositoryId: string,
  opts: { limit?: number; baseBranch?: string } = {}
): Promise<MergeQueueEntry[]> {
  const limit = opts.limit ?? 100;
  try {
    if (opts.baseBranch) {
      return await db
        .select()
        .from(mergeQueueEntries)
        .where(
          and(
            eq(mergeQueueEntries.repositoryId, repositoryId),
            eq(mergeQueueEntries.baseBranch, opts.baseBranch)
          )
        )
        .orderBy(asc(mergeQueueEntries.position), asc(mergeQueueEntries.enqueuedAt))
        .limit(limit);
    }
    return await db
      .select()
      .from(mergeQueueEntries)
      .where(eq(mergeQueueEntries.repositoryId, repositoryId))
      .orderBy(asc(mergeQueueEntries.position), asc(mergeQueueEntries.enqueuedAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Transition the head entry → `running`. Returns the entry (if any) so the
 * caller can kick off gates + perform the merge. The caller must eventually
 * call `completeEntry` with success/failure.
 */
export async function markHeadRunning(
  repositoryId: string,
  baseBranch: string
): Promise<MergeQueueEntry | null> {
  const head = await peekHead(repositoryId, baseBranch);
  if (!head) return null;
  try {
    const [updated] = await db
      .update(mergeQueueEntries)
      .set({ state: "running", startedAt: new Date() })
      .where(
        and(
          eq(mergeQueueEntries.id, head.id),
          eq(mergeQueueEntries.state, "queued")
        )
      )
      .returning();
    return updated || null;
  } catch {
    return null;
  }
}

/**
 * Mark a running entry as finished. `state` is the final state
 * (`merged` | `failed`). Non-running entries are left untouched.
 */
export async function completeEntry(
  entryId: string,
  finalState: "merged" | "failed",
  errorMessage?: string
): Promise<boolean> {
  try {
    const res = await db
      .update(mergeQueueEntries)
      .set({
        state: finalState,
        finishedAt: new Date(),
        errorMessage: errorMessage || null,
      })
      .where(eq(mergeQueueEntries.id, entryId))
      .returning({ id: mergeQueueEntries.id });
    return res.length > 0;
  } catch (err) {
    console.error("[merge-queue] complete:", err);
    return false;
  }
}

/**
 * Is this PR currently queued or running? Convenience helper for the merge
 * UI (so we can swap the button label to "In queue…").
 */
export async function isQueued(pullRequestId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: mergeQueueEntries.id })
      .from(mergeQueueEntries)
      .where(
        and(
          eq(mergeQueueEntries.pullRequestId, pullRequestId),
          sql`${mergeQueueEntries.state} IN ('queued','running')`
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check queue depth for `(repo, baseBranch)` — number of `queued` + `running`.
 */
export async function queueDepth(
  repositoryId: string,
  baseBranch: string
): Promise<number> {
  try {
    const rows = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(mergeQueueEntries)
      .where(
        and(
          eq(mergeQueueEntries.repositoryId, repositoryId),
          eq(mergeQueueEntries.baseBranch, baseBranch),
          sql`${mergeQueueEntries.state} IN ('queued','running')`
        )
      );
    return Number(rows[0]?.n || 0);
  } catch {
    return 0;
  }
}

/**
 * Resolve PR metadata (number, title) for a list of entries — the queue UI
 * needs those to render links. Kept in the helper so routes don't have to
 * re-join.
 */
export interface QueueEntryWithPr extends MergeQueueEntry {
  prNumber: number | null;
  prTitle: string | null;
  prState: string | null;
  prHeadBranch: string | null;
  prAuthorId: string | null;
}

export async function listQueueWithPrs(
  repositoryId: string
): Promise<QueueEntryWithPr[]> {
  try {
    const rows = await db
      .select({
        id: mergeQueueEntries.id,
        repositoryId: mergeQueueEntries.repositoryId,
        pullRequestId: mergeQueueEntries.pullRequestId,
        baseBranch: mergeQueueEntries.baseBranch,
        state: mergeQueueEntries.state,
        position: mergeQueueEntries.position,
        enqueuedBy: mergeQueueEntries.enqueuedBy,
        enqueuedAt: mergeQueueEntries.enqueuedAt,
        startedAt: mergeQueueEntries.startedAt,
        finishedAt: mergeQueueEntries.finishedAt,
        errorMessage: mergeQueueEntries.errorMessage,
        prNumber: pullRequests.number,
        prTitle: pullRequests.title,
        prState: pullRequests.state,
        prHeadBranch: pullRequests.headBranch,
        prAuthorId: pullRequests.authorId,
      })
      .from(mergeQueueEntries)
      .leftJoin(
        pullRequests,
        eq(mergeQueueEntries.pullRequestId, pullRequests.id)
      )
      .where(eq(mergeQueueEntries.repositoryId, repositoryId))
      .orderBy(asc(mergeQueueEntries.position), asc(mergeQueueEntries.enqueuedAt))
      .limit(200);
    return rows as QueueEntryWithPr[];
  } catch {
    return [];
  }
}

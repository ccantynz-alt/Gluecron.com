/**
 * Comment moderation — anti-impersonation gate for public-repo comments.
 *
 * Background (from the platform owner, verbatim):
 *   "Users will not be allowed to comment on another public repo unless
 *    they have the permission of the author. If somebody seems a comment
 *    or comments on a public repo, the author will be notified and it's
 *    up to them whether they want to accept it or not. People pass
 *    comments to make themselves look like they're contributors — that's
 *    not going to happen on this platform."
 *
 * The implementation is a single decision function (`shouldRequireApproval`)
 * plus three side-effect helpers used by the route handlers and the
 * `/comments/pending` queue page. The decision is intentionally pure /
 * easily testable: collaborators always skip, the thread author always
 * skips, and a per-repo trust row can either short-circuit to "auto
 * approve" ('trusted') or "auto reject" ('banned' — equivalent to a
 * silent ban so spammers don't get to re-pester the owner).
 *
 * All notification/audit emissions are best-effort: a failed insert never
 * leaks back into the comment-create flow.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  issueComments,
  prComments,
  issues,
  pullRequests,
  repositories,
  repoCommenterTrust,
  users,
} from "../db/schema";
import { resolveRepoAccess, satisfiesAccess } from "../middleware/repo-access";
import { notify, audit } from "./notify";

export type CommentKind = "issue" | "pr";
export type ModerationStatus = "approved" | "pending" | "rejected" | "spam";
export type TrustStatus = "trusted" | "banned";

/**
 * Decision: should this comment go to the moderation queue instead of
 * being published immediately?
 *
 * Returns FALSE (auto-approve) when:
 *   • The commenter is the repo owner / admin / write collaborator
 *     (i.e. `resolveRepoAccess` returns >= "write").
 *   • The commenter has a `repo_commenter_trust` row with status='trusted'.
 *   • The commenter is the original author of the thread (issue/PR) —
 *     a non-collaborator who opened an issue must always be able to
 *     follow up on it without owner approval, otherwise the issue
 *     tracker is dead.
 *
 * Returns TRUE (gate to 'pending') for everyone else, including users
 * with a 'banned' trust row — banned users still hit the moderation
 * layer, where the route handler immediately auto-rejects them silently
 * (see `applyModerationDecision`).
 *
 * `repositoryId` and either `issueId` or `pullRequestId` (depending on
 * `kind`) are required; the function does its own DB lookups for the
 * thread author + repo public/private flag.
 */
export async function shouldRequireApproval(args: {
  commenterUserId: string;
  repositoryId: string;
  kind: CommentKind;
  threadId: string;
}): Promise<{
  requireApproval: boolean;
  autoReject: boolean;
  reason: string;
}> {
  const { commenterUserId, repositoryId, kind, threadId } = args;

  // 1. Banned commenter? Short-circuit to auto-reject. We surface this as
  //    requireApproval=true so the route handler still uses the moderation
  //    storage path, but it'll flip the status to 'rejected' immediately
  //    (and skip the owner notification).
  let trustRow: { status: string } | undefined;
  try {
    const rows = await db
      .select({ status: repoCommenterTrust.status })
      .from(repoCommenterTrust)
      .where(
        and(
          eq(repoCommenterTrust.repositoryId, repositoryId),
          eq(repoCommenterTrust.commenterUserId, commenterUserId)
        )
      )
      .limit(1);
    trustRow = rows[0];
  } catch {
    // DB hiccup → fall through. We'd rather queue than silently let
    // through, so we treat the trust lookup as "unknown".
  }

  if (trustRow?.status === "banned") {
    return {
      requireApproval: true,
      autoReject: true,
      reason: "commenter is banned on this repo",
    };
  }
  if (trustRow?.status === "trusted") {
    return {
      requireApproval: false,
      autoReject: false,
      reason: "commenter is trusted on this repo",
    };
  }

  // 2. Collaborator check — repo owner / admin / write all skip.
  //    We need the repo's `isPrivate` flag for `resolveRepoAccess`.
  let isPublic = true;
  try {
    const [repo] = await db
      .select({ isPrivate: repositories.isPrivate })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (repo) {
      isPublic = !repo.isPrivate;
    }
  } catch {
    // Treat unknown repo as public (worst case: we queue a comment that
    // would otherwise have been auto-approved — strictly safer than the
    // opposite).
  }

  const access = await resolveRepoAccess({
    repoId: repositoryId,
    userId: commenterUserId,
    isPublic,
  });
  if (satisfiesAccess(access, "write")) {
    return {
      requireApproval: false,
      autoReject: false,
      reason: `commenter has ${access} access`,
    };
  }

  // 3. Thread-author check — if the commenter opened the issue/PR they
  //    are commenting on, let them follow up without approval.
  try {
    if (kind === "issue") {
      const [row] = await db
        .select({ authorId: issues.authorId })
        .from(issues)
        .where(eq(issues.id, threadId))
        .limit(1);
      if (row?.authorId === commenterUserId) {
        return {
          requireApproval: false,
          autoReject: false,
          reason: "commenter opened this issue",
        };
      }
    } else {
      const [row] = await db
        .select({ authorId: pullRequests.authorId })
        .from(pullRequests)
        .where(eq(pullRequests.id, threadId))
        .limit(1);
      if (row?.authorId === commenterUserId) {
        return {
          requireApproval: false,
          autoReject: false,
          reason: "commenter opened this pull request",
        };
      }
    }
  } catch {
    // Fall through — safer to require approval.
  }

  return {
    requireApproval: true,
    autoReject: false,
    reason: "commenter is not a collaborator or trusted user",
  };
}

/**
 * Convenience wrapper used by the issue/PR route handlers.
 *
 * Returns the moderation_status the row should be inserted with:
 *   - 'approved' → caller inserts + publishes as usual
 *   - 'pending'  → caller inserts hidden, notifies repo owner
 *   - 'rejected' → caller inserts hidden (banned user, silent drop)
 */
export async function decideInitialStatus(args: {
  commenterUserId: string;
  repositoryId: string;
  kind: CommentKind;
  threadId: string;
}): Promise<{ status: ModerationStatus; reason: string }> {
  const d = await shouldRequireApproval(args);
  if (!d.requireApproval) {
    return { status: "approved", reason: d.reason };
  }
  if (d.autoReject) {
    return { status: "rejected", reason: d.reason };
  }
  return { status: "pending", reason: d.reason };
}

/**
 * Notify the repo owner that a non-collaborator left a comment that
 * needs their approval. Best-effort; never throws.
 *
 * The notification kind `comment.pending` is a string literal (the
 * `notifications.kind` column is free-form text), so we cast through
 * `any` to avoid a per-kind union expansion on the `NotificationKind`
 * union in `notify.ts`.
 */
export async function notifyOwnerOfPendingComment(args: {
  repositoryId: string;
  commenterUsername: string;
  kind: CommentKind;
  threadNumber: number;
  ownerUsername: string;
  repoName: string;
}): Promise<void> {
  const { repositoryId } = args;
  try {
    const [repo] = await db
      .select({ ownerId: repositories.ownerId })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!repo) return;
    const url = `/${args.ownerUsername}/${args.repoName}/comments/pending`;
    const title = `${args.commenterUsername} commented on ${args.kind === "issue" ? "issue" : "PR"} #${args.threadNumber}`;
    const body = `Awaiting your approval. Review at ${url}`;
    await notify(repo.ownerId, {
      // Free-form string — `notify()` accepts any NotificationKind and we
      // stash this new value through.
      kind: "comment.pending" as any,
      title,
      body,
      url,
      repositoryId,
    });
  } catch (err) {
    console.error("[comment-moderation] notifyOwner failed:", err);
  }
}

/**
 * Approve a pending comment. Flips moderation_status to 'approved',
 * stamps `moderated_at` / `moderated_by_user_id`, optionally inserts a
 * 'trusted' trust row so future comments auto-approve, and notifies the
 * comment author so they know their comment is now visible.
 */
export async function approveComment(args: {
  commentId: string;
  kind: CommentKind;
  moderatorUserId: string;
  alsoTrust?: boolean;
}): Promise<{ ok: boolean; commenterId?: string; repositoryId?: string }> {
  const { commentId, kind, moderatorUserId, alsoTrust } = args;
  const table = kind === "issue" ? issueComments : prComments;
  const now = new Date();

  try {
    const [row] = await db
      .update(table)
      .set({
        moderationStatus: "approved",
        moderatedAt: now,
        moderatedByUserId: moderatorUserId,
      })
      .where(eq(table.id, commentId))
      .returning({
        id: table.id,
        authorId: table.authorId,
      });
    if (!row) return { ok: false };

    const repoId = await repoIdForComment(commentId, kind);
    if (alsoTrust && repoId) {
      await upsertTrust({
        repositoryId: repoId,
        commenterUserId: row.authorId,
        status: "trusted",
        grantedByUserId: moderatorUserId,
      });
    }

    await notify(row.authorId, {
      kind: "comment.approved" as any,
      title: "Your comment was approved",
      body: "The repo owner accepted your comment — it's now visible to everyone.",
      repositoryId: repoId ?? undefined,
    });
    await audit({
      userId: moderatorUserId,
      repositoryId: repoId ?? undefined,
      action: "comment.moderation.approved",
      targetType: `${kind}_comment`,
      targetId: commentId,
      metadata: { alsoTrust: !!alsoTrust },
    });
    if (alsoTrust && repoId) {
      await audit({
        userId: moderatorUserId,
        repositoryId: repoId,
        action: "comment.moderation.trusted",
        targetType: "user",
        targetId: row.authorId,
      });
    }
    return { ok: true, commenterId: row.authorId, repositoryId: repoId ?? undefined };
  } catch (err) {
    console.error("[comment-moderation] approveComment failed:", err);
    return { ok: false };
  }
}

/**
 * Reject a pending comment. Flips to 'rejected', stamps the moderator,
 * notifies the author with an optional polite reason.
 */
export async function rejectComment(args: {
  commentId: string;
  kind: CommentKind;
  moderatorUserId: string;
  reason?: string;
}): Promise<{ ok: boolean }> {
  const { commentId, kind, moderatorUserId, reason } = args;
  const table = kind === "issue" ? issueComments : prComments;
  const now = new Date();

  try {
    const [row] = await db
      .update(table)
      .set({
        moderationStatus: "rejected",
        moderatedAt: now,
        moderatedByUserId: moderatorUserId,
      })
      .where(eq(table.id, commentId))
      .returning({ id: table.id, authorId: table.authorId });
    if (!row) return { ok: false };

    const repoId = await repoIdForComment(commentId, kind);
    const body = reason
      ? `The repo owner did not approve your comment. Reason: ${reason}`
      : "The repo owner did not approve your comment.";
    await notify(row.authorId, {
      kind: "comment.rejected" as any,
      title: "Your comment was not approved",
      body,
      repositoryId: repoId ?? undefined,
    });
    await audit({
      userId: moderatorUserId,
      repositoryId: repoId ?? undefined,
      action: "comment.moderation.rejected",
      targetType: `${kind}_comment`,
      targetId: commentId,
      metadata: reason ? { reason } : undefined,
    });
    return { ok: true };
  } catch (err) {
    console.error("[comment-moderation] rejectComment failed:", err);
    return { ok: false };
  }
}

/**
 * Mark a pending comment as spam. Flips to 'spam', adds a 'banned' trust
 * row so future comments from this user on this repo are silently
 * auto-rejected, and audits both decisions. No notification to the
 * commenter — that's the point of "spam".
 */
export async function markAsSpam(args: {
  commentId: string;
  kind: CommentKind;
  moderatorUserId: string;
}): Promise<{ ok: boolean; commenterId?: string }> {
  const { commentId, kind, moderatorUserId } = args;
  const table = kind === "issue" ? issueComments : prComments;
  const now = new Date();

  try {
    const [row] = await db
      .update(table)
      .set({
        moderationStatus: "spam",
        moderatedAt: now,
        moderatedByUserId: moderatorUserId,
      })
      .where(eq(table.id, commentId))
      .returning({ id: table.id, authorId: table.authorId });
    if (!row) return { ok: false };

    const repoId = await repoIdForComment(commentId, kind);
    if (repoId) {
      await upsertTrust({
        repositoryId: repoId,
        commenterUserId: row.authorId,
        status: "banned",
        grantedByUserId: moderatorUserId,
      });
    }
    await audit({
      userId: moderatorUserId,
      repositoryId: repoId ?? undefined,
      action: "comment.moderation.spam",
      targetType: `${kind}_comment`,
      targetId: commentId,
    });
    if (repoId) {
      await audit({
        userId: moderatorUserId,
        repositoryId: repoId,
        action: "comment.moderation.banned",
        targetType: "user",
        targetId: row.authorId,
      });
    }
    return { ok: true, commenterId: row.authorId };
  } catch (err) {
    console.error("[comment-moderation] markAsSpam failed:", err);
    return { ok: false };
  }
}

/**
 * Count pending comments for a given repo. Used by the in-page banner
 * (we don't surface this on the locked RepoNav — see CLAUDE.md / build
 * bible: layout + nav components are frozen).
 *
 * Cheap by design: the migration adds two partial indexes on
 * `moderation_status = 'pending'`, so even on a busy repo this runs in
 * O(matching rows), not O(all comments).
 */
export async function countPendingForRepo(repositoryId: string): Promise<number> {
  try {
    const issueRows = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .innerJoin(issues, eq(issueComments.issueId, issues.id))
      .where(
        and(
          eq(issues.repositoryId, repositoryId),
          eq(issueComments.moderationStatus, "pending")
        )
      );
    const prRows = await db
      .select({ id: prComments.id })
      .from(prComments)
      .innerJoin(pullRequests, eq(prComments.pullRequestId, pullRequests.id))
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(prComments.moderationStatus, "pending")
        )
      );
    return issueRows.length + prRows.length;
  } catch {
    return 0;
  }
}

/**
 * List pending comments for the moderation queue page. Returns enriched
 * rows (commenter info + thread number/title) so the page can render
 * without further joins.
 */
export async function listPendingComments(repositoryId: string): Promise<
  Array<{
    commentId: string;
    kind: CommentKind;
    body: string;
    createdAt: Date;
    commenter: { id: string; username: string; avatarUrl: string | null };
    threadNumber: number;
    threadTitle: string;
    threadUrl: string;
  }>
> {
  const out: Awaited<ReturnType<typeof listPendingComments>> = [];
  try {
    const repo = await db
      .select({ ownerId: repositories.ownerId, name: repositories.name })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!repo[0]) return out;
    const [ownerRow] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, repo[0].ownerId))
      .limit(1);
    const ownerName = ownerRow?.username ?? "";
    const repoName = repo[0].name;

    const issueRows = await db
      .select({
        comment: issueComments,
        commenter: {
          id: users.id,
          username: users.username,
          avatarUrl: users.avatarUrl,
        },
        issue: { number: issues.number, title: issues.title },
      })
      .from(issueComments)
      .innerJoin(issues, eq(issueComments.issueId, issues.id))
      .innerJoin(users, eq(issueComments.authorId, users.id))
      .where(
        and(
          eq(issues.repositoryId, repositoryId),
          eq(issueComments.moderationStatus, "pending")
        )
      );

    for (const r of issueRows) {
      out.push({
        commentId: r.comment.id,
        kind: "issue",
        body: r.comment.body,
        createdAt: r.comment.createdAt,
        commenter: {
          id: r.commenter.id,
          username: r.commenter.username,
          avatarUrl: r.commenter.avatarUrl,
        },
        threadNumber: r.issue.number,
        threadTitle: r.issue.title,
        threadUrl: `/${ownerName}/${repoName}/issues/${r.issue.number}`,
      });
    }

    const prRows = await db
      .select({
        comment: prComments,
        commenter: {
          id: users.id,
          username: users.username,
          avatarUrl: users.avatarUrl,
        },
        pr: { number: pullRequests.number, title: pullRequests.title },
      })
      .from(prComments)
      .innerJoin(
        pullRequests,
        eq(prComments.pullRequestId, pullRequests.id)
      )
      .innerJoin(users, eq(prComments.authorId, users.id))
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(prComments.moderationStatus, "pending")
        )
      );

    for (const r of prRows) {
      out.push({
        commentId: r.comment.id,
        kind: "pr",
        body: r.comment.body,
        createdAt: r.comment.createdAt,
        commenter: {
          id: r.commenter.id,
          username: r.commenter.username,
          avatarUrl: r.commenter.avatarUrl,
        },
        threadNumber: r.pr.number,
        threadTitle: r.pr.title,
        threadUrl: `/${ownerName}/${repoName}/pulls/${r.pr.number}`,
      });
    }
  } catch (err) {
    console.error("[comment-moderation] listPending failed:", err);
  }
  // Newest first.
  out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return out;
}

// ───── internals ───────────────────────────────────────────────────────

async function repoIdForComment(
  commentId: string,
  kind: CommentKind
): Promise<string | null> {
  try {
    if (kind === "issue") {
      const [row] = await db
        .select({ repositoryId: issues.repositoryId })
        .from(issueComments)
        .innerJoin(issues, eq(issueComments.issueId, issues.id))
        .where(eq(issueComments.id, commentId))
        .limit(1);
      return row?.repositoryId ?? null;
    }
    const [row] = await db
      .select({ repositoryId: pullRequests.repositoryId })
      .from(prComments)
      .innerJoin(
        pullRequests,
        eq(prComments.pullRequestId, pullRequests.id)
      )
      .where(eq(prComments.id, commentId))
      .limit(1);
    return row?.repositoryId ?? null;
  } catch {
    return null;
  }
}

async function upsertTrust(args: {
  repositoryId: string;
  commenterUserId: string;
  status: TrustStatus;
  grantedByUserId: string;
}): Promise<void> {
  try {
    // Upsert: if a row already exists (e.g. trusted → banned flip) we
    // overwrite. We don't have an ON CONFLICT helper in this codebase's
    // drizzle setup that's universally safe across both neon-http + pg
    // drivers, so do it as a delete + insert. The unique index keeps
    // this from race-doubling.
    await db
      .delete(repoCommenterTrust)
      .where(
        and(
          eq(repoCommenterTrust.repositoryId, args.repositoryId),
          eq(repoCommenterTrust.commenterUserId, args.commenterUserId)
        )
      );
    await db.insert(repoCommenterTrust).values({
      repositoryId: args.repositoryId,
      commenterUserId: args.commenterUserId,
      status: args.status,
      grantedByUserId: args.grantedByUserId,
    });
  } catch (err) {
    console.error("[comment-moderation] upsertTrust failed:", err);
  }
}

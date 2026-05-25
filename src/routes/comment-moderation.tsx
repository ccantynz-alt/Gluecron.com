/**
 * Comment moderation queue UI.
 *
 * Owner-only page at `/:owner/:repo/comments/pending` that lists every
 * comment from a non-collaborator awaiting approval, with per-row
 * Approve / Reject / Mark spam buttons plus a "trust this user" tickbox
 * (alongside Approve) that promotes the commenter to the per-repo
 * trust list so future comments auto-approve.
 *
 * Bulk-action toolbar: "Reject all" / "Mark all as spam" applied to
 * every checked row. The single-row buttons are POST forms; the
 * bulk submitter is a single form whose checkboxes carry the comment
 * ids and `kind:<commentId>` mapping so the handler knows which table
 * each id lives in.
 *
 * All styling is scoped under `.modq-*` per the build bible's "no
 * touching shared components" rule.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  listPendingComments,
  approveComment,
  rejectComment,
  markAsSpam,
  type CommentKind,
} from "../lib/comment-moderation";

const moderationRoutes = new Hono<AuthEnv>();

const QUEUE_STYLES = `
  .modq-shell {
    max-width: 920px;
    margin: 18px auto 60px;
    padding: 0 16px;
  }
  .modq-head {
    margin: 12px 0 18px;
    padding: 18px 22px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(245, 191, 79, 0.10), rgba(140, 109, 255, 0.06));
    border: 1px solid var(--border, #2a2f3a);
  }
  .modq-head h1 {
    margin: 0 0 6px 0;
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong, #fff);
    letter-spacing: -0.01em;
  }
  .modq-head p {
    margin: 0;
    color: var(--text-muted, #9aa4b2);
    font-size: 14px;
    line-height: 1.5;
  }
  .modq-empty {
    margin: 32px 0;
    padding: 40px 22px;
    text-align: center;
    border-radius: 12px;
    border: 1px dashed var(--border, #2a2f3a);
    color: var(--text-muted, #9aa4b2);
  }
  .modq-empty strong { color: var(--text-strong, #fff); display: block; margin-bottom: 6px; }
  .modq-bulkbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px 0;
    padding: 10px 14px;
    border-radius: 10px;
    background: var(--bg-elevated, #161b22);
    border: 1px solid var(--border, #2a2f3a);
    font-size: 13px;
  }
  .modq-bulkbar-left { flex: 1 1 auto; color: var(--text-muted, #9aa4b2); }
  .modq-list { display: flex; flex-direction: column; gap: 12px; }
  .modq-row {
    padding: 14px 16px;
    border-radius: 12px;
    background: var(--bg-elevated, #161b22);
    border: 1px solid var(--border, #2a2f3a);
  }
  .modq-row-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    font-size: 13px;
    color: var(--text-muted, #9aa4b2);
  }
  .modq-avatar {
    width: 24px; height: 24px;
    border-radius: 50%;
    background: var(--bg, #0d1117);
    border: 1px solid var(--border, #2a2f3a);
    display: inline-flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 11px;
    color: var(--text-strong, #fff);
    overflow: hidden;
  }
  .modq-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .modq-username { color: var(--text-strong, #fff); font-weight: 600; }
  .modq-target { color: var(--accent, #8c6dff); text-decoration: none; }
  .modq-target:hover { text-decoration: underline; }
  .modq-body {
    padding: 10px 12px;
    background: var(--bg, #0d1117);
    border-radius: 8px;
    margin-bottom: 12px;
    font-size: 13.5px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text, #e6edf3);
    max-height: 220px;
    overflow: auto;
  }
  .modq-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .modq-btn {
    appearance: none;
    border: 1px solid var(--border, #2a2f3a);
    background: var(--bg, #0d1117);
    color: var(--text, #e6edf3);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .modq-btn:hover { border-color: var(--text-muted, #9aa4b2); }
  .modq-btn-approve {
    color: #56d364;
    border-color: rgba(86, 211, 100, 0.45);
    background: rgba(86, 211, 100, 0.08);
  }
  .modq-btn-approve:hover { background: rgba(86, 211, 100, 0.16); }
  .modq-btn-reject {
    color: #f5bf4f;
    border-color: rgba(245, 191, 79, 0.45);
    background: rgba(245, 191, 79, 0.08);
  }
  .modq-btn-reject:hover { background: rgba(245, 191, 79, 0.16); }
  .modq-btn-spam {
    color: #f85149;
    border-color: rgba(248, 81, 73, 0.45);
    background: rgba(248, 81, 73, 0.08);
  }
  .modq-btn-spam:hover { background: rgba(248, 81, 73, 0.16); }
  .modq-trust {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--text-muted, #9aa4b2);
  }
  .modq-trust input { transform: translateY(1px); }
  .modq-rowcheck {
    margin-right: 6px;
    transform: translateY(2px);
  }
  .modq-inlineform { display: inline; }
`;

// ---------------------------------------------------------------------------
// GET /:owner/:repo/comments/pending — render the queue
// ---------------------------------------------------------------------------

moderationRoutes.get(
  "/:owner/:repo/comments/pending",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repository = c.get("repository") as {
      id: string;
      ownerId: string;
    };

    // Owner-only. Collaborators with write access can comment freely
    // but the moderation decision is the OWNER's call — see the platform
    // owner's verbatim brief in `comment-moderation.ts`.
    if (repository.ownerId !== user.id) {
      return c.html(
        <Layout title="Forbidden" user={user}>
          <div style="max-width: 600px; margin: 80px auto; padding: 24px; text-align: center;">
            <h1>403 — Moderator only</h1>
            <p>Only the repository owner can review pending comments.</p>
          </div>
        </Layout>,
        403
      );
    }

    const pending = await listPendingComments(repository.id);

    return c.html(
      <Layout title={`Pending comments — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <style dangerouslySetInnerHTML={{ __html: QUEUE_STYLES }} />
        <div class="modq-shell">
          <div class="modq-head">
            <h1>Comment moderation</h1>
            <p>
              Non-collaborators on public repositories can leave a comment,
              but it stays hidden until you approve it. This stops drive-by
              comments that exist only to make someone look like a contributor.
            </p>
          </div>

          {pending.length === 0 ? (
            <div class="modq-empty">
              <strong>Inbox zero.</strong>
              No pending comments for {ownerName}/{repoName}.
            </div>
          ) : (
            <form
              method="post"
              action={`/${ownerName}/${repoName}/comments/pending/bulk`}
            >
              <div class="modq-bulkbar">
                <div class="modq-bulkbar-left">
                  {pending.length} comment{pending.length === 1 ? "" : "s"}{" "}
                  awaiting your decision. Tick rows to bulk-action.
                </div>
                <button
                  type="submit"
                  name="bulk_action"
                  value="reject"
                  class="modq-btn modq-btn-reject"
                >
                  Reject checked
                </button>
                <button
                  type="submit"
                  name="bulk_action"
                  value="spam"
                  class="modq-btn modq-btn-spam"
                >
                  Mark checked as spam
                </button>
              </div>

              <div class="modq-list">
                {pending.map((row) => (
                  <article class="modq-row">
                    <header class="modq-row-head">
                      <input
                        type="checkbox"
                        name="comment_ids"
                        value={`${row.kind}:${row.commentId}`}
                        class="modq-rowcheck"
                        aria-label={`Select comment by ${row.commenter.username}`}
                      />
                      <span class="modq-avatar" aria-hidden="true">
                        {row.commenter.avatarUrl ? (
                          <img src={row.commenter.avatarUrl} alt="" />
                        ) : (
                          row.commenter.username.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span class="modq-username">{row.commenter.username}</span>
                      <span>commented on</span>
                      <a class="modq-target" href={row.threadUrl}>
                        {row.kind === "issue" ? "issue" : "PR"} #
                        {row.threadNumber} — {row.threadTitle}
                      </a>
                    </header>
                    <div class="modq-body">{row.body}</div>
                    <div class="modq-actions">
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/comments/${row.kind}/${row.commentId}/approve`}
                        class="modq-inlineform"
                      >
                        <button type="submit" class="modq-btn modq-btn-approve">
                          Approve
                        </button>
                        <label class="modq-trust" title="Future comments from this user on this repo will be auto-approved.">
                          <input
                            type="checkbox"
                            name="trust"
                            value="1"
                          />
                          Trust this user
                        </label>
                      </form>
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/comments/${row.kind}/${row.commentId}/reject`}
                        class="modq-inlineform"
                      >
                        <button type="submit" class="modq-btn modq-btn-reject">
                          Reject
                        </button>
                      </form>
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/comments/${row.kind}/${row.commentId}/spam`}
                        class="modq-inlineform"
                      >
                        <button type="submit" class="modq-btn modq-btn-spam">
                          Mark spam
                        </button>
                      </form>
                    </div>
                  </article>
                ))}
              </div>
            </form>
          )}
        </div>
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// Per-row actions: approve / reject / spam
// ---------------------------------------------------------------------------

function ownerGate(
  c: any
): { user: { id: string }; repository: { id: string; ownerId: string } } | Response {
  const user = c.get("user")! as { id: string };
  const repository = c.get("repository") as { id: string; ownerId: string };
  if (repository.ownerId !== user.id) {
    return c.text("Forbidden", 403);
  }
  return { user, repository };
}

moderationRoutes.post(
  "/:owner/:repo/comments/:kind/:commentId/approve",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const gate = ownerGate(c);
    if (gate instanceof Response) return gate;
    const kind = c.req.param("kind") as CommentKind;
    if (kind !== "issue" && kind !== "pr") return c.notFound();
    const commentId = c.req.param("commentId");
    const body = await c.req.parseBody().catch(() => ({}) as any);
    const alsoTrust = String(body.trust || "") === "1";
    await approveComment({
      commentId,
      kind,
      moderatorUserId: gate.user.id,
      alsoTrust,
    });
    const { owner, repo } = c.req.param();
    return c.redirect(`/${owner}/${repo}/comments/pending`);
  }
);

moderationRoutes.post(
  "/:owner/:repo/comments/:kind/:commentId/reject",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const gate = ownerGate(c);
    if (gate instanceof Response) return gate;
    const kind = c.req.param("kind") as CommentKind;
    if (kind !== "issue" && kind !== "pr") return c.notFound();
    const commentId = c.req.param("commentId");
    const body = await c.req.parseBody().catch(() => ({}) as any);
    const reason = String(body.reason || "").trim() || undefined;
    await rejectComment({
      commentId,
      kind,
      moderatorUserId: gate.user.id,
      reason,
    });
    const { owner, repo } = c.req.param();
    return c.redirect(`/${owner}/${repo}/comments/pending`);
  }
);

moderationRoutes.post(
  "/:owner/:repo/comments/:kind/:commentId/spam",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const gate = ownerGate(c);
    if (gate instanceof Response) return gate;
    const kind = c.req.param("kind") as CommentKind;
    if (kind !== "issue" && kind !== "pr") return c.notFound();
    const commentId = c.req.param("commentId");
    await markAsSpam({
      commentId,
      kind,
      moderatorUserId: gate.user.id,
    });
    const { owner, repo } = c.req.param();
    return c.redirect(`/${owner}/${repo}/comments/pending`);
  }
);

// Bulk action — reject or spam every checked row.
moderationRoutes.post(
  "/:owner/:repo/comments/pending/bulk",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const gate = ownerGate(c);
    if (gate instanceof Response) return gate;
    const { owner, repo } = c.req.param();
    const body = await c.req.parseBody({ all: true });
    const action = String(body.bulk_action || "");
    const idsRaw = body.comment_ids;
    const ids = Array.isArray(idsRaw)
      ? idsRaw.map(String)
      : idsRaw
      ? [String(idsRaw)]
      : [];

    for (const compound of ids) {
      const [kind, commentId] = compound.split(":");
      if (kind !== "issue" && kind !== "pr") continue;
      if (!commentId) continue;
      if (action === "spam") {
        await markAsSpam({
          commentId,
          kind: kind as CommentKind,
          moderatorUserId: gate.user.id,
        });
      } else if (action === "reject") {
        await rejectComment({
          commentId,
          kind: kind as CommentKind,
          moderatorUserId: gate.user.id,
        });
      }
    }
    return c.redirect(`/${owner}/${repo}/comments/pending`);
  }
);

// Silence unused-import noise from drizzle helpers we may not call here.
void eq;
void db;
void repositories;
void users;

export default moderationRoutes;

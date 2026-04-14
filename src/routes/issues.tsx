/**
 * Issue tracker routes — list, create, view, comment, close/reopen.
 */

import { Hono } from "hono";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  issueComments,
  repositories,
  users,
  labels,
  issueLabels,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { ReactionsBar } from "../views/reactions";
import { summariseReactions } from "../lib/reactions";
import { loadIssueTemplate } from "../lib/templates";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { html } from "hono/html";

const issueRoutes = new Hono<AuthEnv>();

// Helper to resolve repo from :owner/:repo params
async function resolveRepo(ownerName: string, repoName: string) {
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return null;

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return null;

  return { owner, repo };
}

// Issue list
issueRoutes.get("/:owner/:repo/issues", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const state = c.req.query("state") || "open";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const { repo } = resolved;

  const issueList = await db
    .select({
      issue: issues,
      author: { username: users.username },
    })
    .from(issues)
    .innerJoin(users, eq(issues.authorId, users.id))
    .where(
      and(eq(issues.repositoryId, repo.id), eq(issues.state, state))
    )
    .orderBy(desc(issues.createdAt));

  // Count open/closed
  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${issues.state} = 'open')`,
      closed: sql<number>`count(*) filter (where ${issues.state} = 'closed')`,
    })
    .from(issues)
    .where(eq(issues.repositoryId, repo.id));

  return c.html(
    <Layout title={`Issues — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <IssueNav owner={ownerName} repo={repoName} active="issues" />
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <div class="issue-tabs">
          <a
            href={`/${ownerName}/${repoName}/issues?state=open`}
            class={state === "open" ? "active" : ""}
          >
            {counts?.open ?? 0} Open
          </a>
          <a
            href={`/${ownerName}/${repoName}/issues?state=closed`}
            class={state === "closed" ? "active" : ""}
          >
            {counts?.closed ?? 0} Closed
          </a>
        </div>
        {user && (
          <a
            href={`/${ownerName}/${repoName}/issues/new`}
            class="btn btn-primary"
          >
            New issue
          </a>
        )}
      </div>
      {issueList.length === 0 ? (
        <div class="empty-state">
          <p>
            No {state} issues.
            {state === "closed" && (
              <span>
                {" "}
                <a href={`/${ownerName}/${repoName}/issues?state=open`}>
                  View open issues
                </a>
              </span>
            )}
          </p>
        </div>
      ) : (
        <div class="issue-list">
          {issueList.map(({ issue, author }) => (
            <div class="issue-item">
              <div
                class={`issue-state-icon ${issue.state === "open" ? "state-open" : "state-closed"}`}
              >
                {issue.state === "open" ? "\u25CB" : "\u2713"}
              </div>
              <div>
                <div class="issue-title">
                  <a href={`/${ownerName}/${repoName}/issues/${issue.number}`}>
                    {issue.title}
                  </a>
                </div>
                <div class="issue-meta">
                  #{issue.number} opened by {author.username}{" "}
                  {formatRelative(issue.createdAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
});

// New issue form
issueRoutes.get(
  "/:owner/:repo/issues/new",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const error = c.req.query("error");
    const template = await loadIssueTemplate(ownerName, repoName);

    return c.html(
      <Layout title={`New issue — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <IssueNav owner={ownerName} repo={repoName} active="issues" />
        <div style="max-width: 800px">
          <h2 style="margin-bottom: 16px">New issue</h2>
          {template && (
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px">
              Using <code>ISSUE_TEMPLATE.md</code> from the default branch.
            </div>
          )}
          {error && (
            <div class="auth-error">{decodeURIComponent(error)}</div>
          )}
          <form method="POST" action={`/${ownerName}/${repoName}/issues/new`}>
            <div class="form-group">
              <input
                type="text"
                name="title"
                required
                placeholder="Title"
                style="font-size: 16px; padding: 10px 14px"
              />
            </div>
            <div class="form-group">
              <textarea
                name="body"
                rows={12}
                placeholder="Leave a comment... (Markdown supported)"
                style="font-family: var(--font-mono); font-size: 13px"
              >
                {template || ""}
              </textarea>
            </div>
            <button type="submit" class="btn btn-primary">
              Submit new issue
            </button>
          </form>
        </div>
      </Layout>
    );
  }
);

// Create issue
issueRoutes.post(
  "/:owner/:repo/issues/new",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const title = String(body.title || "").trim();
    const issueBody = String(body.body || "").trim();

    if (!title) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/new?error=Title+is+required`
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [issue] = await db
      .insert(issues)
      .values({
        repositoryId: resolved.repo.id,
        authorId: user.id,
        title,
        body: issueBody || null,
      })
      .returning();

    // Update issue count
    await db
      .update(repositories)
      .set({ issueCount: resolved.repo.issueCount + 1 })
      .where(eq(repositories.id, resolved.repo.id));

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issue.number}`
    );
  }
);

// View single issue
issueRoutes.get("/:owner/:repo/issues/:number", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const issueNum = parseInt(c.req.param("number"), 10);
  const user = c.get("user");

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const [issue] = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.repositoryId, resolved.repo.id),
        eq(issues.number, issueNum)
      )
    )
    .limit(1);

  if (!issue) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Issue not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const [author] = await db
    .select()
    .from(users)
    .where(eq(users.id, issue.authorId))
    .limit(1);

  // Get comments
  const comments = await db
    .select({
      comment: issueComments,
      author: { username: users.username },
    })
    .from(issueComments)
    .innerJoin(users, eq(issueComments.authorId, users.id))
    .where(eq(issueComments.issueId, issue.id))
    .orderBy(asc(issueComments.createdAt));

  // Load reactions for the issue + each comment in parallel.
  const [issueReactions, ...commentReactions] = await Promise.all([
    summariseReactions("issue", issue.id, user?.id),
    ...comments.map((row) =>
      summariseReactions("issue_comment", row.comment.id, user?.id)
    ),
  ]);

  const canManage =
    user &&
    (user.id === resolved.owner.id || user.id === issue.authorId);

  return c.html(
    <Layout
      title={`${issue.title} #${issue.number} — ${ownerName}/${repoName}`}
      user={user}
    >
      <RepoHeader owner={ownerName} repo={repoName} />
      <IssueNav owner={ownerName} repo={repoName} active="issues" />
      <div class="issue-detail">
        <h2>
          {issue.title}{" "}
          <span style="color: var(--text-muted); font-weight: 400">
            #{issue.number}
          </span>
        </h2>
        <div style="margin: 8px 0 20px; display: flex; align-items: center; gap: 8px">
          <span
            class={`issue-badge ${issue.state === "open" ? "badge-open" : "badge-closed"}`}
          >
            {issue.state === "open" ? "\u25CB Open" : "\u2713 Closed"}
          </span>
          <span style="color: var(--text-muted); font-size: 14px">
            <strong style="color: var(--text)">
              {author?.username || "unknown"}
            </strong>{" "}
            opened this issue {formatRelative(issue.createdAt)}
          </span>
        </div>

        {issue.body && (
          <div class="issue-comment-box">
            <div class="comment-header">
              <strong>{author?.username}</strong> commented{" "}
              {formatRelative(issue.createdAt)}
            </div>
            <div class="markdown-body">
              {html([renderMarkdown(issue.body)] as unknown as TemplateStringsArray)}
            </div>
            <div style="padding: 0 16px 12px">
              <ReactionsBar
                targetType="issue"
                targetId={issue.id}
                summaries={issueReactions}
                canReact={!!user}
              />
            </div>
          </div>
        )}

        {comments.map(({ comment, author: commentAuthor }, i) => (
          <div class="issue-comment-box">
            <div class="comment-header">
              <strong>{commentAuthor.username}</strong> commented{" "}
              {formatRelative(comment.createdAt)}
            </div>
            <div class="markdown-body">
              {html([renderMarkdown(comment.body)] as unknown as TemplateStringsArray)}
            </div>
            <div style="padding: 0 16px 12px">
              <ReactionsBar
                targetType="issue_comment"
                targetId={comment.id}
                summaries={commentReactions[i] || []}
                canReact={!!user}
              />
            </div>
          </div>
        ))}

        {user && (
          <div style="margin-top: 20px">
            <form
              method="POST"
              action={`/${ownerName}/${repoName}/issues/${issue.number}/comment`}
            >
              <div class="form-group">
                <textarea
                  name="body"
                  rows={6}
                  required
                  placeholder="Leave a comment... (Markdown supported)"
                  style="font-family: var(--font-mono); font-size: 13px"
                />
              </div>
              <div style="display: flex; gap: 8px">
                <button type="submit" class="btn btn-primary">
                  Comment
                </button>
                {canManage && (
                  <button
                    type="submit"
                    formaction={`/${ownerName}/${repoName}/issues/${issue.number}/${issue.state === "open" ? "close" : "reopen"}`}
                    class={`btn ${issue.state === "open" ? "btn-danger" : ""}`}
                  >
                    {issue.state === "open"
                      ? "Close issue"
                      : "Reopen issue"}
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </div>
    </Layout>
  );
});

// Add comment
issueRoutes.post(
  "/:owner/:repo/issues/:number/comment",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const commentBody = String(body.body || "").trim();

    if (!commentBody) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}`
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      )
      .limit(1);

    if (!issue) return c.redirect(`/${ownerName}/${repoName}/issues`);

    await db.insert(issueComments).values({
      issueId: issue.id,
      authorId: user.id,
      body: commentBody,
    });

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issueNum}`
    );
  }
);

// Close issue
issueRoutes.post(
  "/:owner/:repo/issues/:number/close",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db
      .update(issues)
      .set({ state: "closed", closedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      );

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issueNum}`
    );
  }
);

// Reopen issue
issueRoutes.post(
  "/:owner/:repo/issues/:number/reopen",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db
      .update(issues)
      .set({ state: "open", closedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      );

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issueNum}`
    );
  }
);

// Shared nav component with issues tab
const IssueNav = ({
  owner,
  repo,
  active,
}: {
  owner: string;
  repo: string;
  active: "code" | "commits" | "issues";
}) => (
  <div class="repo-nav">
    <a href={`/${owner}/${repo}`} class={active === "code" ? "active" : ""}>
      Code
    </a>
    <a
      href={`/${owner}/${repo}/issues`}
      class={active === "issues" ? "active" : ""}
    >
      Issues
    </a>
    <a
      href={`/${owner}/${repo}/commits`}
      class={active === "commits" ? "active" : ""}
    >
      Commits
    </a>
  </div>
);

function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default issueRoutes;
export { IssueNav };

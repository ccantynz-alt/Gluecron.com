/**
 * Pull request routes — create, list, view, merge, close, comment.
 */

import { Hono } from "hono";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import {
  pullRequests,
  prComments,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, DiffView } from "../views/components";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  listBranches,
  getRepoPath,
} from "../git/repository";
import type { GitDiffFile } from "../git/repository";
import { html } from "hono/html";

const pulls = new Hono<AuthEnv>();

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

// PR Nav helper
const PrNav = ({
  owner,
  repo,
  active,
}: {
  owner: string;
  repo: string;
  active: "code" | "issues" | "pulls" | "commits";
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
      href={`/${owner}/${repo}/pulls`}
      class={active === "pulls" ? "active" : ""}
    >
      Pull Requests
    </a>
    <a
      href={`/${owner}/${repo}/commits`}
      class={active === "commits" ? "active" : ""}
    >
      Commits
    </a>
  </div>
);

// List PRs
pulls.get("/:owner/:repo/pulls", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const state = c.req.query("state") || "open";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  const prList = await db
    .select({
      pr: pullRequests,
      author: { username: users.username },
    })
    .from(pullRequests)
    .innerJoin(users, eq(pullRequests.authorId, users.id))
    .where(
      and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        eq(pullRequests.state, state)
      )
    )
    .orderBy(desc(pullRequests.createdAt));

  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${pullRequests.state} = 'open')`,
      closed: sql<number>`count(*) filter (where ${pullRequests.state} = 'closed')`,
      merged: sql<number>`count(*) filter (where ${pullRequests.state} = 'merged')`,
    })
    .from(pullRequests)
    .where(eq(pullRequests.repositoryId, resolved.repo.id));

  return c.html(
    <Layout title={`Pull Requests — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <div class="issue-tabs">
          <a
            href={`/${ownerName}/${repoName}/pulls?state=open`}
            class={state === "open" ? "active" : ""}
          >
            {counts?.open ?? 0} Open
          </a>
          <a
            href={`/${ownerName}/${repoName}/pulls?state=merged`}
            class={state === "merged" ? "active" : ""}
          >
            {counts?.merged ?? 0} Merged
          </a>
          <a
            href={`/${ownerName}/${repoName}/pulls?state=closed`}
            class={state === "closed" ? "active" : ""}
          >
            {counts?.closed ?? 0} Closed
          </a>
        </div>
        {user && (
          <a
            href={`/${ownerName}/${repoName}/pulls/new`}
            class="btn btn-primary"
          >
            New pull request
          </a>
        )}
      </div>
      {prList.length === 0 ? (
        <div class="empty-state">
          <p>No {state} pull requests.</p>
        </div>
      ) : (
        <div class="issue-list">
          {prList.map(({ pr, author }) => (
            <div class="issue-item">
              <div
                class={`issue-state-icon ${pr.state === "open" ? "state-open" : pr.state === "merged" ? "state-merged" : "state-closed"}`}
              >
                {pr.state === "open"
                  ? "\u25CB"
                  : pr.state === "merged"
                    ? "\u2B8C"
                    : "\u2713"}
              </div>
              <div>
                <div class="issue-title">
                  <a href={`/${ownerName}/${repoName}/pulls/${pr.number}`}>
                    {pr.title}
                  </a>
                </div>
                <div class="issue-meta">
                  #{pr.number}{" "}
                  {pr.headBranch} → {pr.baseBranch}{" "}
                  by {author.username}{" "}
                  {formatRelative(pr.createdAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
});

// New PR form
pulls.get(
  "/:owner/:repo/pulls/new",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const branches = await listBranches(ownerName, repoName);
    const error = c.req.query("error");
    const defaultBase = branches.includes("main") ? "main" : branches[0] || "";

    return c.html(
      <Layout title={`New PR — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <PrNav owner={ownerName} repo={repoName} active="pulls" />
        <div style="max-width: 800px">
          <h2 style="margin-bottom: 16px">Open a pull request</h2>
          {error && (
            <div class="auth-error">{decodeURIComponent(error)}</div>
          )}
          <form method="POST" action={`/${ownerName}/${repoName}/pulls/new`}>
            <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 16px">
              <select name="base" style="padding: 6px 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 13px">
                {branches.map((b) => (
                  <option value={b} selected={b === defaultBase}>
                    {b}
                  </option>
                ))}
              </select>
              <span style="color: var(--text-muted)">&larr;</span>
              <select name="head" style="padding: 6px 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 13px">
                {branches
                  .filter((b) => b !== defaultBase)
                  .concat(defaultBase === branches[0] ? [] : [branches[0]])
                  .map((b) => (
                    <option value={b}>{b}</option>
                  ))}
              </select>
            </div>
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
                rows={8}
                placeholder="Description (Markdown supported)"
                style="font-family: var(--font-mono); font-size: 13px"
              />
            </div>
            <button type="submit" class="btn btn-primary">
              Create pull request
            </button>
          </form>
        </div>
      </Layout>
    );
  }
);

// Create PR
pulls.post(
  "/:owner/:repo/pulls/new",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const title = String(body.title || "").trim();
    const prBody = String(body.body || "").trim();
    const baseBranch = String(body.base || "main");
    const headBranch = String(body.head || "");

    if (!title || !headBranch) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/new?error=Title+and+branches+are+required`
      );
    }

    if (baseBranch === headBranch) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/new?error=Base+and+head+branches+must+be+different`
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: resolved.repo.id,
        authorId: user.id,
        title,
        body: prBody || null,
        baseBranch,
        headBranch,
      })
      .returning();

    return c.redirect(`/${ownerName}/${repoName}/pulls/${pr.number}`);
  }
);

// View single PR
pulls.get("/:owner/:repo/pulls/:number", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const prNum = parseInt(c.req.param("number"), 10);
  const user = c.get("user");
  const tab = c.req.query("tab") || "conversation";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        eq(pullRequests.number, prNum)
      )
    )
    .limit(1);

  if (!pr) return c.notFound();

  const [author] = await db
    .select()
    .from(users)
    .where(eq(users.id, pr.authorId))
    .limit(1);

  const comments = await db
    .select({
      comment: prComments,
      author: { username: users.username },
    })
    .from(prComments)
    .innerJoin(users, eq(prComments.authorId, users.id))
    .where(eq(prComments.pullRequestId, pr.id))
    .orderBy(asc(prComments.createdAt));

  const canManage =
    user &&
    (user.id === resolved.owner.id || user.id === pr.authorId);

  // Get diff for "Files changed" tab
  let diffRaw = "";
  let diffFiles: GitDiffFile[] = [];
  if (tab === "files") {
    const repoDir = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      ["git", "diff", `${pr.baseBranch}...${pr.headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    diffRaw = await new Response(proc.stdout).text();
    await proc.exited;

    const statProc = Bun.spawn(
      ["git", "diff", "--numstat", `${pr.baseBranch}...${pr.headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const stat = await new Response(statProc.stdout).text();
    await statProc.exited;

    diffFiles = stat
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [add, del, filePath] = line.split("\t");
        return {
          path: filePath,
          status: "modified",
          additions: add === "-" ? 0 : parseInt(add, 10),
          deletions: del === "-" ? 0 : parseInt(del, 10),
          patch: "",
        };
      });
  }

  return c.html(
    <Layout
      title={`${pr.title} #${pr.number} — ${ownerName}/${repoName}`}
      user={user}
    >
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
      <div class="issue-detail">
        <h2>
          {pr.title}{" "}
          <span style="color: var(--text-muted); font-weight: 400">
            #{pr.number}
          </span>
        </h2>
        <div style="margin: 8px 0 20px; display: flex; align-items: center; gap: 8px">
          <span
            class={`issue-badge ${pr.state === "open" ? "badge-open" : pr.state === "merged" ? "badge-merged" : "badge-closed"}`}
          >
            {pr.state === "open"
              ? "\u25CB Open"
              : pr.state === "merged"
                ? "\u2B8C Merged"
                : "\u2713 Closed"}
          </span>
          <span style="color: var(--text-muted); font-size: 14px">
            <strong style="color: var(--text)">
              {author?.username}
            </strong>{" "}
            wants to merge <code>{pr.headBranch}</code> into{" "}
            <code>{pr.baseBranch}</code>
          </span>
        </div>

        <div class="issue-tabs" style="margin-bottom: 20px">
          <a
            href={`/${ownerName}/${repoName}/pulls/${pr.number}`}
            class={tab === "conversation" ? "active" : ""}
          >
            Conversation
          </a>
          <a
            href={`/${ownerName}/${repoName}/pulls/${pr.number}?tab=files`}
            class={tab === "files" ? "active" : ""}
          >
            Files changed
          </a>
        </div>

        {tab === "files" ? (
          <DiffView raw={diffRaw} files={diffFiles} />
        ) : (
          <>
            {pr.body && (
              <div class="issue-comment-box">
                <div class="comment-header">
                  <strong>{author?.username}</strong> commented{" "}
                  {formatRelative(pr.createdAt)}
                </div>
                <div class="markdown-body">
                  {html([renderMarkdown(pr.body)] as unknown as TemplateStringsArray)}
                </div>
              </div>
            )}

            {comments.map(({ comment, author: commentAuthor }) => (
              <div
                class={`issue-comment-box ${comment.isAiReview ? "ai-review" : ""}`}
              >
                <div class="comment-header">
                  <strong>{commentAuthor.username}</strong>
                  {comment.isAiReview && (
                    <span class="badge" style="margin-left: 8px; background: rgba(31, 111, 235, 0.15); color: var(--text-link); border-color: var(--accent)">
                      AI Review
                    </span>
                  )}
                  {" "}
                  commented {formatRelative(comment.createdAt)}
                  {comment.filePath && (
                    <span style="margin-left: 8px; font-family: var(--font-mono); font-size: 11px">
                      {comment.filePath}
                      {comment.lineNumber ? `:${comment.lineNumber}` : ""}
                    </span>
                  )}
                </div>
                <div class="markdown-body">
                  {html([renderMarkdown(comment.body)] as unknown as TemplateStringsArray)}
                </div>
              </div>
            ))}

            {user && pr.state === "open" && (
              <div style="margin-top: 20px">
                <form
                  method="POST"
                  action={`/${ownerName}/${repoName}/pulls/${pr.number}/comment`}
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
                      <>
                        <button
                          type="submit"
                          formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/merge`}
                          class="btn"
                          style="background: rgba(63, 185, 80, 0.15); border-color: var(--green); color: var(--green)"
                        >
                          Merge pull request
                        </button>
                        <button
                          type="submit"
                          formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/close`}
                          class="btn btn-danger"
                        >
                          Close
                        </button>
                      </>
                    )}
                  </div>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
});

// Add comment to PR
pulls.post(
  "/:owner/:repo/pulls/:number/comment",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const commentBody = String(body.body || "").trim();

    if (!commentBody) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);

    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    await db.insert(prComments).values({
      pullRequestId: pr.id,
      authorId: user.id,
      body: commentBody,
    });

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Merge PR
pulls.post(
  "/:owner/:repo/pulls/:number/merge",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);

    if (!pr || pr.state !== "open") {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    // Perform git merge
    const repoDir = getRepoPath(ownerName, repoName);
    const mergeProc = Bun.spawn(
      [
        "git",
        "merge-base",
        "--is-ancestor",
        pr.baseBranch,
        pr.headBranch,
      ],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await mergeProc.exited;

    // Use git update-ref for fast-forward or create merge commit
    const ffProc = Bun.spawn(
      [
        "git",
        "update-ref",
        `refs/heads/${pr.baseBranch}`,
        `refs/heads/${pr.headBranch}`,
      ],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const ffExit = await ffProc.exited;

    if (ffExit !== 0) {
      // Fallback: try creating a merge commit via a temporary checkout
      // For now, just report the error
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=merge_conflict`
      );
    }

    await db
      .update(pullRequests)
      .set({
        state: "merged",
        mergedAt: new Date(),
        mergedBy: user.id,
        updatedAt: new Date(),
      })
      .where(eq(pullRequests.id, pr.id));

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Close PR
pulls.post(
  "/:owner/:repo/pulls/:number/close",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db
      .update(pullRequests)
      .set({
        state: "closed",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      );

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
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

export default pulls;

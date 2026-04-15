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
import {
  listIssueTemplates,
  findTemplateBySlug,
  type IssueTemplate,
} from "../lib/issue-templates";
import { renderMarkdown } from "../lib/markdown";
import {
  applyQuery,
  formatIssueQuery,
  parseIssueQuery,
  type QueryableIssue,
} from "../lib/issue-query";
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
  const stateParam = c.req.query("state") || "open";
  const rawQuery = c.req.query("q") || "";

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

  // J23 — the DSL may override `is:` from the query string. If `is:` is set
  // in `q`, it wins; otherwise the tab-based state controls the filter.
  const parsedQuery = parseIssueQuery(rawQuery);
  const effectiveState = parsedQuery.is ?? stateParam;

  // Fetch issues matching the basic state filter, joined with author.
  const issueRows = await db
    .select({
      issue: issues,
      author: { username: users.username },
    })
    .from(issues)
    .innerJoin(users, eq(issues.authorId, users.id))
    .where(
      and(
        eq(issues.repositoryId, repo.id),
        eq(issues.state, effectiveState)
      )
    )
    .orderBy(desc(issues.createdAt));

  // Fetch labels for the fetched issues (single query). Used both for
  // DSL filtering and for an inline render hint.
  const issueIds = issueRows.map((r) => r.issue.id);
  const labelRows =
    issueIds.length === 0
      ? []
      : await db
          .select({
            issueId: issueLabels.issueId,
            name: labels.name,
            color: labels.color,
          })
          .from(issueLabels)
          .innerJoin(labels, eq(issueLabels.labelId, labels.id))
          .where(
            sql`${issueLabels.issueId} IN (${sql.join(
              issueIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          );

  const labelsByIssue = new Map<string, { name: string; color: string }[]>();
  for (const row of labelRows) {
    const arr = labelsByIssue.get(row.issueId) ?? [];
    arr.push({ name: row.name, color: row.color });
    labelsByIssue.set(row.issueId, arr);
  }

  // Build queryable shape for the DSL matcher.
  type Row = (typeof issueRows)[number];
  type RowWithLabels = Row & { labelNames: string[]; colorByLabel: Map<string, string> };
  const enriched: RowWithLabels[] = issueRows.map((r) => {
    const ls = labelsByIssue.get(r.issue.id) ?? [];
    const colorByLabel = new Map<string, string>();
    for (const l of ls) colorByLabel.set(l.name, l.color);
    return { ...r, labelNames: ls.map((l) => l.name), colorByLabel };
  });

  // Apply the DSL if a query was provided. Otherwise pass-through.
  let display: RowWithLabels[];
  if (rawQuery.trim()) {
    const queryable: (QueryableIssue & { __row: RowWithLabels })[] = enriched.map(
      (r) => ({
        title: r.issue.title,
        body: r.issue.body,
        state: r.issue.state,
        authorName: r.author.username,
        labelNames: r.labelNames,
        milestoneTitle: null,
        createdAt: r.issue.createdAt,
        updatedAt: r.issue.updatedAt,
        commentCount: 0,
        __row: r,
      })
    );
    const { matches } = applyQuery(rawQuery, queryable);
    display = matches.map((m) => m.__row);
  } else {
    display = enriched;
  }

  // Count open/closed for the tab pills — always over ALL issues in the
  // repo, independent of `q`, so the counters don't collapse when filters
  // narrow the list.
  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${issues.state} = 'open')`,
      closed: sql<number>`count(*) filter (where ${issues.state} = 'closed')`,
    })
    .from(issues)
    .where(eq(issues.repositoryId, repo.id));

  const qsForTab = (s: string) => {
    const parts: string[] = [`state=${s}`];
    if (rawQuery) parts.push(`q=${encodeURIComponent(rawQuery)}`);
    return parts.join("&");
  };

  return (
    c.html(
    <Layout title={`Issues — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <IssueNav owner={ownerName} repo={repoName} active="issues" />

      {/* J23 — DSL search bar. */}
      <form
        method="GET"
        action={`/${ownerName}/${repoName}/issues`}
        style="margin-bottom: 12px; display: flex; gap: 8px"
      >
        <input type="hidden" name="state" value={effectiveState} />
        <input
          type="text"
          name="q"
          value={rawQuery}
          placeholder='is:open label:bug author:alice "race condition"'
          style="flex: 1; padding: 6px 10px; font-size: 13px; font-family: var(--font-mono)"
        />
        <button type="submit" class="btn" style="padding: 4px 12px">
          Search
        </button>
        {rawQuery && (
          <a
            href={`/${ownerName}/${repoName}/issues?state=${effectiveState}`}
            class="btn"
            style="padding: 4px 12px; font-size: 13px"
          >
            Clear
          </a>
        )}
      </form>
      <details style="margin-bottom: 12px; color: var(--text-muted); font-size: 12px">
        <summary style="cursor: pointer">Search syntax</summary>
        <div style="margin-top: 6px; line-height: 1.6">
          <code>is:open</code> / <code>is:closed</code> •{" "}
          <code>author:&lt;user&gt;</code> •{" "}
          <code>label:&lt;name&gt;</code> (repeatable, AND) •{" "}
          <code>-label:&lt;name&gt;</code> to exclude •{" "}
          <code>no:label</code> •{" "}
          <code>milestone:"v1.0"</code> •{" "}
          <code>sort:</code>
          <code>created-desc</code>|<code>created-asc</code>|
          <code>updated-desc</code>|<code>updated-asc</code>|
          <code>comments-desc</code> • any other text is a case-insensitive
          substring match against title+body.
        </div>
      </details>

      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <div class="issue-tabs">
          <a
            href={`/${ownerName}/${repoName}/issues?${qsForTab("open")}`}
            class={effectiveState === "open" ? "active" : ""}
          >
            {counts?.open ?? 0} Open
          </a>
          <a
            href={`/${ownerName}/${repoName}/issues?${qsForTab("closed")}`}
            class={effectiveState === "closed" ? "active" : ""}
          >
            {counts?.closed ?? 0} Closed
          </a>
        </div>
        <div style="display: flex; gap: 8px; align-items: center">
          {rawQuery && (
            <span style="color: var(--text-muted); font-size: 12px">
              {display.length} match{display.length === 1 ? "" : "es"}
            </span>
          )}
          <a
            href={`/${ownerName}/${repoName}/issues/stale`}
            class="btn"
            style="padding: 4px 10px; font-size: 12px"
          >
            Stale
          </a>
          {user && (
            <a
              href={`/${ownerName}/${repoName}/issues/new`}
              class="btn btn-primary"
            >
              New issue
            </a>
          )}
        </div>
      </div>
      {display.length === 0 ? (
        <div class="empty-state">
          <p>
            {rawQuery
              ? `No issues match ${JSON.stringify(formatIssueQuery(parsedQuery))}.`
              : `No ${effectiveState} issues.`}
            {!rawQuery && effectiveState === "closed" && (
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
          {display.map(({ issue, author, labelNames, colorByLabel }) => (
            <div class="issue-item">
              <div
                class={`issue-state-icon ${issue.state === "open" ? "state-open" : "state-closed"}`}
              >
                {issue.state === "open" ? "\u25CB" : "\u2713"}
              </div>
              <div style="min-width: 0; flex: 1">
                <div class="issue-title">
                  <a href={`/${ownerName}/${repoName}/issues/${issue.number}`}>
                    {issue.title}
                  </a>
                  {labelNames.length > 0 && (
                    <span style="margin-left: 8px">
                      {labelNames.map((name) => (
                        <span
                          style={`display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 10px; margin-right: 4px; background: ${colorByLabel.get(name) ?? "var(--bg-secondary)"}; color: #fff; border: 1px solid var(--border)`}
                        >
                          {name}
                        </span>
                      ))}
                    </span>
                  )}
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
    )
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
    const slug = c.req.query("template");

    // J17 — multi-template selector. Fetch the list first; if there are 2+
    // templates and the user has not picked one, show a chooser. If exactly
    // one template exists, use it automatically. Fall back to the legacy
    // single-file loader when no frontmatter templates are found.
    const multi = await listIssueTemplates(ownerName, repoName);
    const picked: IssueTemplate | null = findTemplateBySlug(multi, slug);

    if (!picked && multi.length >= 2 && !slug) {
      return c.html(
        <Layout
          title={`New issue — ${ownerName}/${repoName}`}
          user={user}
        >
          <RepoHeader owner={ownerName} repo={repoName} />
          <IssueNav owner={ownerName} repo={repoName} active="issues" />
          <div style="max-width: 720px">
            <h2 style="margin-bottom: 4px">New issue</h2>
            <p style="color: var(--text-muted); margin-bottom: 24px">
              Choose a template to get started, or{" "}
              <a
                href={`/${ownerName}/${repoName}/issues/new?template=__blank`}
              >
                open a blank issue
              </a>
              .
            </p>
            <div style="display: flex; flex-direction: column; gap: 12px">
              {multi.map((t) => (
                <div style="display: flex; align-items: center; gap: 16px; border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-secondary)">
                  <div style="flex: 1; min-width: 0">
                    <div style="font-weight: 600; margin-bottom: 4px">
                      {t.name}
                    </div>
                    {t.about && (
                      <div style="font-size: 13px; color: var(--text-muted)">
                        {t.about}
                      </div>
                    )}
                    {t.labels.length > 0 && (
                      <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px">
                        {t.labels.map((l) => (
                          <span style="display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text-muted)">
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <a
                    href={`/${ownerName}/${repoName}/issues/new?template=${encodeURIComponent(t.slug)}`}
                    class="btn btn-primary"
                  >
                    Get started
                  </a>
                </div>
              ))}
            </div>
          </div>
        </Layout>
      );
    }

    // Auto-pick the single template when only one exists and no slug is set.
    const auto = !picked && !slug && multi.length === 1 ? multi[0] : null;
    const active = picked || auto;

    // Legacy fallback for repos that ship a plain ISSUE_TEMPLATE.md.
    const legacy =
      !active && slug !== "__blank"
        ? await loadIssueTemplate(ownerName, repoName)
        : null;

    const prefillTitle = active?.title ?? "";
    const prefillBody = active ? active.body : legacy || "";

    return c.html(
      <Layout title={`New issue — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <IssueNav owner={ownerName} repo={repoName} active="issues" />
        <div style="max-width: 800px">
          <h2 style="margin-bottom: 16px">New issue</h2>
          {active && (
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px">
              Using template <code>{active.path}</code>
              {multi.length >= 2 && (
                <>
                  {" — "}
                  <a href={`/${ownerName}/${repoName}/issues/new`}>
                    choose a different template
                  </a>
                </>
              )}
              .
            </div>
          )}
          {!active && legacy && (
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px">
              Using <code>ISSUE_TEMPLATE.md</code> from the default branch.
            </div>
          )}
          {active && active.labels.length > 0 && (
            <div style="margin-bottom: 8px">
              {active.labels.map((l) => (
                <span style="display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-muted); margin-right: 6px">
                  {l}
                </span>
              ))}
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
                value={prefillTitle}
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
                {prefillBody}
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

  // J14 — issue dependencies: blockers + blocked lists.
  const [blockers, blocked] = await Promise.all([
    (async () => {
      try {
        const { listBlockersOf } = await import("../lib/issue-dependencies");
        return await listBlockersOf(issue.id);
      } catch {
        return [];
      }
    })(),
    (async () => {
      try {
        const { listBlockedBy } = await import("../lib/issue-dependencies");
        return await listBlockedBy(issue.id);
      } catch {
        return [];
      }
    })(),
  ]);
  const depError = c.req.query("depError");

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

        <DependenciesPanel
          owner={ownerName}
          repo={repoName}
          issueNumber={issue.number}
          blockers={blockers}
          blocked={blocked}
          canManage={!!canManage}
          depError={depError}
        />

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

// J14 — Add blocker dependency.
issueRoutes.post(
  "/:owner/:repo/issues/:number/dependencies",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const blockerRaw = String(body.blockerNumber || "").trim().replace(/^#/, "");
    const blockerNum = parseInt(blockerRaw, 10);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    if (!Number.isFinite(blockerNum) || blockerNum <= 0) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}?depError=invalid`
      );
    }

    const [blocked] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      )
      .limit(1);
    if (!blocked) return c.redirect(`/${ownerName}/${repoName}/issues`);

    const [blocker] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, blockerNum)
        )
      )
      .limit(1);
    if (!blocker) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}?depError=not_found`
      );
    }

    const canManage =
      user.id === resolved.owner.id || user.id === blocked.authorId;
    if (!canManage) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}?depError=forbidden`
      );
    }

    const { addDependency } = await import("../lib/issue-dependencies");
    const result = await addDependency({
      blockerIssueId: blocker.id,
      blockedIssueId: blocked.id,
      createdBy: user.id,
    });
    if (!result.ok) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}?depError=${result.reason}`
      );
    }
    return c.redirect(`/${ownerName}/${repoName}/issues/${issueNum}`);
  }
);

// J14 — Remove blocker dependency. :which is either "blockers" or "blocks".
issueRoutes.post(
  "/:owner/:repo/issues/:number/dependencies/:which/:otherId/remove",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);
    const which = c.req.param("which");
    const otherId = c.req.param("otherId");
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [thisIssue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      )
      .limit(1);
    if (!thisIssue) return c.redirect(`/${ownerName}/${repoName}/issues`);

    const canManage =
      user.id === resolved.owner.id || user.id === thisIssue.authorId;
    if (!canManage) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}?depError=forbidden`
      );
    }

    const { removeDependency } = await import("../lib/issue-dependencies");
    // which === "blockers" → otherId is the blocker; this issue is blocked.
    // which === "blocks" → otherId is the blocked; this issue is blocker.
    if (which === "blockers") {
      await removeDependency(otherId, thisIssue.id);
    } else if (which === "blocks") {
      await removeDependency(thisIssue.id, otherId);
    }
    return c.redirect(`/${ownerName}/${repoName}/issues/${issueNum}`);
  }
);

// J14 — Dependencies UI panel.
type DepRow = {
  id: string;
  issueId: string;
  number: number;
  title: string;
  state: string;
  authorUsername: string;
};

function depErrorMessage(reason: string | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case "self":
      return "An issue cannot block itself.";
    case "cross_repo":
      return "Both issues must belong to the same repository.";
    case "exists":
      return "That dependency already exists.";
    case "cycle":
      return "That dependency would create a cycle.";
    case "not_found":
      return "Issue not found.";
    case "invalid":
      return "Invalid issue number.";
    case "forbidden":
      return "You don't have permission to change dependencies on this issue.";
    default:
      return "Could not update dependencies.";
  }
}

const DependenciesPanel = ({
  owner,
  repo,
  issueNumber,
  blockers,
  blocked,
  canManage,
  depError,
}: {
  owner: string;
  repo: string;
  issueNumber: number;
  blockers: DepRow[];
  blocked: DepRow[];
  canManage: boolean;
  depError: string | undefined;
}) => {
  if (blockers.length === 0 && blocked.length === 0 && !canManage) return null;
  const errMsg = depErrorMessage(depError);
  const renderRow = (row: DepRow, which: "blockers" | "blocks") => (
    <div
      style="display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--border)"
    >
      <span
        class={`issue-badge ${row.state === "open" ? "badge-open" : "badge-closed"}`}
        style="font-size: 11px; padding: 1px 6px"
      >
        {row.state === "open" ? "\u25CB" : "\u2713"}
      </span>
      <a
        href={`/${owner}/${repo}/issues/${row.number}`}
        style="flex: 1; text-decoration: none"
      >
        <span style="color: var(--text-muted)">#{row.number}</span>{" "}
        <span>{row.title}</span>
      </a>
      <span style="color: var(--text-muted); font-size: 12px">
        by {row.authorUsername}
      </span>
      {canManage && (
        <form
          method="POST"
          action={`/${owner}/${repo}/issues/${issueNumber}/dependencies/${which}/${row.issueId}/remove`}
          style="margin: 0"
        >
          <button
            type="submit"
            class="btn"
            style="padding: 2px 8px; font-size: 11px"
            title="Remove dependency"
          >
            {"\u2715"}
          </button>
        </form>
      )}
    </div>
  );
  return (
    <div
      style="margin: 16px 0; padding: 12px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary)"
    >
      <div style="font-weight: 600; margin-bottom: 8px">Dependencies</div>
      {errMsg && <div class="auth-error" style="margin-bottom: 8px">{errMsg}</div>}

      <div style="margin-bottom: 12px">
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px">
          Blocked by ({blockers.length})
        </div>
        {blockers.length === 0 ? (
          <div style="font-size: 12px; color: var(--text-muted); padding: 4px 0">
            No blockers.
          </div>
        ) : (
          blockers.map((r) => renderRow(r, "blockers"))
        )}
        {canManage && (
          <form
            method="POST"
            action={`/${owner}/${repo}/issues/${issueNumber}/dependencies`}
            style="display: flex; gap: 6px; margin-top: 8px"
          >
            <input
              type="text"
              name="blockerNumber"
              required
              placeholder="#123"
              style="flex: 1; padding: 4px 8px; font-size: 12px"
            />
            <button type="submit" class="btn" style="padding: 4px 10px; font-size: 12px">
              Add blocker
            </button>
          </form>
        )}
      </div>

      <div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px">
          Blocks ({blocked.length})
        </div>
        {blocked.length === 0 ? (
          <div style="font-size: 12px; color: var(--text-muted); padding: 4px 0">
            This issue does not block any others.
          </div>
        ) : (
          blocked.map((r) => renderRow(r, "blocks"))
        )}
      </div>
    </div>
  );
};

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

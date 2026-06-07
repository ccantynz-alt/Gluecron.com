/**
 * Milestones — group issues and PRs toward a shared goal with due dates
 * and progress tracking.
 *
 * Routes:
 *   GET  /:owner/:repo/milestones            — list
 *   GET  /:owner/:repo/milestones/new        — create form
 *   POST /:owner/:repo/milestones            — create
 *   GET  /:owner/:repo/milestones/:id        — detail (issues + PRs in milestone)
 *   GET  /:owner/:repo/milestones/:id/edit   — edit form
 *   POST /:owner/:repo/milestones/:id        — update
 *   POST /:owner/:repo/milestones/:id/close  — close
 *   POST /:owner/:repo/milestones/:id/delete — delete (owner only)
 */

import { Hono } from "hono";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import { milestones, issues, pullRequests, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";

const milestonesRoutes = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// CSS scoped to .ms-* namespace
// ---------------------------------------------------------------------------
const milestonesStyles = `
  .ms-hero {
    position: relative;
    margin: 4px 0 24px;
    padding: 28px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ms-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ms-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 24px;
    flex-wrap: wrap;
  }
  .ms-hero-text { flex: 1; min-width: 280px; }
  .ms-hero-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .ms-hero-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 3.5vw, 36px);
    font-weight: 800;
    letter-spacing: -0.026em;
    line-height: 1.08;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .ms-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 560px;
  }
  .ms-hero-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Filter tabs */
  .ms-filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .ms-filter-tabs {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
  }
  .ms-filter-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms, background 120ms;
  }
  .ms-filter-tab:hover { color: var(--text-strong); text-decoration: none; }
  .ms-filter-tab.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
  }
  .ms-filter-tab-count {
    font-size: 11.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    padding: 1px 7px;
    border-radius: 9999px;
  }

  /* Milestone card */
  .ms-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .ms-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 22px;
    transition: border-color 120ms, box-shadow 120ms;
  }
  .ms-card:hover {
    border-color: rgba(140,109,255,0.4);
    box-shadow: 0 4px 16px -8px rgba(140,109,255,0.2);
  }
  .ms-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .ms-card-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
    text-decoration: none;
    margin: 0;
  }
  .ms-card-title a {
    color: inherit;
    text-decoration: none;
  }
  .ms-card-title a:hover { color: var(--accent); }
  .ms-card-meta {
    font-size: 12.5px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .ms-card-due-ok  { color: var(--text-muted); }
  .ms-card-due-warn { color: #f59e0b; font-weight: 600; }
  .ms-card-due-over { color: #ef4444; font-weight: 600; }
  .ms-card-state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
  }
  .ms-card-state.is-open   { background: rgba(52,211,153,0.10); color: #34d399; border: 1px solid rgba(52,211,153,0.3); }
  .ms-card-state.is-closed { background: rgba(182,157,255,0.10); color: #b69dff; border: 1px solid rgba(182,157,255,0.3); }

  /* Progress bar */
  .ms-progress-wrap {
    margin-top: 8px;
  }
  .ms-progress-bar-bg {
    height: 6px;
    background: var(--bg-secondary);
    border-radius: 9999px;
    overflow: hidden;
    margin-bottom: 5px;
  }
  .ms-progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #8c6dff, #36c5d6);
    border-radius: 9999px;
    transition: width 400ms ease;
  }
  .ms-progress-label {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Card actions */
  .ms-card-actions {
    margin-top: 12px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ms-card-action-link {
    font-size: 12.5px;
    color: var(--text-muted);
    text-decoration: none;
    padding: 3px 0;
    border-bottom: 1px dashed transparent;
    transition: color 120ms, border-color 120ms;
  }
  .ms-card-action-link:hover { color: var(--accent); border-bottom-color: var(--accent); }
  .ms-card-action-sep { color: var(--text-muted); font-size: 12.5px; }

  /* Empty state */
  .ms-empty {
    margin: 0;
    padding: 56px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
  }
  .ms-empty-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .ms-empty-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0 auto 20px;
    max-width: 440px;
    line-height: 1.55;
  }

  /* Form */
  .ms-form-section {
    max-width: 700px;
    margin: 0 auto;
  }
  .ms-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px 32px;
  }
  .ms-form-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.016em;
    margin: 0 0 22px;
    color: var(--text-strong);
  }
  .ms-form-group { margin-bottom: 18px; }
  .ms-form-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 6px;
  }
  .ms-form-label .ms-form-optional {
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 4px;
  }
  .ms-form-input {
    width: 100%;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: var(--font-sans, inherit);
    font-size: 14px;
    padding: 9px 13px;
    outline: none;
    transition: border-color 120ms, box-shadow 120ms;
    box-sizing: border-box;
  }
  .ms-form-input:focus {
    border-color: rgba(140,109,255,0.6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.15);
  }
  .ms-form-textarea {
    min-height: 100px;
    resize: vertical;
    font-family: var(--font-mono);
    font-size: 13.5px;
    line-height: 1.5;
  }
  .ms-form-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 5px;
    line-height: 1.45;
  }
  .ms-form-actions {
    display: flex;
    gap: 10px;
    margin-top: 24px;
    flex-wrap: wrap;
  }

  /* Detail page */
  .ms-detail-header {
    position: relative;
    margin: 4px 0 20px;
    padding: 22px 26px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ms-detail-header::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ms-detail-title {
    font-family: var(--font-display);
    font-size: clamp(20px, 2.8vw, 28px);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text-strong);
    margin: 0 0 10px;
  }
  .ms-detail-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 13.5px;
    color: var(--text-muted);
    margin-bottom: 14px;
  }
  .ms-detail-desc {
    font-size: 14.5px;
    color: var(--text);
    line-height: 1.55;
    margin-bottom: 14px;
    white-space: pre-wrap;
  }
  .ms-detail-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 14px;
  }

  /* Items list (issues/PRs inside a milestone) */
  .ms-items-section { margin-top: 24px; }
  .ms-items-header {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 10px;
    letter-spacing: -0.01em;
  }
  .ms-items-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .ms-item-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
    transition: background 120ms;
  }
  .ms-item-row:last-child { border-bottom: none; }
  .ms-item-row:hover { background: rgba(140,109,255,0.04); }
  .ms-item-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    margin-top: 3px;
    font-size: 14px;
  }
  .ms-item-icon.is-open   { color: #34d399; }
  .ms-item-icon.is-closed { color: #b69dff; }
  .ms-item-icon.is-merged { color: #a78bfa; }
  .ms-item-main { flex: 1; min-width: 0; }
  .ms-item-title {
    font-size: 14.5px;
    font-weight: 600;
    color: var(--text-strong);
    text-decoration: none;
    line-height: 1.3;
  }
  .ms-item-title:hover { color: var(--accent); }
  .ms-item-meta {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 3px;
  }
  .ms-item-kind {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(255,255,255,0.05);
    color: var(--text-muted);
  }

  /* Alert strip */
  .ms-alert {
    margin-bottom: 14px;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13.5px;
  }
  .ms-alert-error {
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.3);
    color: #ef4444;
  }
  .ms-alert-success {
    background: rgba(52,211,153,0.08);
    border: 1px solid rgba(52,211,153,0.3);
    color: #34d399;
  }

  @media (max-width: 720px) {
    .ms-hero { padding: 20px 16px; }
    .ms-hero-inner { flex-direction: column; align-items: flex-start; }
    .ms-form-card { padding: 20px 16px; }
  }
`;

const MilestonesStyle = () => (
  <style dangerouslySetInnerHTML={{ __html: milestonesStyles }} />
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    .where(and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName)))
    .limit(1);
  if (!repo) return null;

  return { owner, repo };
}

/** Format a date as "MMM D, YYYY" */
function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Days until due date (negative = overdue) */
function daysUntil(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  const diff = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

function dueDateClass(days: number | null): string {
  if (days === null) return "";
  if (days < 0) return "ms-card-due-over";
  if (days <= 7) return "ms-card-due-warn";
  return "ms-card-due-ok";
}

function dueDateLabel(days: number | null, dateStr: string): string {
  if (days === null) return "";
  if (days < 0) return `Overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""} (${dateStr})`;
  if (days === 0) return `Due today (${dateStr})`;
  if (days === 1) return `Due tomorrow (${dateStr})`;
  return `Due ${dateStr}`;
}

// Progress calculation
function calcProgress(total: number, closed: number) {
  if (total === 0) return 0;
  return Math.round((closed / total) * 100);
}

// ---------------------------------------------------------------------------
// GET /:owner/:repo/milestones — list
// ---------------------------------------------------------------------------
milestonesRoutes.get(
  "/:owner/:repo/milestones",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const stateFilter = (c.req.query("state") || "open") as "open" | "closed";

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <p style="padding:40px;color:var(--text-muted)">Repository not found.</p>
        </Layout>,
        404
      );
    }
    const { repo } = resolved;

    const msList = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.repositoryId, repo.id), eq(milestones.state, stateFilter)))
      .orderBy(asc(milestones.dueDate), asc(milestones.createdAt));

    // For each milestone, count open and closed issues
    const progressMap: Record<string, { total: number; closed: number }> = {};
    if (msList.length > 0) {
      const msIds = msList.map((m) => m.id);
      for (const msId of msIds) {
        const [row] = await db
          .select({
            total: sql<number>`count(*)::int`,
            closed: sql<number>`count(*) filter (where ${issues.state} = 'closed')::int`,
          })
          .from(issues)
          .where(eq(issues.milestoneId, msId));
        progressMap[msId] = { total: Number(row?.total ?? 0), closed: Number(row?.closed ?? 0) };
      }
    }

    // Count open/closed milestones for tabs
    const [msCount] = await db
      .select({
        open: sql<number>`count(*) filter (where ${milestones.state} = 'open')::int`,
        closed: sql<number>`count(*) filter (where ${milestones.state} = 'closed')::int`,
      })
      .from(milestones)
      .where(eq(milestones.repositoryId, repo.id));

    const isOwner = !!(user && user.id === resolved.owner.id);

    return c.html(
      <Layout title={`Milestones — ${ownerName}/${repoName}`} user={user}>
        <MilestonesStyle />
        <RepoHeader owner={ownerName} repo={repoName} />

        <section class="ms-hero">
          <div class="ms-hero-inner">
            <div class="ms-hero-text">
              <div class="ms-hero-eyebrow">Milestones &middot; {ownerName}/{repoName}</div>
              <h1 class="ms-hero-title">
                Ship toward <span class="gradient-text">clear goals</span>.
              </h1>
              <p class="ms-hero-sub">
                Group issues and pull requests into milestones with due dates and progress tracking.
              </p>
            </div>
            {isOwner && (
              <div class="ms-hero-actions">
                <a href={`/${ownerName}/${repoName}/milestones/new`} class="btn btn-primary">
                  + New milestone
                </a>
                <a href={`/${ownerName}/${repoName}/issues`} class="btn">
                  Issues
                </a>
              </div>
            )}
          </div>
        </section>

        <div class="ms-filter-row">
          <div class="ms-filter-tabs">
            <a
              class={`ms-filter-tab${stateFilter === "open" ? " is-active" : ""}`}
              href={`/${ownerName}/${repoName}/milestones?state=open`}
            >
              Open
              <span class="ms-filter-tab-count">{Number(msCount?.open ?? 0)}</span>
            </a>
            <a
              class={`ms-filter-tab${stateFilter === "closed" ? " is-active" : ""}`}
              href={`/${ownerName}/${repoName}/milestones?state=closed`}
            >
              Closed
              <span class="ms-filter-tab-count">{Number(msCount?.closed ?? 0)}</span>
            </a>
          </div>
        </div>

        {msList.length === 0 ? (
          <div class="ms-empty">
            <h2 class="ms-empty-title">
              {stateFilter === "closed" ? "No closed milestones" : "No milestones yet"}
            </h2>
            <p class="ms-empty-sub">
              {stateFilter === "closed"
                ? "Closed milestones will appear here once you finish a release cycle."
                : "Create a milestone to group related issues and pull requests toward a shared goal."}
            </p>
            {isOwner && stateFilter === "open" && (
              <a href={`/${ownerName}/${repoName}/milestones/new`} class="btn btn-primary">
                Create your first milestone
              </a>
            )}
          </div>
        ) : (
          <ul class="ms-list">
            {msList.map((ms) => {
              const { total, closed } = progressMap[ms.id] ?? { total: 0, closed: 0 };
              const pct = calcProgress(total, closed);
              const days = daysUntil(ms.dueDate);
              const dateStr = fmtDate(ms.dueDate);
              return (
                <li class="ms-card">
                  <div class="ms-card-header">
                    <h2 class="ms-card-title">
                      <a href={`/${ownerName}/${repoName}/milestones/${ms.id}`}>
                        {ms.title}
                      </a>
                    </h2>
                    <span class={`ms-card-state ${ms.state === "open" ? "is-open" : "is-closed"}`}>
                      {ms.state === "open" ? "Open" : "Closed"}
                    </span>
                  </div>
                  {ms.dueDate && (
                    <div class="ms-card-meta">
                      <span class={dueDateClass(days)}>
                        {dueDateLabel(days, dateStr)}
                      </span>
                    </div>
                  )}
                  {ms.description && (
                    <div class="ms-card-meta" style="margin-top:-2px;margin-bottom:6px">
                      {ms.description}
                    </div>
                  )}
                  <div class="ms-progress-wrap">
                    <div class="ms-progress-bar-bg">
                      <div
                        class="ms-progress-bar-fill"
                        style={`width:${pct}%`}
                        role="progressbar"
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      />
                    </div>
                    <span class="ms-progress-label">
                      {pct}% complete &middot; {total - closed} open &middot; {closed} closed
                    </span>
                  </div>
                  {isOwner && (
                    <div class="ms-card-actions">
                      <a class="ms-card-action-link" href={`/${ownerName}/${repoName}/milestones/${ms.id}/edit`}>
                        Edit
                      </a>
                      <span class="ms-card-action-sep">&middot;</span>
                      {ms.state === "open" ? (
                        <form method="post" action={`/${ownerName}/${repoName}/milestones/${ms.id}/close`} style="display:inline">
                          <button type="submit" class="ms-card-action-link" style="background:none;border:none;padding:3px 0;cursor:pointer;font-family:inherit">
                            Close milestone
                          </button>
                        </form>
                      ) : (
                        <form method="post" action={`/${ownerName}/${repoName}/milestones/${ms.id}`} style="display:inline">
                          <input type="hidden" name="_action" value="reopen" />
                          <button type="submit" class="ms-card-action-link" style="background:none;border:none;padding:3px 0;cursor:pointer;font-family:inherit">
                            Reopen milestone
                          </button>
                        </form>
                      )}
                      <span class="ms-card-action-sep">&middot;</span>
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/milestones/${ms.id}/delete`}
                        style="display:inline"
                        onsubmit="return confirm('Delete this milestone? Issues and PRs will lose their milestone assignment.')"
                      >
                        <button type="submit" class="ms-card-action-link" style="background:none;border:none;padding:3px 0;cursor:pointer;font-family:inherit;color:#ef4444">
                          Delete
                        </button>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// GET /:owner/:repo/milestones/new — create form
// ---------------------------------------------------------------------------
milestonesRoutes.get(
  "/:owner/:repo/milestones/new",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const error = c.req.query("error");

    return c.html(
      <Layout title={`New milestone — ${ownerName}/${repoName}`} user={user}>
        <MilestonesStyle />
        <RepoHeader owner={ownerName} repo={repoName} />
        <div class="ms-form-section" style="margin-top:24px">
          <div class="ms-form-card">
            <h1 class="ms-form-title">New milestone</h1>
            {error && (
              <div class="ms-alert ms-alert-error">{decodeURIComponent(error)}</div>
            )}
            <form method="post" action={`/${ownerName}/${repoName}/milestones`}>
              <div class="ms-form-group">
                <label class="ms-form-label" for="ms-title">Title</label>
                <input
                  id="ms-title"
                  type="text"
                  name="title"
                  required
                  class="ms-form-input"
                  placeholder="e.g. v1.0 Release"
                  maxlength={255}
                />
              </div>
              <div class="ms-form-group">
                <label class="ms-form-label" for="ms-due">
                  Due date <span class="ms-form-optional">(optional)</span>
                </label>
                <input
                  id="ms-due"
                  type="date"
                  name="due_date"
                  class="ms-form-input"
                  style="max-width:220px"
                />
              </div>
              <div class="ms-form-group">
                <label class="ms-form-label" for="ms-desc">
                  Description <span class="ms-form-optional">(optional)</span>
                </label>
                <textarea
                  id="ms-desc"
                  name="description"
                  class="ms-form-input ms-form-textarea"
                  placeholder="A short description of what this milestone represents"
                  maxlength={2000}
                />
                <p class="ms-form-hint">Plain text only.</p>
              </div>
              <div class="ms-form-actions">
                <button type="submit" class="btn btn-primary">Create milestone</button>
                <a href={`/${ownerName}/${repoName}/milestones`} class="btn">Cancel</a>
              </div>
            </form>
          </div>
        </div>
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/milestones — create
// ---------------------------------------------------------------------------
milestonesRoutes.post(
  "/:owner/:repo/milestones",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim() || null;
    const dueDateRaw = String(body.due_date || "").trim();
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;

    // Handle reopen action routed through POST /:id
    const action = String(body._action || "");

    if (!title) {
      return c.redirect(
        `/${ownerName}/${repoName}/milestones/new?error=${encodeURIComponent("Title is required")}`
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db.insert(milestones).values({
      repositoryId: resolved.repo.id,
      title,
      description,
      dueDate: dueDate ?? undefined,
      state: "open",
    });

    return c.redirect(`/${ownerName}/${repoName}/milestones`);
  }
);

// ---------------------------------------------------------------------------
// GET /:owner/:repo/milestones/:milestoneId — detail
// ---------------------------------------------------------------------------
milestonesRoutes.get(
  "/:owner/:repo/milestones/:milestoneId",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName, milestoneId } = c.req.param();
    const user = c.get("user");

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <p style="padding:40px;color:var(--text-muted)">Repository not found.</p>
        </Layout>,
        404
      );
    }
    const { repo } = resolved;

    const [ms] = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.id, milestoneId), eq(milestones.repositoryId, repo.id)))
      .limit(1);

    if (!ms) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <p style="padding:40px;color:var(--text-muted)">Milestone not found.</p>
        </Layout>,
        404
      );
    }

    // Load issues in this milestone
    const msIssues = await db
      .select({ issue: issues, author: { username: users.username } })
      .from(issues)
      .innerJoin(users, eq(issues.authorId, users.id))
      .where(eq(issues.milestoneId, milestoneId))
      .orderBy(desc(issues.createdAt));

    // Load PRs in this milestone
    const msPRs = await db
      .select({ pr: pullRequests, author: { username: users.username } })
      .from(pullRequests)
      .innerJoin(users, eq(pullRequests.authorId, users.id))
      .where(eq(pullRequests.milestoneId, milestoneId))
      .orderBy(desc(pullRequests.createdAt));

    const totalIssues = msIssues.length;
    const closedIssues = msIssues.filter((r) => r.issue.state === "closed").length;
    const totalPRs = msPRs.length;
    const closedPRs = msPRs.filter((r) => r.pr.state === "merged" || r.pr.state === "closed").length;
    const total = totalIssues + totalPRs;
    const closed = closedIssues + closedPRs;
    const pct = calcProgress(total, closed);

    const days = daysUntil(ms.dueDate);
    const dateStr = fmtDate(ms.dueDate);
    const isOwner = !!(user && user.id === resolved.owner.id);
    const success = c.req.query("success");

    return c.html(
      <Layout title={`${ms.title} — ${ownerName}/${repoName}`} user={user}>
        <MilestonesStyle />
        <RepoHeader owner={ownerName} repo={repoName} />

        {success && (
          <div class="ms-alert ms-alert-success" style="margin:12px 0">
            {decodeURIComponent(success)}
          </div>
        )}

        <div class="ms-detail-header">
          <h1 class="ms-detail-title">{ms.title}</h1>
          <div class="ms-detail-meta">
            <span class={`ms-card-state ${ms.state === "open" ? "is-open" : "is-closed"}`}>
              {ms.state === "open" ? "Open" : "Closed"}
            </span>
            {ms.dueDate && (
              <span class={dueDateClass(days)}>
                {dueDateLabel(days, dateStr)}
              </span>
            )}
            <a href={`/${ownerName}/${repoName}/milestones`} style="color:var(--text-muted);text-decoration:none;font-size:13px">
              &larr; All milestones
            </a>
          </div>
          {ms.description && (
            <div class="ms-detail-desc">{ms.description}</div>
          )}

          <div class="ms-progress-wrap">
            <div class="ms-progress-bar-bg">
              <div
                class="ms-progress-bar-fill"
                style={`width:${pct}%`}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <span class="ms-progress-label">
              {pct}% complete &middot; {total - closed} open &middot; {closed} closed
            </span>
          </div>

          {isOwner && (
            <div class="ms-detail-actions">
              <a href={`/${ownerName}/${repoName}/milestones/${ms.id}/edit`} class="btn">
                Edit
              </a>
              {ms.state === "open" ? (
                <form method="post" action={`/${ownerName}/${repoName}/milestones/${ms.id}/close`} style="display:inline">
                  <button type="submit" class="btn">Close milestone</button>
                </form>
              ) : (
                <form method="post" action={`/${ownerName}/${repoName}/milestones/${ms.id}`} style="display:inline">
                  <input type="hidden" name="_action" value="reopen" />
                  <button type="submit" class="btn">Reopen milestone</button>
                </form>
              )}
              <form
                method="post"
                action={`/${ownerName}/${repoName}/milestones/${ms.id}/delete`}
                style="display:inline"
                onsubmit="return confirm('Delete this milestone?')"
              >
                <button type="submit" class="btn btn-danger">Delete</button>
              </form>
            </div>
          )}
        </div>

        {/* Issues */}
        {msIssues.length > 0 && (
          <div class="ms-items-section">
            <h2 class="ms-items-header">Issues ({msIssues.length})</h2>
            <ul class="ms-items-list">
              {msIssues.map(({ issue, author }) => (
                <li class="ms-item-row">
                  <span class={`ms-item-icon ${issue.state === "open" ? "is-open" : "is-closed"}`} aria-hidden="true">
                    {issue.state === "open" ? "○" : "✓"}
                  </span>
                  <div class="ms-item-main">
                    <a
                      href={`/${ownerName}/${repoName}/issues/${issue.number}`}
                      class="ms-item-title"
                    >
                      {issue.title}
                    </a>
                    <div class="ms-item-meta">
                      #{issue.number} opened by {author.username}
                    </div>
                  </div>
                  <span class="ms-item-kind">Issue</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Pull Requests */}
        {msPRs.length > 0 && (
          <div class="ms-items-section">
            <h2 class="ms-items-header">Pull Requests ({msPRs.length})</h2>
            <ul class="ms-items-list">
              {msPRs.map(({ pr, author }) => {
                const prState = pr.state === "merged" ? "merged" : pr.isDraft ? "draft" : pr.state;
                return (
                  <li class="ms-item-row">
                    <span class={`ms-item-icon is-${prState}`} aria-hidden="true">
                      {prState === "merged" ? "✔" : prState === "closed" ? "×" : "○"}
                    </span>
                    <div class="ms-item-main">
                      <a
                        href={`/${ownerName}/${repoName}/pulls/${pr.number}`}
                        class="ms-item-title"
                      >
                        {pr.title}
                      </a>
                      <div class="ms-item-meta">
                        #{pr.number} by {author.username}
                        {pr.isDraft ? " · Draft" : ""}
                      </div>
                    </div>
                    <span class="ms-item-kind">PR</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {total === 0 && (
          <div class="ms-empty" style="margin-top:24px">
            <h2 class="ms-empty-title">No issues or pull requests yet</h2>
            <p class="ms-empty-sub">
              Assign issues or pull requests to this milestone from their respective pages.
            </p>
            <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
              <a href={`/${ownerName}/${repoName}/issues`} class="btn">View issues</a>
              <a href={`/${ownerName}/${repoName}/pulls`} class="btn">View pull requests</a>
            </div>
          </div>
        )}
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// GET /:owner/:repo/milestones/:milestoneId/edit — edit form
// ---------------------------------------------------------------------------
milestonesRoutes.get(
  "/:owner/:repo/milestones/:milestoneId/edit",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName, milestoneId } = c.req.param();
    const user = c.get("user")!;
    const error = c.req.query("error");

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [ms] = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.id, milestoneId), eq(milestones.repositoryId, resolved.repo.id)))
      .limit(1);

    if (!ms) {
      return c.redirect(`/${ownerName}/${repoName}/milestones`);
    }

    // Format date for the input[type=date] value (YYYY-MM-DD)
    const dueDateValue = ms.dueDate
      ? new Date(ms.dueDate).toISOString().split("T")[0]
      : "";

    return c.html(
      <Layout title={`Edit milestone — ${ownerName}/${repoName}`} user={user}>
        <MilestonesStyle />
        <RepoHeader owner={ownerName} repo={repoName} />
        <div class="ms-form-section" style="margin-top:24px">
          <div class="ms-form-card">
            <h1 class="ms-form-title">Edit milestone</h1>
            {error && (
              <div class="ms-alert ms-alert-error">{decodeURIComponent(error)}</div>
            )}
            <form method="post" action={`/${ownerName}/${repoName}/milestones/${ms.id}`}>
              <input type="hidden" name="_action" value="update" />
              <div class="ms-form-group">
                <label class="ms-form-label" for="ms-title">Title</label>
                <input
                  id="ms-title"
                  type="text"
                  name="title"
                  required
                  value={ms.title}
                  class="ms-form-input"
                  maxlength={255}
                />
              </div>
              <div class="ms-form-group">
                <label class="ms-form-label" for="ms-due">
                  Due date <span class="ms-form-optional">(optional)</span>
                </label>
                <input
                  id="ms-due"
                  type="date"
                  name="due_date"
                  value={dueDateValue}
                  class="ms-form-input"
                  style="max-width:220px"
                />
              </div>
              <div class="ms-form-group">
                <label class="ms-form-label" for="ms-desc">
                  Description <span class="ms-form-optional">(optional)</span>
                </label>
                <textarea
                  id="ms-desc"
                  name="description"
                  class="ms-form-input ms-form-textarea"
                  maxlength={2000}
                >
                  {ms.description || ""}
                </textarea>
              </div>
              <div class="ms-form-actions">
                <button type="submit" class="btn btn-primary">Save changes</button>
                <a href={`/${ownerName}/${repoName}/milestones/${ms.id}`} class="btn">Cancel</a>
              </div>
            </form>
          </div>
        </div>
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/milestones/:milestoneId — update or reopen
// ---------------------------------------------------------------------------
milestonesRoutes.post(
  "/:owner/:repo/milestones/:milestoneId",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName, milestoneId } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const action = String(body._action || "update");

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [ms] = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.id, milestoneId), eq(milestones.repositoryId, resolved.repo.id)))
      .limit(1);

    if (!ms) {
      return c.redirect(`/${ownerName}/${repoName}/milestones`);
    }

    if (action === "reopen") {
      await db
        .update(milestones)
        .set({ state: "open", closedAt: null })
        .where(eq(milestones.id, ms.id));
      return c.redirect(
        `/${ownerName}/${repoName}/milestones?success=${encodeURIComponent("Milestone reopened")}`
      );
    }

    // Default: update fields
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim() || null;
    const dueDateRaw = String(body.due_date || "").trim();
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;

    if (!title) {
      return c.redirect(
        `/${ownerName}/${repoName}/milestones/${milestoneId}/edit?error=${encodeURIComponent("Title is required")}`
      );
    }

    await db
      .update(milestones)
      .set({ title, description, dueDate: dueDate ?? undefined })
      .where(eq(milestones.id, ms.id));

    return c.redirect(
      `/${ownerName}/${repoName}/milestones/${ms.id}?success=${encodeURIComponent("Milestone updated")}`
    );
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/milestones/:milestoneId/close
// ---------------------------------------------------------------------------
milestonesRoutes.post(
  "/:owner/:repo/milestones/:milestoneId/close",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName, milestoneId } = c.req.param();

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db
      .update(milestones)
      .set({ state: "closed", closedAt: new Date() })
      .where(and(eq(milestones.id, milestoneId), eq(milestones.repositoryId, resolved.repo.id)));

    return c.redirect(
      `/${ownerName}/${repoName}/milestones?success=${encodeURIComponent("Milestone closed")}`
    );
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/milestones/:milestoneId/delete — owner only
// ---------------------------------------------------------------------------
milestonesRoutes.post(
  "/:owner/:repo/milestones/:milestoneId/delete",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName, milestoneId } = c.req.param();
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    // Only repo owner can delete milestones
    if (user.id !== resolved.owner.id && !user.isAdmin) {
      return c.redirect(`/${ownerName}/${repoName}/milestones`);
    }

    await db
      .delete(milestones)
      .where(and(eq(milestones.id, milestoneId), eq(milestones.repositoryId, resolved.repo.id)));

    return c.redirect(
      `/${ownerName}/${repoName}/milestones?success=${encodeURIComponent("Milestone deleted")}`
    );
  }
);

export default milestonesRoutes;

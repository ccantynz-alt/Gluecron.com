/**
 * Block E1 — Projects / Kanban boards scoped to a repo.
 *
 * Each project has ordered columns ("To Do" / "In Progress" / "Done" by
 * default) and items (notes or linked issues/PRs). Items belong to exactly
 * one column at a time. Simple v1: positions are recomputed via "max+1".
 *
 * Never throws — all DB paths wrapped in try/catch.
 *
 * 2026 polish: scoped `.proj-*` class system mirrors `collaborators.tsx` —
 * eyebrow + display headline, polished project cards with tabular-nums for
 * counts, state pills, and a kanban board with hairline-gradient columns.
 */

import { Hono } from "hono";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import {
  projects,
  projectColumns,
  projectItems,
  repositories,
  users,
  issues,
  pullRequests,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const DEFAULT_COLUMNS = ["To Do", "In Progress", "Done"] as const;

const projectRoutes = new Hono<AuthEnv>();

// ─── Scoped CSS (.proj-*) ───────────────────────────────────────────────────
const projStyles = `
  .proj-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .proj-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .proj-head-text { flex: 1; min-width: 280px; }
  .proj-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .proj-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .proj-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .proj-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .proj-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 640px;
  }

  /* Buttons */
  .proj-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    white-space: nowrap;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .proj-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .proj-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .proj-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .proj-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .proj-btn-mini {
    padding: 4px 10px;
    font-size: 11.5px;
    border-radius: 8px;
  }

  /* Crumbs */
  .proj-crumbs {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
    font-size: 12.5px;
  }
  .proj-crumbs a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 11px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 500;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .proj-crumbs a:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* Project list cards */
  .proj-list { display: flex; flex-direction: column; gap: 10px; }
  .proj-card {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .proj-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .proj-num {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .proj-card-body { flex: 1; min-width: 0; }
  .proj-card-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .proj-card-title a {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 15.5px;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
  }
  .proj-card-title a:hover { text-decoration: underline; }
  .proj-card-desc {
    margin-top: 3px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .proj-card-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .proj-card-meta .sep { opacity: 0.4; }

  /* Pills */
  .proj-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: capitalize;
  }
  .proj-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .proj-pill.is-open {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .proj-pill.is-closed {
    background: rgba(148,163,184,0.16);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }
  .proj-pill.is-count {
    background: rgba(140,109,255,0.12);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  /* Form card */
  .proj-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5);
    max-width: 640px;
    position: relative;
    overflow: hidden;
  }
  .proj-form-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
  }
  .proj-field { margin-bottom: 14px; }
  .proj-field-label {
    display: block;
    font-size: 11.5px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .proj-input, .proj-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 12px;
    font: inherit;
    font-size: 13.5px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .proj-textarea { font-family: inherit; resize: vertical; line-height: 1.5; }
  .proj-input:focus, .proj-textarea:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* Board view */
  .proj-board-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .proj-board-desc {
    margin: 6px 0 0;
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.5;
  }

  .proj-kanban {
    display: flex;
    gap: 14px;
    overflow-x: auto;
    padding-bottom: 12px;
    scrollbar-width: thin;
  }
  .proj-kcol {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    min-width: 280px;
    max-width: 280px;
    flex-shrink: 0;
    padding: 12px;
    position: relative;
    overflow: hidden;
  }
  .proj-kcol::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.5;
    pointer-events: none;
  }
  .proj-kcol-new {
    background: transparent;
    border-style: dashed;
  }
  .proj-kcol-new::before { display: none; }
  .proj-kcol-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 2px 4px 12px;
  }
  .proj-kcol-name {
    font-family: var(--font-display);
    font-size: 13.5px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .proj-kcard {
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
    font-size: 13px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .proj-kcard:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.05);
  }
  .proj-kcard-title {
    font-weight: 600;
    color: var(--text-strong);
    line-height: 1.35;
  }
  .proj-kcard-link {
    color: var(--text-strong);
    text-decoration: none;
  }
  .proj-kcard-link:hover { text-decoration: underline; color: var(--accent); }
  .proj-kcard-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    flex-wrap: wrap;
  }
  .proj-kcard-num {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .proj-kcard-state {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: capitalize;
  }
  .proj-kcard-state.is-open { background: rgba(52,211,153,0.14); color: #6ee7b7; }
  .proj-kcard-state.is-closed { background: rgba(148,163,184,0.16); color: #94a3b8; }
  .proj-kcard-state.is-merged { background: rgba(167,139,250,0.14); color: #c4b5fd; }
  .proj-kcard-state.is-draft { background: rgba(148,163,184,0.12); color: #94a3b8; }
  .proj-kcard-note {
    margin-top: 4px;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.45;
  }
  .proj-kcard-actions {
    margin-top: 8px;
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    align-items: center;
  }
  .proj-kcard-actions form { margin: 0; display: inline-flex; align-items: center; gap: 4px; }
  .proj-kcard-select {
    font: inherit;
    font-size: 11.5px;
    padding: 3px 6px;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
  }
  .proj-kcard-select:focus { outline: none; border-color: rgba(140,109,255,0.55); }

  .proj-kadd-details summary::-webkit-details-marker { display: none; }
  .proj-kadd-panel {
    margin-top: 8px;
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .proj-kadd-sep {
    border: none;
    border-top: 1px solid var(--border);
    margin: 2px 0;
  }
  .proj-kadd { display: flex; flex-direction: column; gap: 6px; }
  .proj-kadd input {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 10px;
    font: inherit;
    font-size: 12.5px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .proj-kadd input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* Empty */
  .proj-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(32px, 6vw, 56px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .proj-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .proj-empty-inner { position: relative; z-index: 1; }
  .proj-empty-icon {
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
    margin-bottom: 14px;
  }
  .proj-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .proj-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 420px;
    line-height: 1.5;
  }
`;

function IconBoard() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="11" rx="1" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

async function resolveRepo(ownerName: string, repoName: string) {
  try {
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
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function notFound(user: any, label = "Not found") {
  return (
    <Layout title={label} user={user}>
      <div class="proj-wrap">
        <div class="proj-empty">
          <div class="proj-empty-orb" aria-hidden="true" />
          <div class="proj-empty-inner">
            <h2 class="proj-empty-title">{label}</h2>
          </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: projStyles }} />
    </Layout>
  );
}

// List
projectRoutes.get("/:owner/:repo/projects", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  const { repo } = resolved;

  let rows: any[] = [];
  try {
    rows = await db
      .select({
        p: projects,
        columnCount: sql<number>`(SELECT count(*) FROM project_columns WHERE project_id = ${projects.id})`,
        itemCount: sql<number>`(SELECT count(*) FROM project_items WHERE project_id = ${projects.id})`,
      })
      .from(projects)
      .where(eq(projects.repositoryId, repo.id))
      .orderBy(desc(projects.updatedAt));
  } catch {
    rows = [];
  }

  return c.html(
    <Layout title={`Projects — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div class="proj-wrap">
        <header class="proj-head">
          <div class="proj-head-text">
            <div class="proj-eyebrow">
              <span class="proj-eyebrow-dot" aria-hidden="true" />
              Repository · Projects
            </div>
            <h1 class="proj-title">
              <span class="proj-title-grad">Plan the work.</span>
            </h1>
            <p class="proj-sub">
              Lightweight kanban boards scoped to {ownerName}/{repoName}. Each
              board owns its own columns and cards.
            </p>
          </div>
          {user && (
            <a
              href={`/${ownerName}/${repoName}/projects/new`}
              class="proj-btn proj-btn-primary"
            >
              <IconPlus />
              New project
            </a>
          )}
        </header>

        {rows.length === 0 ? (
          <div class="proj-empty">
            <div class="proj-empty-orb" aria-hidden="true" />
            <div class="proj-empty-inner">
              <div class="proj-empty-icon" aria-hidden="true">
                <IconBoard />
              </div>
              <h3 class="proj-empty-title">Start your first project</h3>
              <p class="proj-empty-sub">
                Boards are perfect for grouping work — sprints, OKRs, release
                trains. We seed the default <code>To Do</code> /{" "}
                <code>In Progress</code> / <code>Done</code> columns for you.
              </p>
              {user && (
                <a
                  href={`/${ownerName}/${repoName}/projects/new`}
                  class="proj-btn proj-btn-primary"
                >
                  <IconPlus />
                  New project
                </a>
              )}
            </div>
          </div>
        ) : (
          <div class="proj-list">
            {rows.map((r) => (
              <div class="proj-card">
                <div class="proj-num">#{r.p.number}</div>
                <div class="proj-card-body">
                  <div class="proj-card-title">
                    <a href={`/${ownerName}/${repoName}/projects/${r.p.number}`}>
                      {r.p.title}
                    </a>
                    {r.p.state === "closed" ? (
                      <span class="proj-pill is-closed">
                        <span class="dot" aria-hidden="true" />
                        Closed
                      </span>
                    ) : (
                      <span class="proj-pill is-open">
                        <span class="dot" aria-hidden="true" />
                        Open
                      </span>
                    )}
                  </div>
                  {r.p.description && (
                    <div class="proj-card-desc">{r.p.description}</div>
                  )}
                </div>
                <div class="proj-card-meta">
                  <span class="proj-pill is-count">{r.columnCount} cols</span>
                  <span class="sep">·</span>
                  <span class="proj-pill is-count">{r.itemCount} items</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: projStyles }} />
    </Layout>
  );
});

// New form
projectRoutes.get(
  "/:owner/:repo/projects/new",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
    return c.html(
      <Layout title="New project" user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <div class="proj-wrap">
          <div class="proj-crumbs">
            <a href={`/${ownerName}/${repoName}/projects`}>
              <IconArrowLeft />
              All projects
            </a>
          </div>
          <header class="proj-head">
            <div class="proj-head-text">
              <div class="proj-eyebrow">
                <span class="proj-eyebrow-dot" aria-hidden="true" />
                Projects · New
              </div>
              <h1 class="proj-title">
                <span class="proj-title-grad">Create a board.</span>
              </h1>
              <p class="proj-sub">
                Name your project — we seed default kanban columns you can
                rename later.
              </p>
            </div>
          </header>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/projects`}
            class="proj-form-card"
          >
            <div class="proj-field">
              <label class="proj-field-label" for="proj-title">Title</label>
              <input
                class="proj-input"
                type="text"
                id="proj-title"
                name="title"
                placeholder="Sprint 24 — Q3 release"
                required
                aria-label="Project title"
              />
            </div>
            <div class="proj-field">
              <label class="proj-field-label" for="proj-desc">Description</label>
              <textarea
                class="proj-textarea"
                id="proj-desc"
                name="description"
                rows={4}
                placeholder="What is this board for? (optional)"
              ></textarea>
            </div>
            <button type="submit" class="proj-btn proj-btn-primary">
              <IconPlus />
              Create project
            </button>
          </form>
        </div>
        <style dangerouslySetInnerHTML={{ __html: projStyles }} />
      </Layout>
    );
  }
);

// Create
projectRoutes.post(
  "/:owner/:repo/projects",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const form = await c.req.formData();
    const title = (form.get("title") as string || "").trim();
    const description = (form.get("description") as string || "").trim();

    if (!title) {
      return c.redirect(`/${ownerName}/${repoName}/projects/new`);
    }

    try {
      const [row] = await db
        .insert(projects)
        .values({
          repositoryId: resolved.repo.id,
          ownerId: user.id,
          title,
          description,
        })
        .returning({ id: projects.id, number: projects.number });
      // Seed default columns
      await db.insert(projectColumns).values(
        DEFAULT_COLUMNS.map((name, i) => ({
          projectId: row.id,
          name,
          position: i,
        }))
      );
      return c.redirect(`/${ownerName}/${repoName}/projects/${row.number}`);
    } catch {
      return c.redirect(`/${ownerName}/${repoName}/projects`);
    }
  }
);

// Board view
projectRoutes.get(
  "/:owner/:repo/projects/:number",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let project: any = null;
    let columns: any[] = [];
    let items: any[] = [];
    // Maps itemId → { number, title, state } for linked issues/PRs
    const linkedIssueMap: Record<string, { number: number; title: string; state: string; isDraft?: boolean }> = {};
    const linkedPrMap: Record<string, { number: number; title: string; state: string; isDraft?: boolean }> = {};

    try {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.repositoryId, resolved.repo.id),
            eq(projects.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        project = row;
        columns = await db
          .select()
          .from(projectColumns)
          .where(eq(projectColumns.projectId, row.id))
          .orderBy(asc(projectColumns.position), asc(projectColumns.createdAt));
        items = await db
          .select()
          .from(projectItems)
          .where(eq(projectItems.projectId, row.id))
          .orderBy(asc(projectItems.position));

        // Gather itemIds for linked issues / PRs so we can fetch their details.
        const issueItemIds = items
          .filter((it) => it.itemType === "issue" && it.itemId)
          .map((it) => it.itemId as string);
        const prItemIds = items
          .filter((it) => it.itemType === "pr" && it.itemId)
          .map((it) => it.itemId as string);

        if (issueItemIds.length > 0) {
          const issueRows = await db
            .select({ id: issues.id, number: issues.number, title: issues.title, state: issues.state })
            .from(issues)
            .where(eq(issues.repositoryId, resolved.repo.id));
          for (const ir of issueRows) {
            if (issueItemIds.includes(ir.id)) {
              linkedIssueMap[ir.id] = { number: ir.number, title: ir.title, state: ir.state };
            }
          }
        }
        if (prItemIds.length > 0) {
          const prRows = await db
            .select({ id: pullRequests.id, number: pullRequests.number, title: pullRequests.title, state: pullRequests.state, isDraft: pullRequests.isDraft })
            .from(pullRequests)
            .where(eq(pullRequests.repositoryId, resolved.repo.id));
          for (const pr of prRows) {
            if (prItemIds.includes(pr.id)) {
              linkedPrMap[pr.id] = { number: pr.number, title: pr.title, state: pr.state, isDraft: pr.isDraft };
            }
          }
        }
      }
    } catch {
      // leave nulls
    }

    if (!project) return c.html(notFound(user, "Project not found"), 404);

    const itemsByCol: Record<string, any[]> = {};
    for (const col of columns) itemsByCol[col.id] = [];
    for (const it of items) {
      if (itemsByCol[it.columnId]) itemsByCol[it.columnId].push(it);
    }

    return c.html(
      <Layout
        title={`${project.title} — project #${project.number}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <div class="proj-wrap">
          <div class="proj-crumbs">
            <a href={`/${ownerName}/${repoName}/projects`}>
              <IconArrowLeft />
              All projects
            </a>
          </div>
          <div class="proj-board-head">
            <div>
              <div class="proj-eyebrow">
                <span class="proj-eyebrow-dot" aria-hidden="true" />
                Project · #{project.number}
              </div>
              <h1 class="proj-title">
                <span class="proj-title-grad">{project.title}</span>
                {project.state === "closed" && (
                  <span class="proj-pill is-closed" style="margin-left:12px;vertical-align:middle">
                    <span class="dot" aria-hidden="true" />
                    Closed
                  </span>
                )}
              </h1>
              {project.description && (
                <p class="proj-board-desc">{project.description}</p>
              )}
            </div>
            {user && (
              <form
                method="post"
                action={`/${ownerName}/${repoName}/projects/${project.number}/close`}
              >
                <button type="submit" class="proj-btn proj-btn-ghost">
                  {project.state === "open" ? "Close" : "Reopen"}
                </button>
              </form>
            )}
          </div>
          <div class="proj-kanban">
            {columns.map((col) => (
              <div class="proj-kcol">
                <div class="proj-kcol-head">
                  <span class="proj-kcol-name">{col.name}</span>
                  <span class="proj-pill is-count">
                    {(itemsByCol[col.id] || []).length}
                  </span>
                </div>
                {(itemsByCol[col.id] || []).map((it) => {
                  // Resolve linked issue/PR metadata for richer card display.
                  const linkedIssue = it.itemType === "issue" && it.itemId
                    ? linkedIssueMap[it.itemId]
                    : null;
                  const linkedPr = it.itemType === "pr" && it.itemId
                    ? linkedPrMap[it.itemId]
                    : null;
                  const cardTitle = linkedIssue?.title || linkedPr?.title || it.title || "(untitled)";
                  const cardNumber = linkedIssue?.number ?? linkedPr?.number ?? null;
                  const cardState = linkedIssue?.state ?? (linkedPr?.isDraft ? "draft" : linkedPr?.state) ?? null;
                  const cardHref = linkedIssue
                    ? `/${ownerName}/${repoName}/issues/${linkedIssue.number}`
                    : linkedPr
                    ? `/${ownerName}/${repoName}/pulls/${linkedPr.number}`
                    : null;

                  return (
                    <div class="proj-kcard">
                      <div class="proj-kcard-title">
                        {cardHref ? (
                          <a href={cardHref} class="proj-kcard-link">{cardTitle}</a>
                        ) : (
                          cardTitle
                        )}
                      </div>
                      {(cardNumber !== null || cardState) && (
                        <div class="proj-kcard-meta">
                          {cardNumber !== null && (
                            <span class="proj-kcard-num">#{cardNumber}</span>
                          )}
                          {cardState && (
                            <span class={`proj-kcard-state is-${cardState}`}>
                              {cardState}
                            </span>
                          )}
                        </div>
                      )}
                      {it.note && (
                        <div class="proj-kcard-note">{it.note}</div>
                      )}
                      {user && (
                        <div class="proj-kcard-actions">
                          {columns.length > 1 && (
                            <form
                              method="post"
                              action={`/${ownerName}/${repoName}/projects/${project.number}/items/${it.id}/move`}
                              style="display:inline-flex;align-items:center;gap:4px"
                            >
                              <select
                                name="column_id"
                                class="proj-kcard-select"
                                aria-label="Move to column"
                              >
                                {columns
                                  .filter((oc) => oc.id !== col.id)
                                  .map((oc) => (
                                    <option value={oc.id}>{oc.name}</option>
                                  ))}
                              </select>
                              <button
                                type="submit"
                                class="proj-btn proj-btn-ghost proj-btn-mini"
                              >
                                Move
                              </button>
                            </form>
                          )}
                          <form
                            method="post"
                            action={`/${ownerName}/${repoName}/projects/${project.number}/items/${it.id}/delete`}
                          >
                            <button
                              type="submit"
                              class="proj-btn proj-btn-ghost proj-btn-mini"
                              aria-label="Delete item"
                            >
                              ×
                            </button>
                          </form>
                        </div>
                      )}
                    </div>
                  );
                })}
                {user && (
                  <details class="proj-kadd-details">
                    <summary class="proj-btn proj-btn-ghost proj-btn-mini" style="cursor:pointer;list-style:none;margin-top:8px">
                      <IconPlus />
                      Add card
                    </summary>
                    <div class="proj-kadd-panel">
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/projects/${project.number}/items`}
                        class="proj-kadd"
                      >
                        <input type="hidden" name="column_id" value={col.id} />
                        <input type="hidden" name="item_type" value="note" />
                        <input
                          type="text"
                          name="title"
                          placeholder="Note title"
                          required
                          aria-label="Note title"
                        />
                        <button
                          type="submit"
                          class="proj-btn proj-btn-ghost proj-btn-mini"
                        >
                          Add note
                        </button>
                      </form>
                      <hr class="proj-kadd-sep" />
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/projects/${project.number}/items`}
                        class="proj-kadd"
                      >
                        <input type="hidden" name="column_id" value={col.id} />
                        <input type="hidden" name="item_type" value="issue" />
                        <input
                          type="number"
                          name="issue_number"
                          placeholder="Issue # (e.g. 42)"
                          min="1"
                          aria-label="Issue number"
                        />
                        <button
                          type="submit"
                          class="proj-btn proj-btn-ghost proj-btn-mini"
                        >
                          Link issue
                        </button>
                      </form>
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/projects/${project.number}/items`}
                        class="proj-kadd"
                      >
                        <input type="hidden" name="column_id" value={col.id} />
                        <input type="hidden" name="item_type" value="pr" />
                        <input
                          type="number"
                          name="pr_number"
                          placeholder="PR # (e.g. 7)"
                          min="1"
                          aria-label="Pull request number"
                        />
                        <button
                          type="submit"
                          class="proj-btn proj-btn-ghost proj-btn-mini"
                        >
                          Link PR
                        </button>
                      </form>
                    </div>
                  </details>
                )}
              </div>
            ))}
            {user && (
              <div class="proj-kcol proj-kcol-new">
                <form
                  method="post"
                  action={`/${ownerName}/${repoName}/projects/${project.number}/columns`}
                  class="proj-kadd"
                >
                  <input
                    type="text"
                    name="name"
                    placeholder="New column"
                    required
                    aria-label="New column name"
                  />
                  <button type="submit" class="proj-btn proj-btn-ghost proj-btn-mini">
                    <IconPlus />
                    Add column
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: projStyles }} />
      </Layout>
    );
  }
);

// Add column
projectRoutes.post(
  "/:owner/:repo/projects/:number/columns",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/projects`);

    const form = await c.req.formData();
    const name = (form.get("name") as string || "").trim();
    if (!name) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }

    try {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.repositoryId, resolved.repo.id),
            eq(projects.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        const [maxPos] = await db
          .select({ p: sql<number>`coalesce(max(${projectColumns.position}), -1)` })
          .from(projectColumns)
          .where(eq(projectColumns.projectId, row.id));
        await db.insert(projectColumns).values({
          projectId: row.id,
          name,
          position: Number(maxPos?.p || -1) + 1,
        });
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

// Add item (note, linked issue, or linked PR)
projectRoutes.post(
  "/:owner/:repo/projects/:number/items",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/projects`);

    const form = await c.req.formData();
    const columnId = (form.get("column_id") as string || "").trim();
    const itemType = (form.get("item_type") as string || "note").trim();
    const title = (form.get("title") as string || "").trim();
    const note = (form.get("note") as string || "").trim();
    const issueNumberRaw = parseInt(form.get("issue_number") as string || "", 10);
    const prNumberRaw = parseInt(form.get("pr_number") as string || "", 10);

    if (!columnId) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }

    // For notes, title is required. For issue/pr links, we look up by number.
    if (itemType === "note" && !title) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }
    if (itemType === "issue" && isNaN(issueNumberRaw)) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }
    if (itemType === "pr" && isNaN(prNumberRaw)) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }

    try {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.repositoryId, resolved.repo.id),
            eq(projects.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        const [maxPos] = await db
          .select({ p: sql<number>`coalesce(max(${projectItems.position}), -1)` })
          .from(projectItems)
          .where(eq(projectItems.columnId, columnId));
        const position = Number(maxPos?.p || -1) + 1;

        if (itemType === "issue" && !isNaN(issueNumberRaw)) {
          // Look up the issue by number in this repo
          const [issueRow] = await db
            .select({ id: issues.id, title: issues.title })
            .from(issues)
            .where(
              and(
                eq(issues.repositoryId, resolved.repo.id),
                eq(issues.number, issueNumberRaw)
              )
            )
            .limit(1);
          if (issueRow) {
            await db.insert(projectItems).values({
              projectId: row.id,
              columnId,
              itemType: "issue",
              itemId: issueRow.id,
              title: issueRow.title,
              position,
            });
          }
        } else if (itemType === "pr" && !isNaN(prNumberRaw)) {
          // Look up the PR by number in this repo
          const [prRow] = await db
            .select({ id: pullRequests.id, title: pullRequests.title })
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, resolved.repo.id),
                eq(pullRequests.number, prNumberRaw)
              )
            )
            .limit(1);
          if (prRow) {
            await db.insert(projectItems).values({
              projectId: row.id,
              columnId,
              itemType: "pr",
              itemId: prRow.id,
              title: prRow.title,
              position,
            });
          }
        } else {
          // Freeform note
          await db.insert(projectItems).values({
            projectId: row.id,
            columnId,
            itemType: "note",
            title,
            note,
            position,
          });
        }
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

// Move item
projectRoutes.post(
  "/:owner/:repo/projects/:number/items/:itemId/move",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, itemId } = c.req.param();
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/projects`);

    const form = await c.req.formData();
    const columnId = (form.get("column_id") as string || "").trim();
    if (!columnId) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }

    try {
      const [maxPos] = await db
        .select({ p: sql<number>`coalesce(max(${projectItems.position}), -1)` })
        .from(projectItems)
        .where(eq(projectItems.columnId, columnId));
      await db
        .update(projectItems)
        .set({
          columnId,
          position: Number(maxPos?.p || -1) + 1,
          updatedAt: new Date(),
        })
        .where(eq(projectItems.id, itemId));
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

// Delete item
projectRoutes.post(
  "/:owner/:repo/projects/:number/items/:itemId/delete",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, itemId } = c.req.param();
    const numParam = Number(c.req.param("number"));
    try {
      await db.delete(projectItems).where(eq(projectItems.id, itemId));
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

// Toggle close
projectRoutes.post(
  "/:owner/:repo/projects/:number/close",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/projects`);

    try {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.repositoryId, resolved.repo.id),
            eq(projects.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        await db
          .update(projects)
          .set({
            state: row.state === "open" ? "closed" : "open",
            updatedAt: new Date(),
          })
          .where(eq(projects.id, row.id));
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

export default projectRoutes;

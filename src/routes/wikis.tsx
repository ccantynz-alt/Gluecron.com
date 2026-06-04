/**
 * Block E3 — Wikis: per-repo markdown page collection with revision history.
 *
 * v1 is DB-backed (no git bare repo). Each wiki_pages row holds the current
 * title+body+revision counter; every edit appends a wiki_revisions row for
 * history/diff/revert.
 *
 * 2026 polish:
 *   - Scoped `.wiki-*` CSS (no bleed into RepoHeader).
 *   - Eyebrow + display headline + subtitle below the repo header.
 *   - Sidebar polished as page cards w/ last-edited and edit affordance.
 *   - New / Edit forms get the focus-ring + gradient submit treatment.
 *   - Dashed empty state with orb + CTA when there are no pages.
 *
 * Never throws. Every route + form action + POST handler is preserved.
 */

import { Hono } from "hono";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db";
import {
  wikiPages,
  wikiRevisions,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { renderMarkdown } from "../lib/markdown";
import { formatRelative } from "../views/ui";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

/** lowercase-alphanumerics joined by single dashes, trimmed. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const wikiRoutes = new Hono<AuthEnv>();

// ─── Scoped CSS (.wiki-*) ────────────────────────────────────────────────
const wikiStyles = `
  .wiki-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .wiki-head {
    margin-bottom: var(--space-5);
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .wiki-head-text { flex: 1; min-width: 280px; }
  .wiki-eyebrow {
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
  .wiki-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .wiki-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3.2vw, 34px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .wiki-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .wiki-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 720px;
  }

  .wiki-btn {
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
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .wiki-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .wiki-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .wiki-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .wiki-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .wiki-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
  }
  .wiki-btn-danger:hover {
    border-style: dashed;
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
    text-decoration: none;
  }

  /* ─── Layout ─── */
  .wiki-grid {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: var(--space-5);
    align-items: start;
  }
  @media (max-width: 820px) {
    .wiki-grid { grid-template-columns: 1fr; }
  }

  /* ─── Sidebar ─── */
  .wiki-side {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-3);
    overflow: hidden;
  }
  .wiki-side::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1.5px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 50%, #36c5d6 100%);
    opacity: 0.40;
    pointer-events: none;
  }
  .wiki-side-title {
    font-family: var(--font-display);
    font-size: 12.5px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 6px 8px 10px;
  }
  .wiki-side-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .wiki-side-link {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    color: var(--text);
    text-decoration: none;
    font-size: 13px;
    transition: background 120ms ease, color 120ms ease;
  }
  .wiki-side-link::before {
    content: '';
    width: 5px; height: 5px;
    border-radius: 9999px;
    background: var(--text-muted);
    opacity: 0.5;
    flex-shrink: 0;
  }
  .wiki-side-link:hover {
    background: rgba(140,109,255,0.08);
    color: var(--text-strong);
    text-decoration: none;
  }
  .wiki-side-empty {
    padding: 12px;
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }
  .wiki-side-foot {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--border-strong);
  }
  .wiki-side-foot .wiki-btn { width: 100%; }

  /* ─── Main content ─── */
  .wiki-main { min-width: 0; }
  .wiki-page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .wiki-page-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 32px);
    font-weight: 800;
    letter-spacing: -0.024em;
    color: var(--text-strong);
    margin: 0;
  }
  .wiki-page-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .wiki-page-body {
    font-size: 15px;
    line-height: 1.65;
    color: var(--text);
  }

  /* ─── Pages index list (card layout) ─── */
  .wiki-list { display: flex; flex-direction: column; gap: 8px; }
  .wiki-list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 12px 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 10px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .wiki-list-row:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .wiki-list-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14.5px;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.008em;
  }
  .wiki-list-name:hover { text-decoration: underline; }
  .wiki-list-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .wiki-rev-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(148,163,184,0.12);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.28);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 600;
  }

  /* ─── Editor (new / edit form) ─── */
  .wiki-editor {
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    position: relative;
    overflow: hidden;
  }
  .wiki-editor::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1.5px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 50%, #36c5d6 100%);
    opacity: 0.45;
    pointer-events: none;
  }
  .wiki-field-label {
    display: block;
    font-size: 11.5px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .wiki-input,
  .wiki-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    font: inherit;
    font-size: 13.5px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
    outline: none;
  }
  .wiki-input:focus,
  .wiki-textarea:focus {
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .wiki-textarea {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
    resize: vertical;
    min-height: 280px;
  }
  .wiki-editor-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .wiki-editor-hint {
    margin-right: auto;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* ─── Empty state ─── */
  .wiki-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 52px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .wiki-empty-orb {
    position: absolute;
    inset: -40% 25% auto 25%;
    height: 300px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(72px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .wiki-empty-inner { position: relative; z-index: 1; }
  .wiki-empty-icon {
    width: 56px; height: 56px;
    margin: 0 auto 14px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
  }
  .wiki-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .wiki-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 440px;
    line-height: 1.5;
  }

  /* ─── History list ─── */
  .wiki-hist { display: flex; flex-direction: column; gap: 8px; }
  .wiki-hist-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 12px 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .wiki-hist-row:hover { border-color: var(--border-strong); background: rgba(255,255,255,0.03); }
  .wiki-hist-name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    text-decoration: none;
  }
  .wiki-hist-name:hover { text-decoration: underline; }
  .wiki-hist-msg {
    margin-left: 8px;
    color: var(--text-muted);
    font-size: 12.5px;
  }
  .wiki-hist-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }
`;

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

function notFound(user: any, label = "Page not found") {
  return (
    <Layout title={label} user={user}>
      <div class="empty-state">
        <h2>{label}</h2>
      </div>
    </Layout>
  );
}

function IconBook() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function WikiSidebar(props: {
  ownerName: string;
  repoName: string;
  pages: { slug: string; title: string }[];
  user: any;
}) {
  const { ownerName, repoName, pages, user } = props;
  return (
    <aside class="wiki-side">
      <div class="wiki-side-title">Pages</div>
      {pages.length === 0 ? (
        <div class="wiki-side-empty">No pages yet.</div>
      ) : (
        <ul class="wiki-side-list">
          {pages.map((p) => (
            <li>
              <a
                href={`/${ownerName}/${repoName}/wiki/${p.slug}`}
                class="wiki-side-link"
              >
                {p.title}
              </a>
            </li>
          ))}
        </ul>
      )}
      {user && (
        <div class="wiki-side-foot">
          <a
            href={`/${ownerName}/${repoName}/wiki/new`}
            class="wiki-btn wiki-btn-primary"
          >
            <IconPlus />
            New page
          </a>
        </div>
      )}
    </aside>
  );
}

async function listPages(repoId: string) {
  try {
    return await db
      .select({ slug: wikiPages.slug, title: wikiPages.title })
      .from(wikiPages)
      .where(eq(wikiPages.repositoryId, repoId))
      .orderBy(wikiPages.title);
  } catch {
    return [];
  }
}

// Root — render "home" page if exists, else CTA
wikiRoutes.get("/:owner/:repo/wiki", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  const pages = await listPages(resolved.repo.id);

  let home: any = null;
  try {
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.repositoryId, resolved.repo.id),
          eq(wikiPages.slug, "home")
        )
      )
      .limit(1);
    if (row) home = row;
  } catch {
    // leave null
  }

  return c.html(
    <Layout title={`Wiki — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div class="wiki-wrap">
        <header class="wiki-head">
          <div class="wiki-head-text">
            <div class="wiki-eyebrow">
              <span class="wiki-eyebrow-dot" aria-hidden="true" />
              Repository · Wiki
            </div>
            <h1 class="wiki-title">
              <span class="wiki-title-grad">
                {home ? home.title : "Wiki home."}
              </span>
            </h1>
            <p class="wiki-sub">
              Markdown pages with full revision history. Anyone can read;
              signed-in users can edit when allowed by the owner.
            </p>
          </div>
          {user && (
            <a
              href={`/${ownerName}/${repoName}/wiki/new`}
              class="wiki-btn wiki-btn-primary"
            >
              <IconPlus />
              New page
            </a>
          )}
        </header>

        <div class="wiki-grid">
          <WikiSidebar
            ownerName={ownerName}
            repoName={repoName}
            pages={pages}
            user={user}
          />
          <main class="wiki-main">
            {home ? (
              <article
                class="wiki-page-body"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(home.body || ""),
                }}
              />
            ) : (
              <div class="wiki-empty">
                <div class="wiki-empty-orb" aria-hidden="true" />
                <div class="wiki-empty-inner">
                  <div class="wiki-empty-icon" aria-hidden="true">
                    <IconBook />
                  </div>
                  <h3 class="wiki-empty-title">No wiki yet</h3>
                  <p class="wiki-empty-sub">
                    Spin up a Home page to give visitors a tour of the
                    repository, its conventions, or its philosophy.
                  </p>
                  {user ? (
                    <a
                      href={`/${ownerName}/${repoName}/wiki/new`}
                      class="wiki-btn wiki-btn-primary"
                    >
                      <IconPlus />
                      Create the Home page
                    </a>
                  ) : (
                    <p
                      style="margin:0;color:var(--text-muted);font-size:13px"
                    >
                      Sign in to start the wiki.
                    </p>
                  )}
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: wikiStyles }} />
    </Layout>
  );
});

// All pages index
wikiRoutes.get("/:owner/:repo/wiki/pages", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  let rows: any[] = [];
  try {
    rows = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.repositoryId, resolved.repo.id))
      .orderBy(wikiPages.title);
  } catch {
    rows = [];
  }
  return c.html(
    <Layout title={`Wiki pages — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div class="wiki-wrap">
        <header class="wiki-head">
          <div class="wiki-head-text">
            <div class="wiki-eyebrow">
              <span class="wiki-eyebrow-dot" aria-hidden="true" />
              Repository · Wiki · All pages
            </div>
            <h1 class="wiki-title">
              <span class="wiki-title-grad">Every page in the wiki.</span>
            </h1>
            <p class="wiki-sub">
              Alphabetical index of pages with current revision counters.
            </p>
          </div>
          {user && (
            <a
              href={`/${ownerName}/${repoName}/wiki/new`}
              class="wiki-btn wiki-btn-primary"
            >
              <IconPlus />
              New page
            </a>
          )}
        </header>

        {rows.length === 0 ? (
          <div class="wiki-empty">
            <div class="wiki-empty-orb" aria-hidden="true" />
            <div class="wiki-empty-inner">
              <div class="wiki-empty-icon" aria-hidden="true">
                <IconBook />
              </div>
              <h3 class="wiki-empty-title">No pages</h3>
              <p class="wiki-empty-sub">
                Create your first page to start documenting this repository.
              </p>
            </div>
          </div>
        ) : (
          <div class="wiki-list">
            {rows.map((p) => {
              const ts = p.updatedAt
                ? formatRelative(p.updatedAt as unknown as string)
                : null;
              return (
                <div class="wiki-list-row">
                  <div style="min-width:0">
                    <a
                      href={`/${ownerName}/${repoName}/wiki/${p.slug}`}
                      class="wiki-list-name"
                    >
                      {p.title}
                    </a>
                  </div>
                  <div class="wiki-list-meta">
                    {ts && <span>edited {ts}</span>}
                    <span class="wiki-rev-chip">r{p.revision}</span>
                    {user && (
                      <a
                        class="wiki-btn wiki-btn-ghost"
                        href={`/${ownerName}/${repoName}/wiki/${p.slug}/edit`}
                        style="padding:5px 10px;font-size:11.5px"
                      >
                        <IconEdit />
                        Edit
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: wikiStyles }} />
    </Layout>
  );
});

// New page form
wikiRoutes.get("/:owner/:repo/wiki/new", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  return c.html(
    <Layout title="New wiki page" user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div class="wiki-wrap">
        <header class="wiki-head">
          <div class="wiki-head-text">
            <div class="wiki-eyebrow">
              <span class="wiki-eyebrow-dot" aria-hidden="true" />
              Repository · Wiki · New page
            </div>
            <h1 class="wiki-title">
              <span class="wiki-title-grad">Start a new page.</span>
            </h1>
            <p class="wiki-sub">
              Markdown is rendered with GFM extensions: tables, task lists,
              fenced code, autolinks.
            </p>
          </div>
        </header>

        <form
          method="post"
          action={`/${ownerName}/${repoName}/wiki`}
          class="wiki-editor"
        >
          <div>
            <label class="wiki-field-label" for="wiki-new-title">Title</label>
            <input
              id="wiki-new-title"
              type="text"
              name="title"
              placeholder="Page title"
              required
              aria-label="Page title"
              class="wiki-input"
            />
          </div>
          <div>
            <label class="wiki-field-label" for="wiki-new-body">Markdown</label>
            <textarea
              id="wiki-new-body"
              name="body"
              rows={16}
              placeholder="# Page title\n\nWrite something."
              class="wiki-textarea"
            ></textarea>
          </div>
          <div class="wiki-editor-foot">
            <span class="wiki-editor-hint">
              The slug is generated from the title.
            </span>
            <a
              class="wiki-btn wiki-btn-ghost"
              href={`/${ownerName}/${repoName}/wiki`}
            >
              Cancel
            </a>
            <button type="submit" class="wiki-btn wiki-btn-primary">
              Create page
            </button>
          </div>
        </form>
      </div>
      <style dangerouslySetInnerHTML={{ __html: wikiStyles }} />
    </Layout>
  );
});

// Create
wikiRoutes.post("/:owner/:repo/wiki", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

  const form = await c.req.formData();
  const title = (form.get("title") as string || "").trim();
  const body = (form.get("body") as string || "").trim();
  if (!title) {
    return c.redirect(`/${ownerName}/${repoName}/wiki/new`);
  }
  const slug = slugifyTitle(title) || "page";

  try {
    const [page] = await db
      .insert(wikiPages)
      .values({
        repositoryId: resolved.repo.id,
        slug,
        title,
        body,
        revision: 1,
        updatedBy: user.id,
      })
      .returning({ id: wikiPages.id });
    await db.insert(wikiRevisions).values({
      pageId: page.id,
      revision: 1,
      title,
      body,
      message: "Initial",
      authorId: user.id,
    });
  } catch {
    // likely unique-violation on slug; redirect to the existing page
  }
  return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
});

// View page
wikiRoutes.get("/:owner/:repo/wiki/:slug", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName, slug } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

  let page: any = null;
  try {
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.repositoryId, resolved.repo.id),
          eq(wikiPages.slug, slug)
        )
      )
      .limit(1);
    if (row) page = row;
  } catch {
    // leave null
  }
  if (!page) return c.html(notFound(user, "Page not found"), 404);
  const pages = await listPages(resolved.repo.id);
  const isOwner = user && user.id === resolved.repo.ownerId;
  const editedTs = page.updatedAt
    ? formatRelative(page.updatedAt as unknown as string)
    : null;

  return c.html(
    <Layout title={`${page.title} — wiki`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div class="wiki-wrap">
        <header class="wiki-head">
          <div class="wiki-head-text">
            <div class="wiki-eyebrow">
              <span class="wiki-eyebrow-dot" aria-hidden="true" />
              Repository · Wiki
              {editedTs && (
                <>
                  {" · "}
                  <span>edited {editedTs}</span>
                </>
              )}
            </div>
            <h1 class="wiki-title">
              <span class="wiki-title-grad">{page.title}</span>
            </h1>
            <p class="wiki-sub">
              Revision r{page.revision}. Edits append a new revision —
              previous versions remain in the history.
            </p>
          </div>
        </header>

        <div class="wiki-grid">
          <WikiSidebar
            ownerName={ownerName}
            repoName={repoName}
            pages={pages}
            user={user}
          />
          <main class="wiki-main">
            <div class="wiki-page-head">
              <h2 class="wiki-page-title">{page.title}</h2>
              <div class="wiki-page-actions">
                <a
                  href={`/${ownerName}/${repoName}/wiki/${slug}/history`}
                  class="wiki-btn wiki-btn-ghost"
                >
                  History
                </a>
                {user && (
                  <a
                    href={`/${ownerName}/${repoName}/wiki/${slug}/edit`}
                    class="wiki-btn wiki-btn-primary"
                  >
                    <IconEdit />
                    Edit
                  </a>
                )}
                {isOwner && (
                  <form
                    method="post"
                    action={`/${ownerName}/${repoName}/wiki/${slug}/delete`}
                    style="display: inline;"
                    onsubmit="return confirm('Delete this page?')"
                  >
                    <button type="submit" class="wiki-btn wiki-btn-danger">
                      Delete
                    </button>
                  </form>
                )}
              </div>
            </div>
            <article
              class="wiki-page-body"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(page.body || ""),
              }}
            />
          </main>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: wikiStyles }} />
    </Layout>
  );
});

// Edit form
wikiRoutes.get(
  "/:owner/:repo/wiki/:slug/edit",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user");
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let page: any = null;
    try {
      const [row] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (row) page = row;
    } catch {
      // leave null
    }
    if (!page) return c.html(notFound(user, "Page not found"), 404);

    return c.html(
      <Layout title={`Edit ${page.title}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <div class="wiki-wrap">
          <header class="wiki-head">
            <div class="wiki-head-text">
              <div class="wiki-eyebrow">
                <span class="wiki-eyebrow-dot" aria-hidden="true" />
                Repository · Wiki · Editing
              </div>
              <h1 class="wiki-title">
                <span class="wiki-title-grad">Edit "{page.title}"</span>
              </h1>
              <p class="wiki-sub">
                Currently at r{page.revision}. Saving appends a new
                revision; nothing is overwritten in history.
              </p>
            </div>
          </header>

          <form
            method="post"
            action={`/${ownerName}/${repoName}/wiki/${slug}/edit`}
            class="wiki-editor"
          >
            <div>
              <label class="wiki-field-label" for="wiki-edit-title">Title</label>
              <input
                id="wiki-edit-title"
                type="text"
                name="title"
                value={page.title}
                required
                aria-label="Page title"
                class="wiki-input"
              />
            </div>
            <div>
              <label class="wiki-field-label" for="wiki-edit-body">Markdown</label>
              <textarea
                id="wiki-edit-body"
                name="body"
                rows={16}
                class="wiki-textarea"
              >{page.body}</textarea>
            </div>
            <div>
              <label class="wiki-field-label" for="wiki-edit-msg">
                Revision message (optional)
              </label>
              <input
                id="wiki-edit-msg"
                type="text"
                name="message"
                placeholder="What changed?"
                aria-label="Revision message"
                class="wiki-input"
              />
            </div>
            <div class="wiki-editor-foot">
              <span class="wiki-editor-hint">
                Next revision will be r{page.revision + 1}.
              </span>
              <a
                class="wiki-btn wiki-btn-ghost"
                href={`/${ownerName}/${repoName}/wiki/${slug}`}
              >
                Cancel
              </a>
              <button type="submit" class="wiki-btn wiki-btn-primary">
                Save revision
              </button>
            </div>
          </form>
        </div>
        <style dangerouslySetInnerHTML={{ __html: wikiStyles }} />
      </Layout>
    );
  }
);

// Save edit
wikiRoutes.post(
  "/:owner/:repo/wiki/:slug/edit",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const form = await c.req.formData();
    const title = (form.get("title") as string || "").trim();
    const body = (form.get("body") as string || "").trim();
    const message = (form.get("message") as string || "").trim();
    if (!title) {
      return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}/edit`);
    }

    try {
      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (page) {
        const nextRev = page.revision + 1;
        await db
          .update(wikiPages)
          .set({
            title,
            body,
            revision: nextRev,
            updatedAt: new Date(),
            updatedBy: user.id,
          })
          .where(eq(wikiPages.id, page.id));
        await db.insert(wikiRevisions).values({
          pageId: page.id,
          revision: nextRev,
          title,
          body,
          message: message || null,
          authorId: user.id,
        });
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
  }
);

// Delete
wikiRoutes.post(
  "/:owner/:repo/wiki/:slug/delete",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);
    if (user.id !== resolved.repo.ownerId) {
      return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
    }
    try {
      await db
        .delete(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        );
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/wiki`);
  }
);

// History
wikiRoutes.get(
  "/:owner/:repo/wiki/:slug/history",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user");
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let page: any = null;
    let revs: any[] = [];
    try {
      const [row] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (row) {
        page = row;
        revs = await db
          .select({
            r: wikiRevisions,
            author: { username: users.username },
          })
          .from(wikiRevisions)
          .innerJoin(users, eq(wikiRevisions.authorId, users.id))
          .where(eq(wikiRevisions.pageId, page.id))
          .orderBy(desc(wikiRevisions.revision));
      }
    } catch {
      // leave null
    }
    if (!page) return c.html(notFound(user, "Page not found"), 404);

    return c.html(
      <Layout title={`${page.title} — history`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <div class="wiki-wrap">
          <header class="wiki-head">
            <div class="wiki-head-text">
              <div class="wiki-eyebrow">
                <span class="wiki-eyebrow-dot" aria-hidden="true" />
                Repository · Wiki · History
              </div>
              <h1 class="wiki-title">
                <span class="wiki-title-grad">{page.title}</span>
              </h1>
              <p class="wiki-sub">
                Every revision, newest first.{" "}
                <a href={`/${ownerName}/${repoName}/wiki/${slug}`}>
                  View current page
                </a>.
              </p>
            </div>
          </header>

          <div class="wiki-hist">
            {revs.map((rv) => (
              <div class="wiki-hist-row">
                <div style="min-width:0">
                  <a
                    href={`/${ownerName}/${repoName}/wiki/${slug}/revisions/${rv.r.revision}`}
                    class="wiki-hist-name"
                  >
                    r{rv.r.revision}
                  </a>
                  {rv.r.message && (
                    <span class="wiki-hist-msg">{rv.r.message}</span>
                  )}
                </div>
                <div class="wiki-hist-meta">
                  <span>@{rv.author.username}</span>
                  {user && user.id === resolved.repo.ownerId &&
                    rv.r.revision !== page.revision && (
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/wiki/${slug}/revert/${rv.r.revision}`}
                        style="display:inline"
                      >
                        <button
                          type="submit"
                          class="wiki-btn wiki-btn-ghost"
                          style="padding:5px 10px;font-size:11.5px"
                        >
                          Revert
                        </button>
                      </form>
                    )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: wikiStyles }} />
      </Layout>
    );
  }
);

// View revision
wikiRoutes.get(
  "/:owner/:repo/wiki/:slug/revisions/:rev",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user");
    const rev = Number(c.req.param("rev"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let rv: any = null;
    try {
      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (page) {
        const [r] = await db
          .select()
          .from(wikiRevisions)
          .where(
            and(
              eq(wikiRevisions.pageId, page.id),
              eq(wikiRevisions.revision, rev)
            )
          )
          .limit(1);
        if (r) rv = r;
      }
    } catch {
      // leave null
    }
    if (!rv) return c.html(notFound(user, "Revision not found"), 404);

    return c.html(
      <Layout title={`${rv.title} @ r${rev}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <div class="wiki-wrap">
          <header class="wiki-head">
            <div class="wiki-head-text">
              <div class="wiki-eyebrow">
                <span class="wiki-eyebrow-dot" aria-hidden="true" />
                Repository · Wiki · Revision r{rev}
              </div>
              <h1 class="wiki-title">
                <span class="wiki-title-grad">{rv.title}</span>
              </h1>
              <p class="wiki-sub">
                Viewing revision {rev}.{" "}
                <a href={`/${ownerName}/${repoName}/wiki/${slug}`}>
                  Back to current
                </a>.
              </p>
            </div>
          </header>
          <article
            class="wiki-page-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(rv.body || "") }}
          />
        </div>
        <style dangerouslySetInnerHTML={{ __html: wikiStyles }} />
      </Layout>
    );
  }
);

// Revert
wikiRoutes.post(
  "/:owner/:repo/wiki/:slug/revert/:rev",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const rev = Number(c.req.param("rev"));
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);
    if (user.id !== resolved.repo.ownerId) {
      return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
    }
    try {
      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (!page) {
        return c.redirect(`/${ownerName}/${repoName}/wiki`);
      }
      const [target] = await db
        .select()
        .from(wikiRevisions)
        .where(
          and(
            eq(wikiRevisions.pageId, page.id),
            eq(wikiRevisions.revision, rev)
          )
        )
        .limit(1);
      if (target) {
        const nextRev = page.revision + 1;
        await db
          .update(wikiPages)
          .set({
            title: target.title,
            body: target.body,
            revision: nextRev,
            updatedAt: new Date(),
            updatedBy: user.id,
          })
          .where(eq(wikiPages.id, page.id));
        await db.insert(wikiRevisions).values({
          pageId: page.id,
          revision: nextRev,
          title: target.title,
          body: target.body,
          message: `Reverted to revision ${rev}`,
          authorId: user.id,
        });
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
  }
);

export default wikiRoutes;

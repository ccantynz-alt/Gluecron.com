/**
 * Block E4 — Gists: user-owned tiny multi-file repos.
 *
 * DB-backed v1 (no git bare repo). Each gist owns a collection of gist_files,
 * and every edit appends a gist_revisions row with a JSON snapshot of the
 * full file set at that revision.
 *
 * Never throws — all DB paths wrapped in try/catch; any failure redirects.
 *
 * 2026 polish: scoped `.gists-*` class system mirrors `collaborators.tsx` —
 * eyebrow + display headline on /gists, snippet cards with language pill +
 * line count + relative time, mono slug IDs, and orb-lit dashed empty state.
 */

import { Hono } from "hono";
import { and, eq, desc, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "../db";
import {
  gists,
  gistFiles,
  gistRevisions,
  gistStars,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { highlightCode } from "../lib/highlight";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { html } from "hono/html";

export function generateSlug(): string {
  return randomBytes(4).toString("hex");
}

export function snapshotOf(
  files: { filename: string; content: string }[]
): string {
  const map: Record<string, string> = {};
  for (const f of files) map[f.filename] = f.content;
  return JSON.stringify(map);
}

const gistRoutes = new Hono<AuthEnv>();

// ─── Scoped CSS (.gists-*) ──────────────────────────────────────────────────
const gistsStyles = `
  .gists-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .gists-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .gists-head-text { flex: 1; min-width: 280px; }
  .gists-eyebrow {
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
  .gists-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .gists-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .gists-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .gists-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 640px;
  }

  /* Buttons */
  .gists-btn {
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
  .gists-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .gists-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .gists-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .gists-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .gists-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
  }
  .gists-btn-danger:hover {
    border-style: dashed;
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
    text-decoration: none;
  }

  /* Crumbs */
  .gists-crumbs {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
    font-size: 12.5px;
  }
  .gists-crumbs a {
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
  .gists-crumbs a:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* Card grid */
  .gists-list { display: flex; flex-direction: column; gap: 10px; }
  .gists-card {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .gists-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .gists-card-body { flex: 1; min-width: 0; }
  .gists-card-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .gists-card-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 15.5px;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
  }
  .gists-card-title:hover { text-decoration: underline; }
  .gists-card-desc {
    margin-top: 4px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .gists-meta-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    margin-top: 6px;
  }
  .gists-meta-row .sep { opacity: 0.4; }
  .gists-meta-row a { color: var(--text-muted); }
  .gists-meta-row a:hover { color: var(--text-strong); }

  /* Slug ID */
  .gists-slug {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(255,255,255,0.04);
    color: var(--text);
    border: 1px solid var(--border);
    text-decoration: none;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .gists-slug:hover {
    border-color: rgba(140,109,255,0.45);
    color: #c4b5fd;
    text-decoration: none;
  }

  /* Pills */
  .gists-pill {
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
  .gists-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .gists-pill.is-lang {
    background: rgba(140,109,255,0.12);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    font-family: var(--font-mono);
  }
  .gists-pill.is-public {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .gists-pill.is-secret {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .gists-pill.is-count {
    background: rgba(54,197,214,0.14);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  /* Pagination */
  .gists-pager {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: var(--space-5);
    justify-content: center;
  }
  .gists-pager a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    color: var(--text);
    text-decoration: none;
    font-size: 12.5px;
    font-weight: 500;
  }
  .gists-pager a:hover {
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    background: rgba(140,109,255,0.06);
    text-decoration: none;
  }

  /* Form card */
  .gists-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5);
    max-width: 860px;
    position: relative;
    overflow: hidden;
  }
  .gists-form-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
  }
  .gists-field { margin-bottom: 14px; }
  .gists-field-label {
    display: block;
    font-size: 11.5px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .gists-input, .gists-textarea {
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
  .gists-textarea { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5; resize: vertical; }
  .gists-input:focus, .gists-textarea:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .gists-visibility { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 14px; font-size: 13px; }
  .gists-visibility label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .gist-file {
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 10px;
  }

  /* File viewer */
  .gists-file-block {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: 14px;
  }
  .gists-file-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-strong);
    background: rgba(255,255,255,0.02);
  }
  .gists-file-body pre {
    margin: 0;
    padding: 14px 16px;
    font-size: 12.5px;
    line-height: 1.6;
    overflow-x: auto;
  }

  /* Detail header */
  .gists-detail-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .gists-detail-title {
    font-family: var(--font-display);
    font-size: clamp(20px, 2.8vw, 30px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.15;
    margin: 0;
    color: var(--text-strong);
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .gists-detail-title a { color: #c4b5fd; text-decoration: none; }
  .gists-detail-title a:hover { color: #a48bff; text-decoration: underline; }
  .gists-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Star button */
  .gists-star {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border-strong);
    color: var(--text);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    font: inherit;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
    font-variant-numeric: tabular-nums;
  }
  .gists-star:hover {
    border-color: rgba(251,191,36,0.55);
    color: #fde68a;
    background: rgba(251,191,36,0.08);
  }
  .gists-star.is-on { color: #fde68a; border-color: rgba(251,191,36,0.55); background: rgba(251,191,36,0.08); }

  /* Empty */
  .gists-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(32px, 6vw, 60px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .gists-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .gists-empty-inner { position: relative; z-index: 1; }
  .gists-empty-icon {
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
  .gists-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .gists-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 420px;
    line-height: 1.5;
  }
`;

function IconCode() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
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

function notFound(user: any, label = "Gist not found") {
  return (
    <Layout title={label} user={user}>
      <div class="gists-wrap">
        <div class="gists-empty">
          <div class="gists-empty-orb" aria-hidden="true" />
          <div class="gists-empty-inner">
            <h2 class="gists-empty-title">{label}</h2>
          </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: gistsStyles }} />
    </Layout>
  );
}

/** Guess a short language label from a filename extension. */
function langOf(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const i = filename.lastIndexOf(".");
  if (i < 0 || i === filename.length - 1) return null;
  return filename.slice(i + 1).toLowerCase();
}

function relTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const t = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - t.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return t.toLocaleDateString();
}

// Discover / list public gists
gistRoutes.get("/gists", softAuth, async (c) => {
  const user = c.get("user");
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;

  let rows: any[] = [];
  try {
    rows = await db
      .select({
        g: gists,
        owner: { username: users.username },
        fileCount: sql<number>`(SELECT count(*) FROM gist_files WHERE gist_id = ${gists.id})`,
        starCount: sql<number>`(SELECT count(*) FROM gist_stars WHERE gist_id = ${gists.id})`,
      })
      .from(gists)
      .innerJoin(users, eq(gists.ownerId, users.id))
      .where(eq(gists.isPublic, true))
      .orderBy(desc(gists.updatedAt))
      .limit(limit)
      .offset(offset);
  } catch {
    rows = [];
  }

  return c.html(
    <Layout title="Discover gists" user={user}>
      <div class="gists-wrap">
        <header class="gists-head">
          <div class="gists-head-text">
            <div class="gists-eyebrow">
              <span class="gists-eyebrow-dot" aria-hidden="true" />
              Snippets · Discover
            </div>
            <h1 class="gists-title">
              <span class="gists-title-grad">Public gists.</span>
            </h1>
            <p class="gists-sub">
              Tiny multi-file snippets the community has shared — perfect for
              scripts, configs, and one-off code samples.
            </p>
          </div>
          {user && (
            <a href="/gists/new" class="gists-btn gists-btn-primary">
              <IconPlus />
              New gist
            </a>
          )}
        </header>

        {rows.length === 0 ? (
          <div class="gists-empty">
            <div class="gists-empty-orb" aria-hidden="true" />
            <div class="gists-empty-inner">
              <div class="gists-empty-icon" aria-hidden="true">
                <IconCode />
              </div>
              <h3 class="gists-empty-title">Share your first snippet</h3>
              <p class="gists-empty-sub">
                Gists are great for sharing scripts, config samples, and quick
                multi-file demos. Public gists show up here.
              </p>
              {user ? (
                <a href="/gists/new" class="gists-btn gists-btn-primary">
                  <IconPlus />
                  New gist
                </a>
              ) : (
                <a href="/login" class="gists-btn gists-btn-primary">
                  Sign in to create
                </a>
              )}
            </div>
          </div>
        ) : (
          <div class="gists-list">
            {rows.map((r) => {
              const lang = langOf(r.g.title);
              return (
                <div class="gists-card">
                  <div class="gists-card-body">
                    <div class="gists-card-row">
                      <a href={`/gists/${r.g.slug}`} class="gists-card-title">
                        {r.g.title || r.g.slug}
                      </a>
                      {lang && (
                        <span class="gists-pill is-lang">{lang}</span>
                      )}
                      {r.g.isPublic ? (
                        <span class="gists-pill is-public">
                          <span class="dot" aria-hidden="true" />
                          Public
                        </span>
                      ) : (
                        <span class="gists-pill is-secret">
                          <span class="dot" aria-hidden="true" />
                          Secret
                        </span>
                      )}
                    </div>
                    {r.g.description && (
                      <div class="gists-card-desc">{r.g.description}</div>
                    )}
                    <div class="gists-meta-row">
                      <span>
                        by <a href={`/${r.owner.username}`}>@{r.owner.username}</a>
                      </span>
                      <span class="sep">·</span>
                      <span class="gists-pill is-count">
                        {r.fileCount} file{r.fileCount !== 1 ? "s" : ""}
                      </span>
                      <span class="sep">·</span>
                      <span>★ {r.starCount}</span>
                      <span class="sep">·</span>
                      <span>updated {relTime(r.g.updatedAt)}</span>
                    </div>
                  </div>
                  <a href={`/gists/${r.g.slug}`} class="gists-slug">
                    {r.g.slug}
                  </a>
                </div>
              );
            })}
          </div>
        )}
        {(rows.length === limit || page > 1) && (
          <div class="gists-pager">
            {page > 1 && (
              <a href={`/gists?page=${page - 1}`}>
                <IconArrowLeft />
                prev
              </a>
            )}
            {rows.length === limit && (
              <a href={`/gists?page=${page + 1}`}>next →</a>
            )}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: gistsStyles }} />
    </Layout>
  );
});

// New gist form
gistRoutes.get("/gists/new", requireAuth, async (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="New gist" user={user}>
      <div class="gists-wrap">
        <div class="gists-crumbs">
          <a href="/gists">
            <IconArrowLeft />
            Discover gists
          </a>
        </div>
        <header class="gists-head">
          <div class="gists-head-text">
            <div class="gists-eyebrow">
              <span class="gists-eyebrow-dot" aria-hidden="true" />
              Snippets · New
            </div>
            <h1 class="gists-title">
              <span class="gists-title-grad">Create a gist.</span>
            </h1>
            <p class="gists-sub">
              Add one or more files. The first filename becomes the gist title;
              every save adds a revision.
            </p>
          </div>
        </header>
        <form
          method="post"
          action="/gists"
          class="gists-form-card"
        >
          <div class="gists-field">
            <label class="gists-field-label" for="gist-desc">Description</label>
            <input
              class="gists-input"
              type="text"
              id="gist-desc"
              name="description"
              placeholder="Gist description..."
              aria-label="Gist description"
            />
          </div>
          <div class="gists-visibility">
            <label>
              <input type="radio" name="is_public" value="true" checked />
              Public
            </label>
            <label>
              <input type="radio" name="is_public" value="false" />
              Secret
            </label>
          </div>
          <div id="files">
            <div class="gist-file">
              <input
                class="gists-input"
                type="text"
                name="filename[]"
                placeholder="filename.ext"
                required
                aria-label="Filename"
              />
              <textarea
                class="gists-textarea"
                name="content[]"
                rows={12}
                placeholder="File contents..."
                required
                style="margin-top:8px"
              ></textarea>
            </div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
            <button
              type="button"
              class="gists-btn gists-btn-ghost"
              id="add-file"
            >
              <IconPlus />
              Add file
            </button>
            <button type="submit" class="gists-btn gists-btn-primary">
              Create gist
            </button>
          </div>
        </form>
      </div>
      {html`
        <script>
          document.getElementById("add-file").addEventListener("click", () => {
            const div = document.createElement("div");
            div.className = "gist-file";
            div.innerHTML =
              '<input class="gists-input" type="text" name="filename[]" placeholder="filename.ext" required />' +
              '<textarea class="gists-textarea" name="content[]" rows="12" placeholder="File contents..." required style="margin-top:8px"></textarea>';
            document.getElementById("files").appendChild(div);
          });
        </script>
      `}
      <style dangerouslySetInnerHTML={{ __html: gistsStyles }} />
    </Layout>
  );
});

// Create gist
gistRoutes.post("/gists", requireAuth, async (c) => {
  const user = c.get("user")!;
  const form = await c.req.formData();
  const description = (form.get("description") as string || "").trim();
  const isPublic = (form.get("is_public") as string) !== "false";
  const filenames = form.getAll("filename[]") as string[];
  const contents = form.getAll("content[]") as string[];

  const files = filenames
    .map((fn, i) => ({
      filename: (fn || "").trim(),
      content: contents[i] || "",
    }))
    .filter((f) => f.filename && f.content);

  if (files.length === 0) {
    return c.text("At least one file is required", 400);
  }

  // Retry on unique slug collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateSlug();
    try {
      const [gist] = await db
        .insert(gists)
        .values({
          ownerId: user.id,
          slug,
          title: files[0].filename,
          description,
          isPublic,
        })
        .returning({ id: gists.id });
      await db.insert(gistFiles).values(
        files.map((f) => ({
          gistId: gist.id,
          filename: f.filename,
          content: f.content,
          sizeBytes: new TextEncoder().encode(f.content).length,
        }))
      );
      await db.insert(gistRevisions).values({
        gistId: gist.id,
        revision: 1,
        snapshot: snapshotOf(files),
        authorId: user.id,
        message: "Initial",
      });
      return c.redirect(`/gists/${slug}`);
    } catch (err: any) {
      if (attempt === 4) {
        return c.text("Could not create gist", 500);
      }
      // Otherwise assume slug collision, retry with fresh slug.
    }
  }
  return c.redirect("/gists");
});

// View gist
gistRoutes.get("/gists/:slug", softAuth, async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");

  let gist: any = null;
  let files: any[] = [];
  let starCount = 0;
  let isStarred = false;
  try {
    const [row] = await db
      .select({ g: gists, owner: { username: users.username } })
      .from(gists)
      .innerJoin(users, eq(gists.ownerId, users.id))
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row) {
      gist = row;
      files = await db
        .select()
        .from(gistFiles)
        .where(eq(gistFiles.gistId, gist.g.id))
        .orderBy(gistFiles.filename);
      const [cnt] = await db
        .select({ n: sql<number>`count(*)` })
        .from(gistStars)
        .where(eq(gistStars.gistId, gist.g.id));
      starCount = Number(cnt?.n || 0);
      if (user) {
        const [has] = await db
          .select()
          .from(gistStars)
          .where(
            and(
              eq(gistStars.gistId, gist.g.id),
              eq(gistStars.userId, user.id)
            )
          )
          .limit(1);
        isStarred = !!has;
      }
    }
  } catch {
    // leave null
  }

  if (!gist) return c.html(notFound(user), 404);

  const isOwner = user && user.id === gist.g.ownerId;
  if (!gist.g.isPublic && !isOwner) {
    return c.html(notFound(user), 404);
  }

  return c.html(
    <Layout title={gist.g.title || slug} user={user}>
      <div class="gists-wrap">
        <div class="gists-crumbs">
          <a href="/gists">
            <IconArrowLeft />
            Discover
          </a>
        </div>
        <div class="gists-detail-head">
          <div>
            <h1 class="gists-detail-title">
              <a href={`/${gist.owner.username}`}>@{gist.owner.username}</a>
              <span style="color:var(--text-muted)">/</span>
              <span>{gist.g.title || slug}</span>
              {!gist.g.isPublic && (
                <span class="gists-pill is-secret">
                  <span class="dot" aria-hidden="true" />
                  Secret
                </span>
              )}
            </h1>
            {gist.g.description && (
              <p class="gists-sub" style="margin-top:6px">{gist.g.description}</p>
            )}
            <div class="gists-meta-row">
              <span class="gists-slug">{slug}</span>
              <span class="sep">·</span>
              <span class="gists-pill is-count">
                {files.length} file{files.length !== 1 ? "s" : ""}
              </span>
              <span class="sep">·</span>
              <span>updated {relTime(gist.g.updatedAt)}</span>
            </div>
          </div>
          <div class="gists-detail-actions">
            {user && !isOwner && (
              <form
                method="post"
                action={`/gists/${slug}/star`}
              >
                <button
                  type="submit"
                  class={`gists-star${isStarred ? " is-on" : ""}`}
                >
                  {isStarred ? "★" : "☆"} {starCount}
                </button>
              </form>
            )}
            {!user && (
              <span class="gists-star">☆ {starCount}</span>
            )}
            <a href={`/gists/${slug}/revisions`} class="gists-btn gists-btn-ghost">
              Revisions
            </a>
            {isOwner && (
              <>
                <a href={`/gists/${slug}/edit`} class="gists-btn gists-btn-ghost">
                  Edit
                </a>
                <form
                  method="post"
                  action={`/gists/${slug}/delete`}
                  onsubmit="return confirm('Delete this gist?')"
                >
                  <button type="submit" class="gists-btn gists-btn-danger">
                    Delete
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
        {files.map((f) => {
          const { html: highlighted } = highlightCode(f.content, f.filename);
          const lang = langOf(f.filename);
          const lineCount = (f.content || "").split("\n").length;
          return (
            <div class="gists-file-block">
              <div class="gists-file-head">
                <span>{f.filename}</span>
                <div style="display:flex;gap:6px;align-items:center">
                  {lang && <span class="gists-pill is-lang">{lang}</span>}
                  <span class="gists-pill is-count">{lineCount} lines</span>
                </div>
              </div>
              <div class="gists-file-body blob-code">
                <pre>
                  {html([highlighted] as unknown as TemplateStringsArray)}
                </pre>
              </div>
            </div>
          );
        })}
      </div>
      <style dangerouslySetInnerHTML={{ __html: gistsStyles }} />
    </Layout>
  );
});

// Edit form
gistRoutes.get("/gists/:slug/edit", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");

  let gist: any = null;
  let files: any[] = [];
  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row && row.ownerId === user.id) {
      gist = row;
      files = await db
        .select()
        .from(gistFiles)
        .where(eq(gistFiles.gistId, gist.id))
        .orderBy(gistFiles.filename);
    }
  } catch {
    // leave null
  }

  if (!gist) return c.html(notFound(user, "Not found or not yours"), 404);

  return c.html(
    <Layout title={`Edit ${gist.slug}`} user={user}>
      <div class="gists-wrap">
        <div class="gists-crumbs">
          <a href={`/gists/${slug}`}>
            <IconArrowLeft />
            Back to gist
          </a>
        </div>
        <header class="gists-head">
          <div class="gists-head-text">
            <div class="gists-eyebrow">
              <span class="gists-eyebrow-dot" aria-hidden="true" />
              Snippets · Edit
            </div>
            <h1 class="gists-title">
              <span class="gists-title-grad">Edit gist.</span>
            </h1>
            <p class="gists-sub">
              Saving creates a new revision — old versions stay accessible via
              the revisions list.
            </p>
          </div>
        </header>
        <form
          method="post"
          action={`/gists/${slug}/edit`}
          class="gists-form-card"
        >
          <div class="gists-field">
            <label class="gists-field-label" for="gist-edit-desc">Description</label>
            <input
              class="gists-input"
              type="text"
              id="gist-edit-desc"
              name="description"
              value={gist.description}
              placeholder="Description"
              aria-label="Gist description"
            />
          </div>
          <div class="gists-field">
            <label class="gists-field-label" for="gist-edit-msg">Revision message</label>
            <input
              class="gists-input"
              type="text"
              id="gist-edit-msg"
              name="message"
              placeholder="(optional)"
              aria-label="Revision message"
            />
          </div>
          <div id="files">
            {files.map((f) => (
              <div class="gist-file">
                <input
                  class="gists-input"
                  type="text"
                  name="filename[]"
                  value={f.filename}
                  required
                  aria-label="Filename"
                />
                <textarea
                  class="gists-textarea"
                  name="content[]"
                  rows={12}
                  required
                  style="margin-top:8px"
                >
                  {f.content}
                </textarea>
              </div>
            ))}
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
            <button
              type="button"
              class="gists-btn gists-btn-ghost"
              id="add-file"
            >
              <IconPlus />
              Add file
            </button>
            <button type="submit" class="gists-btn gists-btn-primary">
              Save revision
            </button>
          </div>
        </form>
      </div>
      {html`
        <script>
          document.getElementById("add-file").addEventListener("click", () => {
            const div = document.createElement("div");
            div.className = "gist-file";
            div.innerHTML =
              '<input class="gists-input" type="text" name="filename[]" placeholder="filename.ext" required />' +
              '<textarea class="gists-textarea" name="content[]" rows="12" required style="margin-top:8px"></textarea>';
            document.getElementById("files").appendChild(div);
          });
        </script>
      `}
      <style dangerouslySetInnerHTML={{ __html: gistsStyles }} />
    </Layout>
  );
});

// Save edit
gistRoutes.post("/gists/:slug/edit", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const form = await c.req.formData();
  const description = (form.get("description") as string || "").trim();
  const message = (form.get("message") as string || "").trim();
  const filenames = form.getAll("filename[]") as string[];
  const contents = form.getAll("content[]") as string[];

  const files = filenames
    .map((fn, i) => ({
      filename: (fn || "").trim(),
      content: contents[i] || "",
    }))
    .filter((f) => f.filename && f.content);

  if (files.length === 0) {
    return c.text("At least one file is required", 400);
  }

  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (!row || row.ownerId !== user.id) {
      return c.redirect("/gists");
    }
    // Replace file set: delete all, re-insert.
    await db.delete(gistFiles).where(eq(gistFiles.gistId, row.id));
    await db.insert(gistFiles).values(
      files.map((f) => ({
        gistId: row.id,
        filename: f.filename,
        content: f.content,
        sizeBytes: new TextEncoder().encode(f.content).length,
      }))
    );
    // Bump revision.
    const [last] = await db
      .select({ r: sql<number>`max(${gistRevisions.revision})` })
      .from(gistRevisions)
      .where(eq(gistRevisions.gistId, row.id));
    const nextRev = Number(last?.r || 0) + 1;
    await db.insert(gistRevisions).values({
      gistId: row.id,
      revision: nextRev,
      snapshot: snapshotOf(files),
      authorId: user.id,
      message: message || null,
    });
    await db
      .update(gists)
      .set({ description, updatedAt: new Date() })
      .where(eq(gists.id, row.id));
  } catch {
    // swallow
  }
  return c.redirect(`/gists/${slug}`);
});

// Delete
gistRoutes.post("/gists/:slug/delete", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row && row.ownerId === user.id) {
      await db.delete(gists).where(eq(gists.id, row.id));
    }
  } catch {
    // swallow
  }
  return c.redirect("/gists");
});

// Toggle star
gistRoutes.post("/gists/:slug/star", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row && row.ownerId !== user.id) {
      const [existing] = await db
        .select()
        .from(gistStars)
        .where(
          and(
            eq(gistStars.gistId, row.id),
            eq(gistStars.userId, user.id)
          )
        )
        .limit(1);
      if (existing) {
        await db.delete(gistStars).where(eq(gistStars.id, existing.id));
      } else {
        await db.insert(gistStars).values({
          gistId: row.id,
          userId: user.id,
        });
      }
    }
  } catch {
    // swallow
  }
  return c.redirect(`/gists/${slug}`);
});

// Revisions list
gistRoutes.get("/gists/:slug/revisions", softAuth, async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");

  let gist: any = null;
  let revs: any[] = [];
  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row && (row.isPublic || (user && user.id === row.ownerId))) {
      gist = row;
      revs = await db
        .select({
          r: gistRevisions,
          author: { username: users.username },
        })
        .from(gistRevisions)
        .innerJoin(users, eq(gistRevisions.authorId, users.id))
        .where(eq(gistRevisions.gistId, gist.id))
        .orderBy(desc(gistRevisions.revision));
    }
  } catch {
    // leave null
  }

  if (!gist) return c.html(notFound(user), 404);

  return c.html(
    <Layout title={`${gist.slug} — revisions`} user={user}>
      <div class="gists-wrap">
        <div class="gists-crumbs">
          <a href={`/gists/${slug}`}>
            <IconArrowLeft />
            Back to gist
          </a>
        </div>
        <header class="gists-head">
          <div class="gists-head-text">
            <div class="gists-eyebrow">
              <span class="gists-eyebrow-dot" aria-hidden="true" />
              Snippets · Revisions
            </div>
            <h1 class="gists-title">
              <span class="gists-title-grad">{gist.title || slug}</span>
            </h1>
            <p class="gists-sub">Every save is preserved as a numbered revision.</p>
          </div>
        </header>
        <div class="gists-list">
          {revs.map((rv) => (
            <div class="gists-card">
              <div class="gists-card-body">
                <div class="gists-card-row">
                  <a
                    href={`/gists/${slug}/revisions/${rv.r.revision}`}
                    class="gists-card-title"
                  >
                    Revision {rv.r.revision}
                  </a>
                  {rv.r.message && (
                    <span style="color:var(--text-muted);font-size:13px">— {rv.r.message}</span>
                  )}
                </div>
                <div class="gists-meta-row">
                  <span>by @{rv.author.username}</span>
                </div>
              </div>
              <a
                href={`/gists/${slug}/revisions/${rv.r.revision}`}
                class="gists-slug"
              >
                r{rv.r.revision}
              </a>
            </div>
          ))}
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: gistsStyles }} />
    </Layout>
  );
});

// Revision detail
gistRoutes.get(
  "/gists/:slug/revisions/:rev",
  softAuth,
  async (c) => {
    const user = c.get("user");
    const slug = c.req.param("slug");
    const rev = Number(c.req.param("rev"));

    let gist: any = null;
    let snapshot: Record<string, string> | null = null;
    try {
      const [row] = await db
        .select()
        .from(gists)
        .where(eq(gists.slug, slug))
        .limit(1);
      if (row && (row.isPublic || (user && user.id === row.ownerId))) {
        gist = row;
        const [rv] = await db
          .select()
          .from(gistRevisions)
          .where(
            and(
              eq(gistRevisions.gistId, gist.id),
              eq(gistRevisions.revision, rev)
            )
          )
          .limit(1);
        if (rv) {
          try {
            snapshot = JSON.parse(rv.snapshot);
          } catch {
            snapshot = {};
          }
        }
      }
    } catch {
      // leave null
    }

    if (!gist || !snapshot)
      return c.html(notFound(user, "Revision not found"), 404);

    return c.html(
      <Layout title={`${slug} @ r${rev}`} user={user}>
        <div class="gists-wrap">
          <div class="gists-crumbs">
            <a href={`/gists/${slug}/revisions`}>
              <IconArrowLeft />
              All revisions
            </a>
          </div>
          <header class="gists-head">
            <div class="gists-head-text">
              <div class="gists-eyebrow">
                <span class="gists-eyebrow-dot" aria-hidden="true" />
                Snippets · Revision {rev}
              </div>
              <h1 class="gists-title">
                <span class="gists-title-grad">{gist.title || slug}</span>{" "}
                <span style="color:var(--text-muted);font-size:0.6em;font-weight:600">@ r{rev}</span>
              </h1>
            </div>
          </header>
          {Object.entries(snapshot).map(([filename, content]) => {
            const { html: highlighted } = highlightCode(content, filename);
            const lang = langOf(filename);
            const lineCount = (content || "").split("\n").length;
            return (
              <div class="gists-file-block">
                <div class="gists-file-head">
                  <span>{filename}</span>
                  <div style="display:flex;gap:6px;align-items:center">
                    {lang && <span class="gists-pill is-lang">{lang}</span>}
                    <span class="gists-pill is-count">{lineCount} lines</span>
                  </div>
                </div>
                <div class="gists-file-body blob-code">
                  <pre>
                    {html([highlighted] as unknown as TemplateStringsArray)}
                  </pre>
                </div>
              </div>
            );
          })}
        </div>
        <style dangerouslySetInnerHTML={{ __html: gistsStyles }} />
      </Layout>
    );
  }
);

// User's public gists
gistRoutes.get("/:username/gists", softAuth, async (c) => {
  const user = c.get("user");
  const username = c.req.param("username");

  let ownerUser: any = null;
  let rows: any[] = [];
  try {
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (u) {
      ownerUser = u;
      const showPrivate = user && user.id === u.id;
      rows = await db
        .select({
          g: gists,
          fileCount: sql<number>`(SELECT count(*) FROM gist_files WHERE gist_id = ${gists.id})`,
        })
        .from(gists)
        .where(
          showPrivate
            ? eq(gists.ownerId, u.id)
            : and(eq(gists.ownerId, u.id), eq(gists.isPublic, true))
        )
        .orderBy(desc(gists.updatedAt));
    }
  } catch {
    rows = [];
  }

  if (!ownerUser) return c.html(notFound(user, "User not found"), 404);

  return c.html(
    <Layout title={`@${username}'s gists`} user={user}>
      <div class="gists-wrap">
        <header class="gists-head">
          <div class="gists-head-text">
            <div class="gists-eyebrow">
              <span class="gists-eyebrow-dot" aria-hidden="true" />
              Snippets · @{username}
            </div>
            <h1 class="gists-title">
              <span class="gists-title-grad">@{username}'s gists</span>
            </h1>
            <p class="gists-sub">
              Every snippet authored by{" "}
              <a href={`/${username}`}>@{username}</a>.
            </p>
          </div>
        </header>
        {rows.length === 0 ? (
          <div class="gists-empty">
            <div class="gists-empty-orb" aria-hidden="true" />
            <div class="gists-empty-inner">
              <div class="gists-empty-icon" aria-hidden="true">
                <IconCode />
              </div>
              <h3 class="gists-empty-title">No gists yet</h3>
              <p class="gists-empty-sub">
                @{username} hasn't published any public snippets.
              </p>
            </div>
          </div>
        ) : (
          <div class="gists-list">
            {rows.map((r) => {
              const lang = langOf(r.g.title);
              return (
                <div class="gists-card">
                  <div class="gists-card-body">
                    <div class="gists-card-row">
                      <a href={`/gists/${r.g.slug}`} class="gists-card-title">
                        {r.g.title || r.g.slug}
                      </a>
                      {lang && <span class="gists-pill is-lang">{lang}</span>}
                      {!r.g.isPublic && (
                        <span class="gists-pill is-secret">
                          <span class="dot" aria-hidden="true" />
                          Secret
                        </span>
                      )}
                    </div>
                    {r.g.description && (
                      <div class="gists-card-desc">{r.g.description}</div>
                    )}
                    <div class="gists-meta-row">
                      <span class="gists-pill is-count">
                        {r.fileCount} file{r.fileCount !== 1 ? "s" : ""}
                      </span>
                      <span class="sep">·</span>
                      <span>updated {relTime(r.g.updatedAt)}</span>
                    </div>
                  </div>
                  <a href={`/gists/${r.g.slug}`} class="gists-slug">
                    {r.g.slug}
                  </a>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: gistsStyles }} />
    </Layout>
  );
});

export default gistRoutes;

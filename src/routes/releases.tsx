/**
 * Releases — tagged snapshots with AI-generated changelogs.
 *
 *   GET  /:owner/:repo/releases           — list
 *   GET  /:owner/:repo/releases/new       — create form (tag + target + AI notes)
 *   POST /:owner/:repo/releases           — create release + git tag + changelog
 *   GET  /:owner/:repo/releases/:tag      — view single release
 *   POST /:owner/:repo/releases/:tag/delete — owner-only delete (also removes git tag)
 *
 * Publishing a release fans out `release_published` notifications to starrers.
 *
 * 2026 polish: scoped `.rel-*` class system mirrors `admin-ops.tsx` and
 * `collaborators.tsx` — eyebrow + display headline, polished cards with
 * tabular-nums for counts/dates, version pills (mono), gradient hero CTA, and
 * an orb-lit dashed empty state. RepoHeader / RepoNav are untouched.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import {
  releases,
  repositories,
  users,
  stars,
  repoSettings,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  listBranches,
  listTags,
  createTag,
  deleteTag,
  resolveRef,
  commitsBetween,
  getDefaultBranch,
} from "../git/repository";
import { generateChangelog } from "../lib/ai-generators";
import { notifyMany, audit } from "../lib/notify";
import { renderMarkdown } from "../lib/markdown";
import { getUnreadCount } from "../lib/unread";

const releasesRoute = new Hono<AuthEnv>();
releasesRoute.use("*", softAuth);

async function loadRepo(owner: string, repo: string) {
  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
      ownerId: repositories.ownerId,
      starCount: repositories.starCount,
      forkCount: repositories.forkCount,
      forkedFromId: repositories.forkedFromId,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  return row;
}

// ─── Scoped CSS (.rel-*) ────────────────────────────────────────────────────
//
// Every selector prefixed `.rel-*` so it can't leak into surrounding chrome.
// Tokens come from the layout (--bg-elevated, --border, --text-strong,
// --space-*, --font-*).
const relStyles = `
  .rel-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .rel-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .rel-head-text { flex: 1; min-width: 280px; }
  .rel-eyebrow {
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
  .rel-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .rel-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .rel-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .rel-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 640px;
  }

  /* Buttons */
  .rel-btn {
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
  .rel-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .rel-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .rel-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .rel-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .rel-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
  }
  .rel-btn-danger:hover {
    border-style: dashed;
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
    text-decoration: none;
  }

  /* Banner */
  .rel-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .rel-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; }

  /* Crumb */
  .rel-crumbs {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
    font-size: 12.5px;
  }
  .rel-crumbs a {
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
  .rel-crumbs a:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* Release cards */
  .rel-list { display: flex; flex-direction: column; gap: 12px; }
  .rel-card {
    position: relative;
    overflow: hidden;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    transition: border-color 120ms ease, background 120ms ease;
  }
  .rel-card:hover { border-color: var(--border-strong); }
  .rel-card.is-latest::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.6;
    pointer-events: none;
  }
  .rel-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .rel-card-titlewrap { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
  .rel-card-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 18px;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    text-decoration: none;
  }
  .rel-card-name:hover { color: var(--text-strong); text-decoration: underline; }
  .rel-tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(140,109,255,0.12);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    font-variant-numeric: tabular-nums;
  }
  .rel-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: capitalize;
  }
  .rel-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .rel-pill.is-latest {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .rel-pill.is-draft {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .rel-pill.is-pre {
    background: rgba(54,197,214,0.14);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
  }
  .rel-meta-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    margin-bottom: 10px;
  }
  .rel-meta-row a { color: var(--text-muted); }
  .rel-meta-row a:hover { color: var(--text-strong); }
  .rel-meta-row code, .rel-meta-row .mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 6px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .rel-meta-row .sep { opacity: 0.4; }

  .rel-notes {
    font-size: 13.5px;
    color: var(--text);
    line-height: 1.55;
    max-height: 220px;
    overflow: hidden;
    position: relative;
    border-top: 1px dashed var(--border);
    padding-top: 12px;
  }
  .rel-notes::after {
    content: '';
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 48px;
    background: linear-gradient(to top, var(--bg-elevated), transparent);
    pointer-events: none;
  }
  .rel-card-actions { margin-top: 12px; }

  /* Detail card */
  .rel-detail {
    position: relative;
    overflow: hidden;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5);
  }
  .rel-detail::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
  }

  /* Form */
  .rel-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5);
    max-width: 720px;
    position: relative;
    overflow: hidden;
  }
  .rel-form-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
  }
  .rel-field { margin-bottom: 14px; }
  .rel-field-label {
    display: block;
    font-size: 11.5px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .rel-input, .rel-select, .rel-textarea {
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
  .rel-textarea { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5; resize: vertical; }
  .rel-input:focus, .rel-select:focus, .rel-textarea:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .rel-checks { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 16px; font-size: 13px; }
  .rel-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }

  /* Empty */
  .rel-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(32px, 6vw, 60px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .rel-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .rel-empty-inner { position: relative; z-index: 1; }
  .rel-empty-icon {
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
  .rel-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .rel-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 420px;
    line-height: 1.5;
  }
`;

function IconTag() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
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
function IconDownload() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/** YYYY-MM-DD with tabular-nums. */
function shortDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 10);
}

releasesRoute.get("/:owner/:repo/releases", requireRepoAccess("read"), async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const rows = await db
    .select({
      id: releases.id,
      tag: releases.tag,
      name: releases.name,
      body: releases.body,
      targetCommit: releases.targetCommit,
      isDraft: releases.isDraft,
      isPrerelease: releases.isPrerelease,
      createdAt: releases.createdAt,
      publishedAt: releases.publishedAt,
      authorName: users.username,
    })
    .from(releases)
    .innerJoin(users, eq(releases.authorId, users.id))
    .where(eq(releases.repositoryId, repoRow.id))
    .orderBy(desc(releases.createdAt));

  const unread = user ? await getUnreadCount(user.id) : 0;
  const isOwner = !!user && user.id === repoRow.ownerId;

  return c.html(
    <Layout
      title={`Releases — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="releases" />
      <div class="rel-wrap">
        <header class="rel-head">
          <div class="rel-head-text">
            <div class="rel-eyebrow">
              <span class="rel-eyebrow-dot" aria-hidden="true" />
              Repository · Releases
            </div>
            <h1 class="rel-title">
              <span class="rel-title-grad">Tagged snapshots.</span>
            </h1>
            <p class="rel-sub">
              Cut a versioned release of {owner}/{repo}. AI drafts the
              changelog from your commit history — you decide what ships.
            </p>
          </div>
          {isOwner && (
            <a href={`/${owner}/${repo}/releases/new`} class="rel-btn rel-btn-primary">
              <IconPlus />
              Draft release
            </a>
          )}
        </header>

        {rows.length === 0 ? (
          <div class="rel-empty">
            <div class="rel-empty-orb" aria-hidden="true" />
            <div class="rel-empty-inner">
              <div class="rel-empty-icon" aria-hidden="true">
                <IconTag />
              </div>
              <h3 class="rel-empty-title">Tag your first release</h3>
              <p class="rel-empty-sub">
                Pick a commit, name a tag like <code>v1.0.0</code>, and let
                Claude write the changelog. Starrers will be notified the
                moment it ships.
              </p>
              {isOwner && (
                <a href={`/${owner}/${repo}/releases/new`} class="rel-btn rel-btn-primary">
                  <IconPlus />
                  Draft release
                </a>
              )}
            </div>
          </div>
        ) : (
          <div class="rel-list">
            {rows.map((r, i) => {
              const isLatest = i === 0 && !r.isDraft && !r.isPrerelease;
              return (
                <article class={`rel-card${isLatest ? " is-latest" : ""}`}>
                  <div class="rel-card-head">
                    <div class="rel-card-titlewrap">
                      <a
                        href={`/${owner}/${repo}/releases/${encodeURIComponent(r.tag)}`}
                        class="rel-card-name"
                      >
                        {r.name}
                      </a>
                      <span class="rel-tag-pill">
                        <IconTag />
                        {r.tag}
                      </span>
                      {isLatest && (
                        <span class="rel-pill is-latest">
                          <span class="dot" aria-hidden="true" />
                          Latest
                        </span>
                      )}
                      {r.isDraft && (
                        <span class="rel-pill is-draft">
                          <span class="dot" aria-hidden="true" />
                          Draft
                        </span>
                      )}
                      {r.isPrerelease && (
                        <span class="rel-pill is-pre">
                          <span class="dot" aria-hidden="true" />
                          Pre-release
                        </span>
                      )}
                    </div>
                  </div>
                  <div class="rel-meta-row">
                    <span>@{r.authorName}</span>
                    <span class="sep">·</span>
                    <span>released {shortDate(r.publishedAt || r.createdAt)}</span>
                    <span class="sep">·</span>
                    <a href={`/${owner}/${repo}/commit/${r.targetCommit}`}>
                      <span class="mono">{r.targetCommit.slice(0, 7)}</span>
                    </a>
                    <span class="sep">·</span>
                    <a href={`/${owner}/${repo}/archive/${encodeURIComponent(r.tag)}.zip`}>
                      <IconDownload /> Download
                    </a>
                  </div>
                  {r.body && (
                    <div
                      class="rel-notes markdown-body"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(r.body.slice(0, 600) + (r.body.length > 600 ? " …" : "")),
                      }}
                    ></div>
                  )}
                  {isOwner && (
                    <div class="rel-card-actions">
                      <form
                        method="post"
                        action={`/${owner}/${repo}/releases/${encodeURIComponent(r.tag)}/delete`}
                        onsubmit="return confirm('Delete this release?')"
                      >
                        <button type="submit" class="rel-btn rel-btn-danger">
                          Delete
                        </button>
                      </form>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: relStyles }} />
    </Layout>
  );
});

releasesRoute.get("/:owner/:repo/releases/new", requireAuth, requireRepoAccess("write"), async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/releases`);

  const branches = await listBranches(owner, repo);
  const tags = await listTags(owner, repo);
  const unread = await getUnreadCount(user.id);
  const error = c.req.query("error");

  return c.html(
    <Layout
      title={`Draft release — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user.username}
      />
      <RepoNav owner={owner} repo={repo} active="releases" />
      <div class="rel-wrap">
        <div class="rel-crumbs">
          <a href={`/${owner}/${repo}/releases`}>
            <IconArrowLeft />
            All releases
          </a>
        </div>
        <header class="rel-head">
          <div class="rel-head-text">
            <div class="rel-eyebrow">
              <span class="rel-eyebrow-dot" aria-hidden="true" />
              Releases · New
            </div>
            <h1 class="rel-title">
              <span class="rel-title-grad">Draft a release.</span>
            </h1>
            <p class="rel-sub">
              Pick a tag and target, write notes (or leave blank for the AI
              changelog), then publish.
            </p>
          </div>
        </header>

        {error && (
          <div class="rel-banner" role="alert">
            <span class="rel-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        <form
          method="post"
          action={`/${owner}/${repo}/releases`}
          class="rel-form-card"
        >
          <div class="rel-field">
            <label class="rel-field-label" for="rel-tag">Tag</label>
            <input
              class="rel-input"
              type="text"
              id="rel-tag"
              name="tag"
              required
              placeholder="v1.0.0"
              pattern="[A-Za-z0-9._\\-]+"
              aria-label="Tag"
            />
          </div>
          <div class="rel-field">
            <label class="rel-field-label" for="rel-target">Target branch / commit</label>
            <select class="rel-select" id="rel-target" name="target" aria-label="Target branch">
              {branches.map((b) => (
                <option value={b} selected={b === repoRow.defaultBranch}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div class="rel-field">
            <label class="rel-field-label" for="rel-name">Release name</label>
            <input
              class="rel-input"
              type="text"
              id="rel-name"
              name="name"
              required
              placeholder="v1.0.0 — the big one"
              aria-label="Release name"
            />
          </div>
          <div class="rel-field">
            <label class="rel-field-label" for="rel-prev">Previous tag (for AI changelog)</label>
            <select class="rel-select" id="rel-prev" name="previousTag" aria-label="Previous tag">
              <option value="">(auto — last tag)</option>
              {tags.map((t) => (
                <option value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>
          <div class="rel-field">
            <label class="rel-field-label" for="rel-body">Notes (leave blank for AI-generated)</label>
            <div style="display:flex; align-items:center; gap:8px; margin-bottom: 6px;">
              <button
                type="button"
                id="rel-gen-notes"
                class="rel-btn rel-btn-ghost"
                aria-label="Generate AI release notes from merged PRs"
              >
                Generate notes
              </button>
              <span
                id="rel-gen-notes-status"
                style="font-size:12px; color: var(--text-muted);"
                aria-live="polite"
              ></span>
            </div>
            <textarea
              class="rel-textarea"
              id="rel-body"
              name="body"
              rows={10}
              placeholder="Markdown supported. Click 'Generate notes' to have Claude draft a polished changelog from every merged PR since the previous tag."
            ></textarea>
          </div>
          <div class="rel-checks">
            <label class="rel-check">
              <input type="checkbox" name="isPrerelease" value="1" />
              Pre-release
            </label>
            <label class="rel-check">
              <input type="checkbox" name="isDraft" value="1" />
              Save as draft
            </label>
          </div>
          <button type="submit" class="rel-btn rel-btn-primary">
            <IconTag />
            Publish release
          </button>
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function(){
                var btn = document.getElementById('rel-gen-notes');
                if (!btn) return;
                var status = document.getElementById('rel-gen-notes-status');
                var tagInput = document.getElementById('rel-tag');
                var prevSel = document.getElementById('rel-prev');
                var bodyArea = document.getElementById('rel-body');
                btn.addEventListener('click', async function(){
                  var toTag = (tagInput && tagInput.value || '').trim();
                  if (!toTag) {
                    status.textContent = 'Enter a tag name first.';
                    return;
                  }
                  var fromTag = (prevSel && prevSel.value || '').trim() || null;
                  btn.disabled = true;
                  status.textContent = 'Asking Claude…';
                  try {
                    var res = await fetch(${JSON.stringify(`/api/v2/repos/${owner}/${repo}/releases/notes`)}, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'same-origin',
                      body: JSON.stringify({ to_tag: toTag, from_tag: fromTag }),
                    });
                    if (!res.ok) {
                      var err = await res.text();
                      status.textContent = 'Failed: ' + (err || res.status);
                      return;
                    }
                    var data = await res.json();
                    if (data && typeof data.markdown === 'string') {
                      bodyArea.value = data.markdown;
                      status.textContent = data.aiUsed
                        ? ('Drafted from ' + (data.prCount || 0) + ' PR(s).')
                        : ('Deterministic summary (' + (data.prCount || 0) + ' PR(s) — set ANTHROPIC_API_KEY for polished output).');
                    } else {
                      status.textContent = 'Empty response.';
                    }
                  } catch (e) {
                    status.textContent = 'Network error.';
                  } finally {
                    btn.disabled = false;
                  }
                });
              })();
            `,
          }}
        />
      </div>
      <style dangerouslySetInnerHTML={{ __html: relStyles }} />
    </Layout>
  );
});

releasesRoute.post("/:owner/:repo/releases", requireAuth, requireRepoAccess("write"), async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/releases`);

  const body = await c.req.parseBody();
  const tag = String(body.tag || "").trim();
  const name = String(body.name || "").trim() || tag;
  const target = String(body.target || repoRow.defaultBranch).trim();
  const previousTag = String(body.previousTag || "").trim();
  const notes = String(body.body || "").trim();
  const isDraft = !!body.isDraft;
  const isPrerelease = !!body.isPrerelease;

  if (!tag || !/^[A-Za-z0-9._\-]+$/.test(tag)) {
    return c.redirect(
      `/${owner}/${repo}/releases/new?error=Invalid+tag+name`
    );
  }

  const sha = await resolveRef(owner, repo, target);
  if (!sha) {
    return c.redirect(
      `/${owner}/${repo}/releases/new?error=Could+not+resolve+target`
    );
  }

  // Determine previous tag for changelog
  let autoPrev = previousTag;
  if (!autoPrev) {
    const tags = await listTags(owner, repo);
    autoPrev = tags[0]?.name || "";
  }

  // Generate changelog body if none provided
  let finalBody = notes;
  const [settings] = await db
    .select()
    .from(repoSettings)
    .where(eq(repoSettings.repositoryId, repoRow.id))
    .limit(1);
  const aiEnabled = settings ? settings.aiChangelogEnabled : true;

  if (!finalBody && aiEnabled) {
    const commits = await commitsBetween(owner, repo, autoPrev || null, sha);
    finalBody = await generateChangelog(`${owner}/${repo}`, autoPrev || null, tag, commits);
  }

  // Create the git tag (best-effort — if it already exists we reuse)
  const existing = await resolveRef(owner, repo, `refs/tags/${tag}`);
  if (!existing) {
    await createTag(owner, repo, tag, sha, name || tag);
  }

  // Persist release
  let releaseId = "";
  try {
    const [row] = await db
      .insert(releases)
      .values({
        repositoryId: repoRow.id,
        authorId: user.id,
        tag,
        name,
        body: finalBody,
        targetCommit: sha,
        isDraft,
        isPrerelease,
        publishedAt: isDraft ? null : new Date(),
      })
      .returning();
    releaseId = row?.id || "";
  } catch (err) {
    console.error("[releases] insert failed:", err);
    return c.redirect(
      `/${owner}/${repo}/releases/new?error=Tag+already+published`
    );
  }

  // Notify starrers (only on publish)
  if (!isDraft) {
    try {
      const starUsers = await db
        .select({ userId: stars.userId })
        .from(stars)
        .where(eq(stars.repositoryId, repoRow.id));
      await notifyMany(
        starUsers.map((s) => s.userId).filter((id) => id !== user.id),
        {
          kind: "release_published",
          title: `${owner}/${repo} ${tag} released`,
          body: name,
          url: `/${owner}/${repo}/releases/${encodeURIComponent(tag)}`,
          repositoryId: repoRow.id,
        }
      );
    } catch {
      /* ignore */
    }
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "release.publish",
    targetType: "release",
    targetId: releaseId,
    metadata: { tag, target, isDraft, isPrerelease },
  });

  return c.redirect(`/${owner}/${repo}/releases/${encodeURIComponent(tag)}`);
});

releasesRoute.get("/:owner/:repo/releases/:tag", requireRepoAccess("read"), async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const tag = decodeURIComponent(c.req.param("tag"));
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const [release] = await db
    .select({
      id: releases.id,
      tag: releases.tag,
      name: releases.name,
      body: releases.body,
      targetCommit: releases.targetCommit,
      isDraft: releases.isDraft,
      isPrerelease: releases.isPrerelease,
      createdAt: releases.createdAt,
      publishedAt: releases.publishedAt,
      authorName: users.username,
    })
    .from(releases)
    .innerJoin(users, eq(releases.authorId, users.id))
    .where(
      and(eq(releases.repositoryId, repoRow.id), eq(releases.tag, tag))
    )
    .limit(1);
  if (!release) return c.notFound();

  const unread = user ? await getUnreadCount(user.id) : 0;

  return c.html(
    <Layout
      title={`${release.name} — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="releases" />
      <div class="rel-wrap">
        <div class="rel-crumbs">
          <a href={`/${owner}/${repo}/releases`}>
            <IconArrowLeft />
            All releases
          </a>
        </div>
        <header class="rel-head">
          <div class="rel-head-text">
            <div class="rel-eyebrow">
              <span class="rel-eyebrow-dot" aria-hidden="true" />
              Releases · {release.tag}
            </div>
            <h1 class="rel-title">
              <span class="rel-title-grad">{release.name}</span>
            </h1>
            <p class="rel-sub">
              Released by @{release.authorName} on {shortDate(release.publishedAt || release.createdAt)}.
            </p>
          </div>
        </header>

        <article class="rel-detail">
          <div class="rel-card-head">
            <div class="rel-card-titlewrap">
              <span class="rel-tag-pill">
                <IconTag />
                {release.tag}
              </span>
              {release.isDraft && (
                <span class="rel-pill is-draft">
                  <span class="dot" aria-hidden="true" />
                  Draft
                </span>
              )}
              {release.isPrerelease && (
                <span class="rel-pill is-pre">
                  <span class="dot" aria-hidden="true" />
                  Pre-release
                </span>
              )}
            </div>
          </div>
          <div class="rel-meta-row">
            <span>@{release.authorName}</span>
            <span class="sep">·</span>
            <span>released {shortDate(release.publishedAt || release.createdAt)}</span>
            <span class="sep">·</span>
            <a href={`/${owner}/${repo}/commit/${release.targetCommit}`}>
              <span class="mono">{release.targetCommit.slice(0, 7)}</span>
            </a>
            <span class="sep">·</span>
            <a href={`/${owner}/${repo}/archive/${encodeURIComponent(release.tag)}.zip`}>
              <IconDownload /> Download
            </a>
          </div>
          {release.body && (
            <div
              class="markdown-body"
              style="border-top: 1px dashed var(--border); padding-top: 14px; margin-top: 4px"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(release.body),
              }}
            ></div>
          )}
        </article>
      </div>
      <style dangerouslySetInnerHTML={{ __html: relStyles }} />
    </Layout>
  );
});

releasesRoute.post(
  "/:owner/:repo/releases/:tag/delete",
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo } = c.req.param();
    const tag = decodeURIComponent(c.req.param("tag"));
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/releases`);
    }

    await db
      .delete(releases)
      .where(
        and(eq(releases.repositoryId, repoRow.id), eq(releases.tag, tag))
      );
    await deleteTag(owner, repo, tag);
    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "release.delete",
      targetType: "release",
      metadata: { tag },
    });
    return c.redirect(`/${owner}/${repo}/releases`);
  }
);

export default releasesRoute;

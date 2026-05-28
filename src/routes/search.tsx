/**
 * Global search — across repos, users, issues, PRs.
 *
 *   GET /search?q=...&type=repos|users|issues|prs
 *
 * Text search uses Postgres ILIKE — good enough for the scale GlueCron is at
 * today. If traffic grows, swap in pgvector + AI embeddings.
 */

import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getUnreadCount } from "../lib/unread";

const search = new Hono<AuthEnv>();
search.use("*", softAuth);

const SearchPageStyle = () => (
  <style
    dangerouslySetInnerHTML={{
      __html: `
  /* ─── Hero ─── */
  .search-page-hero {
    position: relative;
    margin: 4px 0 22px;
    padding: 32px 32px 28px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .search-page-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .search-page-hero-bg {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 360px;
    height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .search-page-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: searchPageHeroOrb 14s ease-in-out infinite;
  }
  @keyframes searchPageHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-12px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .search-page-hero-orb { animation: none; }
  }
  .search-page-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .search-page-hero-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .search-page-hero-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0;
    color: var(--text-strong);
  }
  .search-page-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .search-page-form {
    margin-top: 6px;
    position: relative;
    display: flex;
    align-items: stretch;
    gap: 0;
  }
  .search-page-input-wrap {
    position: relative;
    flex: 1;
  }
  .search-page-input-icon {
    position: absolute;
    top: 50%;
    left: 18px;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
    width: 18px;
    height: 18px;
  }
  .search-page-input {
    width: 100%;
    padding: 14px 18px 14px 48px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 14px;
    color: var(--text);
    font-size: 15px;
    font-family: inherit;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .search-page-input::placeholder { color: var(--text-muted); }
  .search-page-input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.12);
  }
  .search-page-kbd {
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 8px;
    border-radius: 6px;
    pointer-events: none;
  }
  @media (max-width: 720px) {
    .search-page-hero { padding: 24px 20px; }
    .search-page-kbd { display: none; }
    .search-page-input { padding: 14px 16px 14px 44px; min-height: 44px; }
    .search-page-tabs { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; flex-wrap: nowrap; }
    .search-page-tab { white-space: nowrap; min-height: 40px; padding: 10px 14px; }
    .search-page-result { padding: 14px; gap: 10px; }
    .search-page-result-avatar { width: 36px; height: 36px; font-size: 13px; }
    .search-page-empty { padding: 40px 20px; }
    .search-page-code { padding: 12px; }
    .search-page-shortcut-row { padding: 12px 14px; flex-wrap: wrap; gap: 6px; }
  }

  /* ─── Tab pills ─── */
  .search-page-tabs {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
    margin: 0 0 18px;
    flex-wrap: wrap;
  }
  .search-page-tab {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 16px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease;
    line-height: 1.4;
  }
  .search-page-tab:hover {
    color: var(--text-strong);
    text-decoration: none;
  }
  .search-page-tab.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
  }
  .search-page-tab-count {
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    padding: 1px 8px;
    border-radius: 9999px;
  }
  .search-page-tab.is-active .search-page-tab-count {
    background: rgba(140,109,255,0.20);
    color: var(--text);
  }

  /* ─── Result list ─── */
  .search-page-results {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .search-page-result {
    position: relative;
    display: flex;
    gap: 14px;
    padding: 16px 20px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    text-decoration: none;
    color: inherit;
    transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  .search-page-result:hover {
    transform: translateY(-1px);
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 10px 22px -16px rgba(0,0,0,0.5), 0 0 18px -8px rgba(140,109,255,0.18);
    text-decoration: none;
  }
  .search-page-result-avatar {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 15px;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    flex-shrink: 0;
    letter-spacing: -0.01em;
  }
  .search-page-result-avatar.is-user {
    border-radius: 9999px;
  }
  .search-page-result-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .search-page-result-title {
    font-family: var(--font-display);
    font-size: 15.5px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.014em;
    line-height: 1.35;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .search-page-result:hover .search-page-result-title { color: var(--accent); }
  .search-page-result-meta {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .search-page-result-meta strong {
    color: var(--text);
    font-weight: 600;
  }
  .search-page-result-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 4px 0 0;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ─── State pill (issues/PRs) ─── */
  .search-page-state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.5;
    letter-spacing: 0.005em;
  }
  .search-page-state-open {
    background: rgba(52,211,153,0.10);
    color: #34d399;
    border: 1px solid rgba(52,211,153,0.30);
  }
  .search-page-state-closed {
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    border: 1px solid rgba(140,109,255,0.30);
  }
  .search-page-state-merged {
    background: rgba(54,197,214,0.10);
    color: #36c5d6;
    border: 1px solid rgba(54,197,214,0.28);
  }
  .search-page-state-draft {
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  /* ─── Code result card ─── */
  .search-page-code {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
  }
  .search-page-code-path {
    font-family: var(--font-mono, monospace);
    font-size: 12.5px;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .search-page-code-snippet {
    display: flex;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 12px;
    font-family: var(--font-mono, monospace);
    font-size: 12.5px;
    overflow-x: auto;
  }
  .search-page-code-lineno {
    color: var(--text-muted);
    flex-shrink: 0;
    padding-right: 14px;
    border-right: 1px solid var(--border);
    margin-right: 12px;
    text-align: right;
    min-width: 32px;
    font-variant-numeric: tabular-nums;
  }
  .search-page-code-line {
    color: var(--text);
    white-space: pre;
  }
  .search-page-code-mark {
    background: rgba(140,109,255,0.22);
    color: var(--text-strong);
    border-radius: 3px;
    padding: 0 2px;
  }

  /* ─── Empty / hint states ─── */
  .search-page-empty {
    margin: 0;
    padding: 56px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .search-page-empty::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .search-page-empty-art {
    width: 88px;
    height: 88px;
    margin: 0 auto 18px;
    display: block;
    opacity: 0.85;
  }
  .search-page-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .search-page-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 auto 22px;
    max-width: 480px;
  }
  .search-page-empty-cta {
    display: inline-flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .search-page-empty-tip {
    display: inline-flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
    font-size: 13px;
    color: var(--text-muted);
    text-align: left;
  }
  .search-page-empty-tip-row { color: var(--text-muted); }
  .search-page-empty-tip-row strong { color: var(--text); font-weight: 600; }

  /* ─── Shortcuts page (kept simple — reuses panel) ─── */
  .search-page-shortcut-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 11px 16px;
    border-bottom: 1px solid var(--border);
  }
  .search-page-shortcut-row:last-child { border-bottom: none; }
      `,
    }}
  />
);

function userInitials(u: typeof users.$inferSelect): string {
  const src = u.displayName || u.username || "·";
  const clean = src.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!clean) return src.charAt(0).toUpperCase();
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function repoInitials(ownerName: string, name: string): string {
  const src = name || ownerName || "·";
  const clean = src.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!clean) return src.charAt(0).toUpperCase();
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

search.get("/search", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();
  const type = c.req.query("type") || "repos";
  const unread = user ? await getUnreadCount(user.id) : 0;

  let repoHits: Array<{
    repo: typeof repositories.$inferSelect;
    ownerName: string;
  }> = [];
  let userHits: Array<typeof users.$inferSelect> = [];
  let issueHits: Array<{
    id: string;
    number: number;
    title: string;
    state: string;
    repoName: string;
    repoOwner: string;
  }> = [];
  let prHits: Array<{
    id: string;
    number: number;
    title: string;
    state: string;
    repoName: string;
    repoOwner: string;
  }> = [];

  if (q) {
    const pat = `%${q}%`;
    if (type === "repos") {
      const results = await db
        .select({ repo: repositories, ownerName: users.username })
        .from(repositories)
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(
          and(
            eq(repositories.isPrivate, false),
            sql`(${repositories.name} ILIKE ${pat} OR ${repositories.description} ILIKE ${pat})`
          )
        )
        .orderBy(desc(repositories.starCount))
        .limit(30);
      repoHits = results;
    } else if (type === "users") {
      userHits = await db
        .select()
        .from(users)
        .where(
          sql`(${users.username} ILIKE ${pat} OR ${users.displayName} ILIKE ${pat})`
        )
        .limit(30);
    } else if (type === "issues") {
      issueHits = await db
        .select({
          id: issues.id,
          number: issues.number,
          title: issues.title,
          state: issues.state,
          repoName: repositories.name,
          repoOwner: users.username,
        })
        .from(issues)
        .innerJoin(repositories, eq(issues.repositoryId, repositories.id))
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(
          and(
            eq(repositories.isPrivate, false),
            sql`(${issues.title} ILIKE ${pat} OR ${issues.body} ILIKE ${pat})`
          )
        )
        .orderBy(desc(issues.updatedAt))
        .limit(30);
    } else if (type === "prs") {
      prHits = await db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          state: pullRequests.state,
          repoName: repositories.name,
          repoOwner: users.username,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(
          and(
            eq(repositories.isPrivate, false),
            sql`(${pullRequests.title} ILIKE ${pat} OR ${pullRequests.body} ILIKE ${pat})`
          )
        )
        .orderBy(desc(pullRequests.updatedAt))
        .limit(30);
    }
  }

  // Active-tab count for the count chip (only the active tab knows its count).
  const activeCount =
    type === "repos"
      ? repoHits.length
      : type === "users"
        ? userHits.length
        : type === "issues"
          ? issueHits.length
          : type === "prs"
            ? prHits.length
            : 0;

  const tabPill = (id: string, label: string) => {
    const isActive = type === id;
    const showCount = isActive && q;
    return (
      <a
        href={`/search?q=${encodeURIComponent(q)}&type=${id}`}
        class={`search-page-tab${isActive ? " is-active" : ""}`}
        role="tab"
        aria-selected={isActive ? "true" : "false"}
      >
        <span>{label}</span>
        {showCount && (
          <span class="search-page-tab-count">{activeCount}</span>
        )}
      </a>
    );
  };

  const stateClass = (state: string) =>
    state === "open"
      ? "search-page-state search-page-state-open"
      : state === "merged"
        ? "search-page-state search-page-state-merged"
        : state === "draft"
          ? "search-page-state search-page-state-draft"
          : "search-page-state search-page-state-closed";

  const noResultsFor = (label: string) => (
    <div class="search-page-empty">
      <svg
        class="search-page-empty-art"
        viewBox="0 0 96 96"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="searchEmptyG" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
            <stop stop-color="#8c6dff" />
            <stop offset="1" stop-color="#36c5d6" />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r="22" stroke="url(#searchEmptyG)" stroke-width="4" />
        <path d="M56 56L78 78" stroke="url(#searchEmptyG)" stroke-width="4" stroke-linecap="round" />
        <path d="M32 40h16M40 32v16" stroke="url(#searchEmptyG)" stroke-width="3" stroke-linecap="round" opacity="0.55" />
      </svg>
      <h2 class="search-page-empty-title">No {label} for "{q}"</h2>
      <p class="search-page-empty-sub">
        Try a different keyword, switch categories, or browse{" "}
        <a href="/explore">Explore</a> to discover what's shipping on Gluecron.
      </p>
      <div class="search-page-empty-cta">
        <a href="/explore" class="btn btn-primary">
          Go to Explore
        </a>
        <a href={`/search?q=&type=${type}`} class="btn">
          Clear search
        </a>
      </div>
    </div>
  );

  return c.html(
    <Layout
      title={q ? `Search — ${q}` : "Search"}
      user={user}
      notificationCount={unread}
    >
      <SearchPageStyle />

      <section class="search-page-hero">
        <div class="search-page-hero-bg" aria-hidden="true">
          <div class="search-page-hero-orb" />
        </div>
        <div class="search-page-hero-inner">
          <div class="search-page-hero-eyebrow">Global search</div>
          <h1 class="search-page-hero-title">
            <span class="gradient-text">Search</span> Gluecron.
          </h1>
          <p class="search-page-hero-sub">
            Find repos, people, issues, pull requests, and code across the
            platform. Everything public is fair game.
          </p>
          <form
            method="get"
            action="/search"
            class="search-page-form"
            role="search"
          >
            <input type="hidden" name="type" value={type} />
            <div class="search-page-input-wrap">
              <svg
                class="search-page-input-icon"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
                <path d="M20 20L17 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <input
                type="search"
                name="q"
                value={q}
                placeholder="Search repos, users, issues, code…"
                aria-label="Search Gluecron"
                class="search-page-input"
                autofocus
                autocomplete="off"
              />
              <span class="search-page-kbd" aria-hidden="true">
                Enter
              </span>
            </div>
          </form>
        </div>
      </section>

      <div
        class="search-page-tabs"
        role="tablist"
        aria-label="Result categories"
      >
        {tabPill("repos", "Repositories")}
        {tabPill("users", "Users")}
        {tabPill("issues", "Issues")}
        {tabPill("prs", "Pull requests")}
        {tabPill("code", "Code")}
      </div>

      {!q && (
        <div class="search-page-empty">
          <svg
            class="search-page-empty-art"
            viewBox="0 0 96 96"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="searchIdleG" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop stop-color="#8c6dff" />
                <stop offset="1" stop-color="#36c5d6" />
              </linearGradient>
            </defs>
            <circle cx="42" cy="42" r="22" stroke="url(#searchIdleG)" stroke-width="4" />
            <path d="M58 58L78 78" stroke="url(#searchIdleG)" stroke-width="4" stroke-linecap="round" />
            <circle cx="42" cy="42" r="8" stroke="url(#searchIdleG)" stroke-width="3" opacity="0.55" />
          </svg>
          <h2 class="search-page-empty-title">Search Gluecron</h2>
          <p class="search-page-empty-sub">
            Type to search across repos, users, issues, and pull requests.
            Switch categories with the tabs above.
          </p>
          <div class="search-page-empty-tip">
            <span class="search-page-empty-tip-row">
              <strong>Tip:</strong> Press <code>/</code> from any page to focus
              the global search.
            </span>
            <span class="search-page-empty-tip-row">
              <strong>Semantic search:</strong> the global tab is keyword-only.
              For embedding-backed code search, open a repo and click{" "}
              <em>Semantic search</em> in the AI surfaces row, or hit{" "}
              <code>/:owner/:repo/semantic-search?q=…</code> directly.
            </span>
            <span class="search-page-empty-tip-row">
              Looking for something to browse?{" "}
              <a href="/explore">Head to Explore</a>.
            </span>
          </div>
        </div>
      )}

      {q && type === "repos" && (
        repoHits.length === 0 ? (
          noResultsFor("repositories")
        ) : (
          <div class="search-page-results">
            {repoHits.map(({ repo, ownerName }) => (
              <a
                class="search-page-result"
                href={`/${ownerName}/${repo.name}`}
                aria-label={`${ownerName}/${repo.name}`}
              >
                <div class="search-page-result-avatar" aria-hidden="true">
                  {repoInitials(ownerName, repo.name)}
                </div>
                <div class="search-page-result-body">
                  <h3 class="search-page-result-title">
                    <span>
                      {ownerName}/{repo.name}
                    </span>
                    {repo.forkedFromId && (
                      <span class="search-page-state search-page-state-merged">
                        Fork
                      </span>
                    )}
                  </h3>
                  {repo.description && (
                    <p class="search-page-result-desc">{repo.description}</p>
                  )}
                  <div class="search-page-result-meta">
                    <span>{"★"} {repo.starCount}</span>
                    {" · "}
                    <span>{"⑂"} {repo.forkCount}</span>
                    {repo.pushedAt && (
                      <>
                        {" · "}
                        <span>
                          Updated{" "}
                          {new Date(repo.pushedAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )
      )}

      {q && type === "users" && (
        userHits.length === 0 ? (
          noResultsFor("users")
        ) : (
          <div class="search-page-results">
            {userHits.map((u) => (
              <a
                class="search-page-result"
                href={`/${u.username}`}
                aria-label={u.username}
              >
                <div
                  class="search-page-result-avatar is-user"
                  aria-hidden="true"
                >
                  {userInitials(u)}
                </div>
                <div class="search-page-result-body">
                  <h3 class="search-page-result-title">
                    <span>{u.displayName || u.username}</span>
                  </h3>
                  <div class="search-page-result-meta">@{u.username}</div>
                  {u.bio && (
                    <p class="search-page-result-desc">{u.bio}</p>
                  )}
                </div>
              </a>
            ))}
          </div>
        )
      )}

      {q && type === "issues" && (
        issueHits.length === 0 ? (
          noResultsFor("issues")
        ) : (
          <div class="search-page-results">
            {issueHits.map((i) => (
              <a
                class="search-page-result"
                href={`/${i.repoOwner}/${i.repoName}/issues/${i.number}`}
                aria-label={`Issue ${i.title}`}
              >
                <div class="search-page-result-avatar" aria-hidden="true">
                  {repoInitials(i.repoOwner, i.repoName)}
                </div>
                <div class="search-page-result-body">
                  <h3 class="search-page-result-title">
                    <span>{i.title}</span>
                    <span class={stateClass(i.state)}>{i.state}</span>
                  </h3>
                  <div class="search-page-result-meta">
                    <strong>
                      {i.repoOwner}/{i.repoName}
                    </strong>{" "}
                    · #{i.number}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )
      )}

      {q && type === "prs" && (
        prHits.length === 0 ? (
          noResultsFor("pull requests")
        ) : (
          <div class="search-page-results">
            {prHits.map((pr) => (
              <a
                class="search-page-result"
                href={`/${pr.repoOwner}/${pr.repoName}/pull/${pr.number}`}
                aria-label={`Pull request ${pr.title}`}
              >
                <div class="search-page-result-avatar" aria-hidden="true">
                  {repoInitials(pr.repoOwner, pr.repoName)}
                </div>
                <div class="search-page-result-body">
                  <h3 class="search-page-result-title">
                    <span>{pr.title}</span>
                    <span class={stateClass(pr.state)}>{pr.state}</span>
                  </h3>
                  <div class="search-page-result-meta">
                    <strong>
                      {pr.repoOwner}/{pr.repoName}
                    </strong>{" "}
                    · #{pr.number}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )
      )}

      {q && type === "code" && (
        <div class="search-page-empty">
          <svg
            class="search-page-empty-art"
            viewBox="0 0 96 96"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="searchCodeG" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop stop-color="#8c6dff" />
                <stop offset="1" stop-color="#36c5d6" />
              </linearGradient>
            </defs>
            <path d="M34 30L18 48L34 66" stroke="url(#searchCodeG)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M62 30L78 48L62 66" stroke="url(#searchCodeG)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M54 24L42 72" stroke="url(#searchCodeG)" stroke-width="4" stroke-linecap="round" opacity="0.6" />
          </svg>
          <h2 class="search-page-empty-title">Code search is per-repo</h2>
          <p class="search-page-empty-sub">
            Cross-repo code search is on the roadmap. For now, open a repo and
            use its search tab to find symbols and matching lines.
          </p>
          <div class="search-page-empty-cta">
            <a href="/explore" class="btn btn-primary">
              Browse repos
            </a>
            <a href={`/search?q=${encodeURIComponent(q)}&type=repos`} class="btn">
              Search repos instead
            </a>
          </div>
        </div>
      )}
    </Layout>
  );
});

// Keyboard shortcuts help page — linked from Cmd+? in nav
search.get("/shortcuts", async (c) => {
  const user = c.get("user");
  const unread = user ? await getUnreadCount(user.id) : 0;
  const shortcuts: Array<{ keys: string; desc: string; section?: string }> = [
    { keys: "/", desc: "Focus global search", section: "Global" },
    { keys: "Cmd/Ctrl + K", desc: "Open command palette / AI assistant" },
    { keys: "?", desc: "Show keyboard shortcuts" },
    { keys: "n", desc: "New repository" },
    { keys: "g d", desc: "Go to dashboard" },
    { keys: "g n", desc: "Go to notifications" },
    { keys: "g e", desc: "Go to explore" },
    { keys: "g a", desc: "Go to AI ask" },
    { keys: "j", desc: "Move selection down on list pages", section: "Lists" },
    { keys: "k", desc: "Move selection up on list pages" },
    { keys: "Enter", desc: "Open selected item" },
    { keys: "x", desc: "Toggle select on focused item" },
  ];

  const sections = [...new Set(shortcuts.map((s) => s.section ?? "Global"))];

  return c.html(
    <Layout title="Keyboard shortcuts" user={user} notificationCount={unread}>
      <h2 style="margin-bottom: 16px">Keyboard shortcuts</h2>
      {sections.map((section) => (
        <>
          <h3 style="color: var(--text-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin: 20px 0 8px">{section}</h3>
          <div class="panel">
            {shortcuts.filter((s) => (s.section ?? "Global") === section).map((s) => (
              <div class="panel-item" style="justify-content: space-between">
                <span>{s.desc}</span>
                <kbd
                  style="font-family: var(--font-mono); background: var(--bg-tertiary); padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 12px"
                >
                  {s.keys}
                </kbd>
              </div>
            ))}
          </div>
        </>
      ))}
    </Layout>
  );
});

export default search;

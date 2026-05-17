/**
 * Explore page — discover public repositories, search, trending.
 */

import { Hono } from "hono";
import { eq, desc, sql, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, repoTopics } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const explore = new Hono<AuthEnv>();

explore.use("*", softAuth);

const ExploreStyle = () => (
  <style
    dangerouslySetInnerHTML={{
      __html: `
  /* ─── Hero ─── */
  .explore-hero {
    position: relative;
    margin: 4px 0 24px;
    padding: 28px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .explore-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .explore-hero-bg {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 360px;
    height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .explore-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: exploreHeroOrb 14s ease-in-out infinite;
  }
  @keyframes exploreHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-12px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .explore-hero-orb { animation: none; }
  }
  .explore-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .explore-hero-text { flex: 1; min-width: 280px; }
  .explore-hero-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .explore-hero-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .explore-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .explore-hero-search {
    display: flex;
    gap: 10px;
    align-items: stretch;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .explore-hero-search input[type="search"],
  .explore-hero-search input[type="text"] {
    flex: 1;
    min-width: 240px;
    padding: 11px 16px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text);
    font-size: 14.5px;
    font-family: inherit;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .explore-hero-search input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.12);
  }
  .explore-hero-search .btn { padding: 11px 22px; border-radius: 12px; }
  @media (max-width: 720px) {
    .explore-hero { padding: 24px 20px; }
    .explore-hero-search .btn { flex: 1; min-width: 0; }
  }

  /* ─── Toolbar / Filter pills ─── */
  .explore-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin: 0 0 18px;
  }
  .explore-filters {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
  }
  .explore-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 16px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease;
    line-height: 1.4;
  }
  .explore-filter:hover { color: var(--text-strong); text-decoration: none; }
  .explore-filter.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
  }
  .explore-toolbar-meta {
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .explore-toolbar-meta strong { color: var(--text); font-weight: 600; }

  /* ─── Topic chip ─── */
  .explore-topic-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .explore-topic-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.12);
    color: var(--text-strong);
    border: 1px solid rgba(140,109,255,0.30);
    font-size: 12.5px;
    font-weight: 600;
  }
  .explore-topic-clear {
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease;
  }
  .explore-topic-clear:hover { color: var(--accent); text-decoration: none; }

  /* ─── Repo cards grid ─── */
  .explore-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }
  .explore-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 20px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    text-decoration: none;
    color: inherit;
    transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  .explore-card:hover {
    transform: translateY(-2px);
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 12px 28px -16px rgba(0,0,0,0.55), 0 0 22px -8px rgba(140,109,255,0.20);
    text-decoration: none;
  }
  .explore-card-head {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .explore-card-avatar {
    width: 36px;
    height: 36px;
    border-radius: 9px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    flex-shrink: 0;
    letter-spacing: -0.01em;
  }
  .explore-card-name {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  .explore-card-owner {
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .explore-card-repo {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.018em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 120ms ease;
  }
  .explore-card:hover .explore-card-repo { color: var(--accent); }
  .explore-card-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .explore-card-meta {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: auto;
    font-size: 12px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .explore-card-meta-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-variant-numeric: tabular-nums;
  }
  .explore-card-badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .explore-pill {
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
  .explore-pill-private {
    background: rgba(255,180,94,0.10);
    color: #ffb45e;
    border: 1px solid rgba(255,180,94,0.28);
  }
  .explore-pill-fork {
    background: rgba(54,197,214,0.10);
    color: #36c5d6;
    border: 1px solid rgba(54,197,214,0.28);
  }
  .explore-pill-archived {
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .explore-pill-template {
    background: rgba(140,109,255,0.12);
    color: var(--text-strong);
    border: 1px solid rgba(140,109,255,0.30);
  }
  .explore-card-dot { color: rgba(140,109,255,0.7); }

  /* ─── Empty state ─── */
  .explore-empty {
    margin: 0;
    padding: 60px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .explore-empty::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .explore-empty-art {
    width: 88px;
    height: 88px;
    margin: 0 auto 18px;
    display: block;
    opacity: 0.85;
  }
  .explore-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .explore-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 auto 22px;
    max-width: 460px;
  }
  .explore-empty-cta {
    display: inline-flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
      `,
    }}
  />
);

function initials(name: string): string {
  if (!name) return "·";
  const clean = name.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!clean) return name.charAt(0).toUpperCase();
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function formatRelative(dateStr: string | Date): string {
  const date = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.floor(diffMonths / 12)}y ago`;
}

explore.get("/explore", async (c) => {
  const user = c.get("user");
  const q = c.req.query("q") || "";
  const sort = c.req.query("sort") || "recent";
  const topic = c.req.query("topic") || "";

  let repoList: Array<{
    repo: typeof repositories.$inferSelect;
    ownerName: string;
  }> = [];

  if (q.trim()) {
    // Search repos
    const results = await db
      .select({
        repo: repositories,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(
          eq(repositories.isPrivate, false),
          sql`(${repositories.name} ILIKE ${'%' + q + '%'} OR ${repositories.description} ILIKE ${'%' + q + '%'})`
        )
      )
      .orderBy(desc(repositories.starCount))
      .limit(50);

    repoList = results.map((r) => ({
      repo: r.repo,
      ownerName: r.ownerName,
    }));
  } else if (topic) {
    // Filter by topic
    const results = await db
      .select({
        repo: repositories,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .innerJoin(repoTopics, eq(repoTopics.repositoryId, repositories.id))
      .where(
        and(
          eq(repositories.isPrivate, false),
          eq(repoTopics.topic, topic.toLowerCase())
        )
      )
      .orderBy(desc(repositories.starCount))
      .limit(50);

    repoList = results.map((r) => ({
      repo: r.repo,
      ownerName: r.ownerName,
    }));
  } else {
    // Default: recent or popular
    const orderBy =
      sort === "stars"
        ? desc(repositories.starCount)
        : sort === "forks"
          ? desc(repositories.forkCount)
          : desc(repositories.createdAt);

    const results = await db
      .select({
        repo: repositories,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.isPrivate, false))
      .orderBy(orderBy)
      .limit(50);

    repoList = results.map((r) => ({
      repo: r.repo,
      ownerName: r.ownerName,
    }));
  }

  const sortLabel =
    sort === "stars"
      ? "most-starred"
      : sort === "forks"
        ? "most-forked"
        : "most recent";

  return c.html(
    <Layout title="Explore" user={user}>
      <ExploreStyle />
      <section class="explore-hero">
        <div class="explore-hero-bg" aria-hidden="true">
          <div class="explore-hero-orb" />
        </div>
        <div class="explore-hero-inner">
          <div class="explore-hero-text">
            <div class="explore-hero-eyebrow">Discover</div>
            <h1 class="explore-hero-title">
              What's <span class="gradient-text">shipping</span>.
            </h1>
            <p class="explore-hero-sub">
              {q
                ? `Searching public repos for "${q}".`
                : topic
                  ? `Public repos tagged with #${topic}.`
                  : "Browse public repositories built on Gluecron — AI-reviewed code, gate-checked pushes, and the people shipping them."}
            </p>
          </div>
          <form
            method="get"
            action="/explore"
            class="explore-hero-search"
            role="search"
          >
            <input
              type="search"
              name="q"
              value={q}
              placeholder="Search repos by name or description…"
              aria-label="Search repositories"
              autocomplete="off"
            />
            <button type="submit" class="btn btn-primary">
              Search
            </button>
          </form>
        </div>
      </section>

      {topic && (
        <div class="explore-topic-row">
          <span>Filtering by topic:</span>
          <span class="explore-topic-pill">
            <span aria-hidden="true">#</span>
            {topic}
          </span>
          <a href="/explore" class="explore-topic-clear">
            Clear filter
          </a>
        </div>
      )}

      <div class="explore-toolbar">
        <div
          class="explore-filters"
          role="tablist"
          aria-label="Sort repositories"
        >
          <a
            class={`explore-filter${sort === "stars" ? " is-active" : ""}`}
            href="/explore?sort=stars"
            role="tab"
            aria-selected={sort === "stars" ? "true" : "false"}
          >
            Trending
          </a>
          <a
            class={`explore-filter${sort === "forks" ? " is-active" : ""}`}
            href="/explore?sort=forks"
            role="tab"
            aria-selected={sort === "forks" ? "true" : "false"}
          >
            Most-forked
          </a>
          <a
            class={`explore-filter${sort === "recent" ? " is-active" : ""}`}
            href="/explore?sort=recent"
            role="tab"
            aria-selected={sort === "recent" ? "true" : "false"}
          >
            Recently active
          </a>
        </div>
        <div class="explore-toolbar-meta">
          {repoList.length > 0 ? (
            <span>
              <strong>{repoList.length}</strong> repo
              {repoList.length === 1 ? "" : "s"}
              {q ? <> matching "{q}"</> : <> · sorted by {sortLabel}</>}
            </span>
          ) : null}
        </div>
      </div>

      {repoList.length === 0 ? (
        <div class="explore-empty">
          <svg
            class="explore-empty-art"
            viewBox="0 0 96 96"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="exploreEmptyG" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop stop-color="#8c6dff" />
                <stop offset="1" stop-color="#36c5d6" />
              </linearGradient>
            </defs>
            <circle cx="42" cy="42" r="22" stroke="url(#exploreEmptyG)" stroke-width="4" />
            <path d="M58 58L78 78" stroke="url(#exploreEmptyG)" stroke-width="4" stroke-linecap="round" />
            <circle cx="42" cy="42" r="8" stroke="url(#exploreEmptyG)" stroke-width="3" opacity="0.55" />
          </svg>
          <h2 class="explore-empty-title">
            {q || topic ? "No matching repos" : "Nothing public yet"}
          </h2>
          <p class="explore-empty-sub">
            {q
              ? `We couldn't find any public repositories matching "${q}". Try a broader search or browse all repos.`
              : topic
                ? `No public repositories are tagged with #${topic}. Try a different topic or browse everything.`
                : "When public repositories are created they'll show up here. Be the first to ship something."}
          </p>
          <div class="explore-empty-cta">
            <a href="/explore" class="btn btn-primary">
              Reset filters
            </a>
            {user ? (
              <a href="/new" class="btn">
                New repository
              </a>
            ) : (
              <a href="/register" class="btn">
                Get started
              </a>
            )}
          </div>
        </div>
      ) : (
        <div class="explore-grid">
          {repoList.map(({ repo, ownerName }) => (
            <a
              class="explore-card"
              href={`/${ownerName}/${repo.name}`}
              aria-label={`${ownerName}/${repo.name}`}
            >
              <div class="explore-card-head">
                <div class="explore-card-avatar" aria-hidden="true">
                  {initials(ownerName)}
                </div>
                <div class="explore-card-name">
                  <span class="explore-card-owner">{ownerName}/</span>
                  <span class="explore-card-repo">{repo.name}</span>
                </div>
              </div>
              {repo.description && (
                <p class="explore-card-desc">{repo.description}</p>
              )}
              {(repo.isPrivate ||
                repo.forkedFromId ||
                repo.isArchived ||
                repo.isTemplate) && (
                <div class="explore-card-badges">
                  {repo.isPrivate && (
                    <span class="explore-pill explore-pill-private">
                      Private
                    </span>
                  )}
                  {repo.forkedFromId && (
                    <span class="explore-pill explore-pill-fork">
                      <span aria-hidden="true">{"⑂"}</span> Fork
                    </span>
                  )}
                  {repo.isTemplate && (
                    <span class="explore-pill explore-pill-template">
                      Template
                    </span>
                  )}
                  {repo.isArchived && (
                    <span class="explore-pill explore-pill-archived">
                      Archived
                    </span>
                  )}
                </div>
              )}
              <div class="explore-card-meta">
                <span class="explore-card-meta-item" title="Stars">
                  <span aria-hidden="true">{"★"}</span>
                  {repo.starCount}
                </span>
                <span class="explore-card-meta-item" title="Forks">
                  <span aria-hidden="true">{"⑂"}</span>
                  {repo.forkCount}
                </span>
                {repo.pushedAt && (
                  <span class="explore-card-meta-item" title="Last push">
                    <span class="explore-card-dot" aria-hidden="true">
                      {"●"}
                    </span>
                    Pushed {formatRelative(repo.pushedAt.toString())}
                  </span>
                )}
              </div>
            </a>
          ))}
        </div>
      )}
    </Layout>
  );
});

export default explore;

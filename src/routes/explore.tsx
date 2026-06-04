/**
 * Explore page — discover public repositories, search, trending.
 *
 * Visual polish (2026 pass): adopts the design language from the
 * admin-hero (07f4b70), tile-grid (cf793f9), and build-agent-integration
 * (4a80519) commits. Hero gets a larger clamp(40-72px) gradient title,
 * a drifting orb, and a tighter eyebrow + sub layout. Repo cards now
 * use a gradient hairline that lights up on hover, a polished
 * star/fork/lang chip row with tabular-nums, and ARIA-aware focus
 * rings. Filter pills sit in a glass capsule, pagination/limit hint
 * is surfaced as a dashed footer card, and the empty state keeps the
 * orbiting search orb. All CSS is scoped under `.explore-*`. Route
 * handler, query semantics, sort/topic/q params, and ordering are
 * unchanged from the pre-polish version.
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
  .explore-wrap { max-width: 1320px; margin: 0 auto; }

  /* ─── Hero ─── */
  .explore-hero {
    position: relative;
    margin: 4px 0 28px;
    padding: 40px 36px 36px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .explore-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .explore-hero-bg {
    position: absolute;
    inset: -35% -12% auto auto;
    width: 460px;
    height: 460px;
    pointer-events: none;
    z-index: 0;
  }
  .explore-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    animation: exploreHeroOrb 16s ease-in-out infinite;
  }
  .explore-hero-orb-2 {
    position: absolute;
    inset: auto auto -25% -15%;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(54,197,214,0.16), rgba(140,109,255,0.06) 50%, transparent 75%);
    filter: blur(70px);
    opacity: 0.55;
    pointer-events: none;
    z-index: 0;
    animation: exploreHeroOrb2 18s ease-in-out infinite;
  }
  @keyframes exploreHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.65; }
    50%      { transform: scale(1.12) translate(-14px, 10px); opacity: 0.92; }
  }
  @keyframes exploreHeroOrb2 {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.45; }
    50%      { transform: scale(1.08) translate(16px, -8px); opacity: 0.72; }
  }
  @media (prefers-reduced-motion: reduce) {
    .explore-hero-orb, .explore-hero-orb-2 { animation: none; }
  }
  .explore-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .explore-hero-text { flex: 1; min-width: 280px; }
  .explore-hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 12px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    font-weight: 700;
  }
  .explore-hero-eyebrow-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .explore-hero-title {
    font-family: var(--font-display);
    font-size: clamp(40px, 6.5vw, 72px);
    font-weight: 800;
    letter-spacing: -0.032em;
    line-height: 1.02;
    margin: 0 0 14px;
    color: var(--text-strong);
  }
  .explore-hero-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 45%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .explore-hero-sub {
    font-size: 15.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 640px;
  }
  .explore-hero-search {
    display: flex;
    gap: 10px;
    align-items: stretch;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .explore-hero-search-field {
    position: relative;
    flex: 1;
    min-width: 240px;
  }
  .explore-hero-search-icon {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px; height: 16px;
    color: var(--text-faint);
    pointer-events: none;
    z-index: 1;
  }
  .explore-hero-search input[type="search"] {
    width: 100%;
    padding: 12px 16px 12px 40px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text);
    font-size: 14.5px;
    font-family: inherit;
    transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
  }
  .explore-hero-search input[type="search"]::placeholder {
    color: var(--text-faint);
  }
  .explore-hero-search input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.65);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.14);
    background: var(--bg-secondary);
  }
  .explore-hero-search .btn { padding: 12px 22px; border-radius: 12px; }
  @media (max-width: 720px) {
    .explore-hero { padding: 28px 22px 26px; }
    .explore-hero-search .btn { flex: 1; min-width: 0; }
  }

  /* ─── Toolbar / Filter pills ─── */
  .explore-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin: 0 0 20px;
  }
  .explore-filters {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset;
  }
  .explore-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease, transform 120ms ease;
    line-height: 1.4;
  }
  .explore-filter:hover { color: var(--text-strong); text-decoration: none; }
  .explore-filter.is-active {
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.14));
    color: var(--text-strong);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
  }
  .explore-filter-icon {
    width: 13px; height: 13px;
    display: inline-block;
    opacity: 0.9;
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
    flex-wrap: wrap;
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

  /* ─── Section header (results category) ─── */
  .explore-section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin: 28px 0 14px;
    padding: 0 2px;
    flex-wrap: wrap;
  }
  .explore-section-head:first-of-type { margin-top: 4px; }
  .explore-section-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .explore-section-title-bar {
    display: inline-block;
    width: 3px;
    height: 16px;
    border-radius: 2px;
    background: linear-gradient(180deg, #8c6dff, #36c5d6);
  }
  .explore-section-sub {
    font-size: 12.5px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

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
    overflow: hidden;
    transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  /* Gradient hairline on hover */
  .explore-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0;
    transition: opacity 180ms ease;
    pointer-events: none;
  }
  .explore-card:hover {
    transform: translateY(-3px);
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 14px 30px -16px rgba(0,0,0,0.55), 0 0 24px -8px rgba(140,109,255,0.22);
    text-decoration: none;
  }
  .explore-card:hover::before { opacity: 0.85; }
  .explore-card:focus-visible {
    outline: none;
    border-color: rgba(140,109,255,0.65);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.22);
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
    box-shadow: 0 4px 12px -4px rgba(140,109,255,0.45);
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
  .explore-card:hover .explore-card-repo { color: var(--accent-hover); }
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
  .explore-card-desc-empty {
    font-size: 13px;
    color: var(--text-faint);
    margin: 0;
    font-style: italic;
  }
  .explore-card-meta {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: auto;
    padding-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
    flex-wrap: wrap;
    font-variant-numeric: tabular-nums;
  }
  .explore-card-meta-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-variant-numeric: tabular-nums;
  }
  .explore-card-meta-icon {
    width: 12px; height: 12px;
    color: var(--text-faint);
    display: inline-block;
  }
  .explore-card:hover .explore-card-meta-icon { color: var(--accent); }
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

  /* ─── Loading skeleton (used when JS later swaps in async fragments) ─── */
  .explore-skel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }
  .explore-skel {
    padding: 18px 20px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 140px;
  }
  .explore-skel-row {
    height: 12px;
    border-radius: 6px;
    background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 100%);
    background-size: 200% 100%;
    animation: exploreSkelPulse 1.4s ease-in-out infinite;
  }
  .explore-skel-row.is-title { height: 16px; width: 60%; }
  .explore-skel-row.is-line  { width: 100%; }
  .explore-skel-row.is-short { width: 40%; }
  @keyframes exploreSkelPulse {
    0%   { background-position: 200% 0; opacity: 0.7; }
    100% { background-position: -200% 0; opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .explore-skel-row { animation: none; }
  }

  /* ─── Empty state ─── */
  .explore-empty {
    margin: 0;
    padding: 64px 32px;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 18px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .explore-empty::before {
    content: '';
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 50%, transparent 75%);
    filter: blur(70px);
    opacity: 0.55;
    pointer-events: none;
    animation: exploreHeroOrb 16s ease-in-out infinite;
  }
  .explore-empty-art {
    width: 88px;
    height: 88px;
    margin: 0 auto 18px;
    display: block;
    opacity: 0.92;
    position: relative;
    z-index: 1;
  }
  .explore-empty-title {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    margin: 0 0 8px;
    position: relative;
    z-index: 1;
  }
  .explore-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 auto 22px;
    max-width: 480px;
    position: relative;
    z-index: 1;
  }
  .explore-empty-cta {
    display: inline-flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
    position: relative;
    z-index: 1;
  }

  /* ─── Footer hint (limit + suggest search) ─── */
  .explore-foot {
    margin-top: 28px;
    padding: 18px 22px;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
  }
  .explore-foot-text {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    flex: 1;
    min-width: 200px;
  }
  .explore-foot-text strong {
    color: var(--text);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .explore-foot-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* ─── Mobile (≤720px) ─── */
  @media (max-width: 720px) {
    .explore-wrap { padding: 0 2px; }
    .explore-hero-search-field { min-width: 0; width: 100%; }
    .explore-hero-search input[type="search"] { padding: 14px 14px 14px 38px; min-height: 44px; }
    .explore-toolbar { flex-direction: column; align-items: stretch; }
    .explore-filters { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .explore-filter { min-height: 40px; padding: 10px 14px; }
    .explore-grid { grid-template-columns: 1fr; }
    .explore-skel-grid { grid-template-columns: 1fr; }
    .explore-card { padding: 14px 16px; }
    .explore-empty { padding: 40px 20px; }
    .explore-foot { flex-direction: column; align-items: stretch; padding: 16px 18px; }
    .explore-foot-actions { width: 100%; }
    .explore-foot-actions .btn { flex: 1; min-width: 0; }
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

  // ── Loading skeleton (flag-gated) ──
  // Renders the explore shell + card-grid skeleton when `?skeleton=1`
  // is set. Re-uses the existing `.explore-skel-*` styles from
  // ExploreStyle. Behind a flag so we don't flash empty placeholders
  // before the real list lands.
  if (c.req.query("skeleton") === "1") {
    return c.html(
      <Layout title="Explore" user={user}>
        <ExploreStyle />
        <div class="explore-wrap">
          <section class="explore-hero" aria-hidden="true">
            <div class="explore-hero-bg">
              <div class="explore-hero-orb" />
            </div>
            <div class="explore-hero-orb-2" />
            <div class="explore-hero-inner">
              <div class="explore-hero-text">
                <div class="explore-hero-eyebrow">
                  <span class="explore-hero-eyebrow-dot" />
                  Discover
                </div>
                <h1 class="explore-hero-title">
                  What&rsquo;s{" "}
                  <span class="explore-hero-title-grad">shipping</span>.
                </h1>
                <p class="explore-hero-sub">
                  Loading public repositories…
                </p>
              </div>
            </div>
          </section>
          <div class="explore-skel-grid" aria-hidden="true">
            {Array.from({ length: 9 }).map(() => (
              <div class="explore-skel">
                <div class="explore-skel-row is-title" />
                <div class="explore-skel-row is-line" />
                <div class="explore-skel-row is-line" />
                <div class="explore-skel-row is-short" />
              </div>
            ))}
          </div>
          <span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0" role="status" aria-live="polite">
            Loading public repositories…
          </span>
        </div>
      </Layout>
    );
  }

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

  const sectionTitle = q
    ? `Search results`
    : topic
      ? `Tagged #${topic}`
      : sort === "stars"
        ? `Trending repositories`
        : sort === "forks"
          ? `Most-forked repositories`
          : `Recently active`;

  const sectionSub = q
    ? `Public repositories matching "${q}"`
    : topic
      ? `Public repositories tagged with this topic`
      : sort === "stars"
        ? `Sorted by stars across the platform`
        : sort === "forks"
          ? `Sorted by fork count across the platform`
          : `Sorted by repository creation date`;

  return c.html(
    <Layout title="Explore" user={user}>
      <ExploreStyle />
      <div class="explore-wrap">
        <section class="explore-hero">
          <div class="explore-hero-bg" aria-hidden="true">
            <div class="explore-hero-orb" />
          </div>
          <div class="explore-hero-orb-2" aria-hidden="true" />
          <div class="explore-hero-inner">
            <div class="explore-hero-text">
              <div class="explore-hero-eyebrow">
                <span class="explore-hero-eyebrow-dot" aria-hidden="true" />
                Discover
              </div>
              <h1 class="explore-hero-title">
                What&rsquo;s{" "}
                <span class="explore-hero-title-grad">shipping</span>.
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
              <div class="explore-hero-search-field">
                <svg
                  class="explore-hero-search-icon"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <circle
                    cx="7"
                    cy="7"
                    r="5"
                    stroke="currentColor"
                    stroke-width="1.6"
                  />
                  <path
                    d="M11 11L14 14"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                  />
                </svg>
                <input
                  type="search"
                  name="q"
                  value={q}
                  placeholder="Search repos by name or description…"
                  aria-label="Search repositories"
                  autocomplete="off"
                />
              </div>
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
              <svg
                class="explore-filter-icon"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 1.5l1.95 4.02 4.43.65-3.21 3.12.76 4.41L8 11.62l-3.93 2.08.76-4.41L1.62 6.17l4.43-.65L8 1.5z" />
              </svg>
              Trending
            </a>
            <a
              class={`explore-filter${sort === "forks" ? " is-active" : ""}`}
              href="/explore?sort=forks"
              role="tab"
              aria-selected={sort === "forks" ? "true" : "false"}
            >
              <svg
                class="explore-filter-icon"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                aria-hidden="true"
              >
                <circle cx="4" cy="3" r="1.6" />
                <circle cx="12" cy="3" r="1.6" />
                <circle cx="8" cy="13" r="1.6" />
                <path d="M4 4.5v2.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4.5M8 9v2.5" stroke-linecap="round" />
              </svg>
              Most-forked
            </a>
            <a
              class={`explore-filter${sort === "recent" ? " is-active" : ""}`}
              href="/explore?sort=recent"
              role="tab"
              aria-selected={sort === "recent" ? "true" : "false"}
            >
              <svg
                class="explore-filter-icon"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5V8l2.5 1.5" stroke-linecap="round" />
              </svg>
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
                <linearGradient
                  id="exploreEmptyG"
                  x1="0"
                  y1="0"
                  x2="96"
                  y2="96"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stop-color="#8c6dff" />
                  <stop offset="1" stop-color="#36c5d6" />
                </linearGradient>
              </defs>
              <circle
                cx="42"
                cy="42"
                r="22"
                stroke="url(#exploreEmptyG)"
                stroke-width="4"
              />
              <path
                d="M58 58L78 78"
                stroke="url(#exploreEmptyG)"
                stroke-width="4"
                stroke-linecap="round"
              />
              <circle
                cx="42"
                cy="42"
                r="8"
                stroke="url(#exploreEmptyG)"
                stroke-width="3"
                opacity="0.55"
              />
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
          <>
            <div class="explore-section-head">
              <h2 class="explore-section-title">
                <span
                  class="explore-section-title-bar"
                  aria-hidden="true"
                />
                {sectionTitle}
              </h2>
              <span class="explore-section-sub">{sectionSub}</span>
            </div>
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
                  {repo.description ? (
                    <p class="explore-card-desc">{repo.description}</p>
                  ) : (
                    <p class="explore-card-desc-empty">No description yet.</p>
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
                      <svg
                        class="explore-card-meta-icon"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M8 1.5l1.95 4.02 4.43.65-3.21 3.12.76 4.41L8 11.62l-3.93 2.08.76-4.41L1.62 6.17l4.43-.65L8 1.5z" />
                      </svg>
                      {repo.starCount}
                    </span>
                    <span class="explore-card-meta-item" title="Forks">
                      <svg
                        class="explore-card-meta-icon"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        aria-hidden="true"
                      >
                        <circle cx="4" cy="3" r="1.4" />
                        <circle cx="12" cy="3" r="1.4" />
                        <circle cx="8" cy="13" r="1.4" />
                        <path
                          d="M4 4.5v2.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4.5M8 9v2.5"
                          stroke-linecap="round"
                        />
                      </svg>
                      {repo.forkCount}
                    </span>
                    {repo.pushedAt && (
                      <span class="explore-card-meta-item" title="Last push">
                        <svg
                          class="explore-card-meta-icon"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.6"
                          aria-hidden="true"
                        >
                          <circle cx="8" cy="8" r="6" />
                          <path d="M8 4.5V8l2.5 1.5" stroke-linecap="round" />
                        </svg>
                        {formatRelative(repo.pushedAt.toString())}
                      </span>
                    )}
                  </div>
                </a>
              ))}
            </div>

            {repoList.length >= 50 && (
              <div class="explore-foot">
                <p class="explore-foot-text">
                  Showing the first <strong>50</strong> matches. Refine with
                  search or a topic filter to surface more repositories.
                </p>
                <div class="explore-foot-actions">
                  <a href="/explore" class="btn">
                    Reset
                  </a>
                  {user ? (
                    <a href="/new" class="btn btn-primary">
                      New repository
                    </a>
                  ) : (
                    <a href="/register" class="btn btn-primary">
                      Sign up
                    </a>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
});

export default explore;

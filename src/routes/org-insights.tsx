/**
 * Block F2 — Org-wide insights.
 *
 *   GET /orgs/:slug/insights  — rollup across every repo owned by the org:
 *                               gate green-rate, open/merged PR counts, open
 *                               issue count, recent gate activity, per-repo
 *                               rows sorted by activity.
 *
 * No new tables — computed live from existing `repositories`, `gate_runs`,
 * `pull_requests`, `issues`.
 *
 * 2026 polish: gradient-hairline hero + radial orb + aggregated stat-card
 * grid + leaderboard cards for most-active repos and most-active
 * contributors. Every class prefixed `.org-ins-` so this surface can't
 * bleed into the wider polish. Route + `computeOrgInsights()` contract
 * preserved exactly (extended with an optional `topContributors` field).
 */

import { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  gateRuns,
  issues,
  organizations,
  orgMembers,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const orgInsights = new Hono<AuthEnv>();
orgInsights.use("*", softAuth);

export interface OrgInsightsSummary {
  repoCount: number;
  gateRunsTotal: number;
  gatePassed: number;
  gateFailed: number;
  gateRepaired: number;
  greenRate: number; // 0..1
  openIssues: number;
  openPrs: number;
  mergedPrs30d: number;
  perRepo: Array<{
    id: string;
    name: string;
    runs: number;
    greenRate: number;
    openPrs: number;
    openIssues: number;
  }>;
  /** Most-active contributors (by total PRs opened in this org). Optional so
   *  the contract stays backwards-compatible with existing callers/tests. */
  topContributors?: Array<{ username: string; prs: number; merged: number }>;
}

export async function computeOrgInsights(
  orgId: string
): Promise<OrgInsightsSummary> {
  const empty: OrgInsightsSummary = {
    repoCount: 0,
    gateRunsTotal: 0,
    gatePassed: 0,
    gateFailed: 0,
    gateRepaired: 0,
    greenRate: 0,
    openIssues: 0,
    openPrs: 0,
    mergedPrs30d: 0,
    perRepo: [],
    topContributors: [],
  };

  try {
    const repos = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(eq(repositories.orgId, orgId));
    if (repos.length === 0) return empty;

    const repoIds = repos.map((r) => r.id);
    const idList = sql.raw(
      repoIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")
    );

    // Aggregate gate runs across repos
    const gateRows = await db
      .select({
        repoId: gateRuns.repositoryId,
        status: gateRuns.status,
        n: sql<number>`count(*)::int`,
      })
      .from(gateRuns)
      .where(sql`${gateRuns.repositoryId} IN (${idList})`)
      .groupBy(gateRuns.repositoryId, gateRuns.status);

    const totals = {
      passed: 0,
      failed: 0,
      repaired: 0,
      skipped: 0,
    } as Record<string, number>;
    const byRepo = new Map<
      string,
      { runs: number; passed: number; failed: number; repaired: number }
    >();
    for (const r of gateRows) {
      const n = Number(r.n);
      totals[r.status] = (totals[r.status] || 0) + n;
      const b = byRepo.get(r.repoId) || {
        runs: 0,
        passed: 0,
        failed: 0,
        repaired: 0,
      };
      b.runs += n;
      if (r.status === "passed") b.passed += n;
      else if (r.status === "failed") b.failed += n;
      else if (r.status === "repaired") b.repaired += n;
      byRepo.set(r.repoId, b);
    }
    const gateRunsTotal = Object.values(totals).reduce((a, b) => a + b, 0);
    const gatePassed = totals.passed || 0;
    const gateFailed = totals.failed || 0;
    const gateRepaired = totals.repaired || 0;
    const greenRate = gateRunsTotal
      ? (gatePassed + gateRepaired) / gateRunsTotal
      : 0;

    // Open issues/PRs across org repos
    const issueRows = await db
      .select({
        repoId: issues.repositoryId,
        state: issues.state,
        n: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(sql`${issues.repositoryId} IN (${idList})`)
      .groupBy(issues.repositoryId, issues.state);

    const openIssuesByRepo = new Map<string, number>();
    let openIssues = 0;
    for (const r of issueRows) {
      if (r.state === "open") {
        openIssuesByRepo.set(r.repoId, Number(r.n));
        openIssues += Number(r.n);
      }
    }

    const prRows = await db
      .select({
        repoId: pullRequests.repositoryId,
        state: pullRequests.state,
        n: sql<number>`count(*)::int`,
      })
      .from(pullRequests)
      .where(sql`${pullRequests.repositoryId} IN (${idList})`)
      .groupBy(pullRequests.repositoryId, pullRequests.state);

    const openPrsByRepo = new Map<string, number>();
    let openPrs = 0;
    for (const r of prRows) {
      if (r.state === "open") {
        openPrsByRepo.set(r.repoId, Number(r.n));
        openPrs += Number(r.n);
      }
    }

    // Merged PRs in last 30d
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [mergedRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pullRequests)
      .where(
        and(
          sql`${pullRequests.repositoryId} IN (${idList})`,
          eq(pullRequests.state, "merged"),
          gte(pullRequests.mergedAt, since)
        )
      );

    // Top contributors — by PR count across org repos. Wrapped separately so
    // a failure here doesn't take down the whole rollup.
    let topContributors: NonNullable<
      OrgInsightsSummary["topContributors"]
    > = [];
    try {
      const contribRows = await db
        .select({
          username: users.username,
          prs: sql<number>`count(*)::int`,
          merged: sql<number>`count(*) filter (where ${pullRequests.state} = 'merged')::int`,
        })
        .from(pullRequests)
        .innerJoin(users, eq(pullRequests.authorId, users.id))
        .where(sql`${pullRequests.repositoryId} IN (${idList})`)
        .groupBy(users.username)
        .orderBy(sql`count(*) desc`)
        .limit(8);
      topContributors = contribRows.map((r) => ({
        username: r.username,
        prs: Number(r.prs || 0),
        merged: Number(r.merged || 0),
      }));
    } catch {
      topContributors = [];
    }

    const perRepo = repos.map((r) => {
      const b = byRepo.get(r.id) || {
        runs: 0,
        passed: 0,
        failed: 0,
        repaired: 0,
      };
      const green = b.runs
        ? (b.passed + b.repaired) / b.runs
        : 0;
      return {
        id: r.id,
        name: r.name,
        runs: b.runs,
        greenRate: green,
        openPrs: openPrsByRepo.get(r.id) || 0,
        openIssues: openIssuesByRepo.get(r.id) || 0,
      };
    });
    perRepo.sort((a, b) => b.runs - a.runs);

    return {
      repoCount: repos.length,
      gateRunsTotal,
      gatePassed,
      gateFailed,
      gateRepaired,
      greenRate,
      openIssues,
      openPrs,
      mergedPrs30d: Number(mergedRow?.n || 0),
      perRepo,
      topContributors,
    };
  } catch {
    return empty;
  }
}

async function loadOrg(slug: string) {
  try {
    const [o] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    return o || null;
  } catch {
    return null;
  }
}

async function isOrgMember(orgId: string, userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.org-ins-` so this surface can't
 * bleed into the wider polish. Mirrors the gradient-hairline hero +
 * stat-card grid + leaderboard pattern from `insights.tsx`.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .org-ins-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  .org-ins-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .org-ins-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .org-ins-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .org-ins-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .org-ins-hero-text { max-width: 720px; }
  .org-ins-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .org-ins-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .org-ins-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .org-ins-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .org-ins-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }
  .org-ins-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 10px;
    border: 1px solid var(--border-strong, var(--border));
    background: transparent;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    transition: background 120ms ease, border-color 120ms ease;
    white-space: nowrap;
  }
  .org-ins-back:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    text-decoration: none;
  }

  /* Stat-card grid */
  .org-ins-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .org-ins-stat {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .org-ins-stat:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .org-ins-stat-label {
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 6px;
  }
  .org-ins-stat-value {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .org-ins-stat-value.is-good { color: #6ee7b7; }
  .org-ins-stat-value.is-warn { color: #fca5a5; }
  .org-ins-stat-value.is-info { color: #93c5fd; }
  .org-ins-stat-value.is-accent {
    background-image: linear-gradient(135deg, #a48bff 0%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .org-ins-stat-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Gate-status mini stat row */
  .org-ins-gates {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .org-ins-gate {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
    text-align: center;
  }
  .org-ins-gate-value {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .org-ins-gate-value.is-good { color: #6ee7b7; }
  .org-ins-gate-value.is-warn { color: #fca5a5; }
  .org-ins-gate-value.is-soft { color: #c4b5fd; }
  .org-ins-gate-label {
    margin-top: 6px;
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
  }

  /* Section heading */
  .org-ins-section-head {
    margin: 0 0 var(--space-3);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .org-ins-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .org-ins-section-sub { font-size: 12.5px; color: var(--text-muted); }

  /* Two-column leaderboard layout */
  .org-ins-twocol {
    display: grid;
    grid-template-columns: 1.2fr 0.8fr;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  @media (max-width: 820px) {
    .org-ins-twocol { grid-template-columns: 1fr; }
  }

  /* Leaderboard cards */
  .org-ins-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .org-ins-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .org-ins-card:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .org-ins-rank {
    flex: none;
    width: 28px; height: 28px;
    border-radius: 8px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .org-ins-rank.is-1 {
    background: linear-gradient(135deg, rgba(140,109,255,0.30), rgba(54,197,214,0.30));
    color: #fff;
  }
  .org-ins-card-main { flex: 1; min-width: 0; }
  .org-ins-card-title {
    font-family: var(--font-display);
    font-size: 14.5px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.005em;
    line-height: 1.3;
    margin: 0 0 4px;
    word-break: break-word;
  }
  .org-ins-card-title a { color: inherit; text-decoration: none; }
  .org-ins-card-title a:hover { color: var(--accent); }
  .org-ins-card-sub {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .org-ins-card-meta {
    flex: none;
    text-align: right;
    font-family: var(--font-mono);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .org-ins-card-meta.is-good { color: #6ee7b7; }
  .org-ins-card-meta.is-warn { color: #fca5a5; }
  .org-ins-card-meta.is-mid { color: #fcd34d; }
  .org-ins-card-meta.is-muted { color: var(--text-muted); }

  .org-ins-avatar {
    flex: none;
    width: 32px; height: 32px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18);
  }

  /* Empty state — dashed orb card */
  .org-ins-empty {
    position: relative;
    overflow: hidden;
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 16px;
    background: rgba(255,255,255,0.012);
    color: var(--text-muted);
  }
  .org-ins-empty::before {
    content: '';
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.14), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .org-ins-empty-inner { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .org-ins-empty strong {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
  }
  .org-ins-empty p { font-size: 13px; margin: 0; max-width: 420px; }
  .org-ins-empty .cta {
    display: inline-flex;
    align-items: center;
    padding: 9px 16px;
    border-radius: 10px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .org-ins-empty .cta:hover { text-decoration: none; transform: translateY(-1px); }
`;

function initials(name: string): string {
  if (!name) return "?";
  return name.slice(0, 2);
}

orgInsights.get("/orgs/:slug/insights", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const org = await loadOrg(slug);
  if (!org) return c.notFound();
  const member = await isOrgMember(org.id, user.id);
  if (!member) return c.redirect(`/orgs/${slug}`);

  const summary = await computeOrgInsights(org.id);
  const pct = (n: number) => Math.round(n * 100);
  const contributors = summary.topContributors || [];

  // Total commit proxy — `gateRunsTotal` is the closest aggregated signal
  // we already collect (each push triggers a gate run). Surfaced as
  // "Tracked runs" rather than literal "commits" so the number is honest.
  const totalRuns = summary.gateRunsTotal;

  return c.html(
    <Layout title={`${org.name} — Insights`} user={user}>
      <div class="org-ins-wrap">
        <section class="org-ins-hero">
          <div class="org-ins-hero-orb" aria-hidden="true" />
          <div class="org-ins-hero-inner">
            <div class="org-ins-hero-text">
              <div class="org-ins-eyebrow">
                <span class="org-ins-eyebrow-dot" aria-hidden="true" />
                Org insights · {slug}
              </div>
              <h2 class="org-ins-title">
                <span class="org-ins-title-grad">{org.name}</span>
              </h2>
              <p class="org-ins-sub">
                Aggregated health across every repo in the org — gate runs,
                pull-request flow, open issues, and the people moving things
                forward.
              </p>
            </div>
            <a href={`/orgs/${slug}`} class="org-ins-back">
              ← Back to {slug}
            </a>
          </div>
        </section>

        <div class="org-ins-stats">
          <div class="org-ins-stat">
            <div class="org-ins-stat-label">Repositories</div>
            <div class="org-ins-stat-value">
              {summary.repoCount.toLocaleString()}
            </div>
            <div class="org-ins-stat-hint">Owned by this org</div>
          </div>
          <div class="org-ins-stat">
            <div class="org-ins-stat-label">Contributors</div>
            <div class="org-ins-stat-value is-info">
              {contributors.length.toLocaleString()}
            </div>
            <div class="org-ins-stat-hint">Distinct PR authors</div>
          </div>
          <div class="org-ins-stat">
            <div class="org-ins-stat-label">Tracked runs</div>
            <div class="org-ins-stat-value is-accent">
              {totalRuns.toLocaleString()}
            </div>
            <div class="org-ins-stat-hint">All-time gate executions</div>
          </div>
          <div class="org-ins-stat">
            <div class="org-ins-stat-label">Open issues</div>
            <div
              class={
                "org-ins-stat-value" +
                (summary.openIssues > 0 ? " is-warn" : "")
              }
            >
              {summary.openIssues.toLocaleString()}
            </div>
            <div class="org-ins-stat-hint">Across all repos</div>
          </div>
        </div>

        <div class="org-ins-stats">
          <div class="org-ins-stat">
            <div class="org-ins-stat-label">Green rate</div>
            <div
              class={
                "org-ins-stat-value" +
                (summary.greenRate >= 0.9
                  ? " is-good"
                  : summary.greenRate >= 0.7
                    ? ""
                    : " is-warn")
              }
            >
              {pct(summary.greenRate)}%
            </div>
            <div class="org-ins-stat-hint">Passed + repaired ÷ total</div>
          </div>
          <div class="org-ins-stat">
            <div class="org-ins-stat-label">Open PRs</div>
            <div class="org-ins-stat-value is-info">
              {summary.openPrs.toLocaleString()}
            </div>
            <div class="org-ins-stat-hint">Across all repos</div>
          </div>
          <div class="org-ins-stat">
            <div class="org-ins-stat-label">Merged 30d</div>
            <div class="org-ins-stat-value is-accent">
              {summary.mergedPrs30d.toLocaleString()}
            </div>
            <div class="org-ins-stat-hint">Pull requests merged</div>
          </div>
          <div class="org-ins-stat">
            <div class="org-ins-stat-label">Gate runs</div>
            <div class="org-ins-stat-value">
              {summary.gateRunsTotal.toLocaleString()}
            </div>
            <div class="org-ins-stat-hint">Total recorded</div>
          </div>
        </div>

        <div class="org-ins-gates">
          <div class="org-ins-gate">
            <div class="org-ins-gate-value is-good">
              {summary.gatePassed.toLocaleString()}
            </div>
            <div class="org-ins-gate-label">Passed</div>
          </div>
          <div class="org-ins-gate">
            <div class="org-ins-gate-value is-soft">
              {summary.gateRepaired.toLocaleString()}
            </div>
            <div class="org-ins-gate-label">Repaired</div>
          </div>
          <div class="org-ins-gate">
            <div class="org-ins-gate-value is-warn">
              {summary.gateFailed.toLocaleString()}
            </div>
            <div class="org-ins-gate-label">Failed</div>
          </div>
        </div>

        <div class="org-ins-twocol">
          <div>
            <div class="org-ins-section-head">
              <h3 class="org-ins-section-title">Most-active repos</h3>
              <span class="org-ins-section-sub">
                {summary.perRepo.length} total
              </span>
            </div>
            {summary.perRepo.length === 0 ? (
              <div class="org-ins-empty">
                <div class="org-ins-empty-inner">
                  <strong>No repositories yet</strong>
                  <p>
                    Create the first repo in {org.name} to start collecting
                    insights across the org.
                  </p>
                  <a href="/new" class="cta">
                    + New repository
                  </a>
                </div>
              </div>
            ) : (
              <div class="org-ins-list">
                {summary.perRepo.map((r, i) => (
                  <div class="org-ins-card">
                    <div class={"org-ins-rank" + (i === 0 ? " is-1" : "")}>
                      {i + 1}
                    </div>
                    <div class="org-ins-card-main">
                      <h4 class="org-ins-card-title">
                        <a href={`/${slug}/${r.name}`}>
                          {slug}/{r.name}
                        </a>
                      </h4>
                      <p class="org-ins-card-sub">
                        {r.runs.toLocaleString()} run
                        {r.runs === 1 ? "" : "s"} ·{" "}
                        {r.openPrs.toLocaleString()} open PR
                        {r.openPrs === 1 ? "" : "s"} ·{" "}
                        {r.openIssues.toLocaleString()} open issue
                        {r.openIssues === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div
                      class={
                        "org-ins-card-meta " +
                        (r.runs === 0
                          ? "is-muted"
                          : r.greenRate >= 0.9
                            ? "is-good"
                            : r.greenRate >= 0.7
                              ? "is-mid"
                              : "is-warn")
                      }
                    >
                      {r.runs > 0 ? `${pct(r.greenRate)}%` : "—"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div class="org-ins-section-head">
              <h3 class="org-ins-section-title">Top contributors</h3>
              <span class="org-ins-section-sub">
                {contributors.length} of recent
              </span>
            </div>
            {contributors.length === 0 ? (
              <div class="org-ins-empty">
                <div class="org-ins-empty-inner">
                  <strong>No contributors yet</strong>
                  <p>
                    Once people open pull requests across the org, the
                    leaderboard fills in here.
                  </p>
                </div>
              </div>
            ) : (
              <div class="org-ins-list">
                {contributors.map((c, i) => (
                  <div class="org-ins-card">
                    <div class={"org-ins-rank" + (i === 0 ? " is-1" : "")}>
                      {i + 1}
                    </div>
                    <div
                      class="org-ins-avatar"
                      aria-label={`@${c.username}`}
                    >
                      {initials(c.username)}
                    </div>
                    <div class="org-ins-card-main">
                      <h4 class="org-ins-card-title">
                        <a href={`/${c.username}`}>@{c.username}</a>
                      </h4>
                      <p class="org-ins-card-sub">
                        {c.prs.toLocaleString()} PR
                        {c.prs === 1 ? "" : "s"} · {c.merged.toLocaleString()}{" "}
                        merged
                      </p>
                    </div>
                    <div class="org-ins-card-meta is-muted">
                      {c.prs.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

export default orgInsights;

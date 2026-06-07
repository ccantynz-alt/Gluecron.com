/**
 * Engineering Intelligence Dashboard
 *
 * An executive-level analytics surface for CTOs and VPs of Engineering.
 * Answers: "Which team is shipping the most? Where is technical debt
 * accumulating? Which developers are blocked? What's the velocity trend?"
 *
 * Routes:
 *   GET /insights                    — org-level dashboard (all repos the user has access to)
 *   GET /:owner/:repo/insights/engineering — per-repo analytics
 *   GET /insights/api/summary        — JSON endpoint for the main KPIs
 *
 * No new migrations needed — queries existing tables only.
 */

import { Hono } from "hono";
import { db } from "../db";
import {
  repositories,
  pullRequests,
  issues,
  issueComments,
  activityFeed,
  users,
  prComments,
  gateRuns,
  prReviews,
} from "../db/schema";
import {
  eq,
  and,
  gte,
  lte,
  sql,
  desc,
  isNotNull,
  inArray,
  ilike,
  or,
  count,
  avg,
} from "drizzle-orm";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getUnreadCount } from "../lib/unread";

const engineeringInsights = new Hono<AuthEnv>();
engineeringInsights.use("*", softAuth);

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .ei-wrap {
    max-width: 1280px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* Hero */
  .ei-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ei-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #6366f1 25%, #8b5cf6 50%, #06b6d4 75%, transparent 100%);
    opacity: 0.8;
    pointer-events: none;
  }
  .ei-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(99,102,241,0.18), rgba(6,182,212,0.08) 45%, transparent 70%);
    filter: blur(90px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .ei-hero-inner { position: relative; z-index: 1; }
  .ei-hero-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .ei-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 12px;
  }
  .ei-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #6366f1, #06b6d4);
    box-shadow: 0 0 0 3px rgba(99,102,241,0.18);
  }
  .ei-hero-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 3.5vw, 36px);
    font-weight: 800;
    letter-spacing: -0.025em;
    color: var(--text-strong);
    margin: 0 0 var(--space-2);
    line-height: 1.1;
  }
  .ei-hero-title-grad {
    background-image: linear-gradient(135deg, #818cf8 0%, #6366f1 40%, #06b6d4 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ei-hero-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.6;
  }

  /* Time range selector */
  .ei-range-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .ei-range-label {
    font-size: 12px;
    color: var(--text-muted);
    margin-right: 4px;
  }
  .ei-range-btn {
    display: inline-block;
    padding: 5px 13px;
    border-radius: 7px;
    font-size: 12px;
    font-weight: 500;
    text-decoration: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    background: var(--bg);
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
    white-space: nowrap;
  }
  .ei-range-btn:hover { color: var(--text); border-color: var(--border-strong, var(--border)); }
  .ei-range-btn.active {
    background: #6366f1;
    border-color: #6366f1;
    color: #fff;
  }

  /* KPI cards row */
  .ei-kpi-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .ei-kpi {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
    overflow: hidden;
  }
  .ei-kpi:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .ei-kpi-icon {
    width: 32px; height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    margin-bottom: var(--space-3);
  }
  .ei-kpi-icon-blue { background: rgba(99,102,241,0.12); }
  .ei-kpi-icon-green { background: rgba(52,211,153,0.12); }
  .ei-kpi-icon-amber { background: rgba(251,191,36,0.12); }
  .ei-kpi-icon-purple { background: rgba(139,92,246,0.12); }
  .ei-kpi-label {
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 6px;
  }
  .ei-kpi-value {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    margin-bottom: 8px;
  }
  .ei-kpi-value.na { color: var(--text-muted); font-size: 22px; }
  .ei-kpi-delta {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .ei-kpi-delta.up { color: #34d399; }
  .ei-kpi-delta.down { color: #f87171; }
  .ei-kpi-sub {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* Section */
  .ei-section {
    margin-bottom: var(--space-6);
  }
  .ei-section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .ei-section-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    margin: 0;
  }
  .ei-section-sub {
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* Velocity chart */
  .ei-chart-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-4);
    overflow-x: auto;
  }
  .ei-chart-bars {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    height: 120px;
    padding-top: 8px;
  }
  .ei-chart-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    min-width: 40px;
  }
  .ei-chart-bar-wrap {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .ei-chart-bar {
    width: 70%;
    border-radius: 4px 4px 0 0;
    min-height: 4px;
    transition: opacity 120ms ease;
    position: relative;
  }
  .ei-chart-bar.pr-bar { background: linear-gradient(180deg, #818cf8, #6366f1); }
  .ei-chart-bar.issue-bar { background: linear-gradient(180deg, #34d399, #10b981); opacity: 0.6; }
  .ei-chart-bar:hover { opacity: 0.8; }
  .ei-chart-label {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 6px;
    white-space: nowrap;
  }
  .ei-chart-val {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .ei-chart-legend {
    display: flex;
    gap: var(--space-4);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .ei-chart-legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .ei-legend-dot {
    width: 10px; height: 10px;
    border-radius: 2px;
  }

  /* Contributors table */
  .ei-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .ei-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .ei-table th {
    padding: 10px 16px;
    text-align: left;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    white-space: nowrap;
  }
  .ei-table th:not(:first-child) { text-align: right; }
  .ei-table td {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    vertical-align: middle;
  }
  .ei-table td:not(:first-child) {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .ei-table tr:last-child td { border-bottom: none; }
  .ei-table tr:hover td { background: var(--bg-hover); }
  .ei-contributor-rank {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px; height: 20px;
    border-radius: 50%;
    font-size: 10px;
    font-weight: 700;
    background: rgba(99,102,241,0.12);
    color: #818cf8;
    margin-right: 8px;
    flex-shrink: 0;
  }
  .ei-contributor-rank.top1 { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .ei-contributor-rank.top2 { background: rgba(156,163,175,0.15); color: #9ca3af; }
  .ei-contributor-rank.top3 { background: rgba(217,119,6,0.15); color: #d97706; }
  .ei-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px; height: 24px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
    background: rgba(99,102,241,0.18);
    color: #818cf8;
    margin-right: 8px;
    flex-shrink: 0;
  }
  .ei-contributor-cell {
    display: flex;
    align-items: center;
  }

  /* Alert banners */
  .ei-alerts {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
  }
  .ei-alert {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.55;
  }
  .ei-alert.red {
    border: 1px solid rgba(248,113,113,0.3);
    background: rgba(248,113,113,0.07);
    color: #fca5a5;
  }
  .ei-alert.amber {
    border: 1px solid rgba(251,191,36,0.3);
    background: rgba(251,191,36,0.07);
    color: #fcd34d;
  }
  .ei-alert.green {
    border: 1px solid rgba(52,211,153,0.3);
    background: rgba(52,211,153,0.07);
    color: #6ee7b7;
  }
  .ei-alert-icon { font-size: 16px; line-height: 1.4; flex-shrink: 0; }
  .ei-alert strong { font-weight: 700; }

  /* AI impact box */
  .ei-ai-box {
    background: var(--bg-elevated);
    border: 1px solid rgba(99,102,241,0.25);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    position: relative;
    overflow: hidden;
  }
  .ei-ai-box::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, #6366f1 30%, #8b5cf6 60%, transparent);
    opacity: 0.6;
  }
  .ei-ai-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-4);
    margin-top: var(--space-4);
  }
  .ei-ai-stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ei-ai-stat-val {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: var(--text-strong);
  }
  .ei-ai-stat-label {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .ei-ai-summary-line {
    font-size: 13.5px;
    color: var(--text-muted);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
    line-height: 1.55;
  }
  .ei-ai-summary-line strong { color: var(--text); font-weight: 600; }

  /* Health indicators grid */
  .ei-health-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-3);
  }
  .ei-health-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-4);
  }
  .ei-health-card.red { border-color: rgba(248,113,113,0.3); }
  .ei-health-card.amber { border-color: rgba(251,191,36,0.3); }
  .ei-health-card.green { border-color: rgba(52,211,153,0.3); }
  .ei-health-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: var(--space-3);
  }
  .ei-health-badge.red { background: rgba(248,113,113,0.12); color: #f87171; }
  .ei-health-badge.amber { background: rgba(251,191,36,0.12); color: #fbbf24; }
  .ei-health-badge.green { background: rgba(52,211,153,0.12); color: #34d399; }
  .ei-health-num {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: var(--text-strong);
    line-height: 1;
    margin-bottom: 4px;
  }
  .ei-health-label {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* Quality table */
  .ei-quality-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .ei-quality-row:last-child { border-bottom: none; }
  .ei-quality-name {
    flex: 1;
    font-size: 13px;
    color: var(--text);
    font-weight: 500;
  }
  .ei-quality-bar-wrap {
    width: 120px;
    height: 6px;
    background: var(--bg-hover);
    border-radius: 9999px;
    overflow: hidden;
  }
  .ei-quality-bar {
    height: 100%;
    border-radius: 9999px;
    background: linear-gradient(90deg, #6366f1, #06b6d4);
  }
  .ei-quality-val {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    width: 40px;
    text-align: right;
  }

  /* Empty state */
  .ei-empty {
    text-align: center;
    padding: var(--space-6) var(--space-4);
    color: var(--text-muted);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .ei-empty strong {
    display: block;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 4px;
  }

  /* Two-column layout */
  .ei-two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
  }
  @media (max-width: 768px) {
    .ei-two-col { grid-template-columns: 1fr; }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function weeksAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n * 7);
  return d;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function fmtHours(hours: number | null): string {
  if (hours === null || isNaN(hours)) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function shortWeekLabel(weekStart: Date): string {
  return weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Data queries ─────────────────────────────────────────────────────────────

async function getAccessibleRepoIds(userId: string): Promise<string[]> {
  // Owned repos (public + private) + public repos
  const owned = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.ownerId, userId));
  return owned.map((r) => r.id);
}

interface WeeklyBucket {
  weekStart: Date;
  prsMerged: number;
  issuesClosed: number;
}

async function getWeeklyVelocity(
  repoIds: string[],
  weeks: number
): Promise<WeeklyBucket[]> {
  if (repoIds.length === 0) return [];

  const since = weeksAgo(weeks);
  const buckets: WeeklyBucket[] = [];

  // Build week buckets
  for (let i = weeks - 1; i >= 0; i--) {
    const start = weeksAgo(i + 1);
    start.setHours(0, 0, 0, 0);
    const end = weeksAgo(i);
    end.setHours(23, 59, 59, 999);
    buckets.push({ weekStart: start, prsMerged: 0, issuesClosed: 0 });

    // PRs merged in this week
    const prs = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          inArray(pullRequests.repositoryId, repoIds),
          eq(pullRequests.state, "merged"),
          gte(pullRequests.mergedAt, start),
          lte(pullRequests.mergedAt, end)
        )
      );
    buckets[buckets.length - 1].prsMerged = prs.length;

    // Issues closed in this week
    const closedIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          inArray(issues.repositoryId, repoIds),
          eq(issues.state, "closed"),
          gte(issues.closedAt, start),
          lte(issues.closedAt, end)
        )
      );
    buckets[buckets.length - 1].issuesClosed = closedIssues.length;
  }

  return buckets;
}

interface PrStats {
  totalMerged: number;
  avgMergeHours: number | null;
  mergedThisPeriod: number;
  mergedLastPeriod: number;
}

async function getPrStats(repoIds: string[], days: number): Promise<PrStats> {
  if (repoIds.length === 0) {
    return { totalMerged: 0, avgMergeHours: null, mergedThisPeriod: 0, mergedLastPeriod: 0 };
  }

  const periodStart = daysAgo(days);
  const prevPeriodStart = daysAgo(days * 2);

  const merged = await db
    .select({
      id: pullRequests.id,
      createdAt: pullRequests.createdAt,
      mergedAt: pullRequests.mergedAt,
    })
    .from(pullRequests)
    .where(
      and(
        inArray(pullRequests.repositoryId, repoIds),
        eq(pullRequests.state, "merged"),
        isNotNull(pullRequests.mergedAt)
      )
    );

  const thisPeriod = merged.filter(
    (p) => p.mergedAt && new Date(p.mergedAt) >= periodStart
  );
  const lastPeriod = merged.filter(
    (p) =>
      p.mergedAt &&
      new Date(p.mergedAt) >= prevPeriodStart &&
      new Date(p.mergedAt) < periodStart
  );

  // avg merge time (hours) from created→merged
  const timesHours = thisPeriod
    .filter((p) => p.mergedAt)
    .map((p) => {
      const diff =
        new Date(p.mergedAt!).getTime() - new Date(p.createdAt).getTime();
      return diff / 1000 / 3600;
    })
    .filter((h) => h >= 0 && h < 10000);

  const avgMergeHours =
    timesHours.length > 0
      ? timesHours.reduce((a, b) => a + b, 0) / timesHours.length
      : null;

  return {
    totalMerged: merged.length,
    avgMergeHours,
    mergedThisPeriod: thisPeriod.length,
    mergedLastPeriod: lastPeriod.length,
  };
}

interface GateStats {
  passRate: number | null;
  totalRuns: number;
  passed: number;
  failed: number;
}

async function getGateStats(repoIds: string[], days: number): Promise<GateStats> {
  if (repoIds.length === 0) return { passRate: null, totalRuns: 0, passed: 0, failed: 0 };

  const since = daysAgo(days);
  const runs = await db
    .select({ status: gateRuns.status })
    .from(gateRuns)
    .where(
      and(
        inArray(gateRuns.repositoryId, repoIds),
        gte(gateRuns.createdAt, since)
      )
    );

  const passed = runs.filter((r) => r.status === "passed").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const total = runs.length;
  const passRate = total > 0 ? (passed / total) * 100 : null;

  return { passRate, totalRuns: total, passed, failed };
}

interface ContributorRow {
  username: string;
  displayName: string | null;
  prsMerged: number;
  prsOpened: number;
  reviewsGiven: number;
  avgMergeHours: number | null;
}

async function getTopContributors(
  repoIds: string[],
  days: number
): Promise<ContributorRow[]> {
  if (repoIds.length === 0) return [];

  const since = daysAgo(days);

  // PRs opened per user
  const opened = await db
    .select({
      authorId: pullRequests.authorId,
      username: users.username,
      displayName: users.displayName,
      createdAt: pullRequests.createdAt,
    })
    .from(pullRequests)
    .innerJoin(users, eq(pullRequests.authorId, users.id))
    .where(
      and(
        inArray(pullRequests.repositoryId, repoIds),
        gte(pullRequests.createdAt, since)
      )
    );

  // PRs merged per user
  const mergedRows = await db
    .select({
      authorId: pullRequests.authorId,
      createdAt: pullRequests.createdAt,
      mergedAt: pullRequests.mergedAt,
    })
    .from(pullRequests)
    .where(
      and(
        inArray(pullRequests.repositoryId, repoIds),
        eq(pullRequests.state, "merged"),
        isNotNull(pullRequests.mergedAt),
        gte(pullRequests.mergedAt, since)
      )
    );

  // Reviews (non-AI comments on PRs)
  const reviews = await db
    .select({ authorId: prComments.authorId })
    .from(prComments)
    .innerJoin(pullRequests, eq(prComments.pullRequestId, pullRequests.id))
    .where(
      and(
        inArray(pullRequests.repositoryId, repoIds),
        eq(prComments.isAiReview, false),
        gte(prComments.createdAt, since)
      )
    );

  // Aggregate by user
  const byUser = new Map<
    string,
    {
      username: string;
      displayName: string | null;
      opened: number;
      merged: number;
      reviews: number;
      mergeTimes: number[];
    }
  >();

  for (const row of opened) {
    const key = row.authorId;
    if (!byUser.has(key)) {
      byUser.set(key, {
        username: row.username,
        displayName: row.displayName,
        opened: 0,
        merged: 0,
        reviews: 0,
        mergeTimes: [],
      });
    }
    byUser.get(key)!.opened++;
  }

  for (const row of mergedRows) {
    const key = row.authorId;
    if (!byUser.has(key)) continue;
    byUser.get(key)!.merged++;
    if (row.mergedAt) {
      const hours =
        (new Date(row.mergedAt).getTime() - new Date(row.createdAt).getTime()) /
        1000 /
        3600;
      if (hours >= 0 && hours < 10000) {
        byUser.get(key)!.mergeTimes.push(hours);
      }
    }
  }

  for (const row of reviews) {
    const key = row.authorId;
    if (!byUser.has(key)) continue;
    byUser.get(key)!.reviews++;
  }

  // Sort by merged desc, then opened
  return Array.from(byUser.entries())
    .map(([, v]) => ({
      username: v.username,
      displayName: v.displayName,
      prsMerged: v.merged,
      prsOpened: v.opened,
      reviewsGiven: v.reviews,
      avgMergeHours:
        v.mergeTimes.length > 0
          ? v.mergeTimes.reduce((a, b) => a + b, 0) / v.mergeTimes.length
          : null,
    }))
    .sort((a, b) => b.prsMerged - a.prsMerged || b.prsOpened - a.prsOpened)
    .slice(0, 10);
}

interface HealthIndicators {
  staleRepos: number;
  stuckPrs: number;
  abandonedIssues: number;
}

async function getHealthIndicators(
  repoIds: string[]
): Promise<HealthIndicators> {
  if (repoIds.length === 0)
    return { staleRepos: 0, stuckPrs: 0, abandonedIssues: 0 };

  const thirtyDaysAgo = daysAgo(30);
  const sevenDaysAgo = daysAgo(7);

  // Stale repos: no pushAt update in 30+ days
  const staleReposRows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        inArray(repositories.id, repoIds),
        or(
          lte(repositories.pushedAt, thirtyDaysAgo),
          sql`${repositories.pushedAt} IS NULL`
        )
      )
    );

  // Stuck PRs: open for > 7 days
  const stuckPrsRows = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        inArray(pullRequests.repositoryId, repoIds),
        eq(pullRequests.state, "open"),
        lte(pullRequests.createdAt, sevenDaysAgo)
      )
    );

  // Abandoned issues: open > 30 days with no comments
  const openOldIssues = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        inArray(issues.repositoryId, repoIds),
        eq(issues.state, "open"),
        lte(issues.createdAt, thirtyDaysAgo)
      )
    );

  // Count which have no comments
  let abandonedCount = 0;
  if (openOldIssues.length > 0) {
    const issueIds = openOldIssues.map((i) => i.id);
    const withComments = await db
      .select({ issueId: issueComments.issueId })
      .from(issueComments)
      .where(inArray(issueComments.issueId, issueIds));
    const commentedSet = new Set(withComments.map((c) => c.issueId));
    abandonedCount = openOldIssues.filter((i) => !commentedSet.has(i.id)).length;
  }

  return {
    staleRepos: staleReposRows.length,
    stuckPrs: stuckPrsRows.length,
    abandonedIssues: abandonedCount,
  };
}

interface AiImpact {
  aiMergedPrs: number;
  aiSecurityIssues: number;
  aiReviewComments: number;
  estimatedHoursSaved: number;
}

async function getAiImpact(repoIds: string[], days: number): Promise<AiImpact> {
  if (repoIds.length === 0)
    return { aiMergedPrs: 0, aiSecurityIssues: 0, aiReviewComments: 0, estimatedHoursSaved: 0 };

  const since = daysAgo(days);

  // AI-merged PRs: merged via mergedBy where the user has "ai" or "bot" in name,
  // or from activity_feed with action='pr_merge' and metadata containing AI hint.
  // Simpler: PRs merged where title or body contains "[AI]" or "auto-merged"
  const aiMergedRows = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        inArray(pullRequests.repositoryId, repoIds),
        eq(pullRequests.state, "merged"),
        isNotNull(pullRequests.mergedAt),
        gte(pullRequests.mergedAt, since),
        or(
          ilike(pullRequests.title, "%[ai]%"),
          ilike(pullRequests.title, "%auto-merged%"),
          ilike(pullRequests.body, "%auto-merged by gluecron%")
        )
      )
    );

  // AI security issues: issues with [CVE] or [AI] in title
  const aiSecurityRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        inArray(issues.repositoryId, repoIds),
        gte(issues.createdAt, since),
        or(
          ilike(issues.title, "%[cve]%"),
          ilike(issues.title, "%[ai]%"),
          ilike(issues.title, "%[security]%")
        )
      )
    );

  // AI review comments
  const aiCommentsRows = await db
    .select({ id: prComments.id })
    .from(prComments)
    .innerJoin(pullRequests, eq(prComments.pullRequestId, pullRequests.id))
    .where(
      and(
        inArray(pullRequests.repositoryId, repoIds),
        eq(prComments.isAiReview, true),
        gte(prComments.createdAt, since)
      )
    );

  // Estimate: avg review takes 4h; each AI-merged PR saves that
  const estimatedHoursSaved = aiMergedRows.length * 4;

  return {
    aiMergedPrs: aiMergedRows.length,
    aiSecurityIssues: aiSecurityRows.length,
    aiReviewComments: aiCommentsRows.length,
    estimatedHoursSaved,
  };
}

// ─── SVG Chart ────────────────────────────────────────────────────────────────

function VelocityChart({ buckets }: { buckets: WeeklyBucket[] }) {
  const maxVal = Math.max(...buckets.map((b) => Math.max(b.prsMerged, b.issuesClosed)), 1);
  const chartHeight = 100;

  return (
    <div class="ei-chart-wrap">
      <div class="ei-chart-bars">
        {buckets.map((b) => {
          const prHeight = Math.max(4, (b.prsMerged / maxVal) * chartHeight);
          const issueHeight = Math.max(4, (b.issuesClosed / maxVal) * chartHeight);
          return (
            <div class="ei-chart-col">
              <div class="ei-chart-val">{b.prsMerged}</div>
              <div class="ei-chart-bar-wrap">
                <div
                  class="ei-chart-bar pr-bar"
                  style={`height:${prHeight}px`}
                  title={`${b.prsMerged} PRs merged`}
                />
              </div>
              <div class="ei-chart-label">{shortWeekLabel(b.weekStart)}</div>
            </div>
          );
        })}
      </div>
      <div class="ei-chart-legend">
        <div class="ei-chart-legend-item">
          <div class="ei-legend-dot" style="background: linear-gradient(90deg,#818cf8,#6366f1)" />
          PRs merged per week
        </div>
      </div>
    </div>
  );
}

// ─── Global /insights dashboard ───────────────────────────────────────────────

engineeringInsights.get("/insights", requireAuth, async (c) => {
  const user = c.get("user")!;
  const rangeParam = c.req.query("range") || "30";
  const days = rangeParam === "7" ? 7 : rangeParam === "90" ? 90 : rangeParam === "365" ? 365 : 30;
  const notifCount = await getUnreadCount(user.id);

  const repoIds = await getAccessibleRepoIds(user.id);

  const [prStats, gateStats, weeklyVelocity, contributors, health, aiImpact] =
    await Promise.all([
      getPrStats(repoIds, days),
      getGateStats(repoIds, days),
      getWeeklyVelocity(repoIds, 8),
      getTopContributors(repoIds, days),
      getHealthIndicators(repoIds),
      getAiImpact(repoIds, days),
    ]);

  const rangeLabel =
    days === 7 ? "7d" : days === 90 ? "90d" : days === 365 ? "12mo" : "30d";

  // Deltas
  const prDeltaPct =
    prStats.mergedLastPeriod > 0
      ? Math.round(
          ((prStats.mergedThisPeriod - prStats.mergedLastPeriod) /
            prStats.mergedLastPeriod) *
            100
        )
      : 0;

  return c.html(
    <Layout
      title="Engineering Intelligence — Insights"
      user={user}
      notificationCount={notifCount}
      description="Org-level engineering metrics: velocity, quality, AI impact, and team health."
    >
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="ei-wrap">
        {/* Hero */}
        <section class="ei-hero">
          <div class="ei-hero-orb" aria-hidden="true" />
          <div class="ei-hero-inner">
            <div class="ei-hero-top">
              <div>
                <div class="ei-eyebrow">
                  <span class="ei-eyebrow-dot" aria-hidden="true" />
                  Engineering Intelligence
                </div>
                <h1 class="ei-hero-title">
                  <span class="ei-hero-title-grad">Team Performance.</span>{" "}
                  Org-wide.
                </h1>
                <p class="ei-hero-sub">
                  Velocity, quality, AI impact, and developer health across all
                  your repositories — in one view.
                </p>
              </div>
              {/* Time range selector */}
              <div>
                <div class="ei-range-label">Time range</div>
                <div class="ei-range-bar">
                  {(["7", "30", "90", "365"] as const).map((r) => (
                    <a
                      href={`/insights?range=${r}`}
                      class={`ei-range-btn${rangeParam === r ? " active" : ""}`}
                    >
                      {r === "365" ? "12mo" : `${r}d`}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* KPI Row */}
        <div class="ei-kpi-row">
          <div class="ei-kpi">
            <div class="ei-kpi-icon ei-kpi-icon-blue">{"⬆"}</div>
            <div class="ei-kpi-label">PRs Merged</div>
            <div class="ei-kpi-value">{prStats.mergedThisPeriod}</div>
            {prDeltaPct !== 0 && (
              <div class={`ei-kpi-delta ${prDeltaPct > 0 ? "up" : "down"}`}>
                <span>{prDeltaPct > 0 ? "▲" : "▼"}</span>
                {Math.abs(prDeltaPct)}% vs last {rangeLabel}
              </div>
            )}
            <div class="ei-kpi-sub">This {rangeLabel}</div>
          </div>

          <div class="ei-kpi">
            <div class="ei-kpi-icon ei-kpi-icon-green">{"⏱"}</div>
            <div class="ei-kpi-label">Avg Merge Time</div>
            <div class={`ei-kpi-value${prStats.avgMergeHours === null ? " na" : ""}`}>
              {fmtHours(prStats.avgMergeHours)}
            </div>
            <div class="ei-kpi-sub">Open → merge, merged PRs</div>
          </div>

          <div class="ei-kpi">
            <div class="ei-kpi-icon ei-kpi-icon-amber">{"✓"}</div>
            <div class="ei-kpi-label">Gate Pass Rate</div>
            <div class={`ei-kpi-value${gateStats.passRate === null ? " na" : ""}`}>
              {gateStats.passRate !== null
                ? `${Math.round(gateStats.passRate)}%`
                : "—"}
            </div>
            <div class="ei-kpi-sub">
              {gateStats.passed}/{gateStats.totalRuns} runs passed
            </div>
          </div>

          <div class="ei-kpi">
            <div class="ei-kpi-icon ei-kpi-icon-purple">{"✨"}</div>
            <div class="ei-kpi-label">AI Impact</div>
            <div class="ei-kpi-value">{aiImpact.aiMergedPrs}</div>
            <div class="ei-kpi-sub">
              PRs auto-merged · ~{aiImpact.estimatedHoursSaved}h saved
            </div>
          </div>
        </div>

        {/* At-risk alerts */}
        {(health.stuckPrs > 0 || health.staleRepos > 0 || health.abandonedIssues > 0) && (
          <div class="ei-alerts">
            {health.stuckPrs > 0 && (
              <div class="ei-alert red">
                <span class="ei-alert-icon">{"⚠"}</span>
                <div>
                  <strong>
                    {health.stuckPrs} PR{health.stuckPrs !== 1 ? "s" : ""} open for
                    {" "}{">"} 7 days
                  </strong>{" "}
                  — these need attention. Unreviewed PRs slow down the whole team.
                </div>
              </div>
            )}
            {health.staleRepos > 0 && (
              <div class="ei-alert amber">
                <span class="ei-alert-icon">{"⚡"}</span>
                <div>
                  <strong>
                    {health.staleRepos} repo{health.staleRepos !== 1 ? "s" : ""} with no
                    commits in 30+ days
                  </strong>{" "}
                  — consider archiving or reassigning.
                </div>
              </div>
            )}
            {health.abandonedIssues > 0 && (
              <div class="ei-alert amber">
                <span class="ei-alert-icon">{"!"}</span>
                <div>
                  <strong>
                    {health.abandonedIssues} issue{health.abandonedIssues !== 1 ? "s" : ""} open
                    {">"} 30 days with no comments
                  </strong>{" "}
                  — abandoned backlog items inflate your issue count artificially.
                </div>
              </div>
            )}
            {gateStats.passRate !== null && gateStats.passRate >= 90 && (
              <div class="ei-alert green">
                <span class="ei-alert-icon">{"✓"}</span>
                <div>
                  Gate pass rate is{" "}
                  <strong>{Math.round(gateStats.passRate)}%</strong> — solid
                  quality signal across your repos.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Velocity chart */}
        <section class="ei-section">
          <div class="ei-section-head">
            <h2 class="ei-section-title">PR Velocity</h2>
            <span class="ei-section-sub">PRs merged per week, last 8 weeks</span>
          </div>
          {repoIds.length === 0 ? (
            <div class="ei-empty">
              <strong>No repositories yet</strong>
              Create or import a repository to see velocity metrics.
            </div>
          ) : (
            <VelocityChart buckets={weeklyVelocity} />
          )}
        </section>

        <div class="ei-two-col">
          {/* Top contributors */}
          <section class="ei-section">
            <div class="ei-section-head">
              <h2 class="ei-section-title">Top Contributors</h2>
              <span class="ei-section-sub">Last {rangeLabel}</span>
            </div>
            {contributors.length === 0 ? (
              <div class="ei-empty">
                <strong>No contributor data yet</strong>
                Merge some PRs to see rankings.
              </div>
            ) : (
              <div class="ei-table-wrap">
                <table class="ei-table">
                  <thead>
                    <tr>
                      <th>Developer</th>
                      <th>Merged</th>
                      <th>Opened</th>
                      <th>Reviews</th>
                      <th>Avg TTM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contributors.map((c, i) => (
                      <tr>
                        <td>
                          <div class="ei-contributor-cell">
                            <span
                              class={`ei-contributor-rank${i === 0 ? " top1" : i === 1 ? " top2" : i === 2 ? " top3" : ""}`}
                            >
                              {i + 1}
                            </span>
                            <div class="ei-avatar">
                              {(c.displayName || c.username).charAt(0).toUpperCase()}
                            </div>
                            <a href={`/${c.username}`} style="color:var(--text);text-decoration:none;font-weight:500">
                              {c.displayName || c.username}
                            </a>
                          </div>
                        </td>
                        <td>{c.prsMerged}</td>
                        <td>{c.prsOpened}</td>
                        <td>{c.reviewsGiven}</td>
                        <td>{fmtHours(c.avgMergeHours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Health indicators */}
          <section class="ei-section">
            <div class="ei-section-head">
              <h2 class="ei-section-title">Health Indicators</h2>
              <span class="ei-section-sub">Across all repos</span>
            </div>
            <div class="ei-health-grid">
              <div class={`ei-health-card ${health.stuckPrs > 0 ? "red" : "green"}`}>
                <div class={`ei-health-badge ${health.stuckPrs > 0 ? "red" : "green"}`}>
                  {health.stuckPrs > 0 ? "⚠ Stuck" : "✓ Clear"}
                </div>
                <div class="ei-health-num">{health.stuckPrs}</div>
                <div class="ei-health-label">PRs open {">"} 7 days</div>
              </div>
              <div class={`ei-health-card ${health.staleRepos > 0 ? "amber" : "green"}`}>
                <div class={`ei-health-badge ${health.staleRepos > 0 ? "amber" : "green"}`}>
                  {health.staleRepos > 0 ? "! Stale" : "✓ Active"}
                </div>
                <div class="ei-health-num">{health.staleRepos}</div>
                <div class="ei-health-label">Repos with no commits in 30d</div>
              </div>
              <div class={`ei-health-card ${health.abandonedIssues > 0 ? "amber" : "green"}`}>
                <div class={`ei-health-badge ${health.abandonedIssues > 0 ? "amber" : "green"}`}>
                  {health.abandonedIssues > 0 ? "! Backlog" : "✓ Engaged"}
                </div>
                <div class="ei-health-num">{health.abandonedIssues}</div>
                <div class="ei-health-label">Issues {">"} 30d with no comments</div>
              </div>
              <div class={`ei-health-card ${gateStats.passRate !== null && gateStats.passRate < 80 ? "red" : gateStats.passRate !== null && gateStats.passRate < 95 ? "amber" : "green"}`}>
                <div class={`ei-health-badge ${gateStats.passRate !== null && gateStats.passRate < 80 ? "red" : gateStats.passRate !== null && gateStats.passRate < 95 ? "amber" : "green"}`}>
                  {gateStats.passRate !== null && gateStats.passRate >= 95 ? "✓ Healthy" : gateStats.passRate !== null && gateStats.passRate < 80 ? "⚠ Critical" : "! Watch"}
                </div>
                <div class="ei-health-num">
                  {gateStats.passRate !== null ? `${Math.round(gateStats.passRate)}%` : "—"}
                </div>
                <div class="ei-health-label">Gate pass rate</div>
              </div>
            </div>
          </section>
        </div>

        {/* AI Impact */}
        <section class="ei-section">
          <div class="ei-section-head">
            <h2 class="ei-section-title">{"✨ "}AI Impact</h2>
            <span class="ei-section-sub">Last {rangeLabel}</span>
          </div>
          <div class="ei-ai-box">
            <div class="ei-ai-grid">
              <div class="ei-ai-stat">
                <div class="ei-ai-stat-val">{aiImpact.aiMergedPrs}</div>
                <div class="ei-ai-stat-label">PRs auto-merged by AI</div>
              </div>
              <div class="ei-ai-stat">
                <div class="ei-ai-stat-val">~{aiImpact.estimatedHoursSaved}h</div>
                <div class="ei-ai-stat-label">Estimated hours saved (4h/PR avg)</div>
              </div>
              <div class="ei-ai-stat">
                <div class="ei-ai-stat-val">{aiImpact.aiSecurityIssues}</div>
                <div class="ei-ai-stat-label">Security issues opened by AI</div>
              </div>
              <div class="ei-ai-stat">
                <div class="ei-ai-stat-val">{aiImpact.aiReviewComments}</div>
                <div class="ei-ai-stat-label">AI review comments left</div>
              </div>
            </div>
            {aiImpact.aiMergedPrs > 0 && (
              <div class="ei-ai-summary-line">
                AI has auto-merged{" "}
                <strong>{aiImpact.aiMergedPrs} PRs</strong> saving an
                estimated{" "}
                <strong>~{aiImpact.estimatedHoursSaved} hours</strong> of
                review time.{" "}
                {aiImpact.aiSecurityIssues > 0 && (
                  <>
                    AI also opened{" "}
                    <strong>{aiImpact.aiSecurityIssues} security issues</strong>{" "}
                    and left{" "}
                    <strong>{aiImpact.aiReviewComments} review comments</strong>.
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </Layout>
  );
});

// ─── JSON API summary ─────────────────────────────────────────────────────────

engineeringInsights.get("/insights/api/summary", requireAuth, async (c) => {
  const user = c.get("user")!;
  const days = parseInt(c.req.query("days") || "30", 10);

  const repoIds = await getAccessibleRepoIds(user.id);

  const [prStats, gateStats, health, aiImpact, contributors] = await Promise.all([
    getPrStats(repoIds, days),
    getGateStats(repoIds, days),
    getHealthIndicators(repoIds),
    getAiImpact(repoIds, days),
    getTopContributors(repoIds, days),
  ]);

  return c.json({
    ok: true,
    period: { days },
    repos: repoIds.length,
    velocity: {
      prsMergedThisPeriod: prStats.mergedThisPeriod,
      prsMergedLastPeriod: prStats.mergedLastPeriod,
      avgMergeHours: prStats.avgMergeHours,
    },
    quality: {
      gatePassRate: gateStats.passRate,
      gateRunsTotal: gateStats.totalRuns,
      gatePassed: gateStats.passed,
      gateFailed: gateStats.failed,
    },
    health: {
      stuckPrs: health.stuckPrs,
      staleRepos: health.staleRepos,
      abandonedIssues: health.abandonedIssues,
    },
    ai: {
      prsMergedByAi: aiImpact.aiMergedPrs,
      securityIssuesOpened: aiImpact.aiSecurityIssues,
      reviewCommentsLeft: aiImpact.aiReviewComments,
      estimatedHoursSaved: aiImpact.estimatedHoursSaved,
    },
    topContributors: contributors.slice(0, 5).map((c) => ({
      username: c.username,
      prsMerged: c.prsMerged,
      prsOpened: c.prsOpened,
      reviewsGiven: c.reviewsGiven,
      avgMergeHours: c.avgMergeHours,
    })),
  });
});

// ─── Per-repo engineering insights ───────────────────────────────────────────

engineeringInsights.get(
  "/:owner/:repo/insights/engineering",
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user");
    const rangeParam = c.req.query("range") || "30";
    const days =
      rangeParam === "7" ? 7 : rangeParam === "90" ? 90 : rangeParam === "365" ? 365 : 30;
    const rangeLabel = days === 7 ? "7d" : days === 90 ? "90d" : days === 365 ? "12mo" : "30d";
    const notifCount = user ? await getUnreadCount(user.id) : 0;

    // Resolve repo
    const repoRows = await db
      .select({ id: repositories.id, ownerId: repositories.ownerId })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(
          eq(users.username, owner),
          eq(repositories.name, repo)
        )
      )
      .limit(1);

    if (repoRows.length === 0) return c.notFound();
    const repoId = repoRows[0].id;
    const repoIds = [repoId];

    const [prStats, gateStats, weeklyVelocity, contributors, health, aiImpact] =
      await Promise.all([
        getPrStats(repoIds, days),
        getGateStats(repoIds, days),
        getWeeklyVelocity(repoIds, 8),
        getTopContributors(repoIds, days),
        getHealthIndicators(repoIds),
        getAiImpact(repoIds, days),
      ]);

    const prDeltaPct =
      prStats.mergedLastPeriod > 0
        ? Math.round(
            ((prStats.mergedThisPeriod - prStats.mergedLastPeriod) /
              prStats.mergedLastPeriod) *
              100
          )
        : 0;

    return c.html(
      <Layout
        title={`Engineering Insights — ${owner}/${repo}`}
        user={user}
        notificationCount={notifCount}
      >
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <RepoHeader owner={owner} repo={repo} />
        <RepoNav owner={owner} repo={repo} active="insights" />

        <div class="ei-wrap">
          {/* Hero */}
          <section class="ei-hero">
            <div class="ei-hero-orb" aria-hidden="true" />
            <div class="ei-hero-inner">
              <div class="ei-hero-top">
                <div>
                  <div class="ei-eyebrow">
                    <span class="ei-eyebrow-dot" aria-hidden="true" />
                    Engineering Intelligence · {owner}/{repo}
                  </div>
                  <h1 class="ei-hero-title">
                    <span class="ei-hero-title-grad">Velocity.</span>{" "}
                    Quality. AI Impact.
                  </h1>
                  <p class="ei-hero-sub">
                    Shipping velocity, gate health, contributor rankings, and AI
                    impact — all scoped to this repository.
                  </p>
                </div>
                {/* Time range + sub-nav */}
                <div>
                  <div class="ei-range-label">Time range</div>
                  <div class="ei-range-bar">
                    {(["7", "30", "90", "365"] as const).map((r) => (
                      <a
                        href={`/${owner}/${repo}/insights/engineering?range=${r}`}
                        class={`ei-range-btn${rangeParam === r ? " active" : ""}`}
                      >
                        {r === "365" ? "12mo" : `${r}d`}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Insights sub-nav */}
          <div style="display:flex;gap:4px;margin-bottom:var(--space-5);border-bottom:1px solid var(--border);padding-bottom:0">
            <a href={`/${owner}/${repo}/insights`} style="padding:8px 14px;font-size:13px;font-weight:500;color:var(--text-muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px">
              Code Intelligence
            </a>
            <a href={`/${owner}/${repo}/insights/velocity`} style="padding:8px 14px;font-size:13px;font-weight:500;color:var(--text-muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px">
              Velocity
            </a>
            <a href={`/${owner}/${repo}/insights/dora`} style="padding:8px 14px;font-size:13px;font-weight:500;color:var(--text-muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px">
              DORA
            </a>
            <a href={`/${owner}/${repo}/insights/health`} style="padding:8px 14px;font-size:13px;font-weight:500;color:var(--text-muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px">
              Health
            </a>
            <a href={`/${owner}/${repo}/insights/engineering`}
              style="padding:8px 14px;font-size:13px;font-weight:500;color:var(--accent,#5865f2);text-decoration:none;border-bottom:2px solid var(--accent,#5865f2);margin-bottom:-1px">
              Engineering
            </a>
          </div>

          {/* KPI Row */}
          <div class="ei-kpi-row">
            <div class="ei-kpi">
              <div class="ei-kpi-icon ei-kpi-icon-blue">{"⬆"}</div>
              <div class="ei-kpi-label">PRs Merged</div>
              <div class="ei-kpi-value">{prStats.mergedThisPeriod}</div>
              {prDeltaPct !== 0 && (
                <div class={`ei-kpi-delta ${prDeltaPct > 0 ? "up" : "down"}`}>
                  <span>{prDeltaPct > 0 ? "▲" : "▼"}</span>
                  {Math.abs(prDeltaPct)}% vs last {rangeLabel}
                </div>
              )}
              <div class="ei-kpi-sub">This {rangeLabel}</div>
            </div>

            <div class="ei-kpi">
              <div class="ei-kpi-icon ei-kpi-icon-green">{"⏱"}</div>
              <div class="ei-kpi-label">Avg Merge Time</div>
              <div class={`ei-kpi-value${prStats.avgMergeHours === null ? " na" : ""}`}>
                {fmtHours(prStats.avgMergeHours)}
              </div>
              <div class="ei-kpi-sub">Open → merge, merged PRs</div>
            </div>

            <div class="ei-kpi">
              <div class="ei-kpi-icon ei-kpi-icon-amber">{"✓"}</div>
              <div class="ei-kpi-label">Gate Pass Rate</div>
              <div class={`ei-kpi-value${gateStats.passRate === null ? " na" : ""}`}>
                {gateStats.passRate !== null
                  ? `${Math.round(gateStats.passRate)}%`
                  : "—"}
              </div>
              <div class="ei-kpi-sub">
                {gateStats.passed}/{gateStats.totalRuns} passed this {rangeLabel}
              </div>
            </div>

            <div class="ei-kpi">
              <div class="ei-kpi-icon ei-kpi-icon-purple">{"✨"}</div>
              <div class="ei-kpi-label">AI Impact</div>
              <div class="ei-kpi-value">{aiImpact.aiMergedPrs}</div>
              <div class="ei-kpi-sub">
                PRs auto-merged · ~{aiImpact.estimatedHoursSaved}h saved
              </div>
            </div>
          </div>

          {/* Alerts */}
          {(health.stuckPrs > 0 || health.staleRepos > 0 || health.abandonedIssues > 0) && (
            <div class="ei-alerts">
              {health.stuckPrs > 0 && (
                <div class="ei-alert red">
                  <span class="ei-alert-icon">{"⚠"}</span>
                  <div>
                    <strong>
                      {health.stuckPrs} PR{health.stuckPrs !== 1 ? "s" : ""} open
                      {" "}{">"} 7 days in this repo
                    </strong>{" "}
                    — unblock them to maintain team velocity.
                  </div>
                </div>
              )}
              {health.abandonedIssues > 0 && (
                <div class="ei-alert amber">
                  <span class="ei-alert-icon">{"!"}</span>
                  <div>
                    <strong>
                      {health.abandonedIssues} issue
                      {health.abandonedIssues !== 1 ? "s" : ""} open {">"} 30 days
                      without comments
                    </strong>{" "}
                    — consider triaging or closing these.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Velocity chart */}
          <section class="ei-section">
            <div class="ei-section-head">
              <h2 class="ei-section-title">PR Velocity</h2>
              <span class="ei-section-sub">PRs merged per week, last 8 weeks</span>
            </div>
            <VelocityChart buckets={weeklyVelocity} />
          </section>

          <div class="ei-two-col">
            {/* Contributors */}
            <section class="ei-section">
              <div class="ei-section-head">
                <h2 class="ei-section-title">Top Contributors</h2>
                <span class="ei-section-sub">
                  <a href={`/${owner}/${repo}/contributors`} style="color:var(--accent);text-decoration:none">
                    View all →
                  </a>
                </span>
              </div>
              {contributors.length === 0 ? (
                <div class="ei-empty">
                  <strong>No contributor data yet</strong>
                  Merge some PRs to see rankings.
                </div>
              ) : (
                <div class="ei-table-wrap">
                  <table class="ei-table">
                    <thead>
                      <tr>
                        <th>Developer</th>
                        <th>Merged</th>
                        <th>Reviews</th>
                        <th>Avg TTM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contributors.slice(0, 7).map((c, i) => (
                        <tr>
                          <td>
                            <div class="ei-contributor-cell">
                              <span
                                class={`ei-contributor-rank${i === 0 ? " top1" : i === 1 ? " top2" : i === 2 ? " top3" : ""}`}
                              >
                                {i + 1}
                              </span>
                              <a href={`/${c.username}`} style="color:var(--text);text-decoration:none;font-weight:500">
                                {c.displayName || c.username}
                              </a>
                            </div>
                          </td>
                          <td>{c.prsMerged}</td>
                          <td>{c.reviewsGiven}</td>
                          <td>{fmtHours(c.avgMergeHours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Health indicators */}
            <section class="ei-section">
              <div class="ei-section-head">
                <h2 class="ei-section-title">Health Snapshot</h2>
                <span class="ei-section-sub">
                  <a href={`/${owner}/${repo}/insights/health`} style="color:var(--accent);text-decoration:none">
                    Full report →
                  </a>
                </span>
              </div>
              <div class="ei-health-grid">
                <div class={`ei-health-card ${health.stuckPrs > 0 ? "red" : "green"}`}>
                  <div class={`ei-health-badge ${health.stuckPrs > 0 ? "red" : "green"}`}>
                    {health.stuckPrs > 0 ? "⚠ Stuck" : "✓ Clear"}
                  </div>
                  <div class="ei-health-num">{health.stuckPrs}</div>
                  <div class="ei-health-label">PRs open {">"} 7 days</div>
                </div>
                <div class={`ei-health-card ${health.abandonedIssues > 0 ? "amber" : "green"}`}>
                  <div class={`ei-health-badge ${health.abandonedIssues > 0 ? "amber" : "green"}`}>
                    {health.abandonedIssues > 0 ? "! Backlog" : "✓ Active"}
                  </div>
                  <div class="ei-health-num">{health.abandonedIssues}</div>
                  <div class="ei-health-label">Abandoned issues</div>
                </div>
              </div>
            </section>
          </div>

          {/* AI Impact */}
          <section class="ei-section">
            <div class="ei-section-head">
              <h2 class="ei-section-title">{"✨ "}AI Impact</h2>
              <span class="ei-section-sub">Last {rangeLabel}</span>
            </div>
            <div class="ei-ai-box">
              <div class="ei-ai-grid">
                <div class="ei-ai-stat">
                  <div class="ei-ai-stat-val">{aiImpact.aiMergedPrs}</div>
                  <div class="ei-ai-stat-label">PRs auto-merged by AI</div>
                </div>
                <div class="ei-ai-stat">
                  <div class="ei-ai-stat-val">~{aiImpact.estimatedHoursSaved}h</div>
                  <div class="ei-ai-stat-label">Estimated hours saved</div>
                </div>
                <div class="ei-ai-stat">
                  <div class="ei-ai-stat-val">{aiImpact.aiSecurityIssues}</div>
                  <div class="ei-ai-stat-label">Security issues opened by AI</div>
                </div>
                <div class="ei-ai-stat">
                  <div class="ei-ai-stat-val">{aiImpact.aiReviewComments}</div>
                  <div class="ei-ai-stat-label">AI review comments</div>
                </div>
              </div>
              {(aiImpact.aiMergedPrs > 0 || aiImpact.aiReviewComments > 0) && (
                <div class="ei-ai-summary-line">
                  {aiImpact.aiMergedPrs > 0 && (
                    <>
                      AI auto-merged{" "}
                      <strong>{aiImpact.aiMergedPrs} PRs</strong>, saving
                      ~<strong>{aiImpact.estimatedHoursSaved} hours</strong> of
                      review time.{" "}
                    </>
                  )}
                  {aiImpact.aiReviewComments > 0 && (
                    <>
                      AI left{" "}
                      <strong>{aiImpact.aiReviewComments} review comments</strong>{" "}
                      and opened{" "}
                      <strong>{aiImpact.aiSecurityIssues} security issues</strong>.
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </Layout>
    );
  }
);

export default engineeringInsights;

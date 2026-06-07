/**
 * Repository Health Score — /:owner/:repo/health
 *
 * Full breakdown page for the 0-100 composite health score.
 *
 * GET  /:owner/:repo/health             — breakdown page (softAuth, public repos visible)
 * POST /:owner/:repo/health/recompute   — invalidate cache (requireAuth + repo owner)
 */

import { Hono } from "hono";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { and, eq } from "drizzle-orm";
import type { AuthEnv } from "../middleware/auth";
import { softAuth, requireAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import {
  getHealthScore,
  invalidateHealthScore,
  type HealthScoreBreakdown,
} from "../lib/repo-health";

const repoHealthRoutes = new Hono<AuthEnv>();

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .rh-wrap {
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* Sub-navigation */
  .rh-subnav {
    display: flex;
    gap: 4px;
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .rh-subnav-link {
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 120ms ease, border-color 120ms ease;
    border-radius: 4px 4px 0 0;
  }
  .rh-subnav-link:hover { color: var(--text); }
  .rh-subnav-link.active {
    color: var(--accent, #5865f2);
    border-bottom-color: var(--accent, #5865f2);
  }

  /* Hero */
  .rh-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: var(--space-6);
    flex-wrap: wrap;
  }
  .rh-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    pointer-events: none;
    opacity: 0.8;
  }
  .rh-hero--green::before  { background: linear-gradient(90deg, transparent, #34d399, transparent); }
  .rh-hero--yellow::before { background: linear-gradient(90deg, transparent, #facc15, transparent); }
  .rh-hero--red::before    { background: linear-gradient(90deg, transparent, #f87171, transparent); }

  /* SVG gauge */
  .rh-gauge {
    position: relative;
    width: 140px;
    height: 140px;
    flex-shrink: 0;
  }
  .rh-gauge-svg {
    width: 140px;
    height: 140px;
    transform: rotate(-90deg);
  }
  .rh-gauge-track {
    fill: none;
    stroke: var(--border);
    stroke-width: 12;
  }
  .rh-gauge-fill {
    fill: none;
    stroke-width: 12;
    stroke-linecap: round;
    transition: stroke-dashoffset 600ms ease;
  }
  .rh-gauge-label {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .rh-gauge-score {
    font-size: 36px;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: var(--text-strong);
  }
  .rh-gauge-max {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  /* Hero text */
  .rh-hero-body {
    flex: 1;
    min-width: 200px;
  }
  .rh-hero-eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .rh-hero-title {
    font-family: var(--font-display);
    font-size: clamp(20px, 2.5vw, 28px);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.15;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .rh-hero-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0 0 14px;
    line-height: 1.5;
  }
  .rh-hero-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .rh-computed-at {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Score badge pill */
  .rh-score-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .rh-score-pill--green  { background: rgba(52,211,153,.15);  color: #34d399; border: 1px solid rgba(52,211,153,.3); }
  .rh-score-pill--yellow { background: rgba(250,204,21,.15);  color: #facc15; border: 1px solid rgba(250,204,21,.3); }
  .rh-score-pill--red    { background: rgba(248,113,113,.15); color: #f87171; border: 1px solid rgba(248,113,113,.3); }

  /* Recompute button */
  .rh-recompute-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #5865f2, #8b5cf6);
    border: none;
    cursor: pointer;
    transition: opacity 120ms ease;
  }
  .rh-recompute-btn:hover { opacity: 0.85; }

  /* Section */
  .rh-section-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 var(--space-3) 0;
  }

  /* Signal cards */
  .rh-signals {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: var(--space-5);
  }
  .rh-signal-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-4) var(--space-5);
    transition: border-color 120ms ease;
  }
  .rh-signal-card:hover { border-color: rgba(88,101,242,0.3); }

  .rh-signal-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 10px;
    gap: 8px;
    flex-wrap: wrap;
  }
  .rh-signal-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .rh-signal-score {
    font-size: 13px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .rh-signal-score strong {
    font-weight: 700;
    color: var(--text);
  }

  .rh-bar-track {
    height: 8px;
    background: var(--bg-tertiary, rgba(255,255,255,0.06));
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .rh-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 500ms ease;
  }
  .rh-bar-green  { background: #34d399; }
  .rh-bar-yellow { background: #facc15; }
  .rh-bar-red    { background: #f87171; }
  .rh-bar-blue   { background: #60a5fa; }
  .rh-bar-purple { background: #a78bfa; }

  .rh-signal-detail {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .rh-signal-detail strong { color: var(--text); font-weight: 600; }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number): "green" | "yellow" | "red" {
  if (score >= 80) return "green";
  if (score >= 50) return "yellow";
  return "red";
}

function gaugeProps(score: number) {
  const r = 55;
  const circumference = 2 * Math.PI * r;
  const dashoffset = circumference * (1 - score / 100);
  const color =
    score >= 80 ? "#34d399" :
    score >= 50 ? "#facc15" :
    "#f87171";
  return {
    r,
    cx: 70,
    cy: 70,
    dasharray: circumference.toFixed(2),
    dashoffset: dashoffset.toFixed(2),
    color,
  };
}

function barColor(pct: number): string {
  if (pct >= 0.75) return "rh-bar-green";
  if (pct >= 0.45) return "rh-bar-yellow";
  return "rh-bar-red";
}

function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ─── Signal card rendering helpers ───────────────────────────────────────────

function CiCard({ breakdown }: { breakdown: HealthScoreBreakdown }) {
  const { score, rate, totalRuns, passedRuns } = breakdown.ciGreenRate;
  const pct = score / 25;
  const detail =
    totalRuns === 0
      ? "No gate runs in the last 30 days — benefit of the doubt applied."
      : `${passedRuns} of ${totalRuns} gate runs passed (${Math.round(rate * 100)}%) in the last 30 days.`;

  return (
    <div class="rh-signal-card">
      <div class="rh-signal-header">
        <span class="rh-signal-name">CI Green Rate</span>
        <span class="rh-signal-score">
          <strong>{score}</strong> / 25
        </span>
      </div>
      <div class="rh-bar-track">
        <div
          class={`rh-bar-fill ${barColor(pct)}`}
          style={`width:${Math.round(pct * 100)}%`}
        />
      </div>
      <div class="rh-signal-detail">{detail}</div>
    </div>
  );
}

function BusFactorCard({ breakdown }: { breakdown: HealthScoreBreakdown }) {
  const { score, atRiskFileCount, criticalCount } = breakdown.busFactor;
  const pct = score / 20;
  const detail =
    atRiskFileCount === 0
      ? score === 15
        ? "No bus factor analysis available yet."
        : "No at-risk files detected — knowledge well distributed."
      : `${atRiskFileCount} at-risk file${atRiskFileCount !== 1 ? "s" : ""} (${criticalCount} critical). High knowledge concentration detected.`;

  return (
    <div class="rh-signal-card">
      <div class="rh-signal-header">
        <span class="rh-signal-name">Bus Factor</span>
        <span class="rh-signal-score">
          <strong>{score}</strong> / 20
        </span>
      </div>
      <div class="rh-bar-track">
        <div
          class={`rh-bar-fill ${barColor(pct)}`}
          style={`width:${Math.round(pct * 100)}%`}
        />
      </div>
      <div class="rh-signal-detail">{detail}</div>
    </div>
  );
}

function CveCard({ breakdown }: { breakdown: HealthScoreBreakdown }) {
  const { score, count } = breakdown.openCves;
  const pct = score / 20;
  const detail =
    count === 0
      ? "No open CVE alerts — dependency security looks clean."
      : `${count} open CVE alert${count !== 1 ? "s" : ""} detected in dependencies.`;

  return (
    <div class="rh-signal-card">
      <div class="rh-signal-header">
        <span class="rh-signal-name">Open CVEs</span>
        <span class="rh-signal-score">
          <strong>{score}</strong> / 20
        </span>
      </div>
      <div class="rh-bar-track">
        <div
          class={`rh-bar-fill ${barColor(pct)}`}
          style={`width:${Math.round(pct * 100)}%`}
        />
      </div>
      <div class="rh-signal-detail">{detail}</div>
    </div>
  );
}

function VelocityCard({ breakdown }: { breakdown: HealthScoreBreakdown }) {
  const { score, avgHours, sampleSize } = breakdown.reviewVelocity;
  const pct = score / 15;
  let detail: string;
  if (avgHours === null) {
    detail = "No merged PRs with human review comments in the last 30 days.";
  } else {
    detail = `Average time to first review: <strong>${formatHours(avgHours)}</strong> across ${sampleSize} PR${sampleSize !== 1 ? "s" : ""} (last 30 days).`;
  }

  return (
    <div class="rh-signal-card">
      <div class="rh-signal-header">
        <span class="rh-signal-name">PR Review Velocity</span>
        <span class="rh-signal-score">
          <strong>{score}</strong> / 15
        </span>
      </div>
      <div class="rh-bar-track">
        <div
          class={`rh-bar-fill rh-bar-blue`}
          style={`width:${Math.round(pct * 100)}%`}
        />
      </div>
      <div
        class="rh-signal-detail"
        dangerouslySetInnerHTML={{ __html: detail }}
      />
    </div>
  );
}

function DebtCard({ breakdown }: { breakdown: HealthScoreBreakdown }) {
  const { score, available } = breakdown.techDebt;
  const pct = score / 20;
  const detail = available
    ? "Onboarding analysis available — neutral score applied (no debt-map data yet)."
    : "No tech debt analysis available. Neutral score applied.";

  return (
    <div class="rh-signal-card">
      <div class="rh-signal-header">
        <span class="rh-signal-name">Tech Debt</span>
        <span class="rh-signal-score">
          <strong>{score}</strong> / 20
        </span>
      </div>
      <div class="rh-bar-track">
        <div
          class={`rh-bar-fill rh-bar-purple`}
          style={`width:${Math.round(pct * 100)}%`}
        />
      </div>
      <div class="rh-signal-detail">{detail}</div>
    </div>
  );
}

// ─── Route: GET /:owner/:repo/health ─────────────────────────────────────────

repoHealthRoutes.use("/:owner/:repo/health", softAuth);

repoHealthRoutes.get(
  "/:owner/:repo/health",
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user") ?? null;
    const repository = (
      c.get("repository" as never) as { id: string; ownerId: string } | null
    );

    if (!repository) return c.notFound();

    const repoId = repository.id;
    const isOwner = !!user && user.id === repository.ownerId;

    const [breakdown, unreadCount] = await Promise.all([
      getHealthScore(repoId),
      user ? getUnreadCount(user.id) : Promise.resolve(0),
    ]);

    const color = scoreColor(breakdown.total);
    const gauge = gaugeProps(breakdown.total);
    const computedAtStr = breakdown.computedAt.toLocaleString();

    return c.html(
      <Layout
        title={`Health Score — ${owner}/${repo}`}
        user={user}
        notificationCount={unreadCount}
      >
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="rh-wrap">
          <RepoHeader owner={owner} repo={repo} healthScore={breakdown.total} />
          <RepoNav owner={owner} repo={repo} active="insights" />

          {/* Sub-navigation */}
          <nav class="rh-subnav">
            <a class="rh-subnav-link" href={`/${owner}/${repo}/insights`}>Overview</a>
            <a class="rh-subnav-link" href={`/${owner}/${repo}/insights/dora`}>DORA</a>
            <a class="rh-subnav-link" href={`/${owner}/${repo}/insights/velocity`}>Velocity</a>
            <a class="rh-subnav-link" href={`/${owner}/${repo}/pulse`}>Pulse</a>
            <a class="rh-subnav-link active" href={`/${owner}/${repo}/health`}>Health</a>
            <a class="rh-subnav-link" href={`/${owner}/${repo}/insights/hotfiles`}>Hot Files</a>
            <a class="rh-subnav-link" href={`/${owner}/${repo}/insights/bus-factor`}>Bus Factor</a>
          </nav>

          {/* Hero */}
          <div class={`rh-hero rh-hero--${color}`}>
            {/* SVG circle gauge */}
            <div class="rh-gauge">
              <svg class="rh-gauge-svg" viewBox="0 0 140 140">
                <circle
                  class="rh-gauge-track"
                  cx={gauge.cx}
                  cy={gauge.cy}
                  r={gauge.r}
                />
                <circle
                  class="rh-gauge-fill"
                  cx={gauge.cx}
                  cy={gauge.cy}
                  r={gauge.r}
                  stroke={gauge.color}
                  stroke-dasharray={gauge.dasharray}
                  stroke-dashoffset={gauge.dashoffset}
                />
              </svg>
              <div class="rh-gauge-label">
                <span class="rh-gauge-score">{breakdown.total}</span>
                <span class="rh-gauge-max">/ 100</span>
              </div>
            </div>

            <div class="rh-hero-body">
              <div class="rh-hero-eyebrow">Repository Intelligence</div>
              <h1 class="rh-hero-title">Health Score</h1>
              <p class="rh-hero-sub">
                Composite signal across CI reliability, bus factor, CVE exposure,
                review velocity, and tech debt for{" "}
                <strong>{owner}/{repo}</strong>.
              </p>
              <div class="rh-hero-actions">
                <span class={`rh-score-pill rh-score-pill--${color}`}>
                  {breakdown.total >= 80 ? "Healthy" : breakdown.total >= 50 ? "Fair" : "Needs Attention"}
                </span>
                {isOwner && (
                  <form
                    method="post"
                    action={`/${owner}/${repo}/health/recompute`}
                    style="display:inline"
                  >
                    <button type="submit" class="rh-recompute-btn">
                      ↻ Recompute
                    </button>
                  </form>
                )}
                <span class="rh-computed-at">
                  Computed {computedAtStr}
                </span>
              </div>
            </div>
          </div>

          {/* Signal breakdown */}
          <h2 class="rh-section-title">Signal Breakdown</h2>
          <div class="rh-signals">
            <CiCard breakdown={breakdown} />
            <BusFactorCard breakdown={breakdown} />
            <CveCard breakdown={breakdown} />
            <VelocityCard breakdown={breakdown} />
            <DebtCard breakdown={breakdown} />
          </div>
        </div>
      </Layout>
    );
  }
);

// ─── Route: POST /:owner/:repo/health/recompute ───────────────────────────────

repoHealthRoutes.use("/:owner/:repo/health/recompute", requireAuth);

repoHealthRoutes.post(
  "/:owner/:repo/health/recompute",
  requireRepoAccess("write"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    // Only repo owner may force recompute
    const repoRows = await db
      .select({ id: repositories.id, ownerId: repositories.ownerId })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(eq(users.username, owner), eq(repositories.name, repo))
      )
      .limit(1);

    if (!repoRows.length) return c.notFound();
    const repository = repoRows[0];

    if (user.id !== repository.ownerId) {
      return c.text("Forbidden", 403);
    }

    invalidateHealthScore(repository.id);
    return c.redirect(`/${owner}/${repo}/health`);
  }
);

export default repoHealthRoutes;

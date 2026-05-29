/**
 * Repository Health Score Dashboard — M14.
 *
 * Route: GET /:owner/:repo/insights/health
 *
 * Composite 0-100 score combining:
 *   - Security    (0-30 pts): open advisory alerts
 *   - Green Gates (0-25 pts): gate pass rate (30d)
 *   - Velocity    (0-25 pts): avg PR time-to-merge (90d)
 *   - Maintenance (0-20 pts): avg open issue age
 *
 * Zero new DB tables — pure computation from existing tables via
 * src/lib/health-score.ts.
 *
 * Scoped CSS: `.hs-*`
 */

import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth";
import { softAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import { computeHealthScore } from "../lib/health-score";

const healthRoutes = new Hono<AuthEnv>();

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .hs-wrap {
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* Insights sub-navigation — mirrors .vel-subnav */
  .hs-subnav {
    display: flex;
    gap: 4px;
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .hs-subnav-link {
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
  .hs-subnav-link:hover { color: var(--text); }
  .hs-subnav-link.active {
    color: var(--accent, #5865f2);
    border-bottom-color: var(--accent, #5865f2);
  }

  /* Hero card */
  .hs-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: var(--space-6);
    flex-wrap: wrap;
  }
  .hs-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #34d399 30%, #3b82f6 70%, transparent 100%);
    opacity: 0.8;
    pointer-events: none;
  }

  /* Circular gauge (CSS-only) */
  .hs-gauge {
    position: relative;
    width: 120px;
    height: 120px;
    flex-shrink: 0;
  }
  .hs-gauge-svg {
    width: 120px;
    height: 120px;
    transform: rotate(-90deg);
  }
  .hs-gauge-track {
    fill: none;
    stroke: var(--border);
    stroke-width: 10;
  }
  .hs-gauge-fill {
    fill: none;
    stroke-width: 10;
    stroke-linecap: round;
    transition: stroke-dashoffset 600ms ease;
  }
  .hs-gauge-label {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .hs-gauge-score {
    font-size: 28px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: var(--text);
  }
  .hs-gauge-max {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  /* Grade badge */
  .hs-grade-badge {
    display: inline-block;
    padding: 4px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .hs-grade-elite      { background: rgba(52,211,153,.15); color: #34d399; border: 1px solid rgba(52,211,153,.3); }
  .hs-grade-strong     { background: rgba(96,165,250,.15); color: #60a5fa; border: 1px solid rgba(96,165,250,.3); }
  .hs-grade-improving  { background: rgba(250,204,21,.15);  color: #facc15; border: 1px solid rgba(250,204,21,.3); }
  .hs-grade-needs-attention { background: rgba(248,113,113,.15); color: #f87171; border: 1px solid rgba(248,113,113,.3); }

  .hs-hero-text {
    flex: 1;
    min-width: 200px;
  }
  .hs-hero-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 var(--space-2) 0;
    color: var(--text);
  }
  .hs-hero-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 var(--space-3) 0;
    line-height: 1.5;
  }

  /* Component bars */
  .hs-components {
    margin-bottom: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .hs-component {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-4) var(--space-5);
  }
  .hs-component-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .hs-component-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .hs-component-score {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .hs-component-score strong {
    color: var(--text);
    font-weight: 700;
  }
  .hs-bar-track {
    height: 8px;
    background: var(--border);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 6px;
  }
  .hs-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 500ms ease;
  }
  .hs-component-hint {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Bar fill colours keyed to component */
  .hs-fill-security    { background: #f87171; }
  .hs-fill-security.good { background: #34d399; }
  .hs-fill-greenGates  { background: #34d399; }
  .hs-fill-velocity    { background: #60a5fa; }
  .hs-fill-maintenance { background: #a78bfa; }

  /* Section title */
  .hs-section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 var(--space-3) 0;
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gradeLabel(grade: string): string {
  switch (grade) {
    case "elite":           return "Elite";
    case "strong":          return "Strong";
    case "improving":       return "Improving";
    case "needs-attention": return "Needs Attention";
    default:                return grade;
  }
}

/** Gauge stroke-dasharray / stroke-dashoffset for an SVG circle of r=50 */
function gaugeProps(score: number): { dasharray: string; dashoffset: string; color: string } {
  const circumference = 2 * Math.PI * 50; // ≈ 314.16
  const dashoffset = circumference * (1 - score / 100);
  const color =
    score >= 85 ? "#34d399" :
    score >= 70 ? "#60a5fa" :
    score >= 50 ? "#facc15" :
    "#f87171";
  return {
    dasharray: circumference.toFixed(2),
    dashoffset: dashoffset.toFixed(2),
    color,
  };
}

/** Pick bar-fill CSS class for a component key */
function barClass(key: string, score: number, max: number): string {
  const base = `hs-bar-fill hs-fill-${key}`;
  // Security bar flips to green when full score
  if (key === "security" && score === max) return `${base} good`;
  return base;
}

// ─── Path-scoped middleware ────────────────────────────────────────────────────

healthRoutes.use("/:owner/:repo/insights/health", softAuth);

// ─── GET handler ──────────────────────────────────────────────────────────────

healthRoutes.get(
  "/:owner/:repo/insights/health",
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user") ?? null;
    const repository = (
      c.get("repository" as never) as { id: string; name: string; isPrivate: boolean }
    ) ?? null;

    if (!repository) {
      return c.html("Repository not found", 404);
    }

    const repoId = repository.id;

    // Compute health score + unread count in parallel
    const [health, unreadCount] = await Promise.all([
      computeHealthScore(repoId),
      user ? getUnreadCount(user.id) : Promise.resolve(0),
    ]);

    const gauge = gaugeProps(health.total);

    // Ordered component entries for rendering
    const componentEntries = [
      { key: "security",    data: health.components.security },
      { key: "greenGates",  data: health.components.greenGates },
      { key: "velocity",    data: health.components.velocity },
      { key: "maintenance", data: health.components.maintenance },
    ] as const;

    return c.html(
      <Layout
        title={`Health Score — ${owner}/${repo}`}
        user={user}
        notificationCount={unreadCount}
      >
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="hs-wrap">
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="insights" />

          {/* Insights sub-nav */}
          <div class="hs-subnav">
            <a href={`/${owner}/${repo}/insights`} class="hs-subnav-link">
              Insights
            </a>
            <a href={`/${owner}/${repo}/insights/dora`} class="hs-subnav-link">
              DORA
            </a>
            <a
              href={`/${owner}/${repo}/insights/velocity`}
              class="hs-subnav-link"
            >
              Velocity
            </a>
            <a href={`/${owner}/${repo}/pulse`} class="hs-subnav-link">
              Pulse
            </a>
            <a
              href={`/${owner}/${repo}/insights/health`}
              class="hs-subnav-link active"
            >
              Health
            </a>
            <a
              href={`/${owner}/${repo}/insights/hotfiles`}
              class="hs-subnav-link"
            >
              Hot Files
            </a>
          </div>

          {/* Hero — gauge + title + grade */}
          <div class="hs-hero">
            {/* CSS-only SVG circle gauge */}
            <div class="hs-gauge">
              <svg class="hs-gauge-svg" viewBox="0 0 120 120">
                <circle
                  class="hs-gauge-track"
                  cx="60"
                  cy="60"
                  r="50"
                />
                <circle
                  class="hs-gauge-fill"
                  cx="60"
                  cy="60"
                  r="50"
                  stroke={gauge.color}
                  stroke-dasharray={gauge.dasharray}
                  stroke-dashoffset={gauge.dashoffset}
                />
              </svg>
              <div class="hs-gauge-label">
                <span class="hs-gauge-score">{health.total}</span>
                <span class="hs-gauge-max">/ 100</span>
              </div>
            </div>

            <div class="hs-hero-text">
              <h1 class="hs-hero-title">Repository Health Score</h1>
              <p class="hs-hero-sub">
                Composite score across security, gate reliability, PR velocity,
                and issue maintenance for{" "}
                <strong>
                  {owner}/{repo}
                </strong>
                .
              </p>
              <span class={`hs-grade-badge hs-grade-${health.grade}`}>
                {gradeLabel(health.grade)}
              </span>
            </div>
          </div>

          {/* Component breakdown */}
          <h2 class="hs-section-title">Score Breakdown</h2>
          <div class="hs-components">
            {componentEntries.map(({ key, data }) => {
              const pct = data.max > 0 ? (data.score / data.max) * 100 : 0;
              return (
                <div class="hs-component" key={key}>
                  <div class="hs-component-header">
                    <span class="hs-component-label">{data.label}</span>
                    <span class="hs-component-score">
                      <strong>{data.score}</strong> / {data.max}
                    </span>
                  </div>
                  <div class="hs-bar-track">
                    <div
                      class={barClass(key, data.score, data.max)}
                      style={`width: ${pct.toFixed(1)}%`}
                    />
                  </div>
                  <div class="hs-component-hint">{data.hint}</div>
                </div>
              );
            })}
          </div>
        </div>
      </Layout>
    );
  }
);

export default healthRoutes;

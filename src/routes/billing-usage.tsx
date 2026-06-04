/**
 * /billing/usage — Per-repo + per-agent AI cost dashboard.
 *
 *   GET  /billing/usage                — the personal AI spend dashboard
 *   POST /billing/usage/budget         — set monthly AI budget (cents)
 *
 * The dashboard is observational (we do NOT block calls on overspend yet —
 * that's a future hard-gate). It surfaces:
 *
 *   - Stat cards: This month, Last month, Daily average, Projected EOM
 *   - 30-day trend sparkline (inline SVG, no chart library)
 *   - Breakdown by category, by repo, by agent
 *   - Monthly budget form + an exceeded-warning banner
 *
 * All CSS is scoped under `.cost-*`. Reuses the 2026 hero/orb pattern from
 * `/settings/billing` so the surface feels familiar.
 */

import { Hono } from "hono";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db";
import {
  aiBudgets,
  aiCostEvents,
  agentSessions,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  aggregateEvents,
  dailyAverageCents,
  formatCents,
  formatTokens,
  projectMonthEndCents,
  startOfUtcMonth,
  summarizeCostsForRepo,
  summarizeCostsForUser,
  toUtcDayKey,
} from "../lib/ai-cost-tracker";
import type { CostSummary } from "../lib/ai-cost-tracker";

const usage = new Hono<AuthEnv>();
usage.use("*", softAuth);

// ─── Scoped CSS (all `.cost-*`) ───────────────────────────────────────────
const styles = `
  .cost-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6, 32px) var(--space-4, 24px); }

  .cost-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .cost-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75; pointer-events: none;
  }
  .cost-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px); opacity: 0.7;
    pointer-events: none; z-index: 0;
  }
  .cost-hero-inner { position: relative; z-index: 1; display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .cost-hero-text { max-width: 680px; flex: 1; min-width: 240px; }
  .cost-eyebrow {
    display: inline-flex; align-items: center; gap: 8px;
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--text-muted); font-weight: 600;
    margin-bottom: 16px;
  }
  .cost-eyebrow-dot {
    width: 8px; height: 8px; border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .cost-eyebrow strong { color: var(--accent); font-weight: 600; letter-spacing: 0.04em; }
  .cost-title {
    font-family: var(--font-display);
    font-size: clamp(32px, 5vw, 48px);
    font-weight: 800;
    letter-spacing: -0.030em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .cost-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; color: transparent;
  }
  .cost-total {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.02em;
    margin-top: 4px;
  }
  .cost-total small {
    font-size: 13px; color: var(--text-muted);
    margin-left: 10px; font-weight: 500;
  }
  .cost-sub { font-size: 16px; color: var(--text-muted); margin: 0; line-height: 1.55; max-width: 580px; }

  /* Banner */
  .cost-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    display: flex; align-items: center; gap: 10px;
  }
  .cost-banner.is-warn { border-color: rgba(245,158,11,0.40); background: rgba(245,158,11,0.08); color: #fde68a; }
  .cost-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .cost-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* Stat cards */
  .cost-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .cost-stat {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    display: flex; flex-direction: column; gap: 6px;
  }
  .cost-stat-head {
    font-size: 10.5px; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.14em;
    font-family: var(--font-mono); font-weight: 600;
  }
  .cost-stat-val {
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-size: 24px; font-weight: 700; color: var(--text-strong);
    letter-spacing: -0.02em;
  }
  .cost-stat-sub { font-size: 11.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }

  /* Section card (shared) */
  .cost-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .cost-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: var(--space-3); flex-wrap: wrap;
  }
  .cost-section-title {
    margin: 0; font-family: var(--font-display); font-size: 16px;
    font-weight: 700; color: var(--text-strong); letter-spacing: -0.014em;
  }
  .cost-section-sub { margin: 4px 0 0; font-size: 12.5px; color: var(--text-muted); }
  .cost-section-body { padding: var(--space-4) var(--space-5); }

  /* Trend chart */
  .cost-trend { width: 100%; height: 140px; display: block; }
  .cost-trend-line { stroke: #8c6dff; stroke-width: 2; fill: none; }
  .cost-trend-fill { fill: url(#cost-grad); opacity: 0.45; }
  .cost-trend-axis { stroke: var(--border); stroke-width: 1; opacity: 0.6; }
  .cost-trend-label { fill: var(--text-muted); font-family: var(--font-mono); font-size: 10px; }

  /* Breakdown table */
  .cost-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .cost-table th { text-align: left; font-weight: 600; color: var(--text-muted); padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; }
  .cost-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text); font-variant-numeric: tabular-nums; }
  .cost-table td.is-num { text-align: right; font-family: var(--font-mono); }
  .cost-table tr:last-child td { border-bottom: none; }
  .cost-table .cost-cat-pill {
    display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px;
    background: rgba(140,109,255,0.12); color: #c4b5fd; border: 1px solid rgba(140,109,255,0.30);
    font-family: var(--font-mono);
  }
  .cost-empty { color: var(--text-muted); font-size: 13px; font-style: italic; padding: 6px 0; }

  /* Budget form */
  .cost-budget-form { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .cost-budget-form label { font-size: 13px; color: var(--text-muted); }
  .cost-budget-form input[type="number"] {
    flex: 0 0 140px; padding: 8px 12px;
    background: var(--bg-secondary, rgba(0,0,0,0.15));
    border: 1px solid var(--border); border-radius: 8px; color: var(--text);
    font-family: var(--font-mono); font-variant-numeric: tabular-nums;
  }
  .cost-budget-form button {
    padding: 8px 16px; border-radius: 8px;
    border: 1px solid rgba(140,109,255,0.40);
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.12));
    color: var(--text-strong); font-weight: 600; cursor: pointer; font-size: 13px;
  }
  .cost-budget-form button:hover { border-color: rgba(140,109,255,0.60); }
  .cost-budget-note { margin-top: 10px; font-size: 12px; color: var(--text-muted); }

  .cost-foot { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border); font-size: 12.5px; color: var(--text-muted); text-align: center; }
  .cost-foot a { color: var(--accent); }

  .cost-sublinks { display: flex; gap: var(--space-3); flex-wrap: wrap; font-size: 13px; margin-bottom: var(--space-4); }
  .cost-sublinks a { color: var(--text-muted); text-decoration: none; padding: 6px 12px; border-radius: 9px; border: 1px solid var(--border); background: rgba(255,255,255,0.02); }
  .cost-sublinks a:hover { color: var(--text-strong); border-color: var(--border-strong); }
  .cost-sublinks a.is-current { color: var(--text-strong); border-color: rgba(140,109,255,0.45); background: rgba(140,109,255,0.08); }
`;

/** Build the inline-SVG sparkline for the last N days. Pure function. */
export function buildTrendSparkline(
  byDayCents: Array<{ day: string; cents: number }>,
  days = 30
): { points: string; areaPoints: string; max: number; total: number } {
  const today = new Date();
  // Build last N days inclusive, fill 0 where missing.
  const map = new Map(byDayCents.map((d) => [d.day, d.cents]));
  const series: Array<{ day: string; cents: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = toUtcDayKey(d);
    series.push({ day: key, cents: map.get(key) || 0 });
  }
  const max = Math.max(1, ...series.map((s) => s.cents));
  const w = 100;
  const h = 100;
  const stepX = series.length > 1 ? w / (series.length - 1) : w;
  const pts = series.map((s, i) => {
    const x = +(i * stepX).toFixed(2);
    const y = +(h - (s.cents / max) * h).toFixed(2);
    return `${x},${y}`;
  });
  const points = pts.join(" ");
  const areaPoints = `0,${h} ${points} ${w},${h}`;
  const total = series.reduce((a, b) => a + b.cents, 0);
  return { points, areaPoints, max, total };
}

/** Wrapper that builds the whole dashboard payload for a user. Exported so
 * tests + the API endpoint share the same code path. */
export async function buildDashboardForUser(userId: string): Promise<{
  thisMonth: CostSummary;
  lastMonth: CostSummary;
  thirtyDay: CostSummary;
  thisMonthCents: number;
  lastMonthCents: number;
  dailyAvgCents: number;
  projectedEomCents: number;
  budgetCents: number;
  exceeds: boolean;
}> {
  const now = new Date();
  const monthStart = startOfUtcMonth(now);
  const prevMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const prevMonthEnd = new Date(monthStart.getTime() - 1);
  const thirtyAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const [thisMonth, lastMonth, thirtyDay] = await Promise.all([
    summarizeCostsForUser(userId, { fromDate: monthStart, toDate: now }),
    summarizeCostsForUser(userId, {
      fromDate: prevMonthStart,
      toDate: prevMonthEnd,
    }),
    summarizeCostsForUser(userId, { fromDate: thirtyAgo, toDate: now }),
  ]);

  const thisMonthCents = thisMonth.totalCents;
  const lastMonthCents = lastMonth.totalCents;
  const dailyAvgCents = dailyAverageCents(thisMonthCents, now);
  const projectedEomCents = projectMonthEndCents(thisMonthCents, now);

  let budgetCents = 0;
  try {
    const [b] = await db
      .select()
      .from(aiBudgets)
      .where(eq(aiBudgets.userId, userId))
      .limit(1);
    budgetCents = b?.monthlyCents ?? 0;
  } catch {
    /* tolerate — table may not yet exist */
  }
  const exceeds = budgetCents > 0 && projectedEomCents > budgetCents;

  return {
    thisMonth,
    lastMonth,
    thirtyDay,
    thisMonthCents,
    lastMonthCents,
    dailyAvgCents,
    projectedEomCents,
    budgetCents,
    exceeds,
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  ai_review: "PR review",
  ai_patch: "AI patches",
  ci_healer: "CI healer",
  spec_to_pr: "Spec-to-PR",
  standup: "AI standup",
  chat: "Repo chat",
  voice: "Voice-to-PR",
  test_gen: "Test gen",
  refactor: "Multi-repo refactor",
  other: "Other",
};

// ─── GET /billing/usage ─────────────────────────────────────────────────
usage.get("/billing/usage", requireAuth, async (c) => {
  const user = c.get("user")!;
  const data = await buildDashboardForUser(user.id);
  const trend = buildTrendSparkline(data.thirtyDay.byDay, 30);

  // Hydrate repo names + agent names for the breakdown tables.
  const repoLookup = await loadRepoLookup(data.thisMonth.byRepo.map((r) => r.repositoryId).filter((x): x is string => !!x));
  const agentLookup = await loadAgentLookup(data.thisMonth.byAgent.map((r) => r.agentSessionId).filter((x): x is string => !!x));

  const saved = c.req.query("saved") === "1";

  return c.html(
    <Layout title="AI usage — Gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="cost-wrap">
        {/* Hero */}
        <section class="cost-hero">
          <div class="cost-orb" aria-hidden="true" />
          <div class="cost-hero-inner">
            <div class="cost-hero-text">
              <div class="cost-eyebrow">
                <span class="cost-eyebrow-dot" aria-hidden="true" />
                Billing · <strong>@{user.username}</strong> · usage
              </div>
              <h1 class="cost-title">
                <span class="cost-title-grad">AI spend.</span>
              </h1>
              <div class="cost-total">
                {formatCents(data.thisMonthCents)}
                <small>this month</small>
              </div>
              <p class="cost-sub" style="margin-top:12px">
                Per-repo + per-agent Anthropic spend, classified by feature. Cents are estimated from the published Claude rate card at call time.
              </p>
            </div>
          </div>
        </section>

        <div class="cost-sublinks">
          <a href="/settings/billing">Plans + payment</a>
          <a href="/billing/usage" class="is-current">AI usage</a>
          <a href="/settings/agents">Agents</a>
        </div>

        {saved && (
          <div class="cost-banner is-ok" role="status">
            <span class="cost-banner-dot" aria-hidden="true" />
            Budget saved.
          </div>
        )}
        {data.exceeds && (
          <div class="cost-banner is-warn" role="alert">
            <span class="cost-banner-dot" aria-hidden="true" />
            Projected month-end spend ({formatCents(data.projectedEomCents)}) exceeds your budget ({formatCents(data.budgetCents)}). Trim usage or raise the cap below.
          </div>
        )}

        {/* Stat cards */}
        <div class="cost-stats">
          <div class="cost-stat">
            <div class="cost-stat-head">This month</div>
            <div class="cost-stat-val">{formatCents(data.thisMonthCents)}</div>
            <div class="cost-stat-sub">
              {formatTokens(data.thisMonth.totalInputTokens + data.thisMonth.totalOutputTokens)} tokens
            </div>
          </div>
          <div class="cost-stat">
            <div class="cost-stat-head">Last month</div>
            <div class="cost-stat-val">{formatCents(data.lastMonthCents)}</div>
            <div class="cost-stat-sub">
              {formatTokens(data.lastMonth.totalInputTokens + data.lastMonth.totalOutputTokens)} tokens
            </div>
          </div>
          <div class="cost-stat">
            <div class="cost-stat-head">Daily average</div>
            <div class="cost-stat-val">{formatCents(data.dailyAvgCents)}</div>
            <div class="cost-stat-sub">elapsed month-to-date</div>
          </div>
          <div class="cost-stat">
            <div class="cost-stat-head">Projected EOM</div>
            <div class="cost-stat-val">{formatCents(data.projectedEomCents)}</div>
            <div class="cost-stat-sub">linear extrapolation</div>
          </div>
        </div>

        {/* Trend chart */}
        <section class="cost-section">
          <header class="cost-section-head">
            <div>
              <h3 class="cost-section-title">30-day trend</h3>
              <p class="cost-section-sub">
                Daily spend in cents. Peak day:&nbsp;
                <span style="font-family:var(--font-mono);color:var(--text-strong)">{formatCents(trend.max)}</span>.
                30-day total:&nbsp;
                <span style="font-family:var(--font-mono);color:var(--text-strong)">{formatCents(trend.total)}</span>.
              </p>
            </div>
          </header>
          <div class="cost-section-body">
            <svg
              class="cost-trend"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-label="30-day AI spend sparkline"
              role="img"
            >
              <defs>
                <linearGradient id="cost-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#8c6dff" stop-opacity="0.6" />
                  <stop offset="100%" stop-color="#36c5d6" stop-opacity="0.05" />
                </linearGradient>
              </defs>
              <line class="cost-trend-axis" x1="0" y1="100" x2="100" y2="100" />
              <polygon class="cost-trend-fill" points={trend.areaPoints} />
              <polyline class="cost-trend-line" points={trend.points} />
            </svg>
          </div>
        </section>

        {/* Breakdown by category */}
        <section class="cost-section">
          <header class="cost-section-head">
            <div>
              <h3 class="cost-section-title">By feature this month</h3>
              <p class="cost-section-sub">Where the spend is going — PR review, CI healing, refactors, etc.</p>
            </div>
          </header>
          <div class="cost-section-body">
            {data.thisMonth.byCategory.length === 0 ? (
              <div class="cost-empty">No AI activity yet this month.</div>
            ) : (
              <table class="cost-table">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th style="text-align:right">Spend</th>
                    <th style="text-align:right">Input tokens</th>
                    <th style="text-align:right">Output tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.thisMonth.byCategory.map((c) => (
                    <tr>
                      <td>
                        <span class="cost-cat-pill">{CATEGORY_LABELS[c.category] || c.category}</span>
                      </td>
                      <td class="is-num">{formatCents(c.cents)}</td>
                      <td class="is-num">{formatTokens(c.inputTokens)}</td>
                      <td class="is-num">{formatTokens(c.outputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* By repo */}
        <section class="cost-section">
          <header class="cost-section-head">
            <div>
              <h3 class="cost-section-title">Top repos this month</h3>
              <p class="cost-section-sub">Top 10 repositories by spend. NULL = global activity (not repo-scoped).</p>
            </div>
          </header>
          <div class="cost-section-body">
            {data.thisMonth.byRepo.length === 0 ? (
              <div class="cost-empty">No repo-scoped AI activity yet this month.</div>
            ) : (
              <table class="cost-table">
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th style="text-align:right">Spend</th>
                    <th style="text-align:right">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.thisMonth.byRepo.slice(0, 10).map((r) => {
                    const meta = r.repositoryId ? repoLookup.get(r.repositoryId) : null;
                    const label = meta ? `${meta.owner}/${meta.name}` : "(global)";
                    return (
                      <tr>
                        <td>{meta ? <a href={`/${meta.owner}/${meta.name}`}>{label}</a> : <span style="color:var(--text-muted)">{label}</span>}</td>
                        <td class="is-num">{formatCents(r.cents)}</td>
                        <td class="is-num">{formatTokens(r.inputTokens + r.outputTokens)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* By agent */}
        <section class="cost-section">
          <header class="cost-section-head">
            <div>
              <h3 class="cost-section-title">Top agents this month</h3>
              <p class="cost-section-sub">Top 10 agent sessions by spend. Manage caps at /settings/agents.</p>
            </div>
          </header>
          <div class="cost-section-body">
            {data.thisMonth.byAgent.filter((a) => a.agentSessionId).length === 0 ? (
              <div class="cost-empty">No agent-attributed AI activity yet this month.</div>
            ) : (
              <table class="cost-table">
                <thead>
                  <tr>
                    <th>Agent session</th>
                    <th style="text-align:right">Spend</th>
                    <th style="text-align:right">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.thisMonth.byAgent
                    .filter((a) => a.agentSessionId)
                    .slice(0, 10)
                    .map((a) => {
                      const meta = a.agentSessionId ? agentLookup.get(a.agentSessionId) : null;
                      const label = meta ? meta.name : a.agentSessionId?.slice(0, 8) || "?";
                      return (
                        <tr>
                          <td>
                            <span style="font-family:var(--font-mono);font-size:12.5px">{label}</span>
                          </td>
                          <td class="is-num">{formatCents(a.cents)}</td>
                          <td class="is-num">{formatTokens(a.inputTokens + a.outputTokens)}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Budget form */}
        <section class="cost-section">
          <header class="cost-section-head">
            <div>
              <h3 class="cost-section-title">Monthly budget</h3>
              <p class="cost-section-sub">Advisory cap; we warn when projected EOM exceeds it. 0 disables the warning.</p>
            </div>
          </header>
          <div class="cost-section-body">
            <form
              method="post"
              action="/billing/usage/budget"
              class="cost-budget-form"
            >
              <label for="budget-dollars">Cap (USD)</label>
              <input
                type="number"
                id="budget-dollars"
                name="dollars"
                min="0"
                step="1"
                value={String(Math.round((data.budgetCents || 0) / 100))}
              />
              <button type="submit">Save</button>
            </form>
            <p class="cost-budget-note">
              Current cap:&nbsp;
              <span style="font-family:var(--font-mono);color:var(--text-strong)">{data.budgetCents > 0 ? formatCents(data.budgetCents) : "no cap"}</span>.
            </p>
          </div>
        </section>

        <div class="cost-foot">
          Need raw events? <a href="/api/v2/usage/me">GET /api/v2/usage/me</a>{" "}
          returns the same shape as this page in JSON.
        </div>
      </div>
    </Layout>
  );
});

// ─── POST /billing/usage/budget ─────────────────────────────────────────
usage.post("/billing/usage/budget", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const rawDollars = body.dollars;
  const dollars = Math.max(0, Math.floor(Number(rawDollars) || 0));
  const cents = dollars * 100;
  try {
    await db
      .insert(aiBudgets)
      .values({ userId: user.id, monthlyCents: cents })
      .onConflictDoUpdate({
        target: aiBudgets.userId,
        set: { monthlyCents: cents, updatedAt: new Date() },
      });
  } catch (err) {
    console.warn(
      "[billing-usage] budget save failed:",
      err instanceof Error ? err.message : err
    );
  }
  return c.redirect("/billing/usage?saved=1");
});

// ─── Helpers ────────────────────────────────────────────────────────────
async function loadRepoLookup(
  repoIds: string[]
): Promise<Map<string, { name: string; owner: string }>> {
  const lookup = new Map<string, { name: string; owner: string }>();
  if (repoIds.length === 0) return lookup;
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id));
    for (const r of rows) {
      if (repoIds.includes(r.id)) {
        lookup.set(r.id, { name: r.name, owner: r.ownerName });
      }
    }
  } catch {
    /* tolerate */
  }
  return lookup;
}

async function loadAgentLookup(
  sessionIds: string[]
): Promise<Map<string, { name: string }>> {
  const lookup = new Map<string, { name: string }>();
  if (sessionIds.length === 0) return lookup;
  try {
    const rows = await db
      .select({ id: agentSessions.id, name: agentSessions.name })
      .from(agentSessions);
    for (const r of rows) {
      if (sessionIds.includes(r.id)) lookup.set(r.id, { name: r.name });
    }
  } catch {
    /* tolerate */
  }
  return lookup;
}

// ─── Test-only exports ──────────────────────────────────────────────────
export const __test = {
  buildTrendSparkline,
  buildDashboardForUser,
  CATEGORY_LABELS,
};

export default usage;

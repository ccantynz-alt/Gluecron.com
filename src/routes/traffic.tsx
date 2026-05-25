/**
 * Block F1 — Traffic analytics UI.
 *
 *   GET  /:owner/:repo/traffic  — owner-only 14-day views/clones chart,
 *                                  unique visitors, top paths + referers.
 *
 * 2026 polish: gradient-hairline hero + radial orb + stat-card grid with
 * tabular-nums + ▲/▼ trend arrows, simple 14-day bar chart, top-referers
 * list with mono URLs, dashed-orb empty states. Every class prefixed
 * `.traffic-` so this surface can't bleed into the wider repo polish. All
 * routes, queries, and the `summarise()` contract preserved exactly.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { summarise } from "../lib/traffic";

const traffic = new Hono<AuthEnv>();
traffic.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.traffic-` so this surface can't
 * bleed into the wider repo polish. Mirrors the gradient-hairline hero +
 * stat-card grid pattern from `insights.tsx` + `admin-integrations`.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .traffic-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  .traffic-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .traffic-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .traffic-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .traffic-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .traffic-hero-text { max-width: 720px; }
  .traffic-eyebrow {
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
  .traffic-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .traffic-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .traffic-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .traffic-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* Window switcher (7/14/30/90d) */
  .traffic-windows {
    display: inline-flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .traffic-window {
    display: inline-flex;
    align-items: center;
    padding: 6px 12px;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-muted);
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
    font-variant-numeric: tabular-nums;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .traffic-window:hover { border-color: rgba(140,109,255,0.45); color: var(--text-strong); text-decoration: none; }
  .traffic-window.is-active {
    color: #fff;
    background: linear-gradient(135deg, rgba(140,109,255,0.85), rgba(54,197,214,0.85));
    border-color: rgba(140,109,255,0.55);
  }

  /* Stat-card grid */
  .traffic-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .traffic-stat {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .traffic-stat:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .traffic-stat-label {
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 6px;
  }
  .traffic-stat-value {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .traffic-stat-trend {
    margin-top: 8px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .traffic-stat-trend.is-up { color: #6ee7b7; }
  .traffic-stat-trend.is-down { color: #fca5a5; }
  .traffic-stat-trend .arrow { font-size: 11px; line-height: 1; }
  .traffic-stat-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Section heading */
  .traffic-section-head {
    margin: 0 0 var(--space-3);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .traffic-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .traffic-section-sub { font-size: 12.5px; color: var(--text-muted); }

  /* Bar-chart card */
  .traffic-chart {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    margin-bottom: var(--space-5);
  }
  .traffic-chart-bars {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 160px;
    padding: 12px 0 10px;
    border-bottom: 1px solid var(--border);
  }
  .traffic-bar {
    flex: 1;
    min-width: 8px;
    position: relative;
    display: flex;
    flex-direction: column-reverse;
    border-radius: 4px 4px 0 0;
    overflow: hidden;
    background: rgba(255,255,255,0.03);
    transition: transform 120ms ease;
  }
  .traffic-bar:hover { transform: translateY(-2px); }
  .traffic-bar .seg-views {
    background: linear-gradient(180deg, #8c6dff, #6d4dff);
    box-shadow: 0 0 12px -2px rgba(140,109,255,0.45);
  }
  .traffic-bar .seg-clones {
    background: linear-gradient(180deg, #36c5d6, #0891b2);
  }
  .traffic-bar-day {
    margin-top: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
    text-align: center;
    transform: rotate(-35deg);
    transform-origin: center;
    white-space: nowrap;
  }
  .traffic-bars-row {
    display: flex;
    gap: 6px;
    margin-top: 12px;
  }
  .traffic-bars-row > div { flex: 1; min-width: 8px; }
  .traffic-chart-legend {
    display: flex;
    gap: 18px;
    margin-top: 16px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .traffic-legend-dot {
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 3px;
    margin-right: 6px;
    vertical-align: middle;
  }
  .traffic-legend-dot.views { background: linear-gradient(180deg, #8c6dff, #6d4dff); }
  .traffic-legend-dot.clones { background: linear-gradient(180deg, #36c5d6, #0891b2); }

  /* Two-column lists (top paths + referrers) */
  .traffic-twocol {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  @media (max-width: 720px) {
    .traffic-twocol { grid-template-columns: 1fr; }
  }
  .traffic-list-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-3) var(--space-4);
  }
  .traffic-list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .traffic-list-row:last-child { border-bottom: 0; }
  .traffic-list-key {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .traffic-list-key a { color: inherit; text-decoration: none; }
  .traffic-list-key a:hover { color: var(--accent); text-decoration: none; }
  .traffic-list-val {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Empty state — dashed orb card */
  .traffic-empty {
    position: relative;
    overflow: hidden;
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 16px;
    background: rgba(255,255,255,0.012);
    color: var(--text-muted);
  }
  .traffic-empty::before {
    content: '';
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.14), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .traffic-empty-inner { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .traffic-empty strong {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
  }
  .traffic-empty p { font-size: 13px; margin: 0; max-width: 420px; }
`;

async function loadRepo(owner: string, repo: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

traffic.get("/:owner/:repo/traffic", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const windowDays = Math.max(
    1,
    Math.min(90, parseInt(c.req.query("days") || "14", 10) || 14)
  );
  const summary = await summarise(repoRow.id, windowDays);

  // Bar-chart scaling: tallest single-day total across the window.
  const maxN = Math.max(
    1,
    ...summary.daily.map((d) => d.views + d.clones)
  );

  // Crude trend signals: compare first vs second half of the window. Used
  // only for the ▲/▼ glyph on the stat cards — the actual numbers come
  // straight from `summarise()` so the contract is preserved.
  const half = Math.max(1, Math.floor(summary.daily.length / 2));
  const firstViews = summary.daily
    .slice(0, half)
    .reduce((n, d) => n + d.views, 0);
  const lastViews = summary.daily
    .slice(half)
    .reduce((n, d) => n + d.views, 0);
  const viewsTrend =
    summary.daily.length < 2
      ? "flat"
      : lastViews >= firstViews
        ? "up"
        : "down";
  const firstClones = summary.daily
    .slice(0, half)
    .reduce((n, d) => n + d.clones, 0);
  const lastClones = summary.daily
    .slice(half)
    .reduce((n, d) => n + d.clones, 0);
  const clonesTrend =
    summary.daily.length < 2
      ? "flat"
      : lastClones >= firstClones
        ? "up"
        : "down";

  const trendClass = (t: string) =>
    t === "up" ? "is-up" : t === "down" ? "is-down" : "";
  const trendArrow = (t: string) => (t === "down" ? "▼" : "▲");

  return c.html(
    <Layout title={`Traffic — ${owner}/${repo}`} user={user}>
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user.username}
      />
      <RepoNav owner={owner} repo={repo} active="insights" />

      <div class="traffic-wrap">
        <section class="traffic-hero">
          <div class="traffic-hero-orb" aria-hidden="true" />
          <div class="traffic-hero-inner">
            <div class="traffic-hero-text">
              <div class="traffic-eyebrow">
                <span class="traffic-eyebrow-dot" aria-hidden="true" />
                Traffic · {owner}/{repo}
              </div>
              <h2 class="traffic-title">
                <span class="traffic-title-grad">Who's looking.</span>
              </h2>
              <p class="traffic-sub">
                Views, clones, and unique visitors over the last{" "}
                {windowDays} day{windowDays === 1 ? "" : "s"} — refreshed live
                from every web hit and git-http access.
              </p>
            </div>
            <div class="traffic-windows" aria-label="Time window">
              {[7, 14, 30, 90].map((d) => (
                <a
                  href={`/${owner}/${repo}/traffic?days=${d}`}
                  class={
                    "traffic-window" + (d === windowDays ? " is-active" : "")
                  }
                >
                  {d}d
                </a>
              ))}
            </div>
          </div>
        </section>

        <div class="traffic-stats">
          <div class="traffic-stat">
            <div class="traffic-stat-label">Views</div>
            <div class="traffic-stat-value">
              {summary.totalViews.toLocaleString()}
            </div>
            <div class={"traffic-stat-trend " + trendClass(viewsTrend)}>
              <span class="arrow" aria-hidden="true">
                {trendArrow(viewsTrend)}
              </span>
              vs prior period
            </div>
          </div>
          <div class="traffic-stat">
            <div class="traffic-stat-label">Unique visitors</div>
            <div class="traffic-stat-value">
              {summary.uniqueVisitorsApprox.toLocaleString()}
            </div>
            <div class="traffic-stat-hint">Approx · distinct ip-hash</div>
          </div>
          <div class="traffic-stat">
            <div class="traffic-stat-label">Clones</div>
            <div class="traffic-stat-value">
              {summary.totalClones.toLocaleString()}
            </div>
            <div class={"traffic-stat-trend " + trendClass(clonesTrend)}>
              <span class="arrow" aria-hidden="true">
                {trendArrow(clonesTrend)}
              </span>
              vs prior period
            </div>
          </div>
          <div class="traffic-stat">
            <div class="traffic-stat-label">Referrers</div>
            <div class="traffic-stat-value">
              {summary.topReferers.length.toLocaleString()}
            </div>
            <div class="traffic-stat-hint">Distinct sources</div>
          </div>
        </div>

        <div class="traffic-section-head">
          <h3 class="traffic-section-title">Daily activity</h3>
          <span class="traffic-section-sub">
            {summary.daily.length} day{summary.daily.length === 1 ? "" : "s"}{" "}
            with data
          </span>
        </div>
        <div class="traffic-chart">
          {summary.daily.length === 0 ? (
            <div class="traffic-empty">
              <div class="traffic-empty-inner">
                <strong>No traffic recorded yet</strong>
                <p>
                  Views are tracked automatically as people visit this repo;
                  clones + API hits are tracked on git-http access. Share the
                  URL and check back in a bit.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div class="traffic-chart-bars" role="img" aria-label="Daily traffic bars">
                {summary.daily.map((d) => {
                  const total = d.views + d.clones;
                  const heightPct = Math.max(2, (total / maxN) * 100);
                  const viewsShare = total ? (d.views / total) * heightPct : 0;
                  const clonesShare = total ? (d.clones / total) * heightPct : 0;
                  return (
                    <div
                      class="traffic-bar"
                      title={`${d.day} · ${d.views} views, ${d.clones} clones`}
                      style={`height:${heightPct}%`}
                    >
                      <div class="seg-clones" style={`height:${clonesShare}%`} />
                      <div class="seg-views" style={`height:${viewsShare}%`} />
                    </div>
                  );
                })}
              </div>
              <div class="traffic-bars-row" aria-hidden="true">
                {summary.daily.map((d) => (
                  <div class="traffic-bar-day">{d.day.slice(5)}</div>
                ))}
              </div>
              <div class="traffic-chart-legend">
                <span>
                  <span class="traffic-legend-dot views" aria-hidden="true" />
                  Views
                </span>
                <span>
                  <span class="traffic-legend-dot clones" aria-hidden="true" />
                  Clones
                </span>
              </div>
            </>
          )}
        </div>

        <div class="traffic-twocol">
          <div>
            <div class="traffic-section-head">
              <h3 class="traffic-section-title">Top paths</h3>
              <span class="traffic-section-sub">
                {summary.topPaths.length} path
                {summary.topPaths.length === 1 ? "" : "s"}
              </span>
            </div>
            <div class="traffic-list-card">
              {summary.topPaths.length === 0 ? (
                <div class="traffic-empty">
                  <div class="traffic-empty-inner">
                    <strong>No paths recorded</strong>
                    <p>Path hits appear here as visitors browse the repo.</p>
                  </div>
                </div>
              ) : (
                summary.topPaths.map((p) => (
                  <div class="traffic-list-row">
                    <span class="traffic-list-key" title={p.path}>
                      {p.path}
                    </span>
                    <span class="traffic-list-val">
                      {p.n.toLocaleString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div>
            <div class="traffic-section-head">
              <h3 class="traffic-section-title">Top referrers</h3>
              <span class="traffic-section-sub">
                {summary.topReferers.length} source
                {summary.topReferers.length === 1 ? "" : "s"}
              </span>
            </div>
            <div class="traffic-list-card">
              {summary.topReferers.length === 0 ? (
                <div class="traffic-empty">
                  <div class="traffic-empty-inner">
                    <strong>No external referrers</strong>
                    <p>
                      Share this repo on social or in docs to start seeing
                      where visits come from.
                    </p>
                  </div>
                </div>
              ) : (
                summary.topReferers.map((r) => (
                  <div class="traffic-list-row">
                    <span class="traffic-list-key" title={r.referer}>
                      {r.referer}
                    </span>
                    <span class="traffic-list-val">
                      {r.n.toLocaleString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

export default traffic;

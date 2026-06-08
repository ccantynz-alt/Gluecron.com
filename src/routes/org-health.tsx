/**
 * Org-level team health dashboard.
 *
 *   GET  /orgs/:slug/health            — ranked health page (worst-first)
 *   POST /orgs/:slug/health/recompute  — invalidate caches + redirect
 *
 * Reuses `computeOrgHealth` from src/lib/org-health.ts and the
 * `getHealthScore` signal breakdown already built in src/lib/repo-health.ts.
 * No new tables — leverages repo_health_cache + bus_factor_cache etc.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { organizations, orgMembers } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  computeOrgHealth,
  invalidateOrgHealthAndRepos,
  type OrgRepoHealth,
} from "../lib/org-health";
import { loadOrgForUser, orgRoleAtLeast } from "../lib/orgs";

const orgHealthRoutes = new Hono<AuthEnv>();
orgHealthRoutes.use("*", softAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score >= 80) return "#34d399";
  if (score >= 50) return "#fbbf24";
  return "#f87171";
}

function scorePillClass(score: number): string {
  if (score >= 80) return "oh-pill--good";
  if (score >= 50) return "oh-pill--warn";
  return "oh-pill--bad";
}

function trendArrow(trend: "up" | "down" | "stable"): string {
  if (trend === "up") return "↑";
  if (trend === "down") return "↓";
  return "→";
}

function trendClass(trend: "up" | "down" | "stable"): string {
  if (trend === "up") return "oh-trend--up";
  if (trend === "down") return "oh-trend--down";
  return "oh-trend--stable";
}

function badgeStyle(score: number): string {
  const color = scoreColor(score);
  return `background:rgba(0,0,0,0.25);color:${color};border:1px solid ${color}40;padding:2px 6px;border-radius:4px;font-size:11px;font-family:var(--font-mono);font-weight:600`;
}

// ---------------------------------------------------------------------------
// Scoped CSS — every class prefixed `.oh-`
// ---------------------------------------------------------------------------

const styles = `
  .oh-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  /* Hero */
  .oh-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .oh-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #34d399 30%, #fbbf24 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .oh-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(52,211,153,0.18), rgba(251,191,36,0.08) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.6;
    pointer-events: none;
    z-index: 0;
  }
  .oh-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .oh-hero-text { max-width: 720px; }
  .oh-eyebrow {
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
  .oh-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #34d399, #fbbf24);
    box-shadow: 0 0 0 3px rgba(52,211,153,0.18);
  }
  .oh-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 4vw, 38px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .oh-title-grad {
    background-image: linear-gradient(135deg, #6ee7b7 0%, #34d399 50%, #fbbf24 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .oh-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }
  .oh-back {
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
  .oh-back:hover {
    background: rgba(52,211,153,0.06);
    border-color: rgba(52,211,153,0.45);
    text-decoration: none;
  }

  /* Avg score pill */
  .oh-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 64px; height: 64px;
    border-radius: 9999px;
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 800;
    border: 3px solid;
    margin-top: 14px;
    font-variant-numeric: tabular-nums;
  }
  .oh-pill--good { color: #34d399; border-color: rgba(52,211,153,0.5); background: rgba(52,211,153,0.08); }
  .oh-pill--warn { color: #fbbf24; border-color: rgba(251,191,36,0.5); background: rgba(251,191,36,0.08); }
  .oh-pill--bad  { color: #f87171; border-color: rgba(248,113,113,0.5); background: rgba(248,113,113,0.08); }

  /* AI summary card */
  .oh-ai-card {
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: rgba(59,130,246,0.05);
    border: 1px solid rgba(59,130,246,0.3);
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.65;
    color: var(--text);
    white-space: pre-wrap;
  }
  .oh-ai-label {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #93c5fd;
    margin-bottom: var(--space-2);
  }
  .oh-ai-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59,130,246,0.2);
  }

  /* Repo table */
  .oh-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .oh-table-head {
    padding: var(--space-3) var(--space-4);
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .oh-table-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-strong);
  }
  .oh-table-sub { font-size: 12px; color: var(--text-muted); }
  table.oh-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .oh-table th {
    padding: 10px 14px;
    text-align: left;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .oh-table td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .oh-table tr:last-child td { border-bottom: none; }
  .oh-table tr:hover td { background: rgba(255,255,255,0.02); }
  .oh-rank {
    width: 28px; height: 28px;
    border-radius: 8px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .oh-repo-link {
    color: var(--text-strong);
    font-weight: 600;
    text-decoration: none;
    font-size: 13.5px;
  }
  .oh-repo-link:hover { color: var(--accent); }

  /* Score bar */
  .oh-bar-track {
    width: 120px;
    height: 6px;
    background: rgba(255,255,255,0.08);
    border-radius: 3px;
    overflow: hidden;
    display: inline-block;
    vertical-align: middle;
    margin-right: 8px;
  }

  /* Trend arrows */
  .oh-trend--up    { color: #34d399; font-weight: 700; }
  .oh-trend--down  { color: #f87171; font-weight: 700; }
  .oh-trend--stable { color: var(--text-muted); }

  /* Recompute button */
  .oh-recompute-form { margin-top: var(--space-2); }
  .oh-recompute-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 10px;
    border: 1px solid var(--border-strong, var(--border));
    background: transparent;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .oh-recompute-btn:hover {
    background: rgba(52,211,153,0.07);
    border-color: rgba(52,211,153,0.4);
  }

  /* Empty state */
  .oh-empty {
    padding: var(--space-6) var(--space-4);
    text-align: center;
    color: var(--text-muted);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
  }
  .oh-empty strong {
    display: block;
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin-bottom: 8px;
  }

  /* Generated-at footer */
  .oh-footer {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: var(--space-3);
    font-family: var(--font-mono);
  }
`;

// ---------------------------------------------------------------------------
// GET /orgs/:slug/health
// ---------------------------------------------------------------------------

orgHealthRoutes.get("/orgs/:slug/health", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user");

  const { org, role } = await loadOrgForUser(slug, user?.id);
  if (!org) return c.notFound();

  const report = await computeOrgHealth(org.id, org.slug);
  // Patch org name in case the lib used slug as placeholder
  const orgName = org.name;

  const isAdmin = !!role && orgRoleAtLeast(role, "admin");
  const avgScore = report.avgScore;

  return c.html(
    <Layout title={`${orgName} — Engineering Health`} user={user ?? null}>
      <div class="oh-wrap">
        {/* Hero */}
        <section class="oh-hero">
          <div class="oh-hero-orb" aria-hidden="true" />
          <div class="oh-hero-inner">
            <div class="oh-hero-text">
              <div class="oh-eyebrow">
                <span class="oh-eyebrow-dot" aria-hidden="true" />
                Team health · {slug}
              </div>
              <h2 class="oh-title">
                <span class="oh-title-grad">{orgName}</span>{" "}
                Engineering Health
              </h2>
              <p class="oh-sub">
                All repositories ranked worst-first by composite health score.
                Fix the bottom of the list to move the org average.
              </p>
              <div
                class={"oh-pill " + scorePillClass(avgScore)}
                title={`Org average: ${avgScore}/100`}
              >
                {avgScore}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:var(--space-3)">
              <a href={`/orgs/${slug}`} class="oh-back">
                ← Back to {slug}
              </a>
              {isAdmin && (
                <form
                  method="post"
                  action={`/orgs/${slug}/health/recompute`}
                  class="oh-recompute-form"
                >
                  <button type="submit" class="oh-recompute-btn">
                    ↺ Recompute
                  </button>
                </form>
              )}
            </div>
          </div>
        </section>

        {/* AI Summary */}
        {report.aiSummary && (
          <div class="oh-ai-card">
            <div class="oh-ai-label">
              <span class="oh-ai-dot" aria-hidden="true" />
              AI Engineering Summary
            </div>
            {report.aiSummary}
          </div>
        )}

        {/* Repo table */}
        <div class="oh-table-wrap">
          <div class="oh-table-head">
            <h3 class="oh-table-title">Repository Health — Worst First</h3>
            <span class="oh-table-sub">{report.repos.length} repo{report.repos.length === 1 ? "" : "s"}</span>
          </div>

          {report.repos.length === 0 ? (
            <div class="oh-empty">
              <strong>No repositories found</strong>
              <p>This org has no active repositories yet, or health data is still loading.</p>
            </div>
          ) : (
            <table class="oh-table">
              <thead>
                <tr>
                  <th style="width:40px">#</th>
                  <th>Repository</th>
                  <th style="width:200px">Score</th>
                  <th style="width:60px">Trend</th>
                  <th style="width:55px">CI</th>
                  <th style="width:80px">BusFactor</th>
                  <th style="width:55px">CVEs</th>
                  <th style="width:60px">Review</th>
                  <th style="width:55px">Debt</th>
                </tr>
              </thead>
              <tbody>
                {report.repos.map((r: OrgRepoHealth, i: number) => {
                  const b = r.breakdown;
                  const barColor = scoreColor(r.score);
                  return (
                    <tr key={r.repoId}>
                      <td>
                        <span class="oh-rank">{i + 1}</span>
                      </td>
                      <td>
                        <a
                          href={`/${slug}/${r.repoName}`}
                          class="oh-repo-link"
                        >
                          {slug}/{r.repoName}
                        </a>
                      </td>
                      <td>
                        <span class="oh-bar-track">
                          <div
                            style={`width:${r.score}%;background:${barColor};height:6px;border-radius:3px`}
                          />
                        </span>
                        <span
                          style={`color:${barColor};font-family:var(--font-mono);font-size:13px;font-weight:700`}
                        >
                          {r.score}
                        </span>
                        <span style="color:var(--text-muted);font-size:11px">/100</span>
                      </td>
                      <td>
                        <span class={trendClass(r.trend)} title={`Trend: ${r.trend}`}>
                          {trendArrow(r.trend)}
                        </span>
                      </td>
                      <td>
                        <span style={badgeStyle(b.ciGreenRate.score)}>
                          {b.ciGreenRate.score}
                        </span>
                      </td>
                      <td>
                        <span style={badgeStyle(b.busFactor.score)}>
                          {b.busFactor.score}
                        </span>
                      </td>
                      <td>
                        <span style={badgeStyle(b.openCves.score)}>
                          {b.openCves.score}
                        </span>
                      </td>
                      <td>
                        <span style={badgeStyle(b.reviewVelocity.score)}>
                          {b.reviewVelocity.score}
                        </span>
                      </td>
                      <td>
                        <span style={badgeStyle(b.techDebt.score)}>
                          {b.techDebt.score}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div class="oh-footer">
          Generated {report.generatedAt.toISOString().replace("T", " ").slice(0, 19)} UTC · cached 1h
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /orgs/:slug/health/recompute — admin only, invalidate + redirect
// ---------------------------------------------------------------------------

orgHealthRoutes.post("/orgs/:slug/health/recompute", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user")!;

  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.text("Forbidden", 403);
  }

  await invalidateOrgHealthAndRepos(org.id);
  return c.redirect(`/orgs/${slug}/health`);
});

export { orgHealthRoutes };
export default orgHealthRoutes;

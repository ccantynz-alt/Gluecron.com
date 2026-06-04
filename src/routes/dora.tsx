/**
 * DORA (DevOps Research and Assessment) metrics page.
 *
 * Route: GET /:owner/:repo/insights/dora
 *
 * Computes the four key DORA metrics using existing tables:
 *   1. Deployment frequency    — deployments in last 30d
 *   2. Lead time for changes   — avg gap between consecutive deployments (proxy)
 *   3. Change failure rate     — % of deployments with status = 'failed'
 *   4. MTTR                    — avg time from failure to next success
 *
 * Plus two Gluecron-specific bonus metrics:
 *   5. Gate pass rate          — % of gate_runs with status = 'pass'
 *   6. Workflow success rate   — % of workflow_runs with status = 'success'
 *
 * All DB queries are wrapped in Promise.all for parallelism and in
 * try/catch so a DB failure never throws into the request path.
 */

import { Hono } from "hono";
import { db } from "../db";
import { deployments, gateRuns, workflowRuns, repositories, users } from "../db/schema";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import type { AuthEnv } from "../middleware/auth";
import { softAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";

const doraRoutes = new Hono<AuthEnv>();

// ─── DORA benchmark thresholds ───────────────────────────────────────────────

type DoraLevel = "Elite" | "High" | "Medium" | "Low";

function deployFreqLevel(deploysPerWeek: number): DoraLevel {
  // Elite = multiple/day (>7/week), High = weekly (~1/week), Medium = monthly (~0.25/week)
  if (deploysPerWeek >= 7) return "Elite";
  if (deploysPerWeek >= 1) return "High";
  if (deploysPerWeek >= 0.25) return "Medium";
  return "Low";
}

function leadTimeLevel(avgGapHours: number): DoraLevel {
  if (avgGapHours < 1) return "Elite";
  if (avgGapHours < 24) return "High";
  if (avgGapHours < 168) return "Medium"; // 1 week
  return "Low";
}

function changeFailureLevel(failurePct: number): DoraLevel {
  if (failurePct <= 2) return "Elite";
  if (failurePct <= 5) return "High";
  if (failurePct <= 15) return "Medium";
  return "Low";
}

function mttrLevel(avgHours: number): DoraLevel {
  if (avgHours < 1) return "Elite";
  if (avgHours < 24) return "High";
  if (avgHours < 168) return "Medium";
  return "Low";
}

function levelColor(level: DoraLevel): string {
  switch (level) {
    case "Elite": return "var(--green, #4caf50)";
    case "High":  return "var(--blue, #2196f3)";
    case "Medium":return "var(--yellow, #ff9800)";
    case "Low":   return "var(--red, #f44336)";
  }
}

function worstLevel(levels: (DoraLevel | null)[]): DoraLevel {
  const order: DoraLevel[] = ["Elite", "High", "Medium", "Low"];
  let worst: DoraLevel = "Elite";
  for (const l of levels) {
    if (!l) continue;
    if (order.indexOf(l) > order.indexOf(worst)) worst = l;
  }
  return worst;
}

function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

// ─── Scoped CSS ───────────────────────────────────────────────────────────────

const styles = `
  .dora-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  .dora-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .dora-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.8;
    pointer-events: none;
  }

  .dora-eyebrow {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }
  .dora-hero-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 var(--space-2) 0;
    color: var(--text);
  }
  .dora-hero-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 var(--space-4) 0;
  }
  .dora-overall {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 18px;
    border-radius: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .dora-overall-label {
    font-size: 13px;
    color: var(--text-muted);
  }
  .dora-overall-badge {
    font-size: 15px;
    font-weight: 700;
    border-radius: 5px;
    padding: 2px 10px;
    color: #fff;
  }

  .dora-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  .dora-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dora-card-name {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
  }
  .dora-card-value {
    font-size: 24px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    line-height: 1.1;
  }
  .dora-card-value.dora-na {
    font-size: 18px;
    color: var(--text-muted);
  }
  .dora-level-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    border-radius: 4px;
    padding: 2px 8px;
    color: #fff;
    margin-top: 2px;
    align-self: flex-start;
  }
  .dora-card-desc {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.45;
    margin-top: 2px;
  }

  .dora-section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 var(--space-3) 0;
  }
  .dora-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .dora-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .dora-table th {
    text-align: left;
    padding: 10px 16px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .dora-table td {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .dora-table tr:last-child td { border-bottom: none; }
  .dora-pill {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    border-radius: 4px;
    padding: 2px 8px;
    color: #fff;
  }
  .dora-pill-success { background: var(--green, #4caf50); }
  .dora-pill-failed  { background: var(--red, #f44336); }
  .dora-pill-other   { background: var(--text-muted); }
  .dora-sha          { font-family: monospace; font-size: 12px; color: var(--text-muted); }
`;

// ─── Route ────────────────────────────────────────────────────────────────────

doraRoutes.get(
  "/:owner/:repo/insights/dora",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user") ?? null;
    const repository = (c.get("repository" as never) as { id: string; name: string; isPrivate: boolean }) ?? null;

    if (!repository) {
      return c.html("Repository not found", 404);
    }

    const repoId = repository.id;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // ─── Parallel DB queries (all fail-open) ──────────────────────────────
    const [
      recentDeployments,
      last20Deployments,
      last50Deployments,
      gateRunStats,
      workflowRunStats,
    ] = await Promise.all([
      // 1 & 3: Recent deployments for frequency + failure rate
      (async () => {
        try {
          return await db
            .select({
              id: deployments.id,
              status: deployments.status,
              commitSha: deployments.commitSha,
              createdAt: deployments.createdAt,
              completedAt: deployments.completedAt,
            })
            .from(deployments)
            .where(
              and(
                eq(deployments.repositoryId, repoId),
                gte(deployments.createdAt, thirtyDaysAgo)
              )
            )
            .orderBy(desc(deployments.createdAt));
        } catch {
          return null;
        }
      })(),

      // 2: Last 20 deployments for lead-time proxy (avg gap between consecutive)
      (async () => {
        try {
          return await db
            .select({ createdAt: deployments.createdAt })
            .from(deployments)
            .where(eq(deployments.repositoryId, repoId))
            .orderBy(desc(deployments.createdAt))
            .limit(20);
        } catch {
          return null;
        }
      })(),

      // 4: Last 50 deployments for MTTR (failure→success pairs)
      (async () => {
        try {
          return await db
            .select({
              status: deployments.status,
              createdAt: deployments.createdAt,
            })
            .from(deployments)
            .where(eq(deployments.repositoryId, repoId))
            .orderBy(desc(deployments.createdAt))
            .limit(50);
        } catch {
          return null;
        }
      })(),

      // 5: Gate pass rate in last 30d
      (async () => {
        try {
          const rows = await db
            .select({ status: gateRuns.status })
            .from(gateRuns)
            .where(
              and(
                eq(gateRuns.repositoryId, repoId),
                gte(gateRuns.createdAt, thirtyDaysAgo)
              )
            );
          return rows;
        } catch {
          return null;
        }
      })(),

      // 6: Workflow success rate in last 30d
      (async () => {
        try {
          const rows = await db
            .select({ status: workflowRuns.status })
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.repositoryId, repoId),
                gte(workflowRuns.createdAt, thirtyDaysAgo)
              )
            );
          return rows;
        } catch {
          return null;
        }
      })(),
    ]);

    // ─── Metric 1: Deployment frequency ──────────────────────────────────
    let deploysPerWeek: number | null = null;
    let freqLevel: DoraLevel | null = null;
    if (recentDeployments !== null) {
      const count = recentDeployments.length;
      deploysPerWeek = (count / 30) * 7;
      freqLevel = deployFreqLevel(deploysPerWeek);
    }

    // ─── Metric 2: Lead time proxy (avg gap between consecutive deploys) ──
    let avgGapHours: number | null = null;
    let leadLevel: DoraLevel | null = null;
    if (last20Deployments !== null && last20Deployments.length >= 2) {
      const sorted = [...last20Deployments].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const ms = new Date(sorted[i].createdAt).getTime() - new Date(sorted[i - 1].createdAt).getTime();
        if (ms > 0) gaps.push(ms / (1000 * 3600)); // ms → hours
      }
      if (gaps.length > 0) {
        avgGapHours = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        leadLevel = leadTimeLevel(avgGapHours);
      }
    }

    // ─── Metric 3: Change failure rate ───────────────────────────────────
    let failurePct: number | null = null;
    let failureLevel: DoraLevel | null = null;
    if (recentDeployments !== null && recentDeployments.length > 0) {
      const failed = recentDeployments.filter((d) => d.status === "failed").length;
      failurePct = (failed / recentDeployments.length) * 100;
      failureLevel = changeFailureLevel(failurePct);
    }

    // ─── Metric 4: MTTR ───────────────────────────────────────────────────
    let mttrHours: number | null = null;
    let mttrLvl: DoraLevel | null = null;
    if (last50Deployments !== null && last50Deployments.length >= 2) {
      // Chronological order
      const chron = [...last50Deployments].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      const gaps: number[] = [];
      for (let i = 0; i < chron.length - 1; i++) {
        if (chron[i].status === "failed") {
          // Find the next success after this failure
          for (let j = i + 1; j < chron.length; j++) {
            if (chron[j].status === "success") {
              const ms = new Date(chron[j].createdAt).getTime() - new Date(chron[i].createdAt).getTime();
              if (ms > 0) gaps.push(ms / (1000 * 3600));
              break;
            }
          }
        }
      }
      if (gaps.length > 0) {
        mttrHours = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        mttrLvl = mttrLevel(mttrHours);
      }
    }

    // ─── Metric 5: Gate pass rate ─────────────────────────────────────────
    let gatePassPct: number | null = null;
    if (gateRunStats !== null && gateRunStats.length > 0) {
      const passed = gateRunStats.filter((r) => r.status === "passed" || r.status === "pass").length;
      gatePassPct = (passed / gateRunStats.length) * 100;
    }

    // ─── Metric 6: Workflow success rate ──────────────────────────────────
    let workflowSuccessPct: number | null = null;
    if (workflowRunStats !== null && workflowRunStats.length > 0) {
      const succeeded = workflowRunStats.filter((r) => r.status === "success").length;
      workflowSuccessPct = (succeeded / workflowRunStats.length) * 100;
    }

    // ─── Overall DORA level (worst of the 4 core metrics) ─────────────────
    const overallLevel = worstLevel([freqLevel, leadLevel, failureLevel, mttrLvl]);

    // ─── Last 10 deployments for the table ────────────────────────────────
    const last10 = recentDeployments ? recentDeployments.slice(0, 10) : [];

    // ─── Render ──────────────────────────────────────────────────────────
    return c.html(
      <Layout title={`DORA Metrics — ${owner}/${repo}`} user={user}>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="dora-wrap">
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="insights" />

          {/* Hero */}
          <div class="dora-hero">
            <div class="dora-eyebrow">DevOps Research &amp; Assessment</div>
            <h1 class="dora-hero-title">DORA Metrics</h1>
            <p class="dora-hero-sub">
              Deployment performance for the last 30 days, measured against Google's DORA benchmarks.
            </p>
            <div class="dora-overall">
              <span class="dora-overall-label">Overall DORA Level</span>
              <span
                class="dora-overall-badge"
                style={`background:${levelColor(overallLevel)}`}
              >
                {overallLevel}
              </span>
            </div>
          </div>

          {/* 4-metric cards */}
          <div class="dora-grid">
            {/* Deployment Frequency */}
            <div class="dora-card">
              <div class="dora-card-name">Deployment Frequency</div>
              {deploysPerWeek !== null ? (
                <>
                  <div class="dora-card-value">{deploysPerWeek.toFixed(1)}<span style="font-size:14px;font-weight:400;color:var(--text-muted)"> /wk</span></div>
                  <span
                    class="dora-level-badge"
                    style={`background:${levelColor(freqLevel!)}`}
                  >
                    {freqLevel}
                  </span>
                  <div class="dora-card-desc">
                    Elite: multiple/day · High: weekly · Medium: monthly
                  </div>
                </>
              ) : (
                <div class="dora-card-value dora-na">No data</div>
              )}
            </div>

            {/* Lead Time (proxy) */}
            <div class="dora-card">
              <div class="dora-card-name">Lead Time for Changes</div>
              {avgGapHours !== null ? (
                <>
                  <div class="dora-card-value">{formatHours(avgGapHours)}</div>
                  <span
                    class="dora-level-badge"
                    style={`background:${levelColor(leadLevel!)}`}
                  >
                    {leadLevel}
                  </span>
                  <div class="dora-card-desc">
                    Avg gap between consecutive deploys. Elite: &lt;1h · High: &lt;1d
                  </div>
                </>
              ) : (
                <div class="dora-card-value dora-na">No data</div>
              )}
            </div>

            {/* Change Failure Rate */}
            <div class="dora-card">
              <div class="dora-card-name">Change Failure Rate</div>
              {failurePct !== null ? (
                <>
                  <div class="dora-card-value">{failurePct.toFixed(1)}<span style="font-size:14px;font-weight:400;color:var(--text-muted)">%</span></div>
                  <span
                    class="dora-level-badge"
                    style={`background:${levelColor(failureLevel!)}`}
                  >
                    {failureLevel}
                  </span>
                  <div class="dora-card-desc">
                    % of deployments that failed. Elite: 0–2% · High: 2–5%
                  </div>
                </>
              ) : (
                <div class="dora-card-value dora-na">No data</div>
              )}
            </div>

            {/* MTTR */}
            <div class="dora-card">
              <div class="dora-card-name">MTTR</div>
              {mttrHours !== null ? (
                <>
                  <div class="dora-card-value">{formatHours(mttrHours)}</div>
                  <span
                    class="dora-level-badge"
                    style={`background:${levelColor(mttrLvl!)}`}
                  >
                    {mttrLvl}
                  </span>
                  <div class="dora-card-desc">
                    Avg time failure → next success. Elite: &lt;1h · High: &lt;1d
                  </div>
                </>
              ) : (
                <div class="dora-card-value dora-na">No data</div>
              )}
            </div>

            {/* Gate Pass Rate */}
            <div class="dora-card">
              <div class="dora-card-name">Gate Pass Rate</div>
              {gatePassPct !== null ? (
                <>
                  <div class="dora-card-value">{gatePassPct.toFixed(1)}<span style="font-size:14px;font-weight:400;color:var(--text-muted)">%</span></div>
                  <div class="dora-card-desc">
                    Gate runs passing in the last 30 days ({gateRunStats!.length} total).
                  </div>
                </>
              ) : (
                <div class="dora-card-value dora-na">No data</div>
              )}
            </div>

            {/* Workflow Success Rate */}
            <div class="dora-card">
              <div class="dora-card-name">Workflow Success Rate</div>
              {workflowSuccessPct !== null ? (
                <>
                  <div class="dora-card-value">{workflowSuccessPct.toFixed(1)}<span style="font-size:14px;font-weight:400;color:var(--text-muted)">%</span></div>
                  <div class="dora-card-desc">
                    Workflow runs succeeding in the last 30 days ({workflowRunStats!.length} total).
                  </div>
                </>
              ) : (
                <div class="dora-card-value dora-na">No data</div>
              )}
            </div>
          </div>

          {/* Last 10 deployments table */}
          <h2 class="dora-section-title">Last 10 Deployments</h2>
          {last10.length === 0 ? (
            <p style="color:var(--text-muted);font-size:14px;">No deployments found in the last 30 days.</p>
          ) : (
            <div class="dora-table-wrap">
              <table class="dora-table">
                <thead>
                  <tr>
                    <th>SHA</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {last10.map((d) => {
                    const sha7 = d.commitSha.slice(0, 7);
                    const statusClass =
                      d.status === "success"
                        ? "dora-pill-success"
                        : d.status === "failed"
                        ? "dora-pill-failed"
                        : "dora-pill-other";
                    const createdStr = new Date(d.createdAt).toISOString().replace("T", " ").slice(0, 19) + " UTC";
                    let duration = "—";
                    if (d.completedAt) {
                      const ms = new Date(d.completedAt).getTime() - new Date(d.createdAt).getTime();
                      if (ms > 0) {
                        const secs = Math.round(ms / 1000);
                        duration = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
                      }
                    }
                    return (
                      <tr key={d.id}>
                        <td><span class="dora-sha">{sha7}</span></td>
                        <td><span class={`dora-pill ${statusClass}`}>{d.status}</span></td>
                        <td style="color:var(--text-muted)">{createdStr}</td>
                        <td style="color:var(--text-muted)">{duration}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Layout>
    );
  }
);

export default doraRoutes;

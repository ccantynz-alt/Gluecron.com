/**
 * AI Technical Debt Map.
 *
 * Routes:
 *   GET  /:owner/:repo/debt-map           — render the interactive graph page
 *   POST /:owner/:repo/debt-map/analyze   — trigger analysis (owner only), returns JSON
 *   GET  /:owner/:repo/debt-map/data      — return DebtReport JSON
 *
 * The page renders a Canvas-based force-directed graph where:
 *   - Node radius  = sqrt(lines), capped 6–30 px
 *   - Node colour  = debt score (green → yellow → red)
 *   - Edges        = import relationships
 *   - Click a node = side panel with Claude's debt analysis
 *
 * Analysis is asynchronous: the POST kicks off a background Bun promise and
 * returns {status:"running"}; the GET /data endpoint returns the cached
 * report (or 202 if still running).
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { isAiAvailable } from "../lib/ai-client";
import { analyzeRepo } from "../lib/debt-analyzer";
import {
  getDebtReport,
  setDebtReport,
  getJobStatus,
  setJobStatus,
} from "../lib/debt-cache";
import { getUnreadCount } from "../lib/unread";

const debtMapRoutes = new Hono<AuthEnv>();

debtMapRoutes.use("/:owner/:repo/debt-map*", softAuth);

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .dm-wrap {
    max-width: 1200px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* ── Hero ───────────────────────────────────────────────────────────────── */
  .dm-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .dm-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f87171 30%, #fbbf24 60%, #34d399 100%);
    opacity: 0.8;
    pointer-events: none;
  }
  .dm-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 440px; height: 440px;
    background: radial-gradient(circle, rgba(248,113,113,0.15), rgba(251,191,36,0.08) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .dm-hero-inner { position: relative; z-index: 1; max-width: 720px; }

  .dm-eyebrow {
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
  .dm-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #f87171, #fbbf24);
    box-shadow: 0 0 0 3px rgba(248,113,113,0.18);
  }
  .dm-title {
    font-family: var(--font-display, system-ui, sans-serif);
    font-size: clamp(24px, 4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.08;
    margin: 0 0 var(--space-2);
    color: var(--text-strong, var(--text));
  }
  .dm-title-grad {
    background: linear-gradient(135deg, #f87171 0%, #fbbf24 50%, #34d399 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .dm-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0 0 var(--space-4);
    line-height: 1.6;
  }

  /* ── Stats callout ───────────────────────────────────────────────────────── */
  .dm-stats {
    display: flex;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .dm-stat-card {
    flex: 1;
    min-width: 130px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
  }
  .dm-stat-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .dm-stat-value {
    font-size: 22px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text-strong, var(--text));
  }
  .dm-stat-sub {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .dm-debt-hours {
    font-size: 18px;
    font-weight: 800;
    background: linear-gradient(135deg, #f87171, #fbbf24);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }

  /* ── Analyze button ──────────────────────────────────────────────────────── */
  .dm-analyze-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    background: linear-gradient(135deg, #f87171 0%, #fbbf24 100%);
    color: #ffffff;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    box-shadow: 0 6px 16px -4px rgba(248,113,113,0.45);
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .dm-analyze-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -6px rgba(248,113,113,0.55);
  }
  .dm-analyze-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
  }

  /* ── Canvas container ────────────────────────────────────────────────────── */
  .dm-graph-wrap {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: var(--space-5);
    display: flex;
    gap: 0;
  }
  #dm-canvas {
    display: block;
    flex: 1;
    min-width: 0;
    cursor: grab;
    background: transparent;
  }
  #dm-canvas:active { cursor: grabbing; }

  /* ── Side panel ──────────────────────────────────────────────────────────── */
  .dm-panel {
    width: 300px;
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    padding: var(--space-4);
    display: none;
    overflow-y: auto;
    max-height: 500px;
    background: var(--bg);
  }
  .dm-panel.is-open { display: block; }
  .dm-panel-path {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-muted);
    word-break: break-all;
    margin-bottom: var(--space-2);
  }
  .dm-panel-score {
    font-size: 32px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    margin-bottom: var(--space-1);
  }
  .dm-panel-score-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .dm-panel-section { margin-bottom: var(--space-3); }
  .dm-panel-section h4 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin: 0 0 8px;
  }
  .dm-panel-issue {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 13px;
    color: var(--text);
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .dm-panel-issue::before {
    content: '▸';
    color: var(--text-muted);
    flex-shrink: 0;
    margin-top: 1px;
  }
  .dm-panel-hours {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong, var(--text));
  }
  .dm-panel-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text);
    text-decoration: none;
    margin-top: var(--space-3);
    transition: border-color 120ms ease;
  }
  .dm-panel-link:hover { border-color: var(--border-strong, var(--border)); color: var(--text); }

  /* ── Legend ──────────────────────────────────────────────────────────────── */
  .dm-legend {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
    font-size: 12px;
    color: var(--text-muted);
  }
  .dm-legend-dot {
    width: 10px; height: 10px;
    border-radius: 9999px;
    flex-shrink: 0;
  }
  .dm-legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* ── Table ───────────────────────────────────────────────────────────────── */
  .dm-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .dm-table-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .dm-table-head h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--text-strong, var(--text));
  }
  .dm-sort-bar {
    display: flex;
    gap: 4px;
    font-size: 12px;
  }
  .dm-sort-btn {
    padding: 3px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-muted);
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    transition: border-color 120ms, color 120ms;
  }
  .dm-sort-btn:hover { color: var(--text); }
  .dm-sort-btn.active {
    background: var(--bg-elevated);
    border-color: var(--accent, #5865f2);
    color: var(--accent, #5865f2);
  }
  table.dm-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .dm-table th {
    text-align: left;
    padding: 8px 16px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .dm-table td {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    vertical-align: middle;
  }
  .dm-table tr:last-child td { border-bottom: none; }
  .dm-table tr:hover td { background: rgba(255,255,255,0.03); }
  .dm-path {
    font-family: var(--font-mono, monospace);
    font-size: 11.5px;
    word-break: break-all;
  }
  .dm-score-bar-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 120px;
  }
  .dm-score-bar-bg {
    flex: 1;
    height: 6px;
    background: rgba(255,255,255,0.08);
    border-radius: 9999px;
    overflow: hidden;
  }
  .dm-score-bar-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width 400ms ease;
  }
  .dm-score-num {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    min-width: 28px;
    text-align: right;
  }

  /* ── Empty state ─────────────────────────────────────────────────────────── */
  .dm-empty {
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border);
    border-radius: 14px;
    color: var(--text-muted);
    margin-bottom: var(--space-5);
  }
  .dm-empty-icon {
    font-size: 40px;
    margin-bottom: var(--space-3);
    opacity: 0.5;
  }
  .dm-empty strong {
    display: block;
    font-size: 16px;
    color: var(--text);
    margin-bottom: 8px;
  }
  .dm-empty p {
    font-size: 13px;
    margin: 0 0 var(--space-4);
    max-width: 400px;
    margin-left: auto;
    margin-right: auto;
  }

  /* ── No-AI gate ──────────────────────────────────────────────────────────── */
  .dm-no-ai {
    background: rgba(251,191,36,0.08);
    border: 1px solid rgba(251,191,36,0.25);
    border-radius: 10px;
    padding: var(--space-3) var(--space-4);
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-4);
  }
  .dm-no-ai strong { color: #fbbf24; }

  /* ── Running state ────────────────────────────────────────────────────────── */
  .dm-running {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: var(--space-3) var(--space-4);
    background: rgba(140,109,255,0.08);
    border: 1px solid rgba(140,109,255,0.25);
    border-radius: 10px;
    margin-bottom: var(--space-4);
    font-size: 13px;
    color: var(--text-muted);
  }
  .dm-spinner {
    width: 16px; height: 16px;
    border: 2px solid rgba(140,109,255,0.3);
    border-top-color: #8c6dff;
    border-radius: 9999px;
    animation: dm-spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes dm-spin { to { transform: rotate(360deg); } }

  /* ── Claude attribution ───────────────────────────────────────────────────── */
  .dm-attribution {
    font-size: 11px;
    color: var(--text-muted);
    text-align: center;
    margin-top: var(--space-4);
    opacity: 0.7;
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function debtColor(score: number): string {
  if (score <= 33) return "#34d399"; // green
  if (score <= 66) return "#fbbf24"; // yellow
  return "#f87171"; // red
}

// ─── Route: GET /:owner/:repo/debt-map ────────────────────────────────────────

debtMapRoutes.get(
  "/:owner/:repo/debt-map",
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user") ?? null;

    // Look up repo from DB (requireRepoAccess already stashed it)
    const repository = (
      c.get("repository" as never) as
        | { id: string; name: string; isPrivate: boolean; ownerId: string }
        | undefined
    ) ?? null;

    let repoId = repository?.id ?? "";
    if (!repoId) {
      const ownerRow = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, owner))
        .limit(1)
        .then((r) => r[0] ?? null);
      if (!ownerRow) return c.notFound();
      const repoRow = await db
        .select({ id: repositories.id, ownerId: repositories.ownerId })
        .from(repositories)
        .where(and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repo)))
        .limit(1)
        .then((r) => r[0] ?? null);
      if (!repoRow) return c.notFound();
      repoId = repoRow.id;
    }

    const isOwner =
      user !== null &&
      repository !== null &&
      (repository as { ownerId: string }).ownerId === user.id;

    const report = getDebtReport(repoId);
    const jobStatus = getJobStatus(repoId);
    const unreadCount = user ? await getUnreadCount(user.id) : 0;
    const aiAvailable = isAiAvailable();

    return c.html(
      <Layout
        title={`Debt Map — ${owner}/${repo}`}
        user={user}
        notificationCount={unreadCount}
      >
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="dm-wrap">
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="debt-map" />

          {/* Hero */}
          <div class="dm-hero">
            <div class="dm-hero-orb" />
            <div class="dm-hero-inner">
              <div class="dm-eyebrow">
                <span class="dm-eyebrow-dot" />
                AI Technical Debt Map
              </div>
              <h1 class="dm-title">
                Visualise your{" "}
                <span class="dm-title-grad">technical debt</span>
              </h1>
              <p class="dm-sub">
                An interactive graph of every source file — sized by lines,
                coloured by Claude&rsquo;s debt score. Click a node to see
                detailed findings and estimated cleanup hours.
              </p>

              {!aiAvailable && (
                <div class="dm-no-ai">
                  <strong>AI features require ANTHROPIC_API_KEY.</strong>{" "}
                  Set the environment variable to enable Claude analysis. Basic
                  heuristic scores will still be computed.
                </div>
              )}

              {isOwner && (
                <button
                  class="dm-analyze-btn"
                  id="dm-trigger-btn"
                  data-repo-id={repoId}
                  data-owner={owner}
                  data-repo={repo}
                >
                  {report ? "Re-analyze" : "Analyze now"}
                </button>
              )}
            </div>
          </div>

          {/* Running indicator */}
          {jobStatus?.status === "running" && !report && (
            <div class="dm-running" id="dm-running-bar">
              <div class="dm-spinner" />
              <span>
                Analysis running &mdash; this can take 20&ndash;30 seconds.
                Page will refresh when complete.
              </span>
            </div>
          )}

          {/* No analysis yet */}
          {!report && jobStatus?.status !== "running" && (
            <div class="dm-empty">
              <div class="dm-empty-icon">&#9638;</div>
              <strong>No analysis yet</strong>
              <p>
                {isOwner
                  ? 'Click "Analyze now" to scan the codebase with Claude and generate the debt graph.'
                  : "The repository owner has not run a debt analysis yet."}
              </p>
            </div>
          )}

          {/* Graph + table — shown when report exists */}
          {report && (
            <>
              {/* Stat cards */}
              <div class="dm-stats">
                <div class="dm-stat-card">
                  <div class="dm-stat-label">Files analyzed</div>
                  <div class="dm-stat-value">{report.nodes.length}</div>
                </div>
                <div class="dm-stat-card">
                  <div class="dm-stat-label">Total debt</div>
                  <div class="dm-stat-value dm-debt-hours">
                    ~{report.totalDebtHours}h
                  </div>
                  <div class="dm-stat-sub">estimated cleanup time</div>
                </div>
                <div class="dm-stat-card">
                  <div class="dm-stat-label">High-debt files</div>
                  <div class="dm-stat-value">
                    {report.nodes.filter((n) => n.debtScore >= 67).length}
                  </div>
                  <div class="dm-stat-sub">score &ge; 67</div>
                </div>
                <div class="dm-stat-card">
                  <div class="dm-stat-label">Last analyzed</div>
                  <div class="dm-stat-value" style="font-size:14px;">
                    {new Date(report.analyzedAt).toLocaleDateString()}
                  </div>
                </div>
              </div>

              {/* Legend */}
              <div class="dm-legend">
                <span style="color:var(--text-muted);font-size:12px;">
                  Node size = lines of code &nbsp;&bull;&nbsp; Colour = debt score
                </span>
                <span class="dm-legend-item">
                  <span class="dm-legend-dot" style="background:#34d399;" />
                  Low (0-33)
                </span>
                <span class="dm-legend-item">
                  <span class="dm-legend-dot" style="background:#fbbf24;" />
                  Medium (34-66)
                </span>
                <span class="dm-legend-item">
                  <span class="dm-legend-dot" style="background:#f87171;" />
                  High (67-100)
                </span>
              </div>

              {/* Canvas graph */}
              <div class="dm-graph-wrap">
                <canvas id="dm-canvas" width="900" height="500" />
                <div class="dm-panel" id="dm-panel">
                  <div class="dm-panel-path" id="dm-panel-path"></div>
                  <div class="dm-panel-score" id="dm-panel-score"></div>
                  <div class="dm-panel-score-label">debt score / 100</div>

                  <div class="dm-panel-section">
                    <h4>Issues</h4>
                    <div id="dm-panel-issues"></div>
                  </div>

                  <div class="dm-panel-section">
                    <h4>Est. cleanup</h4>
                    <div class="dm-panel-hours" id="dm-panel-hours"></div>
                  </div>

                  <div id="dm-panel-link-wrap"></div>
                </div>
              </div>

              {/* Table */}
              <div class="dm-table-wrap">
                <div class="dm-table-head">
                  <h3>All files</h3>
                  <div class="dm-sort-bar">
                    <button class="dm-sort-btn active" data-sort="debt">
                      By debt
                    </button>
                    <button class="dm-sort-btn" data-sort="lines">
                      By size
                    </button>
                    <button class="dm-sort-btn" data-sort="hours">
                      By hours
                    </button>
                  </div>
                </div>
                <table class="dm-table" id="dm-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Lines</th>
                      <th style="min-width:160px;">Debt score</th>
                      <th>Est. hours</th>
                      <th>Issues</th>
                    </tr>
                  </thead>
                  <tbody id="dm-table-body">
                    {[...report.nodes]
                      .sort((a, b) => b.debtScore - a.debtScore)
                      .map((node) => {
                        const color = debtColor(node.debtScore);
                        return (
                          <tr key={node.path}>
                            <td>
                              <a
                                href={`/${owner}/${repo}/blob/HEAD/${node.path}`}
                                class="dm-path"
                              >
                                {node.path}
                              </a>
                            </td>
                            <td style="font-variant-numeric:tabular-nums;font-size:12px;">
                              {node.lines.toLocaleString()}
                            </td>
                            <td>
                              <div class="dm-score-bar-wrap">
                                <div class="dm-score-bar-bg">
                                  <div
                                    class="dm-score-bar-fill"
                                    style={`width:${node.debtScore}%;background:${color};`}
                                  />
                                </div>
                                <span class="dm-score-num" style={`color:${color};`}>
                                  {node.debtScore}
                                </span>
                              </div>
                            </td>
                            <td style="font-variant-numeric:tabular-nums;">
                              {node.estimatedHours}h
                            </td>
                            <td style="font-size:12px;color:var(--text-muted);max-width:280px;">
                              {node.issues.slice(0, 2).join(", ")}
                              {node.issues.length > 2 && ` +${node.issues.length - 2} more`}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              {/* Inline canvas script */}
              <script
                dangerouslySetInnerHTML={{
                  __html: buildGraphScript(owner, repo, report.nodes),
                }}
              />
            </>
          )}

          <p class="dm-attribution">Powered by Claude &mdash; Anthropic</p>
        </div>

        {/* Trigger analysis + polling script */}
        <script
          dangerouslySetInnerHTML={{
            __html: buildControlScript(owner, repo, repoId, isOwner),
          }}
        />
      </Layout>
    );
  }
);

// ─── Route: POST /:owner/:repo/debt-map/analyze ───────────────────────────────

debtMapRoutes.post(
  "/:owner/:repo/debt-map/analyze",
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user") ?? null;

    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Verify ownership
    const ownerRow = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, owner))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!ownerRow || ownerRow.id !== user.id) {
      return c.json({ error: "Only the repository owner can trigger analysis" }, 403);
    }

    const repoRow = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repo)))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!repoRow) return c.json({ error: "Repository not found" }, 404);

    const repoId = repoRow.id;
    const current = getJobStatus(repoId);

    if (current?.status === "running") {
      return c.json({ status: "running" });
    }

    // Kick off background analysis
    setJobStatus(repoId, "running");

    // Fire-and-forget
    analyzeRepo(repoId, owner, repo)
      .then((report) => {
        setDebtReport(repoId, report);
        setJobStatus(repoId, "done");
      })
      .catch((err) => {
        console.error("[debt-map] analysis failed:", err);
        setJobStatus(repoId, "error", String(err?.message ?? err));
      });

    return c.json({ status: "running" });
  }
);

// ─── Route: GET /:owner/:repo/debt-map/data ───────────────────────────────────

debtMapRoutes.get(
  "/:owner/:repo/debt-map/data",
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();

    const ownerRow = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, owner))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!ownerRow) return c.json({ error: "Not found" }, 404);

    const repoRow = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repo)))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!repoRow) return c.json({ error: "Not found" }, 404);

    const repoId = repoRow.id;
    const report = getDebtReport(repoId);
    const job = getJobStatus(repoId);

    if (!report) {
      return c.json(
        { status: job?.status ?? "idle", error: job?.error },
        report ? 200 : 202
      );
    }

    return c.json({ status: "done", report });
  }
);

// ─── Client-side scripts ──────────────────────────────────────────────────────

/**
 * Build the inline canvas script for the force-directed graph.
 * Runs at 60fps for 200 iterations then stops (spring simulation).
 */
function buildGraphScript(
  owner: string,
  repo: string,
  nodes: Array<{
    path: string;
    lines: number;
    debtScore: number;
    issues: string[];
    estimatedHours: number;
    imports: string[];
  }>
): string {
  // Serialise only what the client needs
  const clientNodes = nodes.map((n) => ({
    path: n.path,
    lines: n.lines,
    debtScore: n.debtScore,
    issues: n.issues,
    estimatedHours: n.estimatedHours,
    imports: n.imports,
  }));

  return `(function(){
  var OWNER = ${JSON.stringify(owner)};
  var REPO  = ${JSON.stringify(repo)};
  var nodesData = ${JSON.stringify(clientNodes)};

  // Build a path→index lookup
  var pathIndex = {};
  nodesData.forEach(function(n, i){ pathIndex[n.path] = i; });

  // Build edge list (indices)
  var edges = [];
  nodesData.forEach(function(n, i){
    (n.imports || []).forEach(function(imp){
      // Try with and without extensions
      var j = pathIndex[imp];
      if(j === undefined){
        // Try common extensions
        var exts = ['.ts','.tsx','.js','.jsx','.py','.go','.rs'];
        for(var e=0;e<exts.length;e++){
          j = pathIndex[imp+exts[e]];
          if(j !== undefined) break;
        }
      }
      if(j !== undefined && j !== i){
        edges.push([i, j]);
      }
    });
  });

  var canvas = document.getElementById('dm-canvas');
  if(!canvas) return;
  var ctx = canvas.getContext('2d');

  // Responsive sizing
  function resize(){
    var wrap = canvas.parentElement;
    var w = wrap ? Math.max(300, wrap.clientWidth - (panelOpen ? 300 : 0)) : 900;
    canvas.width = w;
    canvas.height = 500;
  }
  var panelOpen = false;
  resize();
  window.addEventListener('resize', function(){ resize(); draw(); });

  // Initialise positions randomly within canvas
  var W = canvas.width, H = canvas.height;
  var sim = nodesData.map(function(n, i){
    return {
      x: 60 + Math.random() * (W - 120),
      y: 60 + Math.random() * (H - 120),
      vx: 0, vy: 0,
      radius: Math.min(30, Math.max(6, Math.sqrt(n.lines) * 0.9)),
      color: debtColor(n.debtScore),
      idx: i
    };
  });

  function debtColor(score){
    if(score <= 33) return '#34d399';
    if(score <= 66) return '#fbbf24';
    return '#f87171';
  }

  // Force simulation
  var ITERATIONS = 200;
  var iter = 0;
  var running = true;

  function tick(){
    if(!running) return;
    W = canvas.width; H = canvas.height;
    var REPEL = 1800;
    var ATTRACT = 0.005;
    var DAMPING = 0.85;
    var CENTER_PULL = 0.002;

    // Reset forces
    sim.forEach(function(s){ s.fx = 0; s.fy = 0; });

    // Repulsion between nodes
    for(var i=0;i<sim.length;i++){
      for(var j=i+1;j<sim.length;j++){
        var dx = sim[j].x - sim[i].x;
        var dy = sim[j].y - sim[i].y;
        var dist2 = dx*dx + dy*dy + 1;
        var force = REPEL / dist2;
        var nx = dx / Math.sqrt(dist2);
        var ny = dy / Math.sqrt(dist2);
        sim[i].fx -= force * nx;
        sim[i].fy -= force * ny;
        sim[j].fx += force * nx;
        sim[j].fy += force * ny;
      }
    }

    // Spring attraction along edges
    edges.forEach(function(e){
      var a = sim[e[0]], b = sim[e[1]];
      if(!a || !b) return;
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var dist = Math.sqrt(dx*dx + dy*dy) + 1;
      var restLen = 120;
      var stretch = dist - restLen;
      var force = ATTRACT * stretch;
      var nx = dx / dist, ny = dy / dist;
      a.fx += force * nx; a.fy += force * ny;
      b.fx -= force * nx; b.fy -= force * ny;
    });

    // Gentle center pull
    sim.forEach(function(s){
      s.fx += (W/2 - s.x) * CENTER_PULL;
      s.fy += (H/2 - s.y) * CENTER_PULL;
    });

    // Integrate
    sim.forEach(function(s){
      s.vx = (s.vx + s.fx) * DAMPING;
      s.vy = (s.vy + s.fy) * DAMPING;
      s.x += s.vx;
      s.y += s.vy;
      // Clamp to canvas
      var r = s.radius;
      s.x = Math.max(r, Math.min(W - r, s.x));
      s.y = Math.max(r, Math.min(H - r, s.y));
    });

    draw();
    iter++;
    if(iter < ITERATIONS){
      requestAnimationFrame(tick);
    } else {
      running = false;
      draw();
    }
  }

  var selectedIdx = -1;

  function draw(){
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Edges
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    edges.forEach(function(e){
      var a = sim[e[0]], b = sim[e[1]];
      if(!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
    ctx.restore();

    // Nodes
    sim.forEach(function(s){
      var n = nodesData[s.idx];
      ctx.save();
      // Glow for selected
      if(s.idx === selectedIdx){
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 16;
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.globalAlpha = s.idx === selectedIdx ? 1.0 : 0.82;
      ctx.fill();
      ctx.restore();
    });
  }

  // Click handler
  canvas.addEventListener('click', function(e){
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    var hit = -1;
    for(var i=0;i<sim.length;i++){
      var s = sim[i];
      var dx = s.x - mx, dy = s.y - my;
      if(dx*dx + dy*dy <= s.radius*s.radius){
        hit = i;
        break;
      }
    }
    if(hit === -1){
      selectedIdx = -1;
      closePanel();
    } else {
      selectedIdx = hit;
      openPanel(hit);
    }
    draw();
  });

  function openPanel(idx){
    var n = nodesData[idx];
    var panel = document.getElementById('dm-panel');
    if(!panel) return;
    panelOpen = true;
    panel.classList.add('is-open');

    document.getElementById('dm-panel-path').textContent = n.path;

    var scoreEl = document.getElementById('dm-panel-score');
    scoreEl.textContent = n.debtScore;
    scoreEl.style.color = debtColor(n.debtScore);

    var issuesEl = document.getElementById('dm-panel-issues');
    issuesEl.innerHTML = (n.issues && n.issues.length)
      ? n.issues.map(function(iss){ return '<div class="dm-panel-issue">'+escHtml(iss)+'</div>'; }).join('')
      : '<span style="color:var(--text-muted);font-size:13px;">No issues found</span>';

    document.getElementById('dm-panel-hours').textContent = n.estimatedHours + 'h';

    var linkWrap = document.getElementById('dm-panel-link-wrap');
    linkWrap.innerHTML = '<a href="/'+escHtml(OWNER)+'/'+escHtml(REPO)+'/blob/HEAD/'+escHtml(n.path)+'" class="dm-panel-link">View file &rarr;</a>';

    resize();
    if(!running) draw();
  }

  function closePanel(){
    panelOpen = false;
    var panel = document.getElementById('dm-panel');
    if(panel) panel.classList.remove('is-open');
    resize();
    if(!running) draw();
  }

  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Sort table buttons
  document.querySelectorAll('.dm-sort-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.dm-sort-btn').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      var sort = btn.getAttribute('data-sort');
      var tbody = document.getElementById('dm-table-body');
      if(!tbody) return;
      var rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort(function(a, b){
        var aPath = a.querySelector('.dm-path') ? a.querySelector('.dm-path').textContent.trim() : '';
        var bPath = b.querySelector('.dm-path') ? b.querySelector('.dm-path').textContent.trim() : '';
        var aN = nodesData.find(function(n){ return n.path === aPath; });
        var bN = nodesData.find(function(n){ return n.path === bPath; });
        if(!aN || !bN) return 0;
        if(sort === 'debt') return bN.debtScore - aN.debtScore;
        if(sort === 'lines') return bN.lines - aN.lines;
        if(sort === 'hours') return bN.estimatedHours - aN.estimatedHours;
        return 0;
      });
      rows.forEach(function(r){ tbody.appendChild(r); });
    });
  });

  requestAnimationFrame(tick);
})();`;
}

/**
 * Control script: handles the "Analyze now" button and polls for job
 * completion when a job is running.
 */
function buildControlScript(
  owner: string,
  repo: string,
  repoId: string,
  isOwner: boolean
): string {
  return `(function(){
  var OWNER = ${JSON.stringify(owner)};
  var REPO  = ${JSON.stringify(repo)};
  var IS_OWNER = ${JSON.stringify(isOwner)};

  // Analyze button
  var btn = document.getElementById('dm-trigger-btn');
  if(btn){
    btn.addEventListener('click', function(){
      btn.disabled = true;
      btn.textContent = 'Analyzing…';
      fetch('/'+OWNER+'/'+REPO+'/debt-map/analyze', {
        method: 'POST',
        headers: {'x-csrf-token': document.querySelector('meta[name=csrf-token]') ? document.querySelector('meta[name=csrf-token]').content : ''},
        credentials: 'same-origin'
      })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if(data.status === 'running'){
          // Show running bar + start polling
          var runBar = document.getElementById('dm-running-bar');
          if(!runBar){
            runBar = document.createElement('div');
            runBar.id = 'dm-running-bar';
            runBar.className = 'dm-running';
            runBar.innerHTML = '<div class="dm-spinner"></div><span>Analysis running &mdash; this can take 20&ndash;30 seconds. Reloading when done…</span>';
            btn.parentElement && btn.parentElement.after ? btn.parentElement.after(runBar) : document.querySelector('.dm-wrap').insertBefore(runBar, document.querySelector('.dm-empty') || document.querySelector('.dm-graph-wrap'));
          }
          pollUntilDone();
        }
      })
      .catch(function(err){ btn.disabled = false; btn.textContent = 'Retry'; });
    });
  }

  // Poll /debt-map/data until done, then reload page
  function pollUntilDone(){
    setTimeout(function(){
      fetch('/'+OWNER+'/'+REPO+'/debt-map/data', {credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(function(data){
        if(data.status === 'done'){
          window.location.reload();
        } else if(data.status === 'error'){
          var runBar = document.getElementById('dm-running-bar');
          if(runBar) runBar.innerHTML = '<span style="color:#f87171;">Analysis failed: '+(data.error||'unknown error')+'</span>';
          var btn2 = document.getElementById('dm-trigger-btn');
          if(btn2){ btn2.disabled = false; btn2.textContent = 'Retry'; }
        } else {
          pollUntilDone();
        }
      })
      .catch(function(){ pollUntilDone(); });
    }, 3000);
  }

  // If job is running on page load, start polling
  var runBar = document.getElementById('dm-running-bar');
  if(runBar){ pollUntilDone(); }
})();`;
}

export default debtMapRoutes;

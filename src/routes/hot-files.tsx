/**
 * Hot Files Heatmap.
 *
 * Route: GET /:owner/:repo/insights/hotfiles?window=7|30|90
 *
 * Shows the most frequently changed files in the last N days, ranked by
 * churn (lines added + deleted).  Helps teams spot complexity hotspots and
 * high-risk areas of the codebase.
 */

import { Hono } from "hono";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { and, eq } from "drizzle-orm";
import type { AuthEnv } from "../middleware/auth";
import { softAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import { getHotFiles } from "../lib/hot-files";

const hotFilesRoutes = new Hono<AuthEnv>();

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .hf-wrap {
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* Insights sub-navigation */
  .hf-subnav {
    display: flex;
    gap: 4px;
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .hf-subnav-link {
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
  .hf-subnav-link:hover { color: var(--text); }
  .hf-subnav-link.active {
    color: var(--accent, #5865f2);
    border-bottom-color: var(--accent, #5865f2);
  }

  /* Hero */
  .hf-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .hf-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f87171 30%, #fb923c 70%, transparent 100%);
    opacity: 0.8;
    pointer-events: none;
  }
  .hf-hero-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 var(--space-2) 0;
    color: var(--text);
  }
  .hf-hero-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 var(--space-4) 0;
  }

  /* Window selector */
  .hf-window-bar {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .hf-window-label {
    font-size: 12px;
    color: var(--text-muted);
    margin-right: 4px;
  }
  .hf-window-btn {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    text-decoration: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    background: var(--bg);
    transition: border-color 120ms ease, color 120ms ease;
  }
  .hf-window-btn:hover { color: var(--text); border-color: var(--border-strong, var(--border)); }
  .hf-window-btn.active {
    background: var(--accent, #5865f2);
    border-color: var(--accent, #5865f2);
    color: #fff;
  }

  /* Table */
  .hf-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .hf-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .hf-table th {
    text-align: left;
    padding: 10px 16px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .hf-table td {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    vertical-align: middle;
    font-variant-numeric: tabular-nums;
  }
  .hf-table tr:last-child td { border-bottom: none; }
  .hf-table tr:hover td { background: rgba(255,255,255,0.03); }
  .hf-num { text-align: right; }
  .hf-table th.hf-num { text-align: right; }

  /* File path cell */
  .hf-path {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    color: var(--text);
    word-break: break-all;
  }
  .hf-ext-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    background: rgba(255,255,255,0.07);
    color: var(--text-muted);
    margin-right: 8px;
    vertical-align: middle;
    flex-shrink: 0;
  }
  .hf-path-cell {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Heat bar */
  .hf-bar-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 120px;
  }
  .hf-bar-track {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: rgba(255,255,255,0.07);
    overflow: hidden;
    min-width: 60px;
  }
  .hf-bar-fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, #fb923c, #f87171);
    transition: width 300ms ease;
  }
  .hf-bar-value {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 48px;
    text-align: right;
  }

  /* Risk badges */
  .hf-risk {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .hf-risk-high   { background: rgba(248,113,113,0.18); color: #f87171; }
  .hf-risk-medium { background: rgba(251,191, 36,0.18); color: #fbbf24; }
  .hf-risk-low    { background: rgba( 52,211,153,0.18); color: #34d399; }

  /* Empty state */
  .hf-empty {
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border);
    border-radius: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-5);
  }
  .hf-empty strong {
    display: block;
    font-size: 15px;
    color: var(--text);
    margin-bottom: 6px;
  }
  .hf-empty span { font-size: 13px; }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Truncate a file path from the left, keeping the last `maxChars` chars. */
function truncatePath(path: string, maxChars = 40): string {
  if (path.length <= maxChars) return path;
  return "…" + path.slice(path.length - maxChars);
}

// ─── Route ────────────────────────────────────────────────────────────────────

hotFilesRoutes.use("/:owner/:repo/insights/hotfiles", softAuth);

hotFilesRoutes.get(
  "/:owner/:repo/insights/hotfiles",
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user") ?? null;

    // Parse window
    const windowParam = c.req.query("window");
    const windowDays =
      windowParam === "7" ? 7 : windowParam === "90" ? 90 : 30;

    // ─── Resolve owner + repo from DB ────────────────────────────────────
    // requireRepoAccess already looked up and stashed the repo; mirror the
    // velocity.tsx pattern and read it from context.  Fall back to an
    // explicit lookup so the handler is safe even without the middleware.

    const repository = (
      c.get("repository" as never) as
        | { id: string; name: string; isPrivate: boolean }
        | undefined
    ) ?? null;

    if (!repository) {
      // Explicit fallback: owner → user row → repo row.
      const ownerRow = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, owner))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!ownerRow) return c.html("Repository not found", 404);

      const repoRow = await db
        .select({ id: repositories.id, name: repositories.name })
        .from(repositories)
        .where(
          and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repo))
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!repoRow) return c.html("Repository not found", 404);
    }

    // ─── Compute hot files ────────────────────────────────────────────────

    const hotFiles = await getHotFiles(owner, repo, windowDays);

    const maxChurn = hotFiles.length > 0 ? hotFiles[0].churn : 1;

    // Unread notification badge
    const unreadCount = user ? await getUnreadCount(user.id) : 0;

    const baseUrl = `/${owner}/${repo}/insights/hotfiles`;

    // ─── Render ───────────────────────────────────────────────────────────

    return c.html(
      <Layout
        title={`Hot Files — ${owner}/${repo}`}
        user={user}
        notificationCount={unreadCount}
      >
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="hf-wrap">
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="insights" />

          {/* Insights sub-nav */}
          <div class="hf-subnav">
            <a href={`/${owner}/${repo}/insights`} class="hf-subnav-link">
              Insights
            </a>
            <a href={`/${owner}/${repo}/insights/dora`} class="hf-subnav-link">
              DORA
            </a>
            <a
              href={`/${owner}/${repo}/insights/velocity`}
              class="hf-subnav-link"
            >
              Velocity
            </a>
            <a href={`/${owner}/${repo}/pulse`} class="hf-subnav-link">
              Pulse
            </a>
            <a href={`/${owner}/${repo}/insights/health`} class="hf-subnav-link">
              Health
            </a>
            <a
              href={`/${owner}/${repo}/insights/hotfiles`}
              class="hf-subnav-link active"
            >
              Hot Files
            </a>
          </div>

          {/* Hero */}
          <div class="hf-hero">
            <h1 class="hf-hero-title">Hot Files Heatmap</h1>
            <p class="hf-hero-sub">
              Files with the highest churn in {owner}/{repo} — ranked by lines
              added and deleted. High-churn files are often complexity
              hotspots.
            </p>

            {/* Window tabs */}
            <div class="hf-window-bar">
              <span class="hf-window-label">Time window:</span>
              {([7, 30, 90] as const).map((w) => (
                <a
                  href={`${baseUrl}?window=${w}`}
                  class={`hf-window-btn${windowDays === w ? " active" : ""}`}
                >
                  {w}d
                </a>
              ))}
            </div>
          </div>

          {/* Content */}
          {hotFiles.length === 0 ? (
            <div class="hf-empty">
              <strong>No file changes in the last {windowDays} days</strong>
              <span>
                Push some commits, then come back to see which files are
                heating up.
              </span>
            </div>
          ) : (
            <div class="hf-table-wrap">
              <table class="hf-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th class="hf-num">Changes</th>
                    <th>Churn (lines)</th>
                    <th>Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {hotFiles.map((file) => {
                    const barPct =
                      maxChurn > 0
                        ? Math.round((file.churn / maxChurn) * 100)
                        : 0;
                    const displayPath = truncatePath(file.path, 40);
                    return (
                      <tr key={file.path}>
                        {/* File path */}
                        <td>
                          <div class="hf-path-cell">
                            {file.ext && (
                              <span class="hf-ext-badge">{file.ext}</span>
                            )}
                            <span
                              class="hf-path"
                              title={file.path}
                            >
                              {displayPath}
                            </span>
                          </div>
                        </td>

                        {/* Commit count */}
                        <td class="hf-num">{file.changes}</td>

                        {/* Churn bar */}
                        <td>
                          <div class="hf-bar-wrap">
                            <div class="hf-bar-track">
                              <div
                                class="hf-bar-fill"
                                style={`width:${barPct}%`}
                              />
                            </div>
                            <span class="hf-bar-value">
                              +{file.added} / -{file.deleted}
                            </span>
                          </div>
                        </td>

                        {/* Risk badge */}
                        <td>
                          <span class={`hf-risk hf-risk-${file.riskLevel}`}>
                            {file.riskLevel}
                          </span>
                        </td>
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

export default hotFilesRoutes;

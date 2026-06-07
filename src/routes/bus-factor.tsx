/**
 * Bus Factor Report — /:owner/:repo/insights/bus-factor
 *
 * Lists files where knowledge is concentrated in a single author.
 * Includes a pure-CSS bar chart per file and a "Re-analyze" button
 * (owner-only) that triggers a fresh background analysis.
 *
 * GET  /:owner/:repo/insights/bus-factor      — report page
 * POST /:owner/:repo/insights/bus-factor/reanalyze — trigger fresh analysis
 */

import { Hono } from "hono";
import { db } from "../db";
import { repositories, users, busFactorCache } from "../db/schema";
import { and, eq } from "drizzle-orm";
import type { AuthEnv } from "../middleware/auth";
import { softAuth, requireAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import {
  analyzeBusFactor,
  type BusFactorFile,
  type BusFactorReport,
} from "../lib/bus-factor";

const busFactorRoutes = new Hono<AuthEnv>();

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .bf-wrap {
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* Insights sub-navigation */
  .bf-subnav {
    display: flex;
    gap: 4px;
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .bf-subnav-link {
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
  .bf-subnav-link:hover { color: var(--text); }
  .bf-subnav-link.active {
    color: var(--accent, #5865f2);
    border-bottom-color: var(--accent, #5865f2);
  }

  /* Hero */
  .bf-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .bf-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f59e0b 30%, #ef4444 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .bf-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(245,158,11,0.16), rgba(239,68,68,0.08) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .bf-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .bf-hero-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #f59e0b;
    margin-bottom: 10px;
  }
  .bf-hero-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.1;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .bf-hero-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .bf-hero-actions {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 16px;
    flex-wrap: wrap;
  }

  /* Stats bar */
  .bf-stats {
    display: flex;
    gap: 16px;
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }
  .bf-stat-card {
    flex: 1 1 160px;
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    min-width: 120px;
  }
  .bf-stat-value {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 800;
    line-height: 1;
    margin-bottom: 4px;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .bf-stat-label {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }
  .bf-stat-card.is-critical .bf-stat-value { color: #ef4444; }
  .bf-stat-card.is-high    .bf-stat-value { color: #f97316; }
  .bf-stat-card.is-medium  .bf-stat-value { color: #f59e0b; }

  /* File list */
  .bf-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bf-file-card {
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease;
  }
  .bf-file-card:hover { border-color: rgba(245,158,11,0.4); }
  .bf-file-card.risk-critical { border-left: 3px solid #ef4444; }
  .bf-file-card.risk-high     { border-left: 3px solid #f97316; }
  .bf-file-card.risk-medium   { border-left: 3px solid #f59e0b; }

  .bf-file-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .bf-file-path {
    flex: 1 1 auto;
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    word-break: break-all;
  }
  .bf-risk-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .bf-risk-badge.is-critical { color: #ef4444; background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); }
  .bf-risk-badge.is-high     { color: #f97316; background: rgba(249,115,22,0.12); border: 1px solid rgba(249,115,22,0.3); }
  .bf-risk-badge.is-medium   { color: #f59e0b; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); }

  .bf-file-meta {
    display: flex;
    gap: 16px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  /* CSS bar chart — no JS */
  .bf-bar-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .bf-bar-label {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bf-bar-track {
    flex: 1;
    height: 10px;
    background: var(--bg-tertiary, rgba(255,255,255,0.06));
    border-radius: 99px;
    overflow: hidden;
  }
  .bf-bar-fill {
    height: 100%;
    border-radius: 99px;
    background: linear-gradient(90deg, #f59e0b, #ef4444);
    transition: width 300ms ease;
  }
  .bf-bar-pct {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    min-width: 40px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* Empty state */
  .bf-empty {
    text-align: center;
    padding: 64px 24px;
    color: var(--text-muted);
  }
  .bf-empty-icon { font-size: 40px; margin-bottom: 12px; }
  .bf-empty-title { font-size: 18px; font-weight: 700; color: var(--text-strong); margin-bottom: 6px; }
  .bf-empty-sub { font-size: 14px; }

  /* Action button */
  .bf-reanalyze-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px; font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #f59e0b 0%, #ef4444 130%);
    border: none;
    cursor: pointer;
    transition: opacity 120ms ease;
  }
  .bf-reanalyze-btn:hover { opacity: 0.85; }

  .bf-analyzed-at {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 16px;
  }
`;

// ─── Route: GET /:owner/:repo/insights/bus-factor ─────────────────────────────

busFactorRoutes.use("/:owner/:repo/insights/bus-factor", softAuth);

busFactorRoutes.get("/:owner/:repo/insights/bus-factor", requireRepoAccess("read"), async (c) => {
  const user = c.get("user") ?? null;
  const params = c.req.param() as { owner: string; repo: string };
  const ownerName = params.owner;
  const repoName = params.repo;

  // Load repo
  const repoRows = await db
    .select({ id: repositories.id, isPrivate: repositories.isPrivate, ownerId: repositories.ownerId })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
    .limit(1);

  if (!repoRows.length) return c.notFound();
  const repo = repoRows[0];
  const isOwner = !!user && user.id === repo.ownerId;

  const unreadCount = user ? await getUnreadCount(user.id) : 0;

  // Load cached report
  let report: BusFactorReport | null = null;
  const cacheRows = await db
    .select()
    .from(busFactorCache)
    .where(eq(busFactorCache.repositoryId, repo.id))
    .limit(1);

  if (cacheRows.length > 0) {
    const cached = cacheRows[0];
    report = {
      repoId: repo.id,
      analyzedAt: cached.analyzedAt.toISOString(),
      atRiskFiles: cached.atRiskFiles as BusFactorFile[],
      totalFilesAnalyzed: cached.totalFilesAnalyzed,
    };
  }

  const criticalCount = report?.atRiskFiles.filter((f) => f.risk === "critical").length ?? 0;
  const highCount     = report?.atRiskFiles.filter((f) => f.risk === "high").length ?? 0;
  const mediumCount   = report?.atRiskFiles.filter((f) => f.risk === "medium").length ?? 0;

  return c.html(
    <Layout
      title={`Bus Factor — ${ownerName}/${repoName}`}
      user={user}
      notificationCount={unreadCount}
    >
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="bf-wrap">
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="insights" />

        {/* Sub-navigation */}
        <nav class="bf-subnav">
          <a class="bf-subnav-link" href={`/${ownerName}/${repoName}/insights`}>Overview</a>
          <a class="bf-subnav-link" href={`/${ownerName}/${repoName}/insights/health`}>Health</a>
          <a class="bf-subnav-link" href={`/${ownerName}/${repoName}/insights/velocity`}>Velocity</a>
          <a class="bf-subnav-link" href={`/${ownerName}/${repoName}/insights/hotfiles`}>Hot Files</a>
          <a class="bf-subnav-link active" href={`/${ownerName}/${repoName}/insights/bus-factor`}>Bus Factor</a>
        </nav>

        {/* Hero */}
        <div class="bf-hero">
          <div class="bf-hero-orb" aria-hidden="true" />
          <div class="bf-hero-inner">
            <div class="bf-hero-eyebrow">⚠ Knowledge Risk</div>
            <h1 class="bf-hero-title">Bus Factor Analysis</h1>
            <p class="bf-hero-sub">
              Files where a single author owns more than 75% of commits.
              If that person leaves, the team loses critical context.
            </p>
            <div class="bf-hero-actions">
              {isOwner && (
                <form method="post" action={`/${ownerName}/${repoName}/insights/bus-factor/reanalyze`}>
                  <button type="submit" class="bf-reanalyze-btn">
                    ↻ Re-analyze
                  </button>
                </form>
              )}
              {report && (
                <span class="bf-analyzed-at">
                  Last analyzed {new Date(report.analyzedAt).toLocaleDateString()} ·{" "}
                  {report.totalFilesAnalyzed} code files scanned
                </span>
              )}
            </div>
          </div>
        </div>

        {report ? (
          <>
            {/* Stats */}
            <div class="bf-stats">
              <div class="bf-stat-card is-critical">
                <div class="bf-stat-value">{criticalCount}</div>
                <div class="bf-stat-label">Critical risk files</div>
              </div>
              <div class="bf-stat-card is-high">
                <div class="bf-stat-value">{highCount}</div>
                <div class="bf-stat-label">High risk files</div>
              </div>
              <div class="bf-stat-card is-medium">
                <div class="bf-stat-value">{mediumCount}</div>
                <div class="bf-stat-label">Medium risk files</div>
              </div>
              <div class="bf-stat-card">
                <div class="bf-stat-value">{report.atRiskFiles.length}</div>
                <div class="bf-stat-label">Total at-risk files</div>
              </div>
            </div>

            {/* File list */}
            {report.atRiskFiles.length === 0 ? (
              <div class="bf-empty">
                <div class="bf-empty-icon">✓</div>
                <div class="bf-empty-title">No knowledge concentration detected</div>
                <p class="bf-empty-sub">
                  All analyzed files have healthy authorship spread.
                </p>
              </div>
            ) : (
              <div class="bf-list">
                {report.atRiskFiles.map((file) => (
                  <div class={`bf-file-card risk-${file.risk}`}>
                    <div class="bf-file-header">
                      <code class="bf-file-path">{file.path}</code>
                      <span class={`bf-risk-badge is-${file.risk}`}>
                        {file.risk}
                      </span>
                    </div>
                    <div class="bf-file-meta">
                      <span>{file.totalCommits} commits</span>
                      <span>Last modified {file.lastModified}</span>
                    </div>
                    <div class="bf-bar-wrap">
                      <span class="bf-bar-label" title={file.primaryAuthor}>
                        {file.primaryAuthor}
                      </span>
                      <div class="bf-bar-track">
                        <div
                          class="bf-bar-fill"
                          style={`width:${file.primaryAuthorPct}%`}
                        />
                      </div>
                      <span class="bf-bar-pct">{file.primaryAuthorPct}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div class="bf-empty">
            <div class="bf-empty-icon">📊</div>
            <div class="bf-empty-title">No analysis yet</div>
            <p class="bf-empty-sub">
              {isOwner
                ? "Click Re-analyze to run the bus factor scan on this repository."
                : "The repository owner hasn't run a bus factor scan yet."}
            </p>
          </div>
        )}
      </div>
    </Layout>
  );
});

// ─── Route: POST /:owner/:repo/insights/bus-factor/reanalyze ─────────────────

busFactorRoutes.use("/:owner/:repo/insights/bus-factor/reanalyze", requireAuth);

busFactorRoutes.post(
  "/:owner/:repo/insights/bus-factor/reanalyze",
  requireRepoAccess("write"),
  async (c) => {
    const user = c.get("user")!;
    const params = c.req.param() as { owner: string; repo: string };
    const ownerName = params.owner;
    const repoName = params.repo;

    // Only repo owner may trigger re-analysis
    const repoRows = await db
      .select({ id: repositories.id, ownerId: repositories.ownerId })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);

    if (!repoRows.length) return c.notFound();
    const repo = repoRows[0];

    if (user.id !== repo.ownerId) {
      return c.text("Forbidden", 403);
    }

    // Fire-and-forget background analysis
    analyzeBusFactor(repo.id, ownerName, repoName).catch(() => {});

    return c.redirect(`/${ownerName}/${repoName}/insights/bus-factor`);
  }
);

export default busFactorRoutes;

/**
 * Test Gap Report — /:owner/:repo/insights/test-gaps
 *
 * Surfaces untested functions ranked by risk. Developers can see at a glance
 * which parts of their codebase have zero test coverage and why each matters.
 *
 * GET  /:owner/:repo/insights/test-gaps          — report page
 * POST /:owner/:repo/insights/test-gaps/refresh  — owner-only: clear cache + reanalyse
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
import { getTestGaps, clearTestGapsCache, type TestGap, type TestGapReport } from "../lib/test-gaps";

const testGapsRoutes = new Hono<AuthEnv>();

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .tg-wrap {
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* Insights sub-navigation */
  .tg-subnav {
    display: flex;
    gap: 4px;
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .tg-subnav-link {
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
  .tg-subnav-link:hover { color: var(--text); }
  .tg-subnav-link.active {
    color: var(--accent, #5865f2);
    border-bottom-color: var(--accent, #5865f2);
  }

  /* Hero */
  .tg-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .tg-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #6366f1 30%, #8b5cf6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .tg-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(99,102,241,0.16), rgba(139,92,246,0.08) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .tg-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .tg-hero-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #8b5cf6;
    margin-bottom: 10px;
  }
  .tg-hero-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.1;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .tg-hero-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .tg-hero-actions {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 16px;
    flex-wrap: wrap;
  }

  /* Stats bar */
  .tg-stats {
    display: flex;
    gap: 16px;
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }
  .tg-stat-card {
    flex: 1 1 160px;
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    min-width: 120px;
  }
  .tg-stat-value {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 800;
    line-height: 1;
    margin-bottom: 4px;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .tg-stat-label {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }
  .tg-stat-card.is-good   .tg-stat-value { color: #22c55e; }
  .tg-stat-card.is-warn   .tg-stat-value { color: #f59e0b; }
  .tg-stat-card.is-danger .tg-stat-value { color: #ef4444; }

  /* Gap list */
  .tg-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Individual gap card */
  .tg-gap-card {
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease;
  }
  .tg-gap-card:hover { border-color: rgba(99,102,241,0.4); }
  .tg-gap-card.risk-high   { border-left: 3px solid #ef4444; }
  .tg-gap-card.risk-medium { border-left: 3px solid #f59e0b; }
  .tg-gap-card.risk-low    { border-left: 3px solid #22c55e; }

  .tg-gap-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .tg-gap-file {
    flex: 1 1 auto;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    word-break: break-all;
  }
  .tg-gap-fn {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    color: var(--text-strong);
  }

  /* Risk score badge */
  .tg-risk-badge {
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
  .tg-risk-badge.is-high   { color: #ef4444; background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); }
  .tg-risk-badge.is-medium { color: #f59e0b; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); }
  .tg-risk-badge.is-low    { color: #22c55e; background: rgba(34,197,94,0.12);  border: 1px solid rgba(34,197,94,0.3); }

  .tg-gap-meta {
    display: flex;
    gap: 16px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .tg-gap-reason {
    font-size: 13px;
    color: var(--text);
    margin-bottom: 10px;
    line-height: 1.5;
  }

  .tg-gap-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .tg-test-path {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-tertiary, rgba(255,255,255,0.04));
    padding: 3px 8px;
    border-radius: 4px;
    flex: 1 1 auto;
  }
  .tg-stub-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px; font-weight: 600;
    color: var(--text-strong);
    background: var(--bg-tertiary, rgba(255,255,255,0.07));
    border: 1px solid var(--border);
    text-decoration: none;
    transition: background 120ms ease, border-color 120ms ease;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .tg-stub-btn:hover {
    background: var(--bg-secondary);
    border-color: rgba(99,102,241,0.5);
  }

  /* Reanalyse button */
  .tg-reanalyze-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px; font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 130%);
    border: none;
    cursor: pointer;
    transition: opacity 120ms ease;
  }
  .tg-reanalyze-btn:hover { opacity: 0.85; }

  .tg-analyzed-at {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  /* Empty / no-gaps state */
  .tg-empty {
    text-align: center;
    padding: 64px 24px;
    color: var(--text-muted);
  }
  .tg-empty-icon  { font-size: 40px; margin-bottom: 12px; }
  .tg-empty-title { font-size: 18px; font-weight: 700; color: var(--text-strong); margin-bottom: 6px; }
  .tg-empty-sub   { font-size: 14px; }
`;

// ─── Helper: determine risk tier from score ──────────────────────────────────

function riskTier(score: number): "high" | "medium" | "low" {
  if (score > 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

// ─── Route: GET /:owner/:repo/insights/test-gaps ─────────────────────────────

testGapsRoutes.use("/:owner/:repo/insights/test-gaps", softAuth);

testGapsRoutes.get(
  "/:owner/:repo/insights/test-gaps",
  requireRepoAccess("read"),
  async (c) => {
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

    // Load / compute report
    let report: TestGapReport | null = null;
    let analysisError: string | null = null;
    try {
      report = await getTestGaps(ownerName, repoName, repo.id);
    } catch (err) {
      analysisError = err instanceof Error ? err.message : "Analysis failed";
    }

    const highCount   = report?.gaps.filter((g) => riskTier(g.riskScore) === "high").length   ?? 0;
    const mediumCount = report?.gaps.filter((g) => riskTier(g.riskScore) === "medium").length ?? 0;
    const lowCount    = report?.gaps.filter((g) => riskTier(g.riskScore) === "low").length    ?? 0;

    return c.html(
      <Layout
        title={`Test Gaps — ${ownerName}/${repoName}`}
        user={user}
        notificationCount={unreadCount}
      >
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="tg-wrap">
          <RepoHeader owner={ownerName} repo={repoName} />
          <RepoNav owner={ownerName} repo={repoName} active="insights" />

          {/* Sub-navigation */}
          <nav class="tg-subnav">
            <a class="tg-subnav-link" href={`/${ownerName}/${repoName}/insights`}>Overview</a>
            <a class="tg-subnav-link" href={`/${ownerName}/${repoName}/insights/health`}>Health</a>
            <a class="tg-subnav-link" href={`/${ownerName}/${repoName}/insights/velocity`}>Velocity</a>
            <a class="tg-subnav-link" href={`/${ownerName}/${repoName}/insights/hotfiles`}>Hot Files</a>
            <a class="tg-subnav-link" href={`/${ownerName}/${repoName}/insights/bus-factor`}>Bus Factor</a>
            <a class="tg-subnav-link active" href={`/${ownerName}/${repoName}/insights/test-gaps`}>Test Gaps</a>
          </nav>

          {/* Hero */}
          <div class="tg-hero">
            <div class="tg-hero-orb" aria-hidden="true" />
            <div class="tg-hero-inner">
              <div class="tg-hero-eyebrow">&#x2717; Test Coverage</div>
              <h1 class="tg-hero-title">Test Gap Detector</h1>
              <p class="tg-hero-sub">
                Functions and modules with zero test coverage, ranked by risk.
                Write tests where they matter most.
              </p>
              <div class="tg-hero-actions">
                {isOwner && (
                  <form method="post" action={`/${ownerName}/${repoName}/insights/test-gaps/refresh`}>
                    <button type="submit" class="tg-reanalyze-btn">
                      &#8635; Re-analyse
                    </button>
                  </form>
                )}
                {report && (
                  <span class="tg-analyzed-at">
                    {report.totalSourceFiles} source files &middot;{" "}
                    {report.totalTestFiles} test files &middot;{" "}
                    ~{report.coverageEstimate}% coverage estimate
                  </span>
                )}
              </div>
            </div>
          </div>

          {analysisError && (
            <div style="padding:12px 16px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;margin-bottom:16px;font-size:13px;color:#ef4444;">
              Analysis error: {analysisError}
            </div>
          )}

          {report ? (
            <>
              {/* Stats bar */}
              <div class="tg-stats">
                <div class={`tg-stat-card ${highCount > 0 ? "is-danger" : "is-good"}`}>
                  <div class="tg-stat-value">{highCount}</div>
                  <div class="tg-stat-label">High-risk gaps</div>
                </div>
                <div class={`tg-stat-card ${mediumCount > 0 ? "is-warn" : "is-good"}`}>
                  <div class="tg-stat-value">{mediumCount}</div>
                  <div class="tg-stat-label">Medium-risk gaps</div>
                </div>
                <div class="tg-stat-card is-good">
                  <div class="tg-stat-value">{lowCount}</div>
                  <div class="tg-stat-label">Low-risk gaps</div>
                </div>
                <div class={`tg-stat-card ${report.coverageEstimate < 50 ? "is-danger" : report.coverageEstimate < 80 ? "is-warn" : "is-good"}`}>
                  <div class="tg-stat-value">{report.coverageEstimate}%</div>
                  <div class="tg-stat-label">Coverage estimate</div>
                </div>
              </div>

              {/* Gap list or empty state */}
              {report.gaps.length === 0 ? (
                <div class="tg-empty">
                  <div class="tg-empty-icon">&#x1F389;</div>
                  <div class="tg-empty-title">No test gaps detected</div>
                  <p class="tg-empty-sub">
                    Every source file appears to have an associated test file. Great work!
                  </p>
                </div>
              ) : (
                <div class="tg-list">
                  {report.gaps.map((gap: TestGap) => {
                    const tier = riskTier(gap.riskScore);
                    const stubUrl = `/${ownerName}/${repoName}/ai/tests?file=${encodeURIComponent(gap.filePath)}`;
                    return (
                      <div class={`tg-gap-card risk-${tier}`}>
                        <div class="tg-gap-header">
                          <div style="flex:1 1 auto;">
                            <div class="tg-gap-file">{gap.filePath}</div>
                            <div class="tg-gap-fn">{gap.functionName}</div>
                          </div>
                          <span class={`tg-risk-badge is-${tier}`}>
                            {gap.riskScore} / 100
                          </span>
                        </div>
                        <div class="tg-gap-meta">
                          <span>Risk: {tier}</span>
                          {gap.calledByCount > 0 && (
                            <span>Called from {gap.calledByCount} file{gap.calledByCount !== 1 ? "s" : ""}</span>
                          )}
                        </div>
                        <div class="tg-gap-reason">{gap.riskReason}</div>
                        <div class="tg-gap-footer">
                          <code class="tg-test-path">Suggested: {gap.suggestedTestPath}</code>
                          <a href={stubUrl} class="tg-stub-btn">
                            &#x2728; Generate test stub
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : !analysisError ? (
            <div class="tg-empty">
              <div class="tg-empty-icon">&#x1F9EA;</div>
              <div class="tg-empty-title">No analysis yet</div>
              <p class="tg-empty-sub">
                {isOwner
                  ? "Click Re-analyse to scan this repository for test gaps."
                  : "The repository owner hasn't run a test gap scan yet."}
              </p>
            </div>
          ) : null}
        </div>
      </Layout>
    );
  }
);

// ─── Route: POST /:owner/:repo/insights/test-gaps/refresh ────────────────────

testGapsRoutes.use("/:owner/:repo/insights/test-gaps/refresh", requireAuth);

testGapsRoutes.post(
  "/:owner/:repo/insights/test-gaps/refresh",
  requireRepoAccess("write"),
  async (c) => {
    const user = c.get("user")!;
    const params = c.req.param() as { owner: string; repo: string };
    const ownerName = params.owner;
    const repoName = params.repo;

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

    // Clear cache so the GET picks up a fresh analysis
    clearTestGapsCache(repo.id);

    return c.redirect(`/${ownerName}/${repoName}/insights/test-gaps`);
  }
);

export default testGapsRoutes;

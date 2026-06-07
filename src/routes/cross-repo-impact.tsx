/**
 * Cross-Repo Dependency Impact Detection — PR-level downstream analysis
 *
 * GET  /:owner/:repo/pulls/:number/cross-repo-impact
 *      Render the full report page showing downstream repos at risk.
 *
 * POST /:owner/:repo/pulls/:number/cross-repo-impact/analyze
 *      Trigger (or re-trigger) analysis and redirect back to GET.
 *
 * POST /:owner/:repo/pulls/:number/cross-repo-impact/open-fix-pr/:downstreamRepoId
 *      Open a draft PR on the downstream repo with a migration note.
 */

import { Hono } from "hono";
import { db } from "../db";
import {
  repositories,
  users,
  pullRequests,
  prComments,
} from "../db/schema";
import { and, eq } from "drizzle-orm";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth, softAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import {
  analyzeCrossRepoImpact,
  type CrossRepoReport,
  type DownstreamImpact,
} from "../lib/cross-repo-impact";

export const crossRepoImpactRoutes = new Hono<AuthEnv>();

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .cri-wrap {
    max-width: 1200px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* Sub-nav (PR-level) */
  .cri-subnav {
    display: flex;
    gap: 4px;
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .cri-subnav-link {
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
  .cri-subnav-link:hover { color: var(--text); }
  .cri-subnav-link.active {
    color: var(--accent, #5865f2);
    border-bottom-color: var(--accent, #5865f2);
  }

  /* Hero */
  .cri-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .cri-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8b5cf6 30%, #3b82f6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .cri-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(139,92,246,0.14), rgba(59,130,246,0.07) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .cri-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .cri-hero-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #8b5cf6;
    margin-bottom: 10px;
  }
  .cri-hero-title {
    font-family: var(--font-display);
    font-size: clamp(20px, 3vw, 28px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.1;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .cri-hero-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .cri-hero-actions {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .cri-analyze-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px; font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 130%);
    border: none;
    cursor: pointer;
    transition: opacity 120ms ease;
    text-decoration: none;
  }
  .cri-analyze-btn:hover { opacity: 0.85; }
  .cri-analyzed-at {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Stats */
  .cri-stats {
    display: flex;
    gap: 16px;
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }
  .cri-stat-card {
    flex: 1 1 160px;
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    min-width: 120px;
  }
  .cri-stat-value {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 800;
    line-height: 1;
    margin-bottom: 4px;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .cri-stat-label {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }
  .cri-stat-card.is-high   .cri-stat-value { color: #ef4444; }
  .cri-stat-card.is-medium .cri-stat-value { color: #f59e0b; }
  .cri-stat-card.is-low    .cri-stat-value { color: #22c55e; }

  /* Risk score ring */
  .cri-risk-ring {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 700;
  }
  .cri-risk-ring.is-high   { color: #ef4444; background: rgba(239,68,68,0.1);   border: 1px solid rgba(239,68,68,0.3); }
  .cri-risk-ring.is-medium { color: #f59e0b; background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); }
  .cri-risk-ring.is-low    { color: #22c55e; background: rgba(34,197,94,0.1);  border: 1px solid rgba(34,197,94,0.3); }

  /* Downstream repo table */
  .cri-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: var(--space-4);
  }
  .cri-table {
    width: 100%;
    border-collapse: collapse;
  }
  .cri-table th {
    padding: 10px 16px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    background: var(--bg-secondary, rgba(255,255,255,0.03));
    border-bottom: 1px solid var(--border);
    text-align: left;
  }
  .cri-table td {
    padding: 12px 16px;
    font-size: 13px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .cri-table tr:last-child td { border-bottom: none; }
  .cri-table tr:hover td { background: rgba(255,255,255,0.02); }

  /* Risk pills */
  .cri-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .cri-pill.is-high   { color: #ef4444; background: rgba(239,68,68,0.12);   border: 1px solid rgba(239,68,68,0.3); }
  .cri-pill.is-medium { color: #f59e0b; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); }
  .cri-pill.is-low    { color: #22c55e; background: rgba(34,197,94,0.12);  border: 1px solid rgba(34,197,94,0.3); }

  /* Symbol chips */
  .cri-symbols {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: 280px;
  }
  .cri-symbol-chip {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 2px 7px;
    background: rgba(139,92,246,0.1);
    border: 1px solid rgba(139,92,246,0.25);
    border-radius: 4px;
    color: #a78bfa;
    white-space: nowrap;
  }

  /* Fix PR button */
  .cri-fix-btn {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px; font-weight: 600;
    color: #fff;
    background: #5865f2;
    border: none;
    cursor: pointer;
    transition: opacity 120ms ease;
  }
  .cri-fix-btn:hover { opacity: 0.85; }
  .cri-fix-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .cri-repo-link {
    font-weight: 600;
    color: var(--accent, #5865f2);
    text-decoration: none;
  }
  .cri-repo-link:hover { text-decoration: underline; }
  .cri-owner-prefix { color: var(--text-muted); font-weight: 400; }
  .cri-version-tag {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  /* Empty state */
  .cri-empty {
    text-align: center;
    padding: 64px 24px;
    color: var(--text-muted);
  }
  .cri-empty-icon { font-size: 40px; margin-bottom: 12px; }
  .cri-empty-title { font-size: 18px; font-weight: 700; color: var(--text-strong); margin-bottom: 6px; }
  .cri-empty-sub { font-size: 14px; }

  /* Alert banner */
  .cri-alert {
    padding: 12px 16px;
    border-radius: 8px;
    font-size: 13px;
    margin-bottom: var(--space-4);
    border-left: 3px solid;
  }
  .cri-alert.is-info { color: #93c5fd; background: rgba(59,130,246,0.08); border-color: #3b82f6; }
  .cri-alert.is-warn { color: #fcd34d; background: rgba(245,158,11,0.08); border-color: #f59e0b; }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function totalRiskClass(score: number): string {
  if (score >= 60) return "is-high";
  if (score >= 30) return "is-medium";
  return "is-low";
}

function riskLabel(score: number): string {
  if (score >= 60) return "High";
  if (score >= 30) return "Medium";
  return "Low";
}

// ─── Repo + PR resolution helper ─────────────────────────────────────────────

async function resolveRepo(ownerName: string, repoName: string) {
  const rows = await db
    .select({
      id: repositories.id,
      ownerId: repositories.ownerId,
      isPrivate: repositories.isPrivate,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
    .limit(1);
  return rows[0] ?? null;
}

async function resolvePr(repoId: string, prNumber: number) {
  const rows = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      title: pullRequests.title,
      state: pullRequests.state,
      baseBranch: pullRequests.baseBranch,
      headBranch: pullRequests.headBranch,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repoId),
        eq(pullRequests.number, prNumber)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

// ─── Route: GET /:owner/:repo/pulls/:number/cross-repo-impact ─────────────────

crossRepoImpactRoutes.use(
  "/:owner/:repo/pulls/:number/cross-repo-impact",
  softAuth
);

crossRepoImpactRoutes.get(
  "/:owner/:repo/pulls/:number/cross-repo-impact",
  requireRepoAccess("read"),
  async (c) => {
    const user = c.get("user") ?? null;
    const { owner: ownerName, repo: repoName, number: prNumberStr } = c.req.param() as {
      owner: string;
      repo: string;
      number: string;
    };
    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) return c.notFound();

    const repo = await resolveRepo(ownerName, repoName);
    if (!repo) return c.notFound();

    const pr = await resolvePr(repo.id, prNumber);
    if (!pr) return c.notFound();

    const unreadCount = user ? await getUnreadCount(user.id) : 0;
    const isOwner = !!user && user.id === repo.ownerId;

    // Try to load cached report (memory + DB, no re-analysis here)
    let report: CrossRepoReport | null = null;
    try {
      // Import the cache-checking logic only (don't re-run full analysis)
      const { analyzeCrossRepoImpact: analyze } = await import(
        "../lib/cross-repo-impact"
      );
      // If there's a cached version it returns fast; if not, report = null
      // We check the DB directly to avoid running analysis on page load
      const { crossRepoImpactCache } = await import("../db/schema");
      const cacheRows = await db
        .select()
        .from(crossRepoImpactCache)
        .where(eq(crossRepoImpactCache.prId, pr.id))
        .limit(1);

      if (cacheRows.length > 0 && cacheRows[0].cachedUntil > new Date()) {
        report = cacheRows[0].report as CrossRepoReport;
      }
    } catch {
      // Degrade gracefully — show "no analysis yet"
    }

    const highCount = report?.affectedRepos.filter((r) => r.riskLevel === "high").length ?? 0;
    const mediumCount = report?.affectedRepos.filter((r) => r.riskLevel === "medium").length ?? 0;
    const lowCount = report?.affectedRepos.filter((r) => r.riskLevel === "low").length ?? 0;
    const totalRisk = report?.totalRisk ?? 0;

    const baseUrl = `/${ownerName}/${repoName}/pulls/${prNumber}`;

    return c.html(
      <Layout
        title={`Cross-Repo Impact — PR #${prNumber} — ${ownerName}/${repoName}`}
        user={user}
        notificationCount={unreadCount}
      >
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="cri-wrap">
          <RepoHeader owner={ownerName} repo={repoName} />
          <RepoNav owner={ownerName} repo={repoName} active="pulls" />

          {/* PR sub-navigation */}
          <nav class="cri-subnav">
            <a class="cri-subnav-link" href={`${baseUrl}`}>
              Conversation
            </a>
            <a class="cri-subnav-link" href={`${baseUrl}/files`}>
              Files
            </a>
            <a class="cri-subnav-link active" href={`${baseUrl}/cross-repo-impact`}>
              Cross-Repo Impact
            </a>
          </nav>

          {/* Hero */}
          <div class="cri-hero">
            <div class="cri-hero-orb" aria-hidden="true" />
            <div class="cri-hero-inner">
              <div class="cri-hero-eyebrow">&#9888; Dependency Risk</div>
              <h1 class="cri-hero-title">
                Cross-Repo Dependency Impact
              </h1>
              <p class="cri-hero-sub">
                Detects downstream repositories that import exported symbols
                changed by this PR. Run before merging to prevent silent
                breaking changes in dependent packages.
              </p>
              <div class="cri-hero-actions">
                {isOwner && (
                  <form
                    method="post"
                    action={`${baseUrl}/cross-repo-impact/analyze`}
                  >
                    <button type="submit" class="cri-analyze-btn">
                      &#8635; {report ? "Re-analyze" : "Analyze"}
                    </button>
                  </form>
                )}
                {report && (
                  <>
                    <span class={`cri-risk-ring ${totalRiskClass(totalRisk)}`}>
                      {riskLabel(totalRisk)} Risk &mdash; {totalRisk}/100
                    </span>
                    <span class="cri-analyzed-at">
                      Analyzed {new Date(report.analyzedAt).toLocaleString()} &middot;
                      valid until {new Date(report.cachedUntil).toLocaleTimeString()}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {report ? (
            <>
              {/* Stats */}
              <div class="cri-stats">
                <div class="cri-stat-card is-high">
                  <div class="cri-stat-value">{highCount}</div>
                  <div class="cri-stat-label">High risk repos</div>
                </div>
                <div class="cri-stat-card is-medium">
                  <div class="cri-stat-value">{mediumCount}</div>
                  <div class="cri-stat-label">Medium risk repos</div>
                </div>
                <div class="cri-stat-card is-low">
                  <div class="cri-stat-value">{lowCount}</div>
                  <div class="cri-stat-label">Low risk repos</div>
                </div>
                <div class="cri-stat-card">
                  <div class="cri-stat-value">{report.affectedRepos.length}</div>
                  <div class="cri-stat-label">Total downstream</div>
                </div>
              </div>

              {report.affectedRepos.length === 0 ? (
                <div class="cri-empty">
                  <div class="cri-empty-icon">&#10003;</div>
                  <div class="cri-empty-title">No downstream impact detected</div>
                  <p class="cri-empty-sub">
                    No other repos in the dependency graph import the exports
                    changed by this PR. Safe to merge.
                  </p>
                </div>
              ) : (
                <>
                  {highCount > 0 && (
                    <div class="cri-alert is-warn">
                      <strong>Warning:</strong> {highCount} downstream repo{highCount !== 1 ? "s" : ""} import
                      changed symbols and have no test coverage. Merging may cause
                      silent runtime failures. Consider opening fix PRs first.
                    </div>
                  )}

                  {/* Downstream repo table */}
                  <div class="cri-table-wrap">
                    <table class="cri-table">
                      <thead>
                        <tr>
                          <th>Downstream Repo</th>
                          <th>Dependency</th>
                          <th>Risk</th>
                          <th>Changed Symbols</th>
                          {isOwner && <th>Action</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {report.affectedRepos.map((impact) => (
                          <tr key={impact.repoId}>
                            <td>
                              <a
                                class="cri-repo-link"
                                href={`/${impact.ownerName}/${impact.repoName}`}
                              >
                                <span class="cri-owner-prefix">{impact.ownerName}/</span>
                                {impact.repoName}
                              </a>
                            </td>
                            <td>
                              <div style="font-family: var(--font-mono); font-size: 12px;">
                                {impact.dependencyName}
                              </div>
                              <div class="cri-version-tag">{impact.currentVersion}</div>
                            </td>
                            <td>
                              <span class={`cri-pill is-${impact.riskLevel}`}>
                                {impact.riskLevel}
                              </span>
                            </td>
                            <td>
                              <div class="cri-symbols">
                                {impact.changedExports.slice(0, 8).map((sym) => (
                                  <span class="cri-symbol-chip" key={sym}>{sym}</span>
                                ))}
                                {impact.changedExports.length > 8 && (
                                  <span class="cri-symbol-chip">
                                    +{impact.changedExports.length - 8} more
                                  </span>
                                )}
                                {impact.changedExports.length === 0 && (
                                  <span style="color: var(--text-muted); font-size: 12px;">
                                    (dep declared, no symbol match)
                                  </span>
                                )}
                              </div>
                            </td>
                            {isOwner && (
                              <td>
                                {impact.suggestedFixPrUrl ? (
                                  <a
                                    class="cri-fix-btn"
                                    href={impact.suggestedFixPrUrl}
                                  >
                                    View Fix PR
                                  </a>
                                ) : (
                                  <form
                                    method="post"
                                    action={`${baseUrl}/cross-repo-impact/open-fix-pr/${impact.repoId}`}
                                  >
                                    <button type="submit" class="cri-fix-btn">
                                      Open Fix PR
                                    </button>
                                  </form>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div class="cri-alert is-info">
                    Analysis is based on <code>export</code> keyword changes in the PR diff and
                    dependency declarations in <code>repo_dependencies</code>. Results are cached for 15 minutes.
                    Re-analyze after rebasing or updating the diff.
                  </div>
                </>
              )}
            </>
          ) : (
            <div class="cri-empty">
              <div class="cri-empty-icon">&#128202;</div>
              <div class="cri-empty-title">No analysis yet</div>
              <p class="cri-empty-sub">
                {isOwner
                  ? "Click Analyze to detect downstream repos that may break when this PR is merged."
                  : "The repo owner hasn't run a cross-repo impact analysis on this PR yet."}
              </p>
            </div>
          )}
        </div>
      </Layout>
    );
  }
);

// ─── Route: POST /:owner/:repo/pulls/:number/cross-repo-impact/analyze ────────

crossRepoImpactRoutes.use(
  "/:owner/:repo/pulls/:number/cross-repo-impact/analyze",
  requireAuth
);

crossRepoImpactRoutes.post(
  "/:owner/:repo/pulls/:number/cross-repo-impact/analyze",
  requireRepoAccess("write"),
  async (c) => {
    const user = c.get("user")!;
    const { owner: ownerName, repo: repoName, number: prNumberStr } = c.req.param() as {
      owner: string;
      repo: string;
      number: string;
    };
    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) return c.notFound();

    const repo = await resolveRepo(ownerName, repoName);
    if (!repo) return c.notFound();

    if (user.id !== repo.ownerId) {
      return c.text("Forbidden", 403);
    }

    const pr = await resolvePr(repo.id, prNumber);
    if (!pr) return c.notFound();

    // Fire analysis in the background (non-blocking)
    analyzeCrossRepoImpact(repo.id, pr.id, ownerName, repoName).catch(() => {});

    // Small delay to let the analysis start before redirect
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    return c.redirect(
      `/${ownerName}/${repoName}/pulls/${prNumber}/cross-repo-impact`
    );
  }
);

// ─── Route: POST /…/open-fix-pr/:downstreamRepoId ─────────────────────────────

crossRepoImpactRoutes.use(
  "/:owner/:repo/pulls/:number/cross-repo-impact/open-fix-pr/:downstreamRepoId",
  requireAuth
);

crossRepoImpactRoutes.post(
  "/:owner/:repo/pulls/:number/cross-repo-impact/open-fix-pr/:downstreamRepoId",
  requireRepoAccess("write"),
  async (c) => {
    const user = c.get("user")!;
    const {
      owner: ownerName,
      repo: repoName,
      number: prNumberStr,
      downstreamRepoId,
    } = c.req.param() as {
      owner: string;
      repo: string;
      number: string;
      downstreamRepoId: string;
    };
    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) return c.notFound();

    const repo = await resolveRepo(ownerName, repoName);
    if (!repo) return c.notFound();

    if (user.id !== repo.ownerId) {
      return c.text("Forbidden", 403);
    }

    const pr = await resolvePr(repo.id, prNumber);
    if (!pr) return c.notFound();

    // Load the cached report to find the downstream impact entry
    let impact: DownstreamImpact | undefined;
    try {
      const { crossRepoImpactCache } = await import("../db/schema");
      const cacheRows = await db
        .select()
        .from(crossRepoImpactCache)
        .where(eq(crossRepoImpactCache.prId, pr.id))
        .limit(1);
      if (cacheRows.length > 0) {
        const report = cacheRows[0].report as CrossRepoReport;
        impact = report.affectedRepos.find((r) => r.repoId === downstreamRepoId);
      }
    } catch {
      /* best-effort */
    }

    if (!impact) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNumber}/cross-repo-impact`
      );
    }

    // Load the downstream repo details
    const [downstreamRepo] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .where(eq(repositories.id, downstreamRepoId))
      .limit(1)
      .catch(() => []);

    if (!downstreamRepo) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNumber}/cross-repo-impact`
      );
    }

    // Build migration PR body
    const changedSymbolsList = impact.changedExports.length
      ? impact.changedExports.map((s) => `- \`${s}\``).join("\n")
      : "_(see PR diff for details)_";

    const prBody = `## Migration: Updated dependency \`${impact.dependencyName}\`

This PR was automatically created by the cross-repo impact analysis on **${ownerName}/${repoName} #${prNumber}**.

### What changed upstream

The following exported symbols were changed in [${ownerName}/${repoName} PR #${prNumber}](/${ownerName}/${repoName}/pulls/${prNumber}):

${changedSymbolsList}

### What to update in this repo

Review all imports of \`${impact.dependencyName}\` and update any usages of the listed symbols to match the new API.

**Risk level:** ${impact.riskLevel.toUpperCase()}

---
_Generated by Gluecron cross-repo impact detection._`;

    // Insert a draft PR into the downstream repo using existing schema pattern
    try {
      const newPr = await db
        .insert(pullRequests)
        .values({
          repositoryId: downstreamRepo.id,
          authorId: user.id,
          title: `fix: update ${impact.dependencyName} API usage after upstream changes`,
          body: prBody,
          state: "open",
          baseBranch: downstreamRepo.defaultBranch,
          headBranch: `fix/dep-update-${impact.dependencyName.replace(/[^a-z0-9]/gi, "-")}-${Date.now()}`,
          isDraft: true,
        })
        .returning({ id: pullRequests.id, number: pullRequests.number });

      if (newPr.length > 0) {
        const fixPrUrl = `/${impact.ownerName}/${impact.repoName}/pulls/${newPr[0].number}`;

        // Post a comment on the original PR linking the fix PR
        await db.insert(prComments).values({
          pullRequestId: pr.id,
          authorId: user.id,
          body: `**Cross-repo impact fix:** Opened a draft migration PR on \`${impact.ownerName}/${impact.repoName}\`: [${fixPrUrl}](${fixPrUrl})`,
        }).catch(() => {});

        return c.redirect(fixPrUrl);
      }
    } catch {
      /* best-effort — fall through to redirect */
    }

    return c.redirect(
      `/${ownerName}/${repoName}/pulls/${prNumber}/cross-repo-impact`
    );
  }
);

export default crossRepoImpactRoutes;

/**
 * Code Health Report routes.
 *
 * GET  /:owner/:repo/health        — full health dashboard page
 * POST /:owner/:repo/health/compute — trigger a fresh recompute (owner only)
 *
 * The scoring engine lives in src/lib/health-score.ts and writes results to
 * the repo_health_scores table. These routes load that data and render it.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { and } from "drizzle-orm";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  getLatestHealthScore,
  getHealthScoreHistory,
  computeAndStoreHealthScore,
  getBadgeColor,
  type StoredHealthScore,
  type HealthIssue,
  type HealthRecommendation,
} from "../lib/health-score";
import { config } from "../lib/config";

const health = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRepo(ownerName: string, repoName: string) {
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return null;
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return null;
  return { owner, repo };
}

function gradeColor(grade: string): string {
  switch (grade) {
    case "A":
      return "#2ea44f";
    case "B":
      return "#44cc11";
    case "C":
      return "#dfb317";
    case "D":
      return "#fe7d37";
    case "F":
      return "#e05d44";
    default:
      return "#9f9f9f";
  }
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? "s" : ""} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? "s" : ""} ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay !== 1 ? "s" : ""} ago`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function severityColor(severity: HealthIssue["severity"]): string {
  switch (severity) {
    case "critical":
      return "#e05d44";
    case "high":
      return "#fe7d37";
    case "medium":
      return "#dfb317";
    case "low":
      return "#9f9f9f";
    default:
      return "#9f9f9f";
  }
}

function severityDot(severity: HealthIssue["severity"]): string {
  switch (severity) {
    case "critical":
      return "🔴"; // 🔴
    case "high":
      return "🟠"; // 🟠
    case "medium":
      return "🟡"; // 🟡
    case "low":
      return "⚪"; // ⚪
    default:
      return "⚪";
  }
}

function priorityLabel(priority: HealthRecommendation["priority"]): string {
  return priority.toUpperCase();
}

function priorityColor(priority: HealthRecommendation["priority"]): string {
  switch (priority) {
    case "high":
      return "#e05d44";
    case "medium":
      return "#dfb317";
    case "low":
      return "#9f9f9f";
    default:
      return "#9f9f9f";
  }
}

// Category max scores (must sum to 100)
const CATEGORY_MAX: Record<string, number> = {
  security: 30,
  gates: 25,
  ai_review: 20,
  dependencies: 15,
  code_quality: 10,
};

const CATEGORY_ICONS: Record<string, string> = {
  security: "🔒", // 🔒
  gates: "✅", // ✅
  ai_review: "🤖", // 🤖
  dependencies: "📦", // 📦
  code_quality: "⭐", // ⭐
};

const CATEGORY_LABELS: Record<string, string> = {
  security: "Security",
  gates: "Gates",
  ai_review: "AI Review",
  dependencies: "Dependencies",
  code_quality: "Code Quality",
};

// ---------------------------------------------------------------------------
// Category row component
// ---------------------------------------------------------------------------

const CategoryRow = ({
  categoryKey,
  score,
  issues,
  gradeStr,
}: {
  categoryKey: string;
  score: number;
  issues: HealthIssue[];
  gradeStr: string;
}) => {
  const max = CATEGORY_MAX[categoryKey] ?? 10;
  const pct = Math.min(100, Math.round((score / max) * 100));
  const color = gradeColor(gradeStr);
  const icon = CATEGORY_ICONS[categoryKey] ?? "";
  const label = CATEGORY_LABELS[categoryKey] ?? categoryKey;
  const catIssues = issues.filter((i) => i.category === categoryKey);

  return (
    <div style="margin-bottom: 16px">
      <div style="display: flex; align-items: center; gap: 12px">
        <span style="min-width: 140px; font-size: 14px; font-weight: 500; color: var(--text)">
          {icon} {label}
        </span>
        <div
          style="background: #21262d; border-radius: 4px; height: 8px; width: 200px; display: inline-block; flex-shrink: 0; overflow: hidden"
        >
          <div
            style={`height: 100%; width: ${pct}%; border-radius: 4px; background: ${color};`}
          />
        </div>
        <span style="font-size: 13px; color: var(--text-muted); min-width: 56px">
          {score}/{max}
        </span>
      </div>
      {catIssues.map((issue) => (
        <div
          style={`margin-top: 4px; margin-left: 152px; font-size: 12px; color: ${severityColor(issue.severity)}`}
        >
          {severityDot(issue.severity)} {issue.message}
        </div>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// GET /:owner/:repo/health
// ---------------------------------------------------------------------------

health.get(
  "/:owner/:repo/health",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const repoRow = c.get("repository" as any) as any;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.notFound();

    const isOwner = user?.id === resolved.owner.id;

    // Load latest score + history in parallel
    const [scoreRow, history] = await Promise.all([
      getLatestHealthScore(resolved.repo.id),
      getHealthScoreHistory(resolved.repo.id, 10),
    ]);

    // No score yet — trigger background compute
    if (!scoreRow) {
      computeAndStoreHealthScore(resolved.repo.id, ownerName, repoName).catch(
        (err) => console.error("[health] background compute failed:", err)
      );
    }

    const baseUrl = config.appBaseUrl;
    const badgeUrl = `${baseUrl}/badge/${ownerName}/${repoName}`;
    const pageUrl = `${baseUrl}/${ownerName}/${repoName}/health`;
    const badgeMarkdown = `[![Gluecron Health${scoreRow ? ": " + scoreRow.grade : ""}](${badgeUrl})](${pageUrl})`;

    return c.html(
      <Layout
        title={`Health — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active={"health" as any} />

        {!scoreRow ? (
          // Computing state
          <div
            style="text-align: center; padding: 60px 20px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 24px"
          >
            <div style="font-size: 48px; margin-bottom: 16px">&#x231B;</div>
            <h2 style="font-size: 24px; margin-bottom: 8px; color: var(--text)">
              Computing health score…
            </h2>
            <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 24px">
              This is the first time we've analysed this repository. Results will
              be ready shortly — refresh this page in a few seconds.
            </p>
            {isOwner && (
              <form method="post" action={`/${ownerName}/${repoName}/health/compute`} style="display:inline">
                <button type="submit" class="btn btn-primary">
                  Compute now
                </button>
              </form>
            )}
          </div>
        ) : (
          <>
            {/* ── Hero section ─────────────────────────────────── */}
            <div
              style={`background: var(--bg-secondary); border: 2px solid ${gradeColor(scoreRow.grade)}; border-radius: var(--radius); padding: 24px; margin-bottom: 24px`}
            >
              <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px">
                <div>
                  <h2 style="font-size: 18px; font-weight: 600; color: var(--text); margin-bottom: 4px">
                    Code Health
                  </h2>
                  <div style="font-size: 13px; color: var(--text-muted)">
                    Last computed: {formatRelativeTime(new Date(scoreRow.computedAt))}
                  </div>
                </div>
                {isOwner && (
                  <form method="post" action={`/${ownerName}/${repoName}/health/compute`} style="display:inline">
                    <button type="submit" class="btn btn-sm">
                      &#x21BA; Recompute
                    </button>
                  </form>
                )}
              </div>

              <div style="display: flex; align-items: center; gap: 32px; margin-top: 20px; flex-wrap: wrap">
                <div style="text-align: center">
                  <div
                    style={`font-size: 72px; font-weight: 700; line-height: 1; color: ${gradeColor(scoreRow.grade)}`}
                  >
                    {scoreRow.grade}
                  </div>
                  <div style="font-size: 14px; color: var(--text-muted); margin-top: 4px">
                    Score: {scoreRow.score}/100
                  </div>
                </div>

                <div style="flex: 1; min-width: 200px">
                  <CategoryRow
                    categoryKey="security"
                    score={scoreRow.securityScore}
                    issues={scoreRow.issues}
                    gradeStr={scoreRow.grade}
                  />
                  <CategoryRow
                    categoryKey="gates"
                    score={scoreRow.gatesScore}
                    issues={scoreRow.issues}
                    gradeStr={scoreRow.grade}
                  />
                  <CategoryRow
                    categoryKey="ai_review"
                    score={scoreRow.aiReviewScore}
                    issues={scoreRow.issues}
                    gradeStr={scoreRow.grade}
                  />
                  <CategoryRow
                    categoryKey="dependencies"
                    score={scoreRow.dependenciesScore}
                    issues={scoreRow.issues}
                    gradeStr={scoreRow.grade}
                  />
                  <CategoryRow
                    categoryKey="code_quality"
                    score={scoreRow.codeQualityScore}
                    issues={scoreRow.issues}
                    gradeStr={scoreRow.grade}
                  />
                </div>
              </div>

              {/* Badge copy */}
              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border)">
                <button
                  type="button"
                  class="btn btn-sm"
                  onclick={`navigator.clipboard.writeText(${JSON.stringify(badgeMarkdown)}).then(function(){var b=this;b.textContent='Copied!';setTimeout(function(){b.textContent='Copy badge markdown'},1500)}.bind(this)).catch(function(){alert('Copy failed')})`}
                >
                  Copy badge markdown
                </button>
              </div>
            </div>

            {/* ── Issues section ────────────────────────────────── */}
            {scoreRow.issues.length > 0 && (
              <div
                style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 24px"
              >
                <h3
                  style="font-size: 16px; font-weight: 600; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border)"
                >
                  Issues Found
                </h3>
                {scoreRow.issues.map((issue) => (
                  <div
                    style={`display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 14px`}
                  >
                    <span style="flex-shrink: 0; font-size: 16px">
                      {severityDot(issue.severity)}
                    </span>
                    <span
                      class="badge"
                      style={`flex-shrink: 0; font-size: 11px; color: ${severityColor(issue.severity)}; border-color: ${severityColor(issue.severity)}; text-transform: uppercase; padding: 1px 6px`}
                    >
                      {issue.severity}
                    </span>
                    <span style="color: var(--text)">
                      {issue.message}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ── Recommendations section ────────────────────────── */}
            {scoreRow.recommendations.length > 0 && (
              <div
                style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 24px"
              >
                <h3
                  style="font-size: 16px; font-weight: 600; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border)"
                >
                  How to improve your score
                </h3>
                {scoreRow.recommendations.map((rec) => (
                  <div
                    style="display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 14px"
                  >
                    <span style="flex-shrink: 0; color: var(--text-muted)">
                      &#x2191;
                    </span>
                    <span
                      class="badge"
                      style={`flex-shrink: 0; font-size: 11px; color: ${priorityColor(rec.priority)}; border-color: ${priorityColor(rec.priority)}; text-transform: uppercase; padding: 1px 6px`}
                    >
                      {priorityLabel(rec.priority)}
                    </span>
                    <span style="color: var(--text)">
                      {rec.message}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ── Share your badge ──────────────────────────────── */}
            <div
              style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 24px"
            >
              <h3
                style="font-size: 16px; font-weight: 600; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border)"
              >
                Share your health badge
              </h3>

              <div style="margin-bottom: 12px">
                <img
                  src={badgeUrl}
                  alt={`Gluecron Health: ${scoreRow.grade}`}
                  style="height: 20px; display: inline-block; vertical-align: middle"
                />
              </div>

              <div
                style="background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); word-break: break-all; margin-bottom: 12px"
              >
                {badgeMarkdown}
              </div>

              <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <button
                  type="button"
                  class="btn btn-sm"
                  onclick={`navigator.clipboard.writeText(${JSON.stringify(badgeMarkdown)}).then(function(){var b=this;b.textContent='Copied!';setTimeout(function(){b.textContent='Copy markdown'},1500)}.bind(this)).catch(function(){alert('Copy failed')})`}
                >
                  Copy markdown
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  onclick={`navigator.clipboard.writeText(${JSON.stringify(badgeUrl)}).then(function(){var b=this;b.textContent='Copied!';setTimeout(function(){b.textContent='Copy URL'},1500)}.bind(this)).catch(function(){alert('Copy failed')})`}
                >
                  Copy URL
                </button>
              </div>
            </div>

            {/* ── Score history ─────────────────────────────────── */}
            {history.length > 1 && (
              <div
                style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 24px"
              >
                <h3
                  style="font-size: 16px; font-weight: 600; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border)"
                >
                  Score history
                </h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px">
                  <thead>
                    <tr style="color: var(--text-muted); font-size: 12px; border-bottom: 1px solid var(--border)">
                      <th style="text-align: left; padding: 4px 8px; font-weight: 500">Date</th>
                      <th style="text-align: left; padding: 4px 8px; font-weight: 500">Grade</th>
                      <th style="text-align: right; padding: 4px 8px; font-weight: 500">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row, i) => (
                      <tr
                        style={`border-bottom: 1px solid var(--border); ${i === 0 ? "font-weight: 600" : ""}`}
                      >
                        <td style="padding: 6px 8px; color: var(--text-muted)">
                          {formatDate(new Date(row.computedAt))}
                        </td>
                        <td style={`padding: 6px 8px; font-weight: 700; color: ${gradeColor(row.grade)}`}>
                          {row.grade}
                        </td>
                        <td style="padding: 6px 8px; text-align: right; color: var(--text)">
                          {row.score}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/health/compute — trigger recompute (owner only)
// ---------------------------------------------------------------------------

health.post(
  "/:owner/:repo/health/compute",
  softAuth,
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.notFound();

    // Only the repo owner may trigger a manual recompute
    if (user.id !== resolved.owner.id) {
      return c.redirect(`/${ownerName}/${repoName}/health`);
    }

    // Run synchronously so the redirect shows fresh data
    try {
      await computeAndStoreHealthScore(resolved.repo.id, ownerName, repoName);
    } catch (err) {
      console.error("[health/compute] failed:", err);
    }

    return c.redirect(`/${ownerName}/${repoName}/health`);
  }
);

export default health;

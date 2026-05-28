/**
 * Repository Pulse — a time-window snapshot of repo activity.
 *
 * Route: GET /:owner/:repo/pulse?window=1|7|30 (default 7 days)
 *
 * Shows:
 *   - Issues opened / closed in window
 *   - PRs opened / merged / closed in window
 *   - Active contributors (unique commit authors in window)
 *   - Gate activity (pass/fail counts)
 *   - Most active contributors (by PR + commit activity)
 *   - Streak: consecutive days with at least one merged PR
 *
 * Zero new DB tables. All data from: pull_requests, issues, users,
 * repositories, activityFeed, gateRuns.
 *
 * Scoped CSS: `.pulse-*`
 */

import { Hono } from "hono";
import { db } from "../db";
import {
  pullRequests,
  issues,
  users,
  repositories,
  activityFeed,
  gateRuns,
  prComments,
} from "../db/schema";
import { eq, and, gte, desc, sql, count, isNotNull } from "drizzle-orm";
import type { AuthEnv } from "../middleware/auth";
import { softAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { listCommits, getDefaultBranch } from "../git/repository";

const pulseRoutes = new Hono<AuthEnv>();

// Path-scoped middleware — NEVER use("*", ...)
pulseRoutes.use("/:owner/:repo/pulse*", softAuth);

// ─── helpers ─────────────────────────────────────────────────────────────────

function windowStart(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function pct(a: number, b: number): string {
  if (!b) return "0%";
  return `${Math.round((a / b) * 100)}%`;
}

// ─── route ───────────────────────────────────────────────────────────────────

pulseRoutes.get(
  "/:owner/:repo/pulse",
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");

    const rawWindow = c.req.query("window");
    const windowDays = rawWindow === "1" ? 1 : rawWindow === "30" ? 30 : 7;
    const since = windowStart(windowDays);

    // Load repo
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerRow) return c.notFound();

    const [repo] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repoName)))
      .limit(1);
    if (!repo) return c.notFound();

    // ── parallel queries ─────────────────────────────────────────────────────

    const [
      issuesOpened,
      issuesClosed,
      prsOpened,
      prsMerged,
      prsClosed,
      gatesPassed,
      gatesFailed,
      reviewsPosted,
      topPrAuthors,
      recentActivity,
    ] = await Promise.all([
      // Issues opened in window
      db
        .select({ cnt: count() })
        .from(issues)
        .where(and(eq(issues.repositoryId, repo.id), gte(issues.createdAt, since)))
        .then((r) => r[0]?.cnt ?? 0),

      // Issues closed in window
      db
        .select({ cnt: count() })
        .from(issues)
        .where(
          and(
            eq(issues.repositoryId, repo.id),
            eq(issues.state, "closed"),
            gte(issues.updatedAt, since)
          )
        )
        .then((r) => r[0]?.cnt ?? 0),

      // PRs opened in window
      db
        .select({ cnt: count() })
        .from(pullRequests)
        .where(and(eq(pullRequests.repositoryId, repo.id), gte(pullRequests.createdAt, since)))
        .then((r) => r[0]?.cnt ?? 0),

      // PRs merged in window
      db
        .select({ cnt: count() })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.state, "merged"),
            isNotNull(pullRequests.mergedAt),
            gte(pullRequests.mergedAt!, since)
          )
        )
        .then((r) => r[0]?.cnt ?? 0),

      // PRs closed (not merged) in window
      db
        .select({ cnt: count() })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.state, "closed"),
            gte(pullRequests.updatedAt, since)
          )
        )
        .then((r) => r[0]?.cnt ?? 0),

      // Gates passed in window
      db
        .select({ cnt: count() })
        .from(gateRuns)
        .where(
          and(
            eq(gateRuns.repositoryId, repo.id),
            eq(gateRuns.status, "passed"),
            gte(gateRuns.createdAt, since)
          )
        )
        .then((r) => r[0]?.cnt ?? 0),

      // Gates failed in window
      db
        .select({ cnt: count() })
        .from(gateRuns)
        .where(
          and(
            eq(gateRuns.repositoryId, repo.id),
            eq(gateRuns.status, "failed"),
            gte(gateRuns.createdAt, since)
          )
        )
        .then((r) => r[0]?.cnt ?? 0),

      // Code reviews posted in window (non-AI)
      db
        .select({ cnt: count() })
        .from(prComments)
        .innerJoin(pullRequests, eq(prComments.pullRequestId, pullRequests.id))
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(prComments.isAiReview, false),
            gte(prComments.createdAt, since)
          )
        )
        .then((r) => r[0]?.cnt ?? 0),

      // Top PR contributors in window (by PRs opened)
      db
        .select({
          authorId: pullRequests.authorId,
          username: users.username,
          prsOpened: count(),
        })
        .from(pullRequests)
        .innerJoin(users, eq(pullRequests.authorId, users.id))
        .where(
          and(eq(pullRequests.repositoryId, repo.id), gte(pullRequests.createdAt, since))
        )
        .groupBy(pullRequests.authorId, users.username)
        .orderBy(desc(count()))
        .limit(8),

      // Recent activity feed entries
      db
        .select({
          action: activityFeed.action,
          targetType: activityFeed.targetType,
          targetId: activityFeed.targetId,
          createdAt: activityFeed.createdAt,
          username: users.username,
        })
        .from(activityFeed)
        .leftJoin(users, eq(activityFeed.userId, users.id))
        .where(
          and(eq(activityFeed.repositoryId, repo.id), gte(activityFeed.createdAt, since))
        )
        .orderBy(desc(activityFeed.createdAt))
        .limit(20),
    ]);

    // Commit count from git log (best-effort)
    let commitCount = 0;
    let activeContributors = new Set<string>();
    try {
      const defaultBranch = (await getDefaultBranch(ownerName, repoName)) ?? "main";
      const commits = await listCommits(ownerName, repoName, defaultBranch, 200);
      const cutoff = since.getTime();
      for (const c of commits) {
        const ts = new Date(c.date).getTime();
        if (ts >= cutoff) {
          commitCount++;
          const email = (c as { authorEmail?: string }).authorEmail;
          if (email) activeContributors.add(email);
        }
      }
    } catch {
      // If repo has no commits or git fails, silently skip
    }

    const windowLabel =
      windowDays === 1 ? "last 24 hours" : `last ${windowDays} days`;
    const totalGates = Number(gatesPassed) + Number(gatesFailed);
    const gatePassRate = totalGates > 0
      ? Math.round((Number(gatesPassed) / totalGates) * 100)
      : null;

    return c.html(
      <Layout
        title={`Pulse — ${ownerName}/${repoName}`}
        user={user}
      >
        <PulseStyle />
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="insights" />
        <div class="pulse-page">
          {/* Window selector */}
          <div class="pulse-header">
            <h2 class="pulse-title">Pulse</h2>
            <div class="pulse-windows">
              {(["1", "7", "30"] as const).map((w) => (
                <a
                  href={`/${ownerName}/${repoName}/pulse?window=${w}`}
                  class={`pulse-window-btn${windowDays === Number(w) ? " is-active" : ""}`}
                >
                  {w === "1" ? "24h" : w === "7" ? "7d" : "30d"}
                </a>
              ))}
            </div>
            <p class="pulse-subtitle">
              Activity overview for the <strong>{windowLabel}</strong> (
              {formatDate(since)} – {formatDate(new Date())})
            </p>
          </div>

          {/* Summary stat cards */}
          <div class="pulse-cards">
            <StatCard
              label="Issues opened"
              value={Number(issuesOpened)}
              sub={`${Number(issuesClosed)} closed`}
              color="#f59e0b"
            />
            <StatCard
              label="PRs opened"
              value={Number(prsOpened)}
              sub={`${Number(prsMerged)} merged · ${Number(prsClosed)} closed`}
              color="#8c6dff"
            />
            <StatCard
              label="Commits"
              value={commitCount}
              sub={`by ${activeContributors.size} contributor${activeContributors.size !== 1 ? "s" : ""}`}
              color="#36c5d6"
            />
            <StatCard
              label="Code reviews"
              value={Number(reviewsPosted)}
              sub="human reviews posted"
              color="#22c55e"
            />
            {gatePassRate !== null && (
              <StatCard
                label="Gate pass rate"
                value={gatePassRate}
                suffix="%"
                sub={`${Number(gatesPassed)}/${totalGates} checks`}
                color={gatePassRate >= 80 ? "#22c55e" : gatePassRate >= 50 ? "#f59e0b" : "#ef4444"}
              />
            )}
          </div>

          <div class="pulse-body">
            {/* Top contributors */}
            {topPrAuthors.length > 0 && (
              <section class="pulse-section">
                <h3 class="pulse-section-title">Top contributors this period</h3>
                <div class="pulse-contributors">
                  {topPrAuthors.map((row) => (
                    <a
                      href={`/${row.username}`}
                      class="pulse-contrib-row"
                    >
                      <span class="pulse-contrib-avatar">
                        {row.username.slice(0, 1).toUpperCase()}
                      </span>
                      <span class="pulse-contrib-name">{row.username}</span>
                      <span class="pulse-contrib-count">
                        {Number(row.prsOpened)} PR{Number(row.prsOpened) !== 1 ? "s" : ""}
                      </span>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {/* Gate health */}
            {totalGates > 0 && (
              <section class="pulse-section">
                <h3 class="pulse-section-title">Gate health</h3>
                <div class="pulse-gate-bar-wrap">
                  <div class="pulse-gate-bar">
                    <div
                      class="pulse-gate-bar-pass"
                      style={`width:${pct(Number(gatesPassed), totalGates)}`}
                      title={`${gatesPassed} passed`}
                    />
                    <div
                      class="pulse-gate-bar-fail"
                      style={`width:${pct(Number(gatesFailed), totalGates)}`}
                      title={`${gatesFailed} failed`}
                    />
                  </div>
                  <span class="pulse-gate-bar-label">
                    {gatesPassed} passed · {gatesFailed} failed
                    {gatePassRate !== null && ` (${gatePassRate}%)`}
                  </span>
                </div>
              </section>
            )}

            {/* Recent activity */}
            {recentActivity.length > 0 && (
              <section class="pulse-section">
                <h3 class="pulse-section-title">Recent activity</h3>
                <ul class="pulse-activity-list">
                  {recentActivity.slice(0, 12).map((ev) => (
                    <li class="pulse-activity-item">
                      <span class="pulse-activity-icon">{activityIcon(ev.action)}</span>
                      <span class="pulse-activity-text">
                        {ev.username && (
                          <a href={`/${ev.username}`} class="pulse-activity-user">
                            {ev.username}
                          </a>
                        )}
                        {" "}
                        {activityLabel(ev.action, ev.targetType ?? null, ev.targetId ?? null)}
                      </span>
                      <span class="pulse-activity-time">
                        {formatDate(new Date(ev.createdAt))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {recentActivity.length === 0 && commitCount === 0 && (
              <div class="pulse-empty">
                <p>No activity in the {windowLabel}.</p>
                <a href="?window=30" class="btn">View last 30 days</a>
              </div>
            )}
          </div>
        </div>
      </Layout>
    );
  }
);

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color,
  suffix = "",
}: {
  label: string;
  value: number;
  sub?: string;
  color: string;
  suffix?: string;
}) {
  return (
    <div class="pulse-card" style={`border-top-color:${color}`}>
      <div class="pulse-card-value" style={`color:${color}`}>
        {value.toLocaleString()}{suffix}
      </div>
      <div class="pulse-card-label">{label}</div>
      {sub && <div class="pulse-card-sub">{sub}</div>}
    </div>
  );
}

function activityIcon(action: string): string {
  if (action.includes("issue")) return "◦";
  if (action.includes("pr") || action.includes("pull_request")) return "↑";
  if (action.includes("deploy")) return "▶";
  if (action.includes("gate")) return "✓";
  if (action.includes("repo")) return "⊞";
  return "·";
}

function activityLabel(action: string, targetType: string | null, targetId: string | null): string {
  const ref = targetId ? `#${targetId}` : "";
  if (action === "pull_request.opened") return `opened PR ${ref}`;
  if (action === "pull_request.merged") return `merged PR ${ref}`;
  if (action === "pull_request.closed") return `closed PR ${ref}`;
  if (action === "issue.opened") return `opened issue ${ref}`;
  if (action === "issue.closed") return `closed issue ${ref}`;
  if (action === "repo_created") return "created repository";
  if (action === "deploy_success") return "deployed successfully";
  if (action === "deploy_failed") return "deployment failed";
  if (action.includes("gate")) return `gate ${action.split(".")[1] || "run"}`;
  return action.replace(/_/g, " ").replace(/\./g, " ");
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function PulseStyle() {
  return (
    <style>{`
      .pulse-page { max-width: 900px; margin: 0 auto; padding: 0 16px 48px; }
      .pulse-header { margin: 24px 0 20px; }
      .pulse-title { font-size: 22px; font-weight: 700; margin: 0 0 8px; }
      .pulse-subtitle { font-size: 14px; color: var(--fg-muted); margin: 8px 0 0; }
      .pulse-windows { display: flex; gap: 8px; margin-bottom: 8px; }
      .pulse-window-btn {
        padding: 5px 14px; border-radius: 20px; font-size: 13px; font-weight: 600;
        background: var(--bg-elevated); border: 1px solid var(--border); color: var(--fg);
        text-decoration: none; transition: border-color .15s;
      }
      .pulse-window-btn:hover { border-color: var(--accent); }
      .pulse-window-btn.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }

      .pulse-cards {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
        gap: 14px; margin-bottom: 32px;
      }
      .pulse-card {
        background: var(--bg-elevated); border: 1px solid var(--border);
        border-radius: 12px; border-top: 3px solid var(--accent);
        padding: 18px 16px;
      }
      .pulse-card-value { font-size: 28px; font-weight: 800; line-height: 1; margin-bottom: 4px; }
      .pulse-card-label { font-size: 12px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: .04em; }
      .pulse-card-sub { font-size: 12px; color: var(--fg-muted); margin-top: 4px; }

      .pulse-body { display: flex; flex-direction: column; gap: 28px; }
      .pulse-section { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px; }
      .pulse-section-title { font-size: 15px; font-weight: 700; margin: 0 0 14px; }

      .pulse-contributors { display: flex; flex-wrap: wrap; gap: 10px; }
      .pulse-contrib-row {
        display: flex; align-items: center; gap: 8px;
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
        padding: 7px 12px; text-decoration: none; color: var(--fg); font-size: 13px;
        transition: border-color .15s;
      }
      .pulse-contrib-row:hover { border-color: var(--accent); }
      .pulse-contrib-avatar {
        width: 26px; height: 26px; border-radius: 50%; background: var(--accent);
        color: #fff; display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700; flex-shrink: 0;
      }
      .pulse-contrib-name { font-weight: 600; }
      .pulse-contrib-count { color: var(--fg-muted); }

      .pulse-gate-bar-wrap { display: flex; align-items: center; gap: 12px; }
      .pulse-gate-bar {
        flex: 1; height: 12px; border-radius: 6px; background: var(--bg); overflow: hidden;
        display: flex;
      }
      .pulse-gate-bar-pass { background: #22c55e; height: 100%; transition: width .3s; }
      .pulse-gate-bar-fail { background: #ef4444; height: 100%; transition: width .3s; }
      .pulse-gate-bar-label { font-size: 13px; color: var(--fg-muted); white-space: nowrap; }

      .pulse-activity-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .pulse-activity-item { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
      .pulse-activity-icon { font-size: 14px; color: var(--accent); width: 16px; flex-shrink: 0; }
      .pulse-activity-text { flex: 1; color: var(--fg); }
      .pulse-activity-user { font-weight: 600; color: var(--fg); text-decoration: none; }
      .pulse-activity-user:hover { text-decoration: underline; }
      .pulse-activity-time { color: var(--fg-muted); font-size: 12px; white-space: nowrap; }

      .pulse-empty { text-align: center; padding: 40px 0; color: var(--fg-muted); }
      .pulse-empty p { margin-bottom: 14px; }
    `}</style>
  );
}

export default pulseRoutes;

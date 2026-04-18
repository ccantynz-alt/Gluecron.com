/**
 * Dashboard — the authed user's home page.
 *
 * Shows:
 *   - Unread notifications (top 5 with link to full inbox)
 *   - PRs awaiting your review
 *   - PRs you authored that are open
 *   - Issues assigned to you (currently "authored by you" until assignments land)
 *   - Recent activity across your repos
 *   - Your repositories
 *   - Gate health summary across all your repos
 *
 * Rendered at `/dashboard`. The `/` route still calls this for logged-in users.
 */

import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  activityFeed,
  gateRuns,
  issues,
  notifications,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoCard } from "../views/components";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getUnreadCount } from "../lib/unread";

const dashboard = new Hono<AuthEnv>();
dashboard.use("*", softAuth);

function relTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - t.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return t.toLocaleDateString();
}

export async function renderDashboard(c: any) {
  const user = c.get("user")!;
  const unreadCount = await getUnreadCount(user.id);

  // User's repositories
  const myRepos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.ownerId, user.id))
    .orderBy(desc(repositories.updatedAt))
    .limit(12);

  const myRepoIds = myRepos.map((r) => r.id);

  // Unread notifications (top 5)
  let recentNotifications: Array<{
    id: string;
    kind: string;
    title: string;
    url: string | null;
    createdAt: Date;
  }> = [];
  try {
    recentNotifications = await db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        title: notifications.title,
        url: notifications.url,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(
        and(eq(notifications.userId, user.id), isNull(notifications.readAt))
      )
      .orderBy(desc(notifications.createdAt))
      .limit(5);
  } catch {
    /* ignore */
  }

  // Open PRs you authored
  let myPrs: Array<{
    id: string;
    number: number;
    title: string;
    state: string;
    repoName: string;
    repoOwner: string;
    createdAt: Date;
  }> = [];
  try {
    myPrs = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        state: pullRequests.state,
        repoName: repositories.name,
        repoOwner: users.username,
        createdAt: pullRequests.createdAt,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(
          eq(pullRequests.authorId, user.id),
          eq(pullRequests.state, "open")
        )
      )
      .orderBy(desc(pullRequests.updatedAt))
      .limit(10);
  } catch {
    /* ignore */
  }

  // PRs in your repos awaiting review (open, not authored by you)
  let reviewablePrs: Array<{
    id: string;
    number: number;
    title: string;
    repoName: string;
    repoOwner: string;
    createdAt: Date;
  }> = [];
  if (myRepoIds.length > 0) {
    try {
      reviewablePrs = await db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          repoName: repositories.name,
          repoOwner: users.username,
          createdAt: pullRequests.createdAt,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(
          and(
            inArray(pullRequests.repositoryId, myRepoIds),
            eq(pullRequests.state, "open")
          )
        )
        .orderBy(desc(pullRequests.updatedAt))
        .limit(10);
    } catch {
      /* ignore */
    }
  }

  // Issues you authored that are still open
  let myIssues: Array<{
    id: string;
    number: number;
    title: string;
    repoName: string;
    repoOwner: string;
    createdAt: Date;
  }> = [];
  try {
    myIssues = await db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        repoName: repositories.name,
        repoOwner: users.username,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .innerJoin(repositories, eq(issues.repositoryId, repositories.id))
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(issues.authorId, user.id), eq(issues.state, "open")))
      .orderBy(desc(issues.updatedAt))
      .limit(10);
  } catch {
    /* ignore */
  }

  // Recent activity across user's repos
  let recentActivity: Array<{
    id: string;
    action: string;
    repoName: string;
    repoOwner: string;
    createdAt: Date;
  }> = [];
  if (myRepoIds.length > 0) {
    try {
      recentActivity = await db
        .select({
          id: activityFeed.id,
          action: activityFeed.action,
          repoName: repositories.name,
          repoOwner: users.username,
          createdAt: activityFeed.createdAt,
        })
        .from(activityFeed)
        .innerJoin(repositories, eq(activityFeed.repositoryId, repositories.id))
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(inArray(activityFeed.repositoryId, myRepoIds))
        .orderBy(desc(activityFeed.createdAt))
        .limit(15);
    } catch {
      /* ignore */
    }
  }

  // Gate health across your repos (last 20 runs)
  let gateHealth: Array<{
    gateName: string;
    status: string;
    repoName: string;
    repoOwner: string;
    createdAt: Date;
    summary: string | null;
  }> = [];
  if (myRepoIds.length > 0) {
    try {
      gateHealth = await db
        .select({
          gateName: gateRuns.gateName,
          status: gateRuns.status,
          repoName: repositories.name,
          repoOwner: users.username,
          createdAt: gateRuns.createdAt,
          summary: gateRuns.summary,
        })
        .from(gateRuns)
        .innerJoin(repositories, eq(gateRuns.repositoryId, repositories.id))
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(inArray(gateRuns.repositoryId, myRepoIds))
        .orderBy(desc(gateRuns.createdAt))
        .limit(10);
    } catch {
      /* ignore */
    }
  }

  const greenCount = gateHealth.filter(
    (g) => g.status === "passed" || g.status === "repaired" || g.status === "skipped"
  ).length;
  const redCount = gateHealth.filter((g) => g.status === "failed").length;

  return c.html(
    <Layout title="Dashboard" user={user} notificationCount={unreadCount}>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <h2>Welcome back, {user.displayName || user.username}</h2>
        <a href="/new" class="btn btn-primary">
          + New repository
        </a>
      </div>

      <div class="dashboard-grid">
        {/* Left column */}
        <div>
          <div class="dashboard-section">
            <h3>
              Needs your attention
              <a href="/notifications">view all</a>
            </h3>
            <div class="panel">
              {recentNotifications.length === 0 ? (
                <div class="panel-empty">Inbox zero. Nice work.</div>
              ) : (
                recentNotifications.map((n) => (
                  <div class="panel-item">
                    <div class="dot blue"></div>
                    <div style="flex: 1">
                      {n.url ? (
                        <a href={n.url}>{n.title}</a>
                      ) : (
                        <span>{n.title}</span>
                      )}
                      <div class="meta">
                        {n.kind} · {relTime(n.createdAt)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div class="dashboard-section">
            <h3>PRs awaiting review in your repos</h3>
            <div class="panel">
              {reviewablePrs.length === 0 ? (
                <div class="panel-empty">No open PRs in your repositories.</div>
              ) : (
                reviewablePrs.map((pr) => (
                  <div class="panel-item">
                    <div class="dot green"></div>
                    <div style="flex: 1">
                      <a href={`/${pr.repoOwner}/${pr.repoName}/pull/${pr.number}`}>
                        {pr.title}
                      </a>
                      <div class="meta">
                        {pr.repoOwner}/{pr.repoName}#{pr.number} · opened{" "}
                        {relTime(pr.createdAt)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div class="dashboard-section">
            <h3>Your open PRs</h3>
            <div class="panel">
              {myPrs.length === 0 ? (
                <div class="panel-empty">You have no open PRs.</div>
              ) : (
                myPrs.map((pr) => (
                  <div class="panel-item">
                    <div class="dot blue"></div>
                    <div style="flex: 1">
                      <a href={`/${pr.repoOwner}/${pr.repoName}/pull/${pr.number}`}>
                        {pr.title}
                      </a>
                      <div class="meta">
                        {pr.repoOwner}/{pr.repoName}#{pr.number} ·{" "}
                        {relTime(pr.createdAt)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div class="dashboard-section">
            <h3>Your open issues</h3>
            <div class="panel">
              {myIssues.length === 0 ? (
                <div class="panel-empty">No open issues.</div>
              ) : (
                myIssues.map((i) => (
                  <div class="panel-item">
                    <div class="dot yellow"></div>
                    <div style="flex: 1">
                      <a href={`/${i.repoOwner}/${i.repoName}/issues/${i.number}`}>
                        {i.title}
                      </a>
                      <div class="meta">
                        {i.repoOwner}/{i.repoName}#{i.number} ·{" "}
                        {relTime(i.createdAt)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right column */}
        <div>
          <div class="dashboard-section">
            <h3>Gate health</h3>
            <div class="panel" style="padding: 16px">
              <div style="display: flex; gap: 12px; margin-bottom: 12px">
                <div style="flex: 1; text-align: center; padding: 8px; background: rgba(63, 185, 80, 0.1); border-radius: var(--radius)">
                  <div style="font-size: 24px; font-weight: 700; color: var(--green)">
                    {greenCount}
                  </div>
                  <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase">
                    green
                  </div>
                </div>
                <div style="flex: 1; text-align: center; padding: 8px; background: rgba(248, 81, 73, 0.1); border-radius: var(--radius)">
                  <div style="font-size: 24px; font-weight: 700; color: var(--red)">
                    {redCount}
                  </div>
                  <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase">
                    failed
                  </div>
                </div>
              </div>
              <div style="font-size: 12px; color: var(--text-muted); text-align: center">
                Last 10 gate runs across your repos
              </div>
            </div>
          </div>

          <div class="dashboard-section">
            <h3>Recent activity</h3>
            <div class="panel">
              {recentActivity.length === 0 ? (
                <div class="panel-empty">No activity yet.</div>
              ) : (
                recentActivity.map((a) => (
                  <div class="panel-item">
                    <div
                      class={`dot ${a.action === "push" ? "green" : a.action === "pr_merge" ? "blue" : "yellow"}`}
                    ></div>
                    <div style="flex: 1">
                      <a href={`/${a.repoOwner}/${a.repoName}`}>
                        {a.repoOwner}/{a.repoName}
                      </a>{" "}
                      <span style="color: var(--text-muted)">{a.action}</span>
                      <div class="meta">{relTime(a.createdAt)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div class="dashboard-section" style="margin-top: 32px">
        <h3>
          Your repositories
          <a href={`/${user.username}`}>view all</a>
        </h3>
        {myRepos.length === 0 ? (
          <div class="empty-state">
            <h2>No repositories yet</h2>
            <p>Create your first repository to get started.</p>
          </div>
        ) : (
          <div class="card-grid">
            {myRepos.map((repo) => (
              <RepoCard repo={repo} ownerName={user.username} />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

dashboard.get("/dashboard", requireAuth, (c) => renderDashboard(c));

export default dashboard;

/**
 * Repo insights + milestones.
 *
 *   GET  /:owner/:repo/insights              — contributors, commit activity, gate health, AI-generated summary
 *   GET  /:owner/:repo/milestones            — list
 *   POST /:owner/:repo/milestones            — create
 *   POST /:owner/:repo/milestones/:id/close  — close
 *   POST /:owner/:repo/milestones/:id/reopen — reopen
 *   POST /:owner/:repo/milestones/:id/delete — delete
 */

import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  gateRuns,
  issues,
  milestones,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getUnreadCount } from "../lib/unread";
import { listCommits } from "../git/repository";

const insights = new Hono<AuthEnv>();
insights.use("*", softAuth);

async function loadRepo(owner: string, repo: string) {
  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
      ownerId: repositories.ownerId,
      starCount: repositories.starCount,
      forkCount: repositories.forkCount,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  return row;
}

// ---------- Insights ----------

insights.get("/:owner/:repo/insights", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const unread = user ? await getUnreadCount(user.id) : 0;

  // Commit activity — last 200 commits on default
  const commits = await listCommits(
    owner,
    repo,
    repoRow.defaultBranch,
    200
  );

  // Contributors by commit count
  const byAuthor = new Map<string, number>();
  for (const c0 of commits) {
    byAuthor.set(c0.author, (byAuthor.get(c0.author) || 0) + 1);
  }
  const contributors = [...byAuthor.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Commits per day (last 30)
  const dayCounts = new Map<string, number>();
  for (const c0 of commits) {
    const day = c0.date.slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }
  const days: Array<{ date: string; count: number }> = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key, count: dayCounts.get(key) || 0 });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.count));

  // Gate health 30d
  const gateStats = await db
    .select({
      status: gateRuns.status,
      c: sql<number>`count(*)::int`,
    })
    .from(gateRuns)
    .where(eq(gateRuns.repositoryId, repoRow.id))
    .groupBy(gateRuns.status);

  const statTotals: Record<string, number> = {};
  let totalRuns = 0;
  for (const r of gateStats) {
    statTotals[r.status] = r.c;
    totalRuns += r.c;
  }
  const greenRate =
    totalRuns === 0
      ? 100
      : Math.round(
          (((statTotals.passed || 0) +
            (statTotals.repaired || 0) +
            (statTotals.skipped || 0)) /
            totalRuns) *
            100
        );

  // Issues + PR counts
  const [issueStats] = await db
    .select({
      open: sql<number>`count(*) filter (where ${issues.state} = 'open')::int`,
      closed: sql<number>`count(*) filter (where ${issues.state} = 'closed')::int`,
    })
    .from(issues)
    .where(eq(issues.repositoryId, repoRow.id));

  const [prStats] = await db
    .select({
      open: sql<number>`count(*) filter (where ${pullRequests.state} = 'open')::int`,
      merged: sql<number>`count(*) filter (where ${pullRequests.state} = 'merged')::int`,
      closed: sql<number>`count(*) filter (where ${pullRequests.state} = 'closed')::int`,
    })
    .from(pullRequests)
    .where(eq(pullRequests.repositoryId, repoRow.id));

  return c.html(
    <Layout
      title={`Insights — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="insights" />
      <div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px">
        <h3 style="margin: 0">Insights</h3>
        <div style="display: flex; gap: 16px">
          <a
            href={`/${owner}/${repo}/insights/response-time`}
            style="font-size: 12px; color: var(--accent)"
          >
            Response time &rarr;
          </a>
          <a
            href={`/${owner}/${repo}/insights/lead-time`}
            style="font-size: 12px; color: var(--accent)"
          >
            Lead time &rarr;
          </a>
          <a
            href={`/${owner}/${repo}/pulse`}
            style="font-size: 12px; color: var(--accent)"
          >
            Pulse &rarr;
          </a>
          <a
            href={`/${owner}/${repo}/languages`}
            style="font-size: 12px; color: var(--accent)"
          >
            Languages &rarr;
          </a>
          <a
            href={`/${owner}/${repo}/insights/size`}
            style="font-size: 12px; color: var(--accent)"
          >
            Size audit &rarr;
          </a>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px">
        <div class="panel" style="padding: 16px">
          <div style="font-size: 28px; font-weight: 700; color: var(--green)">
            {greenRate}%
          </div>
          <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase">
            Green rate
          </div>
        </div>
        <div class="panel" style="padding: 16px">
          <div style="font-size: 28px; font-weight: 700">{commits.length}</div>
          <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase">
            Recent commits
          </div>
        </div>
        <div class="panel" style="padding: 16px">
          <div style="font-size: 28px; font-weight: 700">
            {(prStats?.open || 0) + (prStats?.merged || 0) + (prStats?.closed || 0)}
          </div>
          <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase">
            Pull requests
          </div>
        </div>
        <div class="panel" style="padding: 16px">
          <div style="font-size: 28px; font-weight: 700">
            {(issueStats?.open || 0) + (issueStats?.closed || 0)}
          </div>
          <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase">
            Issues
          </div>
        </div>
      </div>

      <div class="dashboard-section">
        <h3>Commit activity (last 30 days)</h3>
        <div class="panel" style="padding: 16px">
          <div style="display: flex; align-items: flex-end; gap: 2px; height: 80px">
            {days.map((d) => (
              <div
                title={`${d.date}: ${d.count} commits`}
                style={`flex: 1; background: var(--accent); height: ${Math.max(2, (d.count / maxDay) * 80)}px; border-radius: 2px; opacity: ${d.count === 0 ? 0.2 : 1}`}
              ></div>
            ))}
          </div>
          <div style="display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: var(--text-muted)">
            <span>{days[0].date}</span>
            <span>{days[days.length - 1].date}</span>
          </div>
        </div>
      </div>

      <div class="dashboard-section">
        <h3>Top contributors</h3>
        <div class="panel">
          {contributors.length === 0 ? (
            <div class="panel-empty">No contributors yet.</div>
          ) : (
            contributors.map(([author, count]) => {
              const pct = Math.round(
                (count / contributors[0][1]) * 100
              );
              return (
                <div class="panel-item">
                  <div style="flex: 1">
                    <div style="font-weight: 500">{author}</div>
                    <div
                      style={`height: 6px; background: var(--accent); border-radius: 3px; margin-top: 4px; width: ${pct}%`}
                    ></div>
                  </div>
                  <div style="font-size: 12px; color: var(--text-muted); width: 80px; text-align: right">
                    {count} commit{count !== 1 ? "s" : ""}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Layout>
  );
});

// ---------- Milestones ----------

insights.get("/:owner/:repo/milestones", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  const unread = user ? await getUnreadCount(user.id) : 0;
  const state = c.req.query("state") || "open";

  const rows = await db
    .select()
    .from(milestones)
    .where(
      and(
        eq(milestones.repositoryId, repoRow.id),
        eq(milestones.state, state)
      )
    )
    .orderBy(desc(milestones.createdAt));

  return c.html(
    <Layout
      title={`Milestones — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="issues" />
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <div class="issue-tabs">
          <a
            href={`/${owner}/${repo}/milestones?state=open`}
            class={state === "open" ? "active" : ""}
          >
            Open
          </a>
          <a
            href={`/${owner}/${repo}/milestones?state=closed`}
            class={state === "closed" ? "active" : ""}
          >
            Closed
          </a>
        </div>
        {user && user.id === repoRow.ownerId && (
          <a
            href={`/${owner}/${repo}/milestones#new`}
            class="btn btn-primary btn-sm"
          >
            + New milestone
          </a>
        )}
      </div>

      {rows.length === 0 ? (
        <div class="empty-state">
          <p>No {state} milestones.</p>
        </div>
      ) : (
        <div class="panel" style="margin-bottom: 24px">
          {rows.map((m) => (
            <div class="panel-item" style="justify-content: space-between">
              <div style="flex: 1">
                <div style="font-weight: 600">{m.title}</div>
                {m.description && (
                  <div class="meta" style="margin-top: 2px">{m.description}</div>
                )}
                <div class="meta" style="margin-top: 2px">
                  {m.dueDate
                    ? `Due ${new Date(m.dueDate).toLocaleDateString()}`
                    : "No due date"}
                </div>
              </div>
              {user && user.id === repoRow.ownerId && (
                <div style="display: flex; gap: 4px">
                  {m.state === "open" ? (
                    <form
                      method="POST"
                      action={`/${owner}/${repo}/milestones/${m.id}/close`}
                    >
                      <button type="submit" class="btn btn-sm">
                        Close
                      </button>
                    </form>
                  ) : (
                    <form
                      method="POST"
                      action={`/${owner}/${repo}/milestones/${m.id}/reopen`}
                    >
                      <button type="submit" class="btn btn-sm">
                        Reopen
                      </button>
                    </form>
                  )}
                  <form
                    method="POST"
                    action={`/${owner}/${repo}/milestones/${m.id}/delete`}
                    onsubmit="return confirm('Delete this milestone?')"
                  >
                    <button type="submit" class="btn btn-sm btn-danger">
                      Delete
                    </button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {user && user.id === repoRow.ownerId && (
        <form
          id="new"
          method="POST"
          action={`/${owner}/${repo}/milestones`}
          class="panel"
          style="padding: 16px"
        >
          <h3 style="margin-bottom: 12px">Create milestone</h3>
          <div class="form-group">
            <label>Title</label>
            <input type="text" name="title" required />
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea name="description" rows={3}></textarea>
          </div>
          <div class="form-group">
            <label>Due date (optional)</label>
            <input type="date" name="dueDate" />
          </div>
          <button type="submit" class="btn btn-primary">
            Create
          </button>
        </form>
      )}
    </Layout>
  );
});

insights.post("/:owner/:repo/milestones", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/milestones`);

  const body = await c.req.parseBody();
  const title = String(body.title || "").trim();
  if (!title) return c.redirect(`/${owner}/${repo}/milestones`);
  const description = String(body.description || "").trim() || null;
  const dueDateRaw = String(body.dueDate || "").trim();
  const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;

  try {
    await db.insert(milestones).values({
      repositoryId: repoRow.id,
      title,
      description,
      dueDate,
    });
  } catch (err) {
    console.error("[milestones] create:", err);
  }

  return c.redirect(`/${owner}/${repo}/milestones`);
});

insights.post("/:owner/:repo/milestones/:id/close", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, id } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow || repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}/milestones`);
  }
  await db
    .update(milestones)
    .set({ state: "closed", closedAt: new Date() })
    .where(
      and(eq(milestones.id, id), eq(milestones.repositoryId, repoRow.id))
    );
  return c.redirect(`/${owner}/${repo}/milestones`);
});

insights.post("/:owner/:repo/milestones/:id/reopen", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, id } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow || repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}/milestones`);
  }
  await db
    .update(milestones)
    .set({ state: "open", closedAt: null })
    .where(
      and(eq(milestones.id, id), eq(milestones.repositoryId, repoRow.id))
    );
  return c.redirect(`/${owner}/${repo}/milestones?state=closed`);
});

insights.post("/:owner/:repo/milestones/:id/delete", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, id } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow || repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}/milestones`);
  }
  await db
    .delete(milestones)
    .where(
      and(eq(milestones.id, id), eq(milestones.repositoryId, repoRow.id))
    );
  return c.redirect(`/${owner}/${repo}/milestones`);
});

export default insights;

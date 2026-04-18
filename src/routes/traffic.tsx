/**
 * Block F1 — Traffic analytics UI.
 *
 *   GET  /:owner/:repo/traffic  — owner-only 14-day views/clones chart,
 *                                  unique visitors, top paths + referers.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { summarise } from "../lib/traffic";

const traffic = new Hono<AuthEnv>();
traffic.use("*", softAuth);

async function loadRepo(owner: string, repo: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

traffic.get("/:owner/:repo/traffic", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const windowDays = Math.max(
    1,
    Math.min(90, parseInt(c.req.query("days") || "14", 10) || 14)
  );
  const summary = await summarise(repoRow.id, windowDays);

  // Simple ascii-bar chart scaled to the max day.
  const maxN = Math.max(
    1,
    ...summary.daily.map((d) => d.views + d.clones)
  );

  return c.html(
    <Layout title={`Traffic — ${owner}/${repo}`} user={user}>
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user.username}
      />
      <RepoNav owner={owner} repo={repo} active="insights" />

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3>Traffic ({windowDays}d)</h3>
        <div>
          {[7, 14, 30, 90].map((d) => (
            <a
              href={`/${owner}/${repo}/traffic?days=${d}`}
              class={`btn btn-sm ${d === windowDays ? "btn-primary" : ""}`}
              style="margin-left:4px"
            >
              {d}d
            </a>
          ))}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#79c0ff">
            {summary.totalViews}
          </div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Views
          </div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#d2a8ff">
            {summary.totalClones}
          </div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Clones
          </div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:var(--green)">
            {summary.uniqueVisitorsApprox}
          </div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Unique (approx)
          </div>
        </div>
      </div>

      <h4>Daily</h4>
      <div class="panel" style="margin-bottom:20px;padding:12px">
        {summary.daily.length === 0 ? (
          <p style="color:var(--text-muted);font-size:13px">
            No traffic recorded yet. Views are tracked automatically as people
            visit this repo; clones + API hits are tracked on git-http access.
          </p>
        ) : (
          summary.daily.map((d) => {
            const total = d.views + d.clones;
            const pct = Math.round((total / maxN) * 100);
            return (
              <div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0">
                <span
                  style="font-family:var(--font-mono);color:var(--text-muted);width:88px"
                >
                  {d.day}
                </span>
                <div
                  style={`flex:1;height:14px;background:var(--bg-tertiary);border-radius:3px;position:relative;overflow:hidden`}
                >
                  <div
                    style={`position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:linear-gradient(90deg,#79c0ff ${d.views / Math.max(1, total) * 100}%,#d2a8ff ${d.views / Math.max(1, total) * 100}%)`}
                  />
                </div>
                <span style="font-family:var(--font-mono);width:56px;text-align:right">
                  {d.views}v / {d.clones}c
                </span>
              </div>
            );
          })
        )}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <h4>Top paths</h4>
          <div class="panel">
            {summary.topPaths.length === 0 ? (
              <div class="panel-empty">No paths recorded.</div>
            ) : (
              summary.topPaths.map((p) => (
                <div class="panel-item" style="justify-content:space-between">
                  <code style="font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">
                    {p.path}
                  </code>
                  <span style="font-family:var(--font-mono);color:var(--text-muted)">
                    {p.n}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div>
          <h4>Top referers</h4>
          <div class="panel">
            {summary.topReferers.length === 0 ? (
              <div class="panel-empty">No external referers.</div>
            ) : (
              summary.topReferers.map((r) => (
                <div class="panel-item" style="justify-content:space-between">
                  <span
                    style="font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block"
                  >
                    {r.referer}
                  </span>
                  <span style="font-family:var(--font-mono);color:var(--text-muted)">
                    {r.n}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
});

export default traffic;

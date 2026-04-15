/**
 * Environments + deployment history UI.
 *
 * Routes:
 *   GET /:owner/:repo/deployments            full deploy history per env
 *   GET /:owner/:repo/deployments/:id        single deployment detail
 *
 * Data comes from the `deployments` table populated by Crontech / gate
 * logic on successful push to the default branch.
 */

import { Hono } from "hono";
import { desc, eq, and } from "drizzle-orm";
import { db } from "../db";
import { deployments, repositories, users } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { softAuth, requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { onDeployFailure } from "../lib/ai-incident";

const dep = new Hono<AuthEnv>();

dep.use("/:owner/:repo/deployments", softAuth);
dep.use("/:owner/:repo/deployments/*", softAuth);

type Row = typeof deployments.$inferSelect & { triggeredByName: string | null };

async function resolveRepo(owner: string, name: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(users.username, owner), eq(repositories.name, name)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

/** Parse "auto-issue #42" from a blockedReason string. Returns null if absent. */
function parseAutoIssueNumber(blockedReason: string | null): number | null {
  if (!blockedReason) return null;
  const m = blockedReason.match(/auto-issue #(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "success":
      return "gate-status passed";
    case "failed":
      return "gate-status failed";
    case "blocked":
      return "gate-status skipped";
    case "running":
    case "pending":
      return "gate-status running";
    default:
      return "gate-status";
  }
}

function fmtTs(t: Date | null | undefined): string {
  if (!t) return "—";
  return new Date(t).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function groupByEnv(rows: Row[]): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const r of rows) {
    (out[r.environment] ||= []).push(r);
  }
  return out;
}

function envSummary(rows: Row[]): { last: Row | undefined; successRate: number } {
  const last = rows[0];
  const recent = rows.slice(0, 20);
  const successes = recent.filter((r) => r.status === "success").length;
  const rate = recent.length ? successes / recent.length : 1;
  return { last, successRate: rate };
}

dep.get("/:owner/:repo/deployments", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const repoRow = await resolveRepo(owner, repo);
  if (!repoRow) return c.notFound();

  let rows: Row[] = [];
  try {
    rows = (await db
      .select({
        id: deployments.id,
        repositoryId: deployments.repositoryId,
        environment: deployments.environment,
        commitSha: deployments.commitSha,
        ref: deployments.ref,
        status: deployments.status,
        blockedReason: deployments.blockedReason,
        target: deployments.target,
        triggeredBy: deployments.triggeredBy,
        createdAt: deployments.createdAt,
        completedAt: deployments.completedAt,
        triggeredByName: users.username,
      })
      .from(deployments)
      .leftJoin(users, eq(users.id, deployments.triggeredBy))
      .where(eq(deployments.repositoryId, repoRow.id))
      .orderBy(desc(deployments.createdAt))
      .limit(500)) as Row[];
  } catch (err) {
    console.error("[deployments] list:", err);
  }

  const envs = groupByEnv(rows);
  const envNames = Object.keys(envs).sort();

  return c.html(
    <Layout title={`${owner}/${repo} — deployments`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <div style="max-width: 1000px">
        <h2>Deployments</h2>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px">
          Every deploy to every environment, newest first. Rolled up by
          environment with the latest status and success rate across the last
          20 runs.
        </p>

        {envNames.length === 0 && (
          <div class="empty-state">
            <h2>No deployments yet</h2>
            <p>
              When a green push reaches the default branch and a deploy
              target is configured, the deploy will show up here.
            </p>
          </div>
        )}

        {envNames.map((env) => {
          const envRows = envs[env];
          const { last, successRate } = envSummary(envRows);
          return (
            <div
              style="border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-secondary); margin-bottom: 16px; overflow: hidden"
            >
              <div
                style="padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; background: var(--bg-tertiary); border-bottom: 1px solid var(--border)"
              >
                <h3 style="margin: 0; font-size: 15px">{env}</h3>
                <div style="display: flex; gap: 12px; align-items: center; font-size: 12px">
                  {last && (
                    <span class={statusBadgeClass(last.status)}>
                      {last.status}
                    </span>
                  )}
                  <span style="color: var(--text-muted)">
                    {Math.round(successRate * 100)}% green · {envRows.length} total
                  </span>
                </div>
              </div>
              <div class="gate-list" style="border: none; border-radius: 0">
                {envRows.slice(0, 10).map((r) => (
                  <div class="gate-run-row">
                    <span class={statusBadgeClass(r.status)}>{r.status}</span>
                    <code
                      style="font-family: var(--font-mono); font-size: 12px"
                    >
                      {r.commitSha.slice(0, 7)}
                    </code>
                    <span style="color: var(--text-muted); font-size: 12px">
                      {r.ref.replace(/^refs\/heads\//, "")}
                    </span>
                    <span style="color: var(--text-muted); font-size: 12px; margin-left: auto">
                      {r.target || "—"}
                    </span>
                    <span style="color: var(--text-muted); font-size: 12px">
                      by {r.triggeredByName || "system"}
                    </span>
                    <span style="color: var(--text-muted); font-size: 12px">
                      {fmtTs(r.createdAt)}
                    </span>
                    <a
                      href={`/${owner}/${repo}/deployments/${r.id}`}
                      style="font-size: 12px"
                    >
                      details
                    </a>
                  </div>
                ))}
                {envRows.length > 10 && (
                  <div class="gate-run-row" style="color: var(--text-muted); font-size: 12px">
                    + {envRows.length - 10} more{"\u2026"}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Layout>
  );
});

dep.get("/:owner/:repo/deployments/:id", async (c) => {
  const { owner, repo, id } = c.req.param();
  const user = c.get("user");
  const repoRow = await resolveRepo(owner, repo);
  if (!repoRow) return c.notFound();

  let row: Row | null = null;
  try {
    const [r] = await db
      .select({
        id: deployments.id,
        repositoryId: deployments.repositoryId,
        environment: deployments.environment,
        commitSha: deployments.commitSha,
        ref: deployments.ref,
        status: deployments.status,
        blockedReason: deployments.blockedReason,
        target: deployments.target,
        triggeredBy: deployments.triggeredBy,
        createdAt: deployments.createdAt,
        completedAt: deployments.completedAt,
        triggeredByName: users.username,
      })
      .from(deployments)
      .leftJoin(users, eq(users.id, deployments.triggeredBy))
      .where(
        and(eq(deployments.id, id), eq(deployments.repositoryId, repoRow.id))
      )
      .limit(1);
    row = (r as Row) || null;
  } catch (err) {
    console.error("[deployments] detail:", err);
  }

  if (!row) return c.notFound();

  return c.html(
    <Layout
      title={`Deploy ${row.commitSha.slice(0, 7)} → ${row.environment}`}
      user={user}
    >
      <RepoHeader owner={owner} repo={repo} />
      <div style="max-width: 700px">
        <div class="breadcrumb">
          <a href={`/${owner}/${repo}/deployments`}>deployments</a>
          <span>/</span>
          <span>{row.id.slice(0, 8)}</span>
        </div>
        <h2>
          <span class={statusBadgeClass(row.status)}>{row.status}</span>{" "}
          <span style="font-family: var(--font-mono); font-size: 16px">
            {row.commitSha.slice(0, 7)}
          </span>{" "}
          <span style="color: var(--text-muted); font-weight: 400">
            &rarr; {row.environment}
          </span>
        </h2>
        <table class="audit-table" style="margin-top: 16px">
          <tbody>
            <tr>
              <th style="width: 140px">Target</th>
              <td>{row.target || "—"}</td>
            </tr>
            <tr>
              <th>Ref</th>
              <td>
                <code>{row.ref}</code>
              </td>
            </tr>
            <tr>
              <th>Commit</th>
              <td>
                <a href={`/${owner}/${repo}/commit/${row.commitSha}`}>
                  <code>{row.commitSha}</code>
                </a>
              </td>
            </tr>
            <tr>
              <th>Triggered by</th>
              <td>{row.triggeredByName || "system"}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{fmtTs(row.createdAt)}</td>
            </tr>
            <tr>
              <th>Completed</th>
              <td>{fmtTs(row.completedAt)}</td>
            </tr>
            {row.blockedReason && (
              <tr>
                <th>Blocked reason</th>
                <td style="color: var(--red)">{row.blockedReason}</td>
              </tr>
            )}
            {(() => {
              const n = parseAutoIssueNumber(row.blockedReason);
              return n !== null ? (
                <tr>
                  <th>Incident issue</th>
                  <td>
                    <a href={`/${owner}/${repo}/issues/${n}`}>#{n}</a>
                  </td>
                </tr>
              ) : null;
            })()}
          </tbody>
        </table>
        {row.status === "failed" && (
          <form
            method="post"
            action={`/${owner}/${repo}/deployments/${row.id}/retry-incident`}
            style="margin-top: 16px"
          >
            <button type="submit" class="btn btn-secondary">
              Re-run incident analysis
            </button>
          </form>
        )}
      </div>
    </Layout>
  );
});

// D4: re-trigger the AI incident responder for a failed deployment. Owner-only.
// Redirects back to the deployment detail page in all cases.
dep.post(
  "/:owner/:repo/deployments/:id/retry-incident",
  requireAuth,
  async (c) => {
    const { owner, repo, id } = c.req.param();
    const user = c.get("user")!;
    const repoRow = await resolveRepo(owner, repo);
    const back = `/${owner}/${repo}/deployments/${id}`;
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(back);
    }
    try {
      const [depRow] = await db
        .select()
        .from(deployments)
        .where(
          and(eq(deployments.id, id), eq(deployments.repositoryId, repoRow.id))
        )
        .limit(1);
      if (!depRow || depRow.status !== "failed") return c.redirect(back);
      await onDeployFailure({
        repositoryId: repoRow.id,
        deploymentId: depRow.id,
        ref: depRow.ref,
        commitSha: depRow.commitSha,
        target: depRow.target,
        errorMessage: depRow.blockedReason,
      });
    } catch (err) {
      console.error("[deployments] retry-incident:", err);
    }
    return c.redirect(back);
  }
);

export default dep;

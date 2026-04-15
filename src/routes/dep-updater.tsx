/**
 * Block D2 — AI dependency updater UI.
 *
 *   GET  /:owner/:repo/settings/dep-updater       — run history + "Run now"
 *   POST /:owner/:repo/settings/dep-updater/run   — kicks off a run (fire & forget)
 *
 * Owner-only. See `src/lib/dep-updater.ts` for the orchestrator.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { depUpdateRuns, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { runDepUpdateRun, type Bump } from "../lib/dep-updater";

const depUpdater = new Hono<AuthEnv>();

depUpdater.use("*", softAuth);

/**
 * Resolve repo row + enforce owner-only access. Returns either a
 * rendered Response (when unauthorised / missing) or `{ repo }`.
 */
async function resolveOwnerRepo(
  c: any,
  ownerName: string,
  repoName: string
): Promise<
  | { kind: "ok"; repo: typeof repositories.$inferSelect }
  | { kind: "response"; res: Response }
> {
  const user = c.get("user");
  if (!user) {
    return {
      kind: "response",
      res: c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`),
    };
  }

  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) return { kind: "response", res: c.notFound() };
    if (owner.id !== user.id) {
      return {
        kind: "response",
        res: c.html(
          <Layout title="Unauthorized" user={user}>
            <div class="empty-state">
              <h2>Unauthorized</h2>
              <p>Only the repository owner can configure the dependency updater.</p>
            </div>
          </Layout>,
          403
        ),
      };
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return { kind: "response", res: c.notFound() };
    return { kind: "ok", repo };
  } catch (err) {
    // DB unreachable — let the global 503 / 500 handler cope.
    return {
      kind: "response",
      res: c.html(
        <Layout title="Error" user={user}>
          <div class="empty-state">
            <h2>Service unavailable</h2>
            <p>The dependency updater is temporarily offline.</p>
          </div>
        </Layout>,
        503
      ),
    };
  }
}

function statusChip(status: string) {
  const colorMap: Record<string, string> = {
    success: "badge-open",
    no_updates: "badge-closed",
    failed: "badge-closed",
    running: "badge-open",
    pending: "badge-closed",
  };
  const cls = colorMap[status] || "badge-closed";
  return <span class={`issue-badge ${cls}`}>{status}</span>;
}

function safeParseBumps(raw: string): Bump[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// GET — run history + "Run now"
depUpdater.get(
  "/:owner/:repo/settings/dep-updater",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if (resolved.kind === "response") return resolved.res;
    const { repo } = resolved;
    const user = c.get("user")!;

    let runs: Array<typeof depUpdateRuns.$inferSelect> = [];
    try {
      runs = await db
        .select()
        .from(depUpdateRuns)
        .where(eq(depUpdateRuns.repositoryId, repo.id))
        .orderBy(desc(depUpdateRuns.createdAt))
        .limit(20);
    } catch {
      runs = [];
    }

    return c.html(
      <Layout title={`Dep Updater — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <IssueNav owner={ownerName} repo={repoName} active="code" />
        <div style="max-width: 900px">
          <h2 style="margin-bottom: 8px">Dependency updater</h2>
          <p style="color: var(--text-muted); margin-bottom: 20px">
            Reads <code>package.json</code> on the default branch, queries the
            npm registry for newer versions, and opens a pull request with the
            bumped dependencies. Runs on-demand from this page; background
            scheduling can be added later.
          </p>

          <form
            method="POST"
            action={`/${ownerName}/${repoName}/settings/dep-updater/run`}
            style="margin-bottom: 24px"
          >
            <button type="submit" class="btn btn-primary">
              Run now
            </button>
          </form>

          <h3 style="margin: 24px 0 8px; font-size: 16px">Recent runs</h3>
          {runs.length === 0 ? (
            <div class="empty-state">
              <p>No runs yet. Click "Run now" to start your first scan.</p>
            </div>
          ) : (
            <div class="issue-list">
              {runs.map((r) => {
                const applied = safeParseBumps(r.appliedBumps);
                const attempted = safeParseBumps(r.attemptedBumps);
                const bumps = applied.length > 0 ? applied : attempted;
                const when = new Date(r.createdAt).toLocaleString();
                return (
                  <div
                    class="issue-row"
                    style="padding: 12px; border-bottom: 1px solid var(--border)"
                  >
                    <div style="display: flex; align-items: center; gap: 8px">
                      {statusChip(r.status)}
                      <span style="color: var(--text-muted); font-size: 13px">
                        {when}
                      </span>
                      {r.prNumber != null && (
                        <a
                          href={`/${ownerName}/${repoName}/pulls/${r.prNumber}`}
                          style="font-size: 13px"
                        >
                          PR #{r.prNumber}
                        </a>
                      )}
                      {r.branchName && (
                        <code style="font-size: 12px; color: var(--text-muted)">
                          {r.branchName}
                        </code>
                      )}
                    </div>
                    {r.errorMessage && (
                      <div
                        style="margin-top: 6px; font-size: 13px; color: var(--red)"
                      >
                        {r.errorMessage}
                      </div>
                    )}
                    {bumps.length > 0 && (
                      <details style="margin-top: 8px">
                        <summary style="cursor: pointer; font-size: 13px">
                          {bumps.length} bump{bumps.length === 1 ? "" : "s"}
                        </summary>
                        <table style="margin-top: 8px; font-size: 13px; width: 100%">
                          <thead>
                            <tr style="text-align: left; color: var(--text-muted)">
                              <th style="padding: 4px 8px">Package</th>
                              <th style="padding: 4px 8px">From</th>
                              <th style="padding: 4px 8px">To</th>
                              <th style="padding: 4px 8px">Kind</th>
                              <th style="padding: 4px 8px">Major?</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bumps.map((b) => (
                              <tr>
                                <td style="padding: 4px 8px">
                                  <code>{b.name}</code>
                                </td>
                                <td style="padding: 4px 8px">{b.from}</td>
                                <td style="padding: 4px 8px">{b.to}</td>
                                <td style="padding: 4px 8px">{b.kind}</td>
                                <td style="padding: 4px 8px">
                                  {b.major ? "yes" : "no"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Layout>
    );
  }
);

// POST — fire and forget
depUpdater.post(
  "/:owner/:repo/settings/dep-updater/run",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if (resolved.kind === "response") return resolved.res;
    const { repo } = resolved;
    const user = c.get("user")!;

    // Fire-and-forget. The run records its own failures to `dep_update_runs`.
    runDepUpdateRun({
      repositoryId: repo.id,
      owner: ownerName,
      repo: repoName,
      userId: user.id,
    }).catch((err) => {
      console.error("[dep-updater] run failed:", err);
    });

    return c.redirect(`/${ownerName}/${repoName}/settings/dep-updater`);
  }
);

export default depUpdater;

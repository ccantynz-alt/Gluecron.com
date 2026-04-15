/**
 * Actions-equivalent workflow UI (Block C1).
 *
 *   GET  /:owner/:repo/actions                       — workflows + recent runs
 *   GET  /:owner/:repo/actions/runs/:runId           — run detail + job logs
 *   POST /:owner/:repo/actions/:workflowId/run       — manual trigger (auth)
 *   POST /:owner/:repo/actions/runs/:runId/cancel    — cancel a running run (auth)
 *
 * Render philosophy: keep the view shallow — the real execution happens in
 * the runner (src/lib/workflow-runner.ts). This file is just navigation +
 * manual triggers. Logs for each job are displayed inline (v1 has no
 * streaming; workers write the final logs blob to the row).
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  users,
  workflowJobs,
  workflowRuns,
  workflows,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getUnreadCount } from "../lib/unread";
import { audit } from "../lib/notify";
import { enqueueRun } from "../lib/workflow-runner";

const actions = new Hono<AuthEnv>();
actions.use("*", softAuth);

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

function relTime(d: Date | string | null): string {
  if (!d) return "—";
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

function durationMs(start: Date | string | null, end: Date | string | null): string {
  if (!start) return "";
  const s = typeof start === "string" ? new Date(start) : start;
  const e = end ? (typeof end === "string" ? new Date(end) : end) : new Date();
  const ms = e.getTime() - s.getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s2 = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s2}s`;
}

function statusColor(status: string, conclusion: string | null): string {
  if (status === "running") return "var(--yellow, #e3b341)";
  if (status === "queued") return "var(--text-muted)";
  if (status === "cancelled") return "var(--text-muted)";
  const concl = conclusion || status;
  if (concl === "success") return "var(--green)";
  if (concl === "failure") return "var(--red)";
  return "var(--text-muted)";
}

function statusGlyph(status: string, conclusion: string | null): string {
  if (status === "running") return "\u25D0"; // half-circle
  if (status === "queued") return "\u25CB"; // hollow circle
  if (status === "cancelled") return "\u2715"; // x
  const concl = conclusion || status;
  if (concl === "success") return "\u2713"; // check
  if (concl === "failure") return "\u2717"; // heavy x
  if (concl === "skipped") return "\u2013"; // en dash
  return "\u25CF";
}

// ---------- List workflows + recent runs ----------

actions.get("/:owner/:repo/actions", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  let wfs: (typeof workflows.$inferSelect)[] = [];
  let runs: (typeof workflowRuns.$inferSelect & { workflowName: string | null })[] =
    [];
  try {
    wfs = await db
      .select()
      .from(workflows)
      .where(eq(workflows.repositoryId, repoRow.id))
      .orderBy(desc(workflows.updatedAt));

    const joined = await db
      .select({
        id: workflowRuns.id,
        workflowId: workflowRuns.workflowId,
        repositoryId: workflowRuns.repositoryId,
        runNumber: workflowRuns.runNumber,
        event: workflowRuns.event,
        ref: workflowRuns.ref,
        commitSha: workflowRuns.commitSha,
        triggeredBy: workflowRuns.triggeredBy,
        status: workflowRuns.status,
        conclusion: workflowRuns.conclusion,
        queuedAt: workflowRuns.queuedAt,
        startedAt: workflowRuns.startedAt,
        finishedAt: workflowRuns.finishedAt,
        createdAt: workflowRuns.createdAt,
        workflowName: workflows.name,
      })
      .from(workflowRuns)
      .leftJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .where(eq(workflowRuns.repositoryId, repoRow.id))
      .orderBy(desc(workflowRuns.queuedAt))
      .limit(50);
    runs = joined as typeof runs;
  } catch (err) {
    console.error("[actions] list:", err);
  }

  const unread = user ? await getUnreadCount(user.id) : 0;
  const canRun = !!user && user.id === repoRow.ownerId;

  return c.html(
    <Layout
      title={`Actions — ${owner}/${repo}`}
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
      <RepoNav owner={owner} repo={repo} active="actions" />

      <div style="display: grid; grid-template-columns: 280px 1fr; gap: 20px">
        <aside>
          <h4 style="margin: 0 0 12px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
            Workflows
          </h4>
          {wfs.length === 0 ? (
            <div class="panel" style="padding: 12px; font-size: 12px; color: var(--text-muted)">
              No workflows yet. Add a YAML file under
              {" "}
              <code>.gluecron/workflows/</code> on your default branch.
            </div>
          ) : (
            <div class="panel" style="overflow: hidden">
              {wfs.map((w) => (
                <div
                  style={`padding: 10px 12px; border-bottom: 1px solid var(--border); ${w.disabled ? "opacity: 0.5" : ""}`}
                >
                  <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px">
                    <div style="flex: 1; min-width: 0">
                      <div style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                        {w.name}
                      </div>
                      <div style="font-size: 11px; color: var(--text-muted); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                        {w.path}
                      </div>
                    </div>
                    {canRun && !w.disabled && (
                      <form
                        method="POST"
                        action={`/${owner}/${repo}/actions/${w.id}/run`}
                        style="margin: 0"
                      >
                        <button type="submit" class="btn btn-sm" title="Trigger manual run">
                          Run
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section>
          <h4 style="margin: 0 0 12px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
            Recent runs
          </h4>
          {runs.length === 0 ? (
            <div class="empty-state">
              <p>No workflow runs yet. Push a commit or trigger one manually.</p>
            </div>
          ) : (
            <div class="panel" style="overflow: hidden">
              {runs.map((r) => (
                <a
                  href={`/${owner}/${repo}/actions/runs/${r.id}`}
                  style="display: flex; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border); text-decoration: none; color: inherit"
                >
                  <span
                    style={`display: inline-block; min-width: 18px; text-align: center; color: ${statusColor(r.status, r.conclusion)}; font-weight: 700`}
                    title={r.conclusion || r.status}
                  >
                    {statusGlyph(r.status, r.conclusion)}
                  </span>
                  <div style="flex: 1; min-width: 0">
                    <div style="font-weight: 500">
                      {r.workflowName || "(workflow deleted)"}
                      {" "}
                      <span style="color: var(--text-muted); font-weight: 400">
                        #{r.runNumber}
                      </span>
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
                      <span>{r.event}</span>
                      {r.ref && (
                        <>
                          {" · "}
                          <span>{r.ref.replace(/^refs\/heads\//, "")}</span>
                        </>
                      )}
                      {r.commitSha && (
                        <>
                          {" · "}
                          <code>{r.commitSha.slice(0, 7)}</code>
                        </>
                      )}
                      {" · "}
                      <span>{relTime(r.queuedAt)}</span>
                      {r.startedAt && r.finishedAt && (
                        <>
                          {" · "}
                          <span>{durationMs(r.startedAt, r.finishedAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </section>
      </div>
    </Layout>
  );
});

// ---------- Run detail ----------

actions.get("/:owner/:repo/actions/runs/:runId", async (c) => {
  const user = c.get("user");
  const { owner, repo, runId } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  let run: typeof workflowRuns.$inferSelect | null = null;
  let workflowRow: typeof workflows.$inferSelect | null = null;
  let jobs: (typeof workflowJobs.$inferSelect)[] = [];
  try {
    const [r] = await db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.repositoryId, repoRow.id)
        )
      )
      .limit(1);
    run = r || null;
    if (run) {
      const [w] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, run.workflowId))
        .limit(1);
      workflowRow = w || null;
      jobs = await db
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.runId, run.id))
        .orderBy(workflowJobs.jobOrder);
    }
  } catch (err) {
    console.error("[actions] run detail:", err);
  }

  if (!run) return c.notFound();

  const unread = user ? await getUnreadCount(user.id) : 0;
  const canCancel =
    !!user &&
    user.id === repoRow.ownerId &&
    (run.status === "queued" || run.status === "running");

  return c.html(
    <Layout
      title={`Run #${run.runNumber} — ${owner}/${repo}`}
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
      <RepoNav owner={owner} repo={repo} active="actions" />

      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 16px; gap: 12px">
        <div>
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px">
            <a href={`/${owner}/${repo}/actions`}>Actions</a>
          </div>
          <h3 style="margin: 0">
            <span
              style={`color: ${statusColor(run.status, run.conclusion)}; margin-right: 6px`}
            >
              {statusGlyph(run.status, run.conclusion)}
            </span>
            {workflowRow?.name || "(deleted workflow)"}
            {" "}
            <span style="color: var(--text-muted); font-weight: 400">
              #{run.runNumber}
            </span>
          </h3>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px">
            <span>{run.event}</span>
            {run.ref && (
              <>
                {" · "}
                <span>{run.ref.replace(/^refs\/heads\//, "")}</span>
              </>
            )}
            {run.commitSha && (
              <>
                {" · "}
                <a href={`/${owner}/${repo}/commit/${run.commitSha}`}>
                  <code>{run.commitSha.slice(0, 7)}</code>
                </a>
              </>
            )}
            {" · queued "}
            <span>{relTime(run.queuedAt)}</span>
            {run.startedAt && run.finishedAt && (
              <>
                {" · duration "}
                <span>{durationMs(run.startedAt, run.finishedAt)}</span>
              </>
            )}
          </div>
        </div>
        {canCancel && (
          <form
            method="POST"
            action={`/${owner}/${repo}/actions/runs/${run.id}/cancel`}
            onsubmit="return confirm('Cancel this run?')"
          >
            <button type="submit" class="btn btn-sm btn-danger">
              Cancel
            </button>
          </form>
        )}
      </div>

      {jobs.length === 0 ? (
        <div class="empty-state">
          <p>
            {run.status === "queued"
              ? "Queued — jobs will appear once the runner picks this up."
              : "No jobs recorded for this run."}
          </p>
        </div>
      ) : (
        <div>
          {jobs.map((j) => {
            let steps: Array<{
              name?: string;
              run?: string;
              status?: string;
              exitCode?: number | null;
              durationMs?: number;
              stdout?: string;
              stderr?: string;
            }> = [];
            try {
              steps = JSON.parse(j.steps || "[]");
            } catch {
              steps = [];
            }
            return (
              <details class="panel" style="margin-bottom: 16px; overflow: hidden" open>
                <summary
                  style="padding: 10px 14px; cursor: pointer; display: flex; gap: 10px; align-items: center; background: var(--bg-tertiary)"
                >
                  <span
                    style={`color: ${statusColor(j.status, j.conclusion)}; font-weight: 700`}
                  >
                    {statusGlyph(j.status, j.conclusion)}
                  </span>
                  <span style="flex: 1; font-weight: 500">{j.name}</span>
                  <span style="font-size: 12px; color: var(--text-muted)">
                    {j.startedAt && j.finishedAt
                      ? durationMs(j.startedAt, j.finishedAt)
                      : j.status}
                  </span>
                </summary>
                {steps.length > 0 && (
                  <div style="padding: 8px 14px; border-top: 1px solid var(--border)">
                    {steps.map((s, i) => (
                      <div
                        style="padding: 6px 0; border-bottom: 1px solid var(--border); display: flex; gap: 10px; font-size: 13px"
                      >
                        <span
                          style={`color: ${statusColor(s.status || "", null)}; font-weight: 700; min-width: 18px`}
                        >
                          {statusGlyph(s.status || "", null)}
                        </span>
                        <div style="flex: 1; min-width: 0">
                          <div style="font-weight: 500">
                            {s.name || `Step ${i + 1}`}
                          </div>
                          {s.run && (
                            <code
                              style="display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
                            >
                              $ {s.run}
                            </code>
                          )}
                        </div>
                        {typeof s.durationMs === "number" && (
                          <span style="font-size: 11px; color: var(--text-muted)">
                            {s.durationMs < 1000
                              ? `${s.durationMs}ms`
                              : `${(s.durationMs / 1000).toFixed(1)}s`}
                          </span>
                        )}
                        {typeof s.exitCode === "number" && s.exitCode !== 0 && (
                          <span style="font-size: 11px; color: var(--red)">
                            exit {s.exitCode}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {j.logs && j.logs.length > 0 && (
                  <pre
                    style="margin: 0; padding: 12px 14px; background: #0b0d0f; color: #c7ccd1; font-size: 12px; line-height: 1.45; overflow-x: auto; max-height: 480px; border-top: 1px solid var(--border)"
                  >
                    {j.logs}
                  </pre>
                )}
              </details>
            );
          })}
        </div>
      )}
    </Layout>
  );
});

// ---------- Manual trigger ----------

actions.post("/:owner/:repo/actions/:workflowId/run", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, workflowId } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}/actions`);
  }

  let workflowRow: typeof workflows.$inferSelect | null = null;
  try {
    const [w] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.repositoryId, repoRow.id)
        )
      )
      .limit(1);
    workflowRow = w || null;
  } catch (err) {
    console.error("[actions] manual trigger lookup:", err);
  }
  if (!workflowRow) return c.notFound();
  if (workflowRow.disabled) {
    return c.redirect(`/${owner}/${repo}/actions`);
  }

  const ref = `refs/heads/${repoRow.defaultBranch || "main"}`;

  const runId = await enqueueRun({
    workflowId: workflowRow.id,
    repositoryId: repoRow.id,
    event: "manual",
    ref,
    commitSha: null,
    triggeredBy: user.id,
  });

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "workflow.manual_trigger",
    targetType: "workflow",
    targetId: workflowRow.id,
    metadata: { runId },
  });

  if (runId) {
    return c.redirect(`/${owner}/${repo}/actions/runs/${runId}`);
  }
  return c.redirect(`/${owner}/${repo}/actions`);
});

// ---------- Cancel a run ----------

actions.post(
  "/:owner/:repo/actions/runs/:runId/cancel",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, runId } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/actions`);
    }

    try {
      await db
        .update(workflowRuns)
        .set({
          status: "cancelled",
          conclusion: "cancelled",
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(workflowRuns.id, runId),
            eq(workflowRuns.repositoryId, repoRow.id)
          )
        );
      // Mark any queued/running jobs as cancelled for display. The worker
      // will observe the parent run's status on its next check, but v1 runs
      // a step to completion before checking.
      await db
        .update(workflowJobs)
        .set({
          status: "cancelled",
          conclusion: "cancelled",
          finishedAt: new Date(),
        })
        .where(eq(workflowJobs.runId, runId));
    } catch (err) {
      console.error("[actions] cancel:", err);
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "workflow.cancel",
      targetType: "workflow_run",
      targetId: runId,
    });

    return c.redirect(`/${owner}/${repo}/actions/runs/${runId}`);
  }
);

export default actions;

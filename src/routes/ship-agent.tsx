/**
 * Ship Agent routes — autonomous AI feature implementation.
 *
 * POST /:owner/:repo/issues/:issueNumber/ship          — start a job
 * GET  /:owner/:repo/issues/:issueNumber/ship/:jobId   — progress page
 * GET  /:owner/:repo/issues/:issueNumber/ship/:jobId/status — JSON status
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { issues, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import type { AuthEnv } from "../middleware/auth";
import { startShipJob, getShipJob } from "../lib/ship-agent";
import { isAiAvailable } from "../lib/ai-client";

const shipAgentRoutes = new Hono<AuthEnv>();

// ─── Styles ──────────────────────────────────────────────────────────────────

const shipStyles = `
  .ship-hero {
    position: relative;
    margin: 4px 0 24px;
    padding: 28px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ship-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ship-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 700;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .ship-subtitle {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .ship-phases {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin: 20px 0;
  }
  .ship-phase {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 9999px;
    font-size: 12.5px;
    font-weight: 600;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-muted);
    transition: all 120ms ease;
  }
  .ship-phase.is-active {
    background: rgba(140,109,255,0.14);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
  }
  .ship-phase.is-done {
    background: rgba(52,211,153,0.1);
    border-color: rgba(52,211,153,0.35);
    color: #34d399;
  }
  .ship-phase.is-failed {
    background: rgba(248,113,113,0.1);
    border-color: rgba(248,113,113,0.35);
    color: #f87171;
  }
  .ship-log {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.7;
    color: var(--text-muted);
    max-height: 400px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .ship-log-entry { display: block; }
  .ship-log-entry.is-error { color: #f87171; }
  .ship-log-entry.is-done { color: #34d399; }
  .ship-result {
    margin-top: 18px;
    padding: 14px 18px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.55;
  }
  .ship-result.is-done {
    background: rgba(52,211,153,0.08);
    border: 1px solid rgba(52,211,153,0.3);
    color: var(--text);
  }
  .ship-result.is-failed {
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.3);
    color: var(--text);
  }
  .ship-pr-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    padding: 8px 16px;
    border-radius: 8px;
    background: rgba(140,109,255,0.14);
    border: 1px solid rgba(140,109,255,0.35);
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    font-size: 13.5px;
    transition: background 120ms;
  }
  .ship-pr-link:hover { background: rgba(140,109,255,0.22); text-decoration: none; }
`;

const PHASES: Array<{ key: string; label: string }> = [
  { key: "planning", label: "Planning" },
  { key: "reading", label: "Reading" },
  { key: "coding", label: "Coding" },
  { key: "committing", label: "Committing" },
  { key: "opening-pr", label: "Opening PR" },
  { key: "done", label: "Done" },
];

const PHASE_ORDER: Record<string, number> = {
  planning: 0,
  reading: 1,
  coding: 2,
  committing: 3,
  "opening-pr": 4,
  done: 5,
  failed: 6,
};

// ─── Helper ──────────────────────────────────────────────────────────────────

async function resolveIssue(ownerName: string, repoName: string, issueNum: number) {
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return null;

  const [repo] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName)))
    .limit(1);
  if (!repo) return null;

  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.repositoryId, repo.id), eq(issues.number, issueNum)))
    .limit(1);
  if (!issue) return null;

  return { owner, repo, issue };
}

// ─── POST — start ship job ────────────────────────────────────────────────────

shipAgentRoutes.post(
  "/:owner/:repo/issues/:issueNumber/ship",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    if (!isAiAvailable()) {
      return c.html(
        <Layout title="Ship Agent unavailable" user={c.get("user")}>
          <style dangerouslySetInnerHTML={{ __html: shipStyles }} />
          <div class="ship-hero">
            <h1 class="ship-title">Ship Agent unavailable</h1>
            <p class="ship-subtitle">
              ANTHROPIC_API_KEY is not configured. Ship Agent requires AI to function.
            </p>
          </div>
        </Layout>,
        503
      );
    }

    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("issueNumber"), 10);
    const user = c.get("user")!;

    const resolved = await resolveIssue(ownerName, repoName, issueNum);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div style="padding:40px;text-align:center;color:var(--text-muted)">Issue not found.</div>
        </Layout>,
        404
      );
    }

    let jobId: string;
    try {
      jobId = await startShipJob({
        issueId: resolved.issue.id,
        repoId: resolved.repo.id,
        owner: ownerName,
        repo: repoName,
        issueNumber: issueNum,
        issueTitle: resolved.issue.title,
        issueBody: resolved.issue.body || "",
        requestedByUserId: user.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}?info=${encodeURIComponent(`Ship Agent: ${msg}`)}`
      );
    }

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issueNum}/ship/${jobId}`
    );
  }
);

// ─── GET — progress page ─────────────────────────────────────────────────────

shipAgentRoutes.get(
  "/:owner/:repo/issues/:issueNumber/ship/:jobId",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const jobId = c.req.param("jobId");
    const user = c.get("user");

    const job = getShipJob(jobId);
    if (!job) {
      return c.html(
        <Layout title="Job not found" user={user}>
          <div style="padding:40px;text-align:center;color:var(--text-muted)">
            Ship Agent job not found. It may have been cleaned up after a server restart.
          </div>
        </Layout>,
        404
      );
    }

    const issueNum = job.issueNumber;
    const isTerminal = job.status === "done" || job.status === "failed";
    const currentPhaseIdx = PHASE_ORDER[job.status] ?? 0;

    return c.html(
      <Layout
        title={`Ship Agent — ${job.issueTitle}`}
        user={user}
      >
        <style dangerouslySetInnerHTML={{ __html: shipStyles }} />

        <div class="ship-hero">
          <h1 class="ship-title">
            AI is shipping:{" "}
            <span style="color:var(--accent)">{job.issueTitle}</span>
          </h1>
          <p class="ship-subtitle">
            Issue #{issueNum} &middot; {ownerName}/{repoName} &middot;{" "}
            <a href={`/${ownerName}/${repoName}/issues/${issueNum}`}>
              Back to issue
            </a>
          </p>
        </div>

        {/* Phase progress pills */}
        <div class="ship-phases">
          {PHASES.map((phase) => {
            const phaseIdx = PHASE_ORDER[phase.key];
            const isCurrent = phase.key === job.status;
            const isDone = phaseIdx < currentPhaseIdx && job.status !== "failed";
            const isFailed = job.status === "failed" && phase.key === "done";
            let cls = "ship-phase";
            if (isDone) cls += " is-done";
            else if (isCurrent) cls += " is-active";
            else if (isFailed) cls += " is-failed";
            return (
              <span class={cls}>
                {isDone ? "✓ " : isCurrent ? "⟳ " : ""}
                {phase.label}
              </span>
            );
          })}
        </div>

        {/* Live log */}
        <div class="ship-log" id="ship-log">
          {job.log.length === 0 ? (
            <span class="ship-log-entry">Initialising…</span>
          ) : (
            job.log.map((entry) => (
              <span
                class={`ship-log-entry${entry.includes("FAILED") ? " is-error" : ""}`}
              >
                {entry}
              </span>
            ))
          )}
        </div>

        {/* Result block */}
        {job.status === "done" && job.prNumber && (
          <div class="ship-result is-done">
            <strong>Ship Agent completed!</strong> Changes are in PR #{job.prNumber} and ready for review.
            <br />
            <a href={`/${ownerName}/${repoName}/pulls/${job.prNumber}`} class="ship-pr-link">
              View PR #{job.prNumber}
            </a>
          </div>
        )}
        {job.status === "failed" && (
          <div class="ship-result is-failed">
            <strong>Ship Agent failed.</strong>{" "}
            {job.error}
            <br />
            <form method="post" action={`/${ownerName}/${repoName}/issues/${issueNum}/ship`} style="display:inline">
              <button type="submit" class="btn btn-primary" style="margin-top:10px">
                Try again
              </button>
            </form>
          </div>
        )}

        {/* Polling script — auto-refreshes every 3s while job is running */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
(function() {
  var logEl = document.getElementById('ship-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
  ${!isTerminal ? `setTimeout(function(){ window.location.reload(); }, 3000);` : ""}
})();
`,
          }}
        />
      </Layout>
    );
  }
);

// ─── GET — JSON status endpoint ────────────────────────────────────────────────

shipAgentRoutes.get(
  "/:owner/:repo/issues/:issueNumber/ship/:jobId/status",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const jobId = c.req.param("jobId");
    const job = getShipJob(jobId);
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }
    return c.json({
      id: job.id,
      status: job.status,
      plan: job.plan,
      branchName: job.branchName,
      prNumber: job.prNumber,
      prUrl: job.prUrl,
      log: job.log,
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    });
  }
);

export default shipAgentRoutes;

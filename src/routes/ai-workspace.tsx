/**
 * AI Copilot Workspace routes.
 *
 * GET  /:owner/:repo/issues/:number/workspace        — status page
 * POST /:owner/:repo/issues/:number/workspace/start  — start job
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { issues, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import type { AuthEnv } from "../middleware/auth";
import {
  startWorkspace,
  getWorkspaceJobForIssue,
  type WorkspaceJob,
  type WorkspaceStatus,
} from "../lib/ai-workspace";
import { isAiAvailable } from "../lib/ai-client";

export const workspaceRoutes = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wsStyles = `
  .ws-hero {
    position: relative;
    margin: 4px 0 24px;
    padding: 28px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ws-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ws-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 700;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .ws-subtitle {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .ws-stepper {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 28px 0;
  }
  .ws-step {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 0;
    border-left: 2px solid var(--border);
    padding-left: 20px;
    position: relative;
  }
  .ws-step:last-child {
    border-left: 2px solid transparent;
  }
  .ws-step-dot {
    position: absolute;
    left: -7px;
    top: 18px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--border);
    border: 2px solid var(--bg);
    flex-shrink: 0;
    transition: background 200ms;
  }
  .ws-step.is-done .ws-step-dot {
    background: #34d399;
  }
  .ws-step.is-active .ws-step-dot {
    background: #8c6dff;
    box-shadow: 0 0 0 4px rgba(140,109,255,0.22);
    animation: ws-pulse 1.4s ease-in-out infinite;
  }
  .ws-step.is-failed .ws-step-dot {
    background: #f87171;
  }
  @keyframes ws-pulse {
    0%, 100% { box-shadow: 0 0 0 4px rgba(140,109,255,0.22); }
    50% { box-shadow: 0 0 0 7px rgba(140,109,255,0.10); }
  }
  .ws-step-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    line-height: 1.4;
    padding-top: 1px;
  }
  .ws-step.is-done .ws-step-label { color: #34d399; }
  .ws-step.is-active .ws-step-label { color: var(--text-strong); }
  .ws-step.is-failed .ws-step-label { color: #f87171; }
  .ws-step-desc {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .ws-result {
    margin-top: 18px;
    padding: 16px 20px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.55;
  }
  .ws-result.is-done {
    background: rgba(52,211,153,0.08);
    border: 1px solid rgba(52,211,153,0.3);
    color: var(--text);
  }
  .ws-result.is-failed {
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.3);
    color: var(--text);
  }
  .ws-pr-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    padding: 9px 18px;
    border-radius: 8px;
    background: rgba(140,109,255,0.14);
    border: 1px solid rgba(140,109,255,0.35);
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    font-size: 13.5px;
    transition: background 120ms;
  }
  .ws-pr-link:hover { background: rgba(140,109,255,0.22); text-decoration: none; }
  .ws-start-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 22px;
    border-radius: 8px;
    background: rgba(140,109,255,0.14);
    border: 1px solid rgba(140,109,255,0.35);
    color: var(--accent);
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    transition: background 120ms;
  }
  .ws-start-btn:hover { background: rgba(140,109,255,0.22); }
  .ws-explain {
    margin-top: 18px;
    padding: 14px 18px;
    border-radius: 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.6;
  }
  .ws-explain ul {
    margin: 8px 0 0 18px;
    padding: 0;
  }
  .ws-explain li { margin: 4px 0; }
  .ws-back-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
    margin-bottom: 18px;
  }
  .ws-back-link:hover { color: var(--text); text-decoration: none; }
  .ws-badge {
    display: inline-block;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .ws-badge-active {
    background: rgba(140,109,255,0.15);
    color: #a78bfa;
    border: 1px solid rgba(140,109,255,0.3);
  }
  .ws-badge-done {
    background: rgba(52,211,153,0.12);
    color: #34d399;
    border: 1px solid rgba(52,211,153,0.3);
  }
  .ws-badge-failed {
    background: rgba(248,113,113,0.12);
    color: #f87171;
    border: 1px solid rgba(248,113,113,0.3);
  }
`;

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

const STEPS: Array<{ key: WorkspaceStatus; label: string; desc: string }> = [
  { key: "planning",       label: "Planning",       desc: "Reading the issue, exploring the codebase, generating a plan" },
  { key: "implementing",   label: "Implementing",   desc: "Creating a branch and applying file changes" },
  { key: "opening_pr",     label: "Opening PR",     desc: "Pushing the branch and opening a draft pull request" },
  { key: "done",           label: "Done",           desc: "PR is open and ready for review" },
];

const STATUS_ORDER: Record<WorkspaceStatus, number> = {
  pending: -1,
  planning: 0,
  implementing: 1,
  opening_pr: 2,
  done: 3,
  failed: -2,
};

function stepClass(stepStatus: WorkspaceStatus, currentStatus: WorkspaceStatus): string {
  if (currentStatus === "failed") {
    // All steps pending or last attempted step shows as failed — just show neutral
    return "";
  }
  const stepOrder = STATUS_ORDER[stepStatus];
  const curOrder = STATUS_ORDER[currentStatus];
  if (stepOrder < curOrder) return "is-done";
  if (stepOrder === curOrder) return "is-active";
  return "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveIssueAndRepo(
  ownerName: string,
  repoName: string,
  issueNum: number
) {
  const [ownerRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!ownerRow) return null;

  const [repoRow] = await db
    .select({ id: repositories.id, name: repositories.name, isPrivate: repositories.isPrivate })
    .from(repositories)
    .where(and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repoName)))
    .limit(1);
  if (!repoRow) return null;

  const [issueRow] = await db
    .select({ id: issues.id, number: issues.number, title: issues.title, state: issues.state })
    .from(issues)
    .where(and(eq(issues.repositoryId, repoRow.id), eq(issues.number, issueNum)))
    .limit(1);
  if (!issueRow) return null;

  return { owner: ownerRow, repo: repoRow, issue: issueRow };
}

// ---------------------------------------------------------------------------
// WorkspaceStatusPage JSX component
// ---------------------------------------------------------------------------

function WorkspaceStatusPage({
  owner,
  repoName,
  issue,
  job,
  user,
}: {
  owner: string;
  repoName: string;
  issue: { number: number; title: string };
  job: WorkspaceJob | undefined;
  user: { username: string } | null | undefined;
}) {
  const isActive =
    job &&
    ["pending", "planning", "implementing", "opening_pr"].includes(job.status);
  const isDone = job?.status === "done";
  const isFailed = job?.status === "failed";
  const hasJob = !!job;

  const issueUrl = `/${owner}/${repoName}/issues/${issue.number}`;
  const prUrl = isDone && job.prNumber
    ? `/${owner}/${repoName}/pulls/${job.prNumber}`
    : null;
  const branchUrl = job?.branchName
    ? `/${owner}/${repoName}/tree/${job.branchName}`
    : null;

  return (
    <Layout title={`AI Workspace — #${issue.number}`} user={user as any}>
      {isActive && (
        <meta http-equiv="refresh" content="3" />
      )}
      <style dangerouslySetInnerHTML={{ __html: wsStyles }} />
      <div style="max-width:800px;margin:0 auto;padding:24px 16px">
        <a href={issueUrl} class="ws-back-link">
          &larr; #{issue.number}: {issue.title}
        </a>

        <div class="ws-hero">
          <h1 class="ws-title">
            AI Copilot Workspace
            {isActive && (
              <span class="ws-badge ws-badge-active" style="margin-left:12px;vertical-align:middle">
                Running
              </span>
            )}
            {isDone && (
              <span class="ws-badge ws-badge-done" style="margin-left:12px;vertical-align:middle">
                Done
              </span>
            )}
            {isFailed && (
              <span class="ws-badge ws-badge-failed" style="margin-left:12px;vertical-align:middle">
                Failed
              </span>
            )}
          </h1>
          <p class="ws-subtitle">
            Autonomous issue-to-PR agent — reads the issue, explores the codebase,
            proposes a plan, then opens a draft pull request.
          </p>
        </div>

        {/* If no job, show Start button */}
        {!hasJob && (
          <div>
            <form method="post" action={`/${owner}/${repoName}/issues/${issue.number}/workspace/start`}>
              <button type="submit" class="ws-start-btn">
                Start Workspace
              </button>
            </form>
            <div class="ws-explain">
              <strong>What Gluecron will do:</strong>
              <ul>
                <li>Read issue #{issue.number} and recent comments to understand the task</li>
                <li>Explore the codebase — file tree + most relevant files (Claude-selected)</li>
                <li>Generate an implementation plan and post it as an issue comment</li>
                <li>Create a branch, implement the changes file-by-file</li>
                <li>Open a draft PR linked to this issue</li>
              </ul>
              <p style="margin:12px 0 0">
                This usually takes 60–180 seconds depending on codebase size.
                The page auto-refreshes while running.
              </p>
            </div>
          </div>
        )}

        {/* Stepper — shown when a job exists */}
        {hasJob && (
          <div>
            <div class="ws-stepper">
              {STEPS.map((step) => {
                const cls = isFailed
                  ? ""
                  : stepClass(step.key, job!.status);
                return (
                  <div class={`ws-step ${cls}`}>
                    <div class="ws-step-dot" />
                    <div>
                      <div class="ws-step-label">{step.label}</div>
                      <div class="ws-step-desc">{step.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Done state */}
            {isDone && prUrl && (
              <div class="ws-result is-done">
                <strong>Workspace complete!</strong> A draft PR has been opened.
                <br />
                {job.planComment && (
                  <p style="margin-top:8px;font-size:13px;color:var(--text-muted)">
                    An implementation plan was posted as a comment on the issue.
                  </p>
                )}
                <a href={prUrl} class="ws-pr-link">
                  View Draft PR #{job.prNumber}
                </a>
                {branchUrl && (
                  <>
                    {" "}
                    <a href={branchUrl} class="ws-pr-link" style="margin-left:8px">
                      Browse Branch
                    </a>
                  </>
                )}
              </div>
            )}

            {/* Failed state */}
            {isFailed && (
              <div class="ws-result is-failed">
                <strong>Workspace failed.</strong>
                {job.errorMessage && (
                  <p style="margin:8px 0 0;font-family:var(--font-mono);font-size:12px;word-break:break-all">
                    {job.errorMessage}
                  </p>
                )}
                <form
                  method="post"
                  action={`/${owner}/${repoName}/issues/${issue.number}/workspace/start`}
                  style="margin-top:14px"
                >
                  <button type="submit" class="ws-start-btn">
                    Retry Workspace
                  </button>
                </form>
              </div>
            )}

            {/* Active state hint */}
            {isActive && (
              <p style="font-size:13px;color:var(--text-muted);margin-top:12px">
                This page refreshes every 3 seconds. You can leave and come back.
              </p>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// GET /:owner/:repo/issues/:number/workspace
// ---------------------------------------------------------------------------

workspaceRoutes.get(
  "/:owner/:repo/issues/:number/workspace",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user");

    const resolved = await resolveIssueAndRepo(owner, repo, issueNum);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div style="padding:40px;text-align:center;color:var(--text-muted)">Issue not found.</div>
        </Layout>,
        404
      );
    }

    const job = getWorkspaceJobForIssue(resolved.issue.id);

    return c.html(
      <WorkspaceStatusPage
        owner={owner}
        repoName={repo}
        issue={{ number: resolved.issue.number, title: resolved.issue.title }}
        job={job}
        user={user}
      />
    );
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/issues/:number/workspace/start
// ---------------------------------------------------------------------------

workspaceRoutes.post(
  "/:owner/:repo/issues/:number/workspace/start",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;

    if (!isAiAvailable()) {
      return c.html(
        <Layout title="AI unavailable" user={user}>
          <div style="padding:40px;text-align:center;color:var(--text-muted)">
            ANTHROPIC_API_KEY is not configured. AI Workspace requires the AI features to be enabled.
          </div>
        </Layout>,
        503
      );
    }

    const resolved = await resolveIssueAndRepo(owner, repo, issueNum);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div style="padding:40px;text-align:center;color:var(--text-muted)">Issue not found.</div>
        </Layout>,
        404
      );
    }

    await startWorkspace(
      resolved.issue.id,
      resolved.issue.number,
      resolved.repo.id,
      owner,
      repo,
      user.id
    );

    return c.redirect(`/${owner}/${repo}/issues/${issueNum}/workspace`);
  }
);

export default workspaceRoutes;

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
 *
 * Visual polish (2026): adopts the gradient-hairline + orb pattern from
 * admin-integrations / error-page. Page-level CSS is scoped under `.wf-*`
 * so it can't bleed into the layout. RepoHeader + RepoNav are untouched.
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
import { LogTail } from "../views/log-tail";
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
  if (status === "running") return "◐"; // half-circle
  if (status === "queued") return "○"; // hollow circle
  if (status === "cancelled") return "✕"; // x
  const concl = conclusion || status;
  if (concl === "success") return "✓"; // check
  if (concl === "failure") return "✗"; // heavy x
  if (concl === "skipped") return "–"; // en dash
  return "●";
}

function statusPillClass(status: string, conclusion: string | null): string {
  if (status === "running") return "wf-pill is-running";
  if (status === "queued") return "wf-pill is-queued";
  if (status === "cancelled") return "wf-pill is-cancelled";
  const concl = conclusion || status;
  if (concl === "success") return "wf-pill is-success";
  if (concl === "failure") return "wf-pill is-failure";
  if (concl === "skipped") return "wf-pill is-skipped";
  return "wf-pill";
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.wf-*` so this surface can't bleed
 * into other pages. Mirrors the gradient hairline + orb language from
 * admin-integrations and error-page.
 * ───────────────────────────────────────────────────────────────────── */
const wfStyles = `
  .wf-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .wf-head {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .wf-head::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .wf-head-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .wf-head-inner { position: relative; z-index: 1; display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .wf-head-text { flex: 1; min-width: 240px; max-width: 720px; }
  .wf-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .wf-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .wf-title {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: clamp(22px, 2.6vw, 30px);
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1.1;
    color: var(--text-strong);
  }
  .wf-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .wf-sub {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .wf-grid {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: var(--space-4);
  }
  @media (max-width: 820px) {
    .wf-grid { grid-template-columns: 1fr; }
  }

  .wf-col-title {
    margin: 0 0 var(--space-2);
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-weight: 600;
    color: var(--text-muted);
  }

  /* ─── workflow item card ─── */
  .wf-card-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .wf-card {
    position: relative;
    padding: 12px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  .wf-card::before {
    content: '';
    position: absolute;
    top: 0; left: 12px; right: 12px;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 30%, rgba(54,197,214,0.45) 70%, transparent 100%);
    opacity: 0;
    transition: opacity 160ms ease;
  }
  .wf-card:hover {
    transform: translateY(-1px);
    border-color: rgba(140,109,255,0.32);
    box-shadow: 0 8px 22px -10px rgba(0,0,0,0.40);
  }
  .wf-card:hover::before { opacity: 1; }
  .wf-card.is-disabled { opacity: 0.55; }

  .wf-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .wf-card-title {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    color: var(--text-strong);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: -0.005em;
  }
  .wf-card-meta {
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wf-card-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .wf-card-actions form { margin: 0; }

  /* ─── pills ─── */
  .wf-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .wf-pill.is-success {
    background: rgba(52,211,153,0.10);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .wf-pill.is-failure {
    background: rgba(248,113,113,0.10);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.34);
  }
  .wf-pill.is-running {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .wf-pill.is-queued, .wf-pill.is-cancelled, .wf-pill.is-skipped {
    background: rgba(140,149,167,0.10);
    color: #b6bcc8;
    box-shadow: inset 0 0 0 1px rgba(140,149,167,0.30);
  }
  .wf-pill-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }

  /* ─── ghost buttons (page-local; we don't reuse .btn here so the card
        actions can stay compact) ─── */
  .wf-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 7px;
    cursor: pointer;
    text-decoration: none;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    font-family: inherit;
  }
  .wf-btn:hover {
    background: rgba(140,109,255,0.07);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .wf-btn.is-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 4px 12px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.14);
  }
  .wf-btn.is-primary:hover { transform: translateY(-1px); color: #fff; }
  .wf-btn.is-danger {
    color: #fecaca;
    border-color: rgba(248,113,113,0.35);
  }
  .wf-btn.is-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.55);
    color: #fecaca;
  }

  /* ─── run list (right column) ─── */
  .wf-run-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .wf-run {
    position: relative;
    display: flex;
    gap: 12px;
    padding: 12px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    text-decoration: none;
    color: inherit;
    overflow: hidden;
    transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  .wf-run::before {
    content: '';
    position: absolute;
    top: 0; left: 12px; right: 12px;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 30%, rgba(54,197,214,0.45) 70%, transparent 100%);
    opacity: 0;
    transition: opacity 160ms ease;
  }
  .wf-run:hover {
    transform: translateY(-1px);
    border-color: rgba(140,109,255,0.30);
    box-shadow: 0 8px 22px -10px rgba(0,0,0,0.40);
    text-decoration: none;
  }
  .wf-run:hover::before { opacity: 1; }
  .wf-run-glyph {
    min-width: 18px;
    text-align: center;
    font-weight: 700;
    padding-top: 1px;
  }
  .wf-run-body { flex: 1; min-width: 0; }
  .wf-run-title {
    font-family: var(--font-display);
    font-weight: 700;
    color: var(--text-strong);
    font-size: 14px;
    letter-spacing: -0.005em;
  }
  .wf-run-title .runnum {
    font-family: var(--font-mono);
    color: var(--text-muted);
    font-weight: 500;
    margin-left: 4px;
  }
  .wf-run-meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .wf-run-meta code {
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--text);
  }
  .wf-run-meta .sep { opacity: 0.5; padding: 0 6px; }

  /* ─── empty state — dashed card with orb ─── */
  .wf-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    text-align: center;
    overflow: hidden;
  }
  .wf-empty-orb {
    position: absolute;
    inset: auto auto -40% 50%;
    transform: translateX(-50%);
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
  }
  .wf-empty-inner { position: relative; z-index: 1; max-width: 460px; margin: 0 auto; }
  .wf-empty-icon {
    width: 44px; height: 44px;
    margin: 0 auto var(--space-3);
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.14));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    display: flex; align-items: center; justify-content: center;
    color: #b69dff;
  }
  .wf-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    letter-spacing: -0.01em;
  }
  .wf-empty-body {
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 var(--space-3);
  }
  .wf-empty-body code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(255,255,255,0.05);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text);
  }

  /* ─── run detail page ─── */
  .wf-detail-head {
    position: relative;
    margin-bottom: var(--space-4);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .wf-detail-head::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.6;
    pointer-events: none;
  }
  .wf-back {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .wf-back a { color: var(--text-muted); text-decoration: none; }
  .wf-back a:hover { color: var(--accent); }
  .wf-detail-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: clamp(20px, 2.2vw, 26px);
    font-weight: 800;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    line-height: 1.2;
  }
  .wf-detail-meta {
    margin-top: 8px;
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .wf-detail-meta code {
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11.5px;
    color: var(--text);
  }

  .wf-job {
    margin-bottom: var(--space-3);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .wf-job summary {
    padding: 10px 14px;
    cursor: pointer;
    display: flex;
    gap: 10px;
    align-items: center;
    background: rgba(255,255,255,0.02);
    list-style: none;
  }
  .wf-job summary::-webkit-details-marker { display: none; }
  .wf-job-name { flex: 1; font-family: var(--font-display); font-weight: 600; color: var(--text-strong); }
  .wf-job-dur { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .wf-job-steps {
    padding: 6px 14px 4px;
    border-top: 1px solid var(--border);
  }
  .wf-step {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 10px;
    font-size: 13px;
  }
  .wf-step:last-child { border-bottom: 0; }
  .wf-step-glyph { min-width: 18px; font-weight: 700; }
  .wf-step-body { flex: 1; min-width: 0; }
  .wf-step-name { font-weight: 600; color: var(--text); }
  .wf-step-cmd {
    display: block;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wf-step-dur, .wf-step-exit { font-size: 11px; font-variant-numeric: tabular-nums; }
  .wf-step-dur { color: var(--text-muted); }
  .wf-step-exit { color: var(--red, #f87171); }
  .wf-logs {
    margin: 0;
    padding: 12px 14px;
    background: rgba(0,0,0,0.30);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    overflow-x: auto;
    max-height: 480px;
    border-top: 1px solid var(--border);
  }
`;

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

      <div class="wf-wrap">
        <section class="wf-head">
          <div class="wf-head-orb" aria-hidden="true" />
          <div class="wf-head-inner">
            <div class="wf-head-text">
              <div class="wf-eyebrow">
                <span class="wf-eyebrow-dot" aria-hidden="true" />
                Continuous integration · {owner}/{repo}
              </div>
              <h2 class="wf-title">
                <span class="wf-title-grad">Workflows.</span>
              </h2>
              <p class="wf-sub">
                YAML pipelines that run on push, on a schedule, or on demand —
                with live logs and one-click cancel.
              </p>
            </div>
          </div>
        </section>

        <div class="wf-grid">
          <aside>
            <h4 class="wf-col-title">Workflows</h4>
            {wfs.length === 0 ? (
              <div class="wf-empty">
                <div class="wf-empty-orb" aria-hidden="true" />
                <div class="wf-empty-inner">
                  <div class="wf-empty-icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <path d="M9 13l2 2 4-4" />
                    </svg>
                  </div>
                  <h3 class="wf-empty-title">Add your first workflow</h3>
                  <p class="wf-empty-body">
                    Drop a YAML file under{" "}
                    <code>.gluecron/workflows/</code> on your default branch
                    and push — it will appear here automatically.
                  </p>
                </div>
              </div>
            ) : (
              <div class="wf-card-list">
                {wfs.map((w) => (
                  <div class={`wf-card${w.disabled ? " is-disabled" : ""}`}>
                    <div class="wf-card-top">
                      <div style="flex:1;min-width:0">
                        <div class="wf-card-title" title={w.name}>{w.name}</div>
                        <div class="wf-card-meta" title={w.path}>{w.path}</div>
                      </div>
                      <div class="wf-card-actions">
                        <span
                          class={w.disabled ? "wf-pill is-cancelled" : "wf-pill is-success"}
                          title={w.disabled ? "Disabled" : "Active"}
                        >
                          <span class="wf-pill-dot" aria-hidden="true" />
                          {w.disabled ? "Disabled" : "Active"}
                        </span>
                        {canRun && !w.disabled && (
                          <form
                            method="post"
                            action={`/${owner}/${repo}/actions/${w.id}/run`}
                            style="margin:0"
                          >
                            <button
                              type="submit"
                              class="wf-btn is-primary"
                              title="Trigger manual run"
                            >
                              Run
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </aside>

          <section>
            <h4 class="wf-col-title">Recent runs</h4>
            {runs.length === 0 ? (
              <div class="wf-empty">
                <div class="wf-empty-orb" aria-hidden="true" />
                <div class="wf-empty-inner">
                  <div class="wf-empty-icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                  <h3 class="wf-empty-title">No runs yet</h3>
                  <p class="wf-empty-body">
                    Push a commit on a trigger branch, or use the{" "}
                    <strong>Run</strong> button next to a workflow to start one
                    manually.
                  </p>
                </div>
              </div>
            ) : (
              <div class="wf-run-list">
                {runs.map((r) => (
                  <a
                    href={`/${owner}/${repo}/actions/runs/${r.id}`}
                    class="wf-run"
                  >
                    <span
                      class="wf-run-glyph"
                      style={`color: ${statusColor(r.status, r.conclusion)}`}
                      title={r.conclusion || r.status}
                    >
                      {statusGlyph(r.status, r.conclusion)}
                    </span>
                    <div class="wf-run-body">
                      <div class="wf-run-title">
                        {r.workflowName || "(workflow deleted)"}
                        <span class="runnum">#{r.runNumber}</span>
                        {" "}
                        <span
                          class={statusPillClass(r.status, r.conclusion)}
                          style="margin-left:6px;vertical-align:1px"
                        >
                          <span class="wf-pill-dot" aria-hidden="true" />
                          {r.conclusion || r.status}
                        </span>
                      </div>
                      <div class="wf-run-meta">
                        <span>{r.event}</span>
                        {r.ref && (
                          <>
                            <span class="sep">·</span>
                            <span>{r.ref.replace(/^refs\/heads\//, "")}</span>
                          </>
                        )}
                        {r.commitSha && (
                          <>
                            <span class="sep">·</span>
                            <code>{r.commitSha.slice(0, 7)}</code>
                          </>
                        )}
                        <span class="sep">·</span>
                        <span title={r.queuedAt ? new Date(r.queuedAt).toISOString() : ""}>
                          {relTime(r.queuedAt)}
                        </span>
                        {r.startedAt && r.finishedAt && (
                          <>
                            <span class="sep">·</span>
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
      </div>

      <style dangerouslySetInnerHTML={{ __html: wfStyles }} />
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

      <div class="wf-wrap">
        <section class="wf-detail-head">
          <div style="flex:1;min-width:0">
            <div class="wf-back">
              <a href={`/${owner}/${repo}/actions`}>← Workflows</a>
            </div>
            <h3 class="wf-detail-title">
              <span
                style={`color: ${statusColor(run.status, run.conclusion)}; margin-right: 8px`}
              >
                {statusGlyph(run.status, run.conclusion)}
              </span>
              {workflowRow?.name || "(deleted workflow)"}
              <span style="color:var(--text-muted);font-weight:500;margin-left:6px;font-family:var(--font-mono)">
                #{run.runNumber}
              </span>
              {" "}
              <span
                class={statusPillClass(run.status, run.conclusion)}
                style="vertical-align:3px;margin-left:6px"
              >
                <span class="wf-pill-dot" aria-hidden="true" />
                {run.conclusion || run.status}
              </span>
            </h3>
            <div class="wf-detail-meta">
              <span>{run.event}</span>
              {run.ref && (
                <>
                  <span style="opacity:0.5;padding:0 6px">·</span>
                  <span>{run.ref.replace(/^refs\/heads\//, "")}</span>
                </>
              )}
              {run.commitSha && (
                <>
                  <span style="opacity:0.5;padding:0 6px">·</span>
                  <a href={`/${owner}/${repo}/commit/${run.commitSha}`}>
                    <code>{run.commitSha.slice(0, 7)}</code>
                  </a>
                </>
              )}
              <span style="opacity:0.5;padding:0 6px">·</span>
              <span title={run.queuedAt ? new Date(run.queuedAt).toISOString() : ""}>
                queued {relTime(run.queuedAt)}
              </span>
              {run.startedAt && run.finishedAt && (
                <>
                  <span style="opacity:0.5;padding:0 6px">·</span>
                  <span>duration {durationMs(run.startedAt, run.finishedAt)}</span>
                </>
              )}
            </div>
          </div>
          {canCancel && (
            <form
              method="post"
              action={`/${owner}/${repo}/actions/runs/${run.id}/cancel`}
              onsubmit="return confirm('Cancel this run?')"
            >
              <button type="submit" class="wf-btn is-danger">
                Cancel run
              </button>
            </form>
          )}
        </section>

        {jobs.length === 0 ? (
          <div class="wf-empty">
            <div class="wf-empty-orb" aria-hidden="true" />
            <div class="wf-empty-inner">
              <div class="wf-empty-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <h3 class="wf-empty-title">
                {run.status === "queued" ? "Waiting for a runner" : "No jobs recorded"}
              </h3>
              <p class="wf-empty-body">
                {run.status === "queued"
                  ? "Jobs will appear here the moment the runner picks this up."
                  : "This run produced no job records — check the workflow definition."}
              </p>
            </div>
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
                <details class="wf-job" open>
                  <summary>
                    <span
                      style={`color: ${statusColor(j.status, j.conclusion)}; font-weight: 700`}
                    >
                      {statusGlyph(j.status, j.conclusion)}
                    </span>
                    <span class="wf-job-name">{j.name}</span>
                    <span
                      class={statusPillClass(j.status, j.conclusion)}
                    >
                      <span class="wf-pill-dot" aria-hidden="true" />
                      {j.conclusion || j.status}
                    </span>
                    <span class="wf-job-dur">
                      {j.startedAt && j.finishedAt
                        ? durationMs(j.startedAt, j.finishedAt)
                        : ""}
                    </span>
                  </summary>
                  {steps.length > 0 && (
                    <div class="wf-job-steps">
                      {steps.map((s, i) => (
                        <div class="wf-step">
                          <span
                            class="wf-step-glyph"
                            style={`color: ${statusColor(s.status || "", null)}`}
                          >
                            {statusGlyph(s.status || "", null)}
                          </span>
                          <div class="wf-step-body">
                            <div class="wf-step-name">
                              {s.name || `Step ${i + 1}`}
                            </div>
                            {s.run && (
                              <code class="wf-step-cmd">$ {s.run}</code>
                            )}
                          </div>
                          {typeof s.durationMs === "number" && (
                            <span class="wf-step-dur">
                              {s.durationMs < 1000
                                ? `${s.durationMs}ms`
                                : `${(s.durationMs / 1000).toFixed(1)}s`}
                            </span>
                          )}
                          {typeof s.exitCode === "number" && s.exitCode !== 0 && (
                            <span class="wf-step-exit">exit {s.exitCode}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {(() => {
                    const runLive =
                      run.status === "running" || run.status === "queued";
                    const jobTerminal =
                      j.status === "success" ||
                      j.status === "failure" ||
                      j.status === "cancelled" ||
                      j.status === "skipped" ||
                      j.conclusion === "success" ||
                      j.conclusion === "failure" ||
                      j.conclusion === "cancelled" ||
                      j.conclusion === "skipped";
                    if (runLive && !jobTerminal) {
                      return (
                        <LogTail
                          runId={run.id}
                          jobId={j.id}
                          fallbackLogs={j.logs || ""}
                        />
                      );
                    }
                    if (j.logs && j.logs.length > 0) {
                      return <pre class="wf-logs">{j.logs}</pre>;
                    }
                    return null;
                  })()}
                </details>
              );
            })}
          </div>
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: wfStyles }} />
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

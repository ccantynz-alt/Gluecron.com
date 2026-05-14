/**
 * Block N3 — Platform deploy timeline page + JSON feed.
 *
 *   GET /admin/deploys              — site-admin HTML timeline (last 50 deploys)
 *   GET /admin/deploys/latest.json  — `{ latest, asOf }` JSON. Polled by the
 *                                     layout status pill on every page; SSE
 *                                     pushes follow via `platform:deploys`.
 *
 * The companion POST /admin/deploys/trigger lives in `src/routes/admin-deploys.tsx`
 * (Block N4 — pre-existing locked file) — we MUST NOT extend that file, so
 * these GET routes ship as a sibling. Both mount on the same Hono `/` so the
 * URLs land where the spec expects.
 *
 * Backed by `platform_deploys` (drizzle/0046_platform_deploys.sql,
 * src/db/schema-deploys.ts). Populated by
 * `POST /api/events/deploy/{started,finished}` in `src/routes/events.ts`,
 * which the `.github/workflows/hetzner-deploy.yml` workflow calls as it runs.
 */

import { Hono } from "hono";
import { raw } from "hono/html";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  platformDeploys,
  platformDeploySteps,
} from "../db/schema-deploys";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";

const page = new Hono<AuthEnv>();
page.use("*", softAuth);

// ---------------------------------------------------------------------------
// Helpers — exposed via `__test` so unit tests can hammer the format edges
// without setting up the full Hono request pipeline.
// ---------------------------------------------------------------------------

/**
 * Render a relative time like "just now", "12s ago", "3m ago", "2h ago",
 * "3d ago". Stable for any past Date; clamps negative deltas to "just now"
 * so a slight clock skew doesn't print "-2s".
 */
export function relativeTime(from: Date, now: Date = new Date()): string {
  const ms = now.getTime() - from.getTime();
  if (ms < 5_000) return "just now";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Short SHA — first 7 hex chars, lowercased. */
export function shortSha(sha: string): string {
  return (sha || "").slice(0, 7).toLowerCase();
}

/** Format duration_ms into "12s" / "1m 14s" / "—". */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

interface DeployRow {
  id: string;
  runId: string;
  sha: string;
  source: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  error: string | null;
}

/**
 * R2 — the canonical step order surfaced by `hetzner-deploy.yml`. Drives
 * the modal skeleton so steps render with a stable order even before any
 * step events have arrived. Mirror exactly what the workflow + notify
 * helper emits as `step_name`.
 */
export const R2_STEP_ORDER: ReadonlyArray<{ name: string; label: string }> = [
  { name: "setup", label: "Setup" },
  { name: "git-pull", label: "Git pull" },
  { name: "bun-install", label: "Bun install" },
  { name: "build", label: "Build" },
  { name: "db-migrate", label: "DB migrate" },
  { name: "restart-service", label: "Restart service" },
  { name: "smoke-test", label: "Smoke test" },
];

interface DeployStepRow {
  stepName: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
}

async function fetchStepsForDeploy(deployId: string): Promise<DeployStepRow[]> {
  try {
    const rows = await db
      .select({
        stepName: platformDeploySteps.stepName,
        status: platformDeploySteps.status,
        startedAt: platformDeploySteps.startedAt,
        finishedAt: platformDeploySteps.finishedAt,
        durationMs: platformDeploySteps.durationMs,
      })
      .from(platformDeploySteps)
      .where(eq(platformDeploySteps.deployId, deployId))
      .orderBy(asc(platformDeploySteps.startedAt));
    return rows as DeployStepRow[];
  } catch (err) {
    console.error("[admin-deploys-page] fetchStepsForDeploy failed:", err);
    return [];
  }
}

async function fetchLatest(limit = 50): Promise<DeployRow[]> {
  try {
    const rows = await db
      .select({
        id: platformDeploys.id,
        runId: platformDeploys.runId,
        sha: platformDeploys.sha,
        source: platformDeploys.source,
        status: platformDeploys.status,
        startedAt: platformDeploys.startedAt,
        finishedAt: platformDeploys.finishedAt,
        durationMs: platformDeploys.durationMs,
        error: platformDeploys.error,
      })
      .from(platformDeploys)
      .orderBy(desc(platformDeploys.startedAt))
      .limit(limit);
    return rows as DeployRow[];
  } catch (err) {
    console.error("[admin-deploys-page] fetchLatest failed:", err);
    return [];
  }
}

function serialise(row: DeployRow): Record<string, unknown> {
  return {
    id: row.id,
    run_id: row.runId,
    sha: row.sha,
    source: row.source,
    status: row.status,
    started_at: row.startedAt.toISOString(),
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
    duration_ms: row.durationMs,
    error: row.error,
  };
}

// ---------------------------------------------------------------------------
// Gate — both routes refuse anyone who isn't a site admin. The JSON variant
// returns 401/403 JSON so the layout pill can `fetch()` it safely on every
// page and silently disappear for non-admins.
// ---------------------------------------------------------------------------

async function gate(
  c: any,
  asJson: boolean
): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) {
    return asJson
      ? c.json({ ok: false, error: "Unauthorized" }, 401)
      : c.redirect("/login?next=/admin/deploys");
  }
  if (!(await isSiteAdmin(user.id))) {
    return asJson
      ? c.json({ ok: false, error: "Forbidden" }, 403)
      : c.html(
          <Layout title="Forbidden" user={user}>
            <div class="empty-state">
              <h2>403 — Not a site admin</h2>
              <p>You don't have permission to view this page.</p>
            </div>
          </Layout>,
          403
        );
  }
  return { user };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

page.get("/admin/deploys/latest.json", async (c) => {
  const g = await gate(c, true);
  if (g instanceof Response) return g;
  const rows = await fetchLatest(1);
  return c.json({
    ok: true,
    latest: rows[0] ? serialise(rows[0]) : null,
    asOf: new Date().toISOString(),
  });
});

page.get("/admin/deploys", async (c) => {
  const g = await gate(c, false);
  if (g instanceof Response) return g;
  const { user } = g;
  const rows = await fetchLatest(50);
  const lastSuccess = rows.find((r) => r.status === "succeeded") || null;
  const repo = process.env.GITHUB_REPOSITORY || "ccantynz/Gluecron.com";

  // R2 — if a deploy is currently in_progress, fetch its persisted step
  // history so the modal pre-fills on hard refresh. SSE then keeps it
  // live going forward. If `?modal=<run_id>` is present we open the
  // modal regardless of state (the Trigger button uses an inline JS
  // path; this query-string mode is for deep-linkable debug).
  const inProgress = rows.find((r) => r.status === "in_progress") || null;
  const queryModalRun = (() => {
    const qs = c.req.query("modal");
    return typeof qs === "string" && qs.length > 0 ? qs : null;
  })();
  const modalDeploy =
    inProgress ||
    (queryModalRun ? rows.find((r) => r.runId === queryModalRun) || null : null);
  const modalSteps: DeployStepRow[] = modalDeploy
    ? await fetchStepsForDeploy(modalDeploy.id)
    : [];

  return c.html(
    <Layout title="Deploys — admin" user={user}>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
        <h2 style="margin:0">Platform deploys</h2>
        <form
          method="post"
          action="/admin/deploys/trigger"
          style="margin:0"
        >
          <button type="submit" class="btn btn-sm btn-primary">
            Trigger deploy
          </button>
        </form>
      </div>

      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:18px">
        {lastSuccess ? (
          <div>
            <div style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">
              Last successful deploy
            </div>
            <div style="margin-top:4px;font-size:14px">
              <code class="meta-mono">{shortSha(lastSuccess.sha)}</code>
              {" · "}
              <span title={lastSuccess.startedAt.toISOString()}>
                {relativeTime(lastSuccess.startedAt)}
              </span>
              {" · "}
              <span>{formatDuration(lastSuccess.durationMs)}</span>
              {" · "}
              <span>{lastSuccess.source}</span>
            </div>
          </div>
        ) : (
          <div style="color:var(--text-muted);font-size:14px">
            No successful deploys recorded yet.
          </div>
        )}
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)">
            <th style="padding:8px 6px;width:90px">Status</th>
            <th style="padding:8px 6px">SHA</th>
            <th style="padding:8px 6px">Source</th>
            <th style="padding:8px 6px">Started</th>
            <th style="padding:8px 6px">Duration</th>
            <th style="padding:8px 6px">Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colspan={6}
                style="padding:18px 6px;color:var(--text-muted);text-align:center"
              >
                No deploys recorded yet — they'll appear here when the next
                push to <code>main</code> runs hetzner-deploy.yml.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px 6px">
                <span
                  title={row.status}
                  aria-label={row.status}
                  style={`display:inline-block;width:10px;height:10px;border-radius:50%;background:${
                    row.status === "succeeded"
                      ? "#34d399"
                      : row.status === "failed"
                      ? "#f87171"
                      : "#fbbf24"
                  }`}
                />
                <span style="margin-left:8px">{row.status}</span>
              </td>
              <td style="padding:8px 6px">
                <code class="meta-mono">{shortSha(row.sha)}</code>
              </td>
              <td style="padding:8px 6px">{row.source}</td>
              <td
                style="padding:8px 6px"
                title={row.startedAt.toISOString()}
              >
                {relativeTime(row.startedAt)}
              </td>
              <td style="padding:8px 6px">
                {formatDuration(row.durationMs)}
              </td>
              <td
                style="padding:8px 6px;color:var(--text-muted);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                title={row.error || ""}
              >
                {row.error ? row.error.slice(0, 160) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style="margin-top:18px;font-size:12px;color:var(--text-muted)">
        Manual trigger (CLI shortcut — the button above is wired to the N4
        POST /admin/deploys/trigger handler):{" "}
        <code class="meta-mono">
          gh workflow run hetzner-deploy.yml -R {repo}
        </code>
      </p>

      {/* R2 — Live deploy modal. Hidden by default; shown when an
          in_progress deploy is detected or when ?modal=<run_id> is set.
          The Trigger button posts to /admin/deploys/trigger then opens
          the modal as soon as the SSE stream sends its first event. */}
      {renderDeployModal(modalDeploy, modalSteps, repo)}
    </Layout>
  );
});

/**
 * R2 — server-render the modal skeleton (steps, status pills, live log
 * pane) plus the inline JS that wires it to EventSource on
 * `/live-events/platform:deploys:<run_id>`.
 *
 * The modal is ALWAYS rendered in the DOM (hidden by default) so the
 * client-side Trigger flow can open it without a full page reload after
 * a successful POST /admin/deploys/trigger. When a deploy is already in
 * progress on initial load we mark it visible and pre-seed steps.
 */
function renderDeployModal(
  active: DeployRow | null,
  steps: DeployStepRow[],
  repo: string
) {
  const initiallyOpen = active !== null;
  // Build a status map keyed by step_name → status for fast initial paint.
  const stepStatus: Record<string, string> = {};
  const stepDuration: Record<string, number | null> = {};
  for (const s of steps) {
    // Last-write-wins is what we want — succeeded > in_progress.
    stepStatus[s.stepName] = s.status;
    stepDuration[s.stepName] = s.durationMs ?? null;
  }
  return (
    <>
      <div
        id="deploy-modal-backdrop"
        data-active-run={active ? active.runId : ""}
        style={`position:fixed;inset:0;background:rgba(0,0,0,0.55);display:${
          initiallyOpen ? "flex" : "none"
        };align-items:flex-start;justify-content:center;padding-top:8vh;z-index:1000`}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="deploy-modal-title"
          style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;max-width:600px;width:92vw;padding:18px 20px;box-shadow:0 24px 64px rgba(0,0,0,0.5);font-size:14px;color:var(--text);max-height:80vh;overflow:auto"
        >
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:8px">
            <h3
              id="deploy-modal-title"
              style="margin:0;font-size:16px;font-weight:600"
            >
              Deploying — run{" "}
              <code class="meta-mono" id="deploy-modal-run">
                #{active ? active.runId : ""}
              </code>
            </h3>
            <button
              type="button"
              id="deploy-modal-close"
              aria-label="Close"
              style="background:transparent;border:0;color:var(--text-muted);cursor:pointer;font-size:18px;line-height:1;padding:4px 8px"
            >
              ×
            </button>
          </div>
          <ol
            id="deploy-modal-steps"
            style="list-style:none;padding:0;margin:0 0 12px;display:flex;flex-direction:column;gap:6px"
          >
            {R2_STEP_ORDER.map((step) => {
              const s = stepStatus[step.name];
              const dur = stepDuration[step.name];
              const icon =
                s === "succeeded"
                  ? "✓"
                  : s === "failed"
                  ? "✗"
                  : s === "in_progress"
                  ? "⏳"
                  : "·";
              const colour =
                s === "succeeded"
                  ? "#34d399"
                  : s === "failed"
                  ? "#f87171"
                  : s === "in_progress"
                  ? "#fbbf24"
                  : "var(--text-muted)";
              const detail =
                s === "succeeded" && typeof dur === "number"
                  ? `completed in ${formatDuration(dur)}`
                  : s === "in_progress"
                  ? "in progress"
                  : s === "failed"
                  ? "failed"
                  : "";
              return (
                <li
                  data-step={step.name}
                  data-status={s || "pending"}
                  style="display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.02)"
                >
                  <span
                    class="step-icon"
                    aria-hidden="true"
                    style={`display:inline-block;width:18px;text-align:center;color:${colour};font-weight:600`}
                  >
                    {icon}
                  </span>
                  <span class="step-label" style="flex:1">
                    {step.label}
                  </span>
                  <span
                    class="step-detail"
                    style="color:var(--text-muted);font-size:12px"
                  >
                    {detail}
                  </span>
                </li>
              );
            })}
          </ol>
          <div
            style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:10px"
          >
            <span id="deploy-modal-elapsed">
              {active
                ? `Started ${relativeTime(active.startedAt)}`
                : "Idle"}
            </span>
            <a
              id="deploy-modal-runlink"
              href={
                active
                  ? `https://github.com/${repo}/actions/runs/${active.runId}`
                  : "#"
              }
              target="_blank"
              rel="noreferrer noopener"
              style="color:var(--text-muted)"
            >
              Run on GitHub →
            </a>
          </div>
        </div>
      </div>
      {raw(`<script>${DEPLOY_MODAL_JS}</script>`)}
    </>
  );
}

/**
 * R2 — client-side glue. Plain-JS only (no deps).
 *
 * Responsibilities:
 *   - Wire Esc + backdrop click + close-button to hide the modal.
 *   - Hook the "Trigger deploy" form so submission opens the modal and
 *     starts an EventSource for the new run id. The N4 POST returns
 *     {ok:true, run_id?:string} but the run id isn't guaranteed yet —
 *     we fall back to polling /admin/deploys/latest.json once.
 *   - On every SSE 'step' event, update the matching `<li data-step=…>`
 *     row's icon + status pill.
 */
const DEPLOY_MODAL_JS = `
(function(){
  var modal = document.getElementById('deploy-modal-backdrop');
  if (!modal) return;
  var stepsList = document.getElementById('deploy-modal-steps');
  var runEl = document.getElementById('deploy-modal-run');
  var runLink = document.getElementById('deploy-modal-runlink');
  var closeBtn = document.getElementById('deploy-modal-close');
  var trigger = document.querySelector('form[action="/admin/deploys/trigger"]');
  var es = null;

  function hide(){ modal.style.display = 'none'; if (es) { try { es.close(); } catch(_){} es = null; } }
  function show(){ modal.style.display = 'flex'; }

  closeBtn && closeBtn.addEventListener('click', hide);
  modal.addEventListener('click', function(e){ if (e.target === modal) hide(); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') hide(); });

  function applyStep(stepName, status, durationMs){
    var li = stepsList && stepsList.querySelector('li[data-step="' + stepName + '"]');
    if (!li) return;
    li.setAttribute('data-status', status);
    var icon = li.querySelector('.step-icon');
    var detail = li.querySelector('.step-detail');
    if (status === 'succeeded') {
      if (icon) { icon.textContent = '✓'; icon.style.color = '#34d399'; }
      if (detail) detail.textContent = typeof durationMs === 'number'
        ? ('completed in ' + Math.round(durationMs/1000) + 's')
        : 'completed';
    } else if (status === 'failed') {
      if (icon) { icon.textContent = '✗'; icon.style.color = '#f87171'; }
      if (detail) detail.textContent = 'failed';
    } else if (status === 'in_progress') {
      if (icon) { icon.textContent = '⏳'; icon.style.color = '#fbbf24'; }
      if (detail) detail.textContent = 'in progress';
    }
  }

  function attach(runId){
    if (!runId) return;
    runEl && (runEl.textContent = '#' + runId);
    if (runLink) {
      var href = runLink.getAttribute('href') || '';
      runLink.setAttribute('href', href.replace(/runs\\/[^/]*$/, 'runs/' + runId));
    }
    show();
    if (es) { try { es.close(); } catch(_){} es = null; }
    var topic = 'platform:deploys:' + runId;
    try {
      es = new EventSource('/live-events/' + topic);
    } catch (e) { return; }
    es.addEventListener('step', function(ev){
      try {
        var data = JSON.parse(ev.data);
        applyStep(data.step_name, data.status, data.duration_ms);
      } catch(_){ /* swallow */ }
    });
  }

  // If the server pre-rendered the modal as open, attach to that run id.
  var preActive = modal.getAttribute('data-active-run') || '';
  if (preActive) attach(preActive);

  // Hook the trigger form so a click flips the modal open and we discover
  // the run_id via latest.json.
  if (trigger) {
    trigger.addEventListener('submit', function(e){
      e.preventDefault();
      show();
      fetch('/admin/deploys/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function(){ return fetch('/admin/deploys/latest.json'); })
        .then(function(r){ return r.json(); })
        .then(function(j){
          if (j && j.latest && j.latest.run_id) attach(j.latest.run_id);
        })
        .catch(function(){ /* swallow — the page is still usable */ });
    });
  }
})();
`;

export const __test = {
  relativeTime,
  shortSha,
  formatDuration,
  fetchLatest,
  serialise,
  fetchStepsForDeploy,
  R2_STEP_ORDER,
  DEPLOY_MODAL_JS,
};

export default page;

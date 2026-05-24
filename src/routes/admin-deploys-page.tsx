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

/**
 * Format a step duration in milliseconds for an inline pill.
 * Short and scannable: `420ms`, `3.4s`, `1m02`. Falls back to `…` while
 * a step is still in flight (no duration yet).
 */
function formatStepDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "…";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalS = Math.round(ms / 1000);
  const m = Math.floor(totalS / 60);
  const rem = totalS - m * 60;
  return `${m}m${rem.toString().padStart(2, "0")}`;
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

  // Fetch step rows for the most-recent deploys so we can render coloured
  // step pills inline. Limited to 12 to keep the DB hop short — older rows
  // collapse to a duration-only summary.
  const STEPS_FETCH_LIMIT = 12;
  const stepsByDeploy = new Map<string, DeployStepRow[]>();
  await Promise.all(
    rows.slice(0, STEPS_FETCH_LIMIT).map(async (r) => {
      const s = await fetchStepsForDeploy(r.id);
      stepsByDeploy.set(r.id, s);
    })
  );

  // Stats — today / 7-day window / since-last elapsed.
  const now = new Date();
  const dayMs = 24 * 60 * 60_000;
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(now.getTime() - 7 * dayMs);
  const todayCount = rows.filter((r) => r.startedAt >= startOfDay).length;
  const weekRows = rows.filter(
    (r) => r.startedAt >= sevenDaysAgo && r.status !== "in_progress"
  );
  const weekSucceeded = weekRows.filter((r) => r.status === "succeeded").length;
  const successRatePct =
    weekRows.length === 0
      ? null
      : Math.round((weekSucceeded / weekRows.length) * 100);

  const latest = rows[0] || null;
  const latestState: "green" | "failed" | "rolling" | "idle" = !latest
    ? "idle"
    : latest.status === "succeeded"
    ? "green"
    : latest.status === "failed"
    ? "failed"
    : "rolling";

  const headline =
    latestState === "idle"
      ? "No deploys yet."
      : latestState === "green"
      ? "Last deploy: green."
      : latestState === "failed"
      ? "Last deploy: failed."
      : "Rolling out…";

  const elapsedSinceLast = latest ? relativeTime(latest.startedAt, now) : "—";

  // In-flight banner — only when a deploy is actually mid-flight, and we
  // know how many of the canonical steps have at least started.
  let inflightLine: string | null = null;
  if (inProgress) {
    const steps = stepsByDeploy.get(inProgress.id) || [];
    const completed = steps.filter(
      (s) => s.status === "succeeded" || s.status === "failed"
    ).length;
    const total = R2_STEP_ORDER.length;
    inflightLine = `Deploy in progress — ${completed} / ${total} steps complete`;
  }

  return c.html(
    <Layout title="Deploys — admin" user={user}>
      <div class="deploys-wrap">
        <section class="deploys-hero">
          <div class="deploys-hero-orb" aria-hidden="true" />
          <div class="deploys-hero-inner">
            <div class="deploys-hero-top">
              <div class="deploys-hero-text">
                <div class="deploys-eyebrow">
                  <span class="deploys-eyebrow-dot" aria-hidden="true" />
                  Deploys · live timeline
                </div>
                <h1 class="deploys-title">
                  <span
                    class={
                      "deploys-title-grad " +
                      (latestState === "failed"
                        ? "is-failed"
                        : latestState === "rolling"
                        ? "is-rolling"
                        : "is-green")
                    }
                  >
                    {headline}
                  </span>
                </h1>
                <p class="deploys-sub">
                  Operator timeline for{" "}
                  <code class="deploys-mono-sub">{repo}</code>. Push to{" "}
                  <code class="deploys-mono-sub">main</code> fires{" "}
                  <code class="deploys-mono-sub">hetzner-deploy.yml</code>{" "}
                  — every step lands here in real time.
                </p>
              </div>
              <div class="deploys-hero-actions">
                <form
                  method="post"
                  action="/admin/deploys/trigger"
                  class="deploys-trigger-form"
                >
                  <button
                    type="submit"
                    class="deploys-btn deploys-btn-primary"
                  >
                    Trigger deploy
                  </button>
                </form>
                <form
                  method="post"
                  action="/admin/ops/rollback"
                  class="deploys-rollback-form"
                  onsubmit="return confirm('Roll back main to the previous tagged release?')"
                >
                  <button
                    type="submit"
                    class="deploys-btn deploys-btn-ghost"
                    title={
                      lastSuccess
                        ? `Rollback to ${shortSha(lastSuccess.sha)}`
                        : "No prior successful deploy on file"
                    }
                  >
                    Rollback to previous
                  </button>
                </form>
              </div>
            </div>

            <div class="deploys-stats" role="list">
              <div class="deploys-stat" role="listitem">
                <div class="deploys-stat-label">Latest SHA</div>
                <div class="deploys-stat-value deploys-tabular">
                  {latest ? (
                    <a
                      class="deploys-sha-pill"
                      href={`https://github.com/${repo}/commit/${latest.sha}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <span
                        class={`deploys-sha-dot is-${latestState}`}
                        aria-hidden="true"
                      />
                      <code>{shortSha(latest.sha)}</code>
                    </a>
                  ) : (
                    <span class="deploys-stat-empty">—</span>
                  )}
                </div>
              </div>
              <div class="deploys-stat" role="listitem">
                <div class="deploys-stat-label">Since last deploy</div>
                <div class="deploys-stat-value deploys-tabular">
                  {elapsedSinceLast}
                </div>
              </div>
              <div class="deploys-stat" role="listitem">
                <div class="deploys-stat-label">Deploys today</div>
                <div class="deploys-stat-value deploys-tabular">
                  {todayCount}
                </div>
              </div>
              <div class="deploys-stat" role="listitem">
                <div class="deploys-stat-label">7-day success</div>
                <div class="deploys-stat-value deploys-tabular">
                  {successRatePct === null ? (
                    <span class="deploys-stat-empty">—</span>
                  ) : (
                    <span
                      class={
                        "deploys-rate " +
                        (successRatePct >= 95
                          ? "is-good"
                          : successRatePct >= 70
                          ? "is-warn"
                          : "is-bad")
                      }
                    >
                      {successRatePct}%
                    </span>
                  )}
                  <span class="deploys-stat-sub">
                    {weekSucceeded}/{weekRows.length}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {inflightLine && (
          <div
            class="deploys-inflight"
            role="status"
            aria-live="polite"
          >
            <span class="deploys-inflight-dot" aria-hidden="true" />
            <span class="deploys-inflight-text">{inflightLine}</span>
            <a
              class="deploys-inflight-link"
              href={`/admin/deploys?modal=${inProgress!.runId}`}
            >
              Watch live →
            </a>
          </div>
        )}

        {lastSuccess && (
          <div class="deploys-lastgood">
            <div class="deploys-lastgood-label">Last green deploy</div>
            <div class="deploys-lastgood-body">
              <code class="deploys-mono">{shortSha(lastSuccess.sha)}</code>
              <span class="deploys-lastgood-sep" aria-hidden="true">·</span>
              <span title={lastSuccess.startedAt.toISOString()}>
                {relativeTime(lastSuccess.startedAt)}
              </span>
              <span class="deploys-lastgood-sep" aria-hidden="true">·</span>
              <span class="deploys-tabular">
                {formatDuration(lastSuccess.durationMs)}
              </span>
              <span class="deploys-lastgood-sep" aria-hidden="true">·</span>
              <span class="deploys-lastgood-source">{lastSuccess.source}</span>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div class="deploys-empty">
            <div class="deploys-empty-orb" aria-hidden="true" />
            <div class="deploys-empty-eyebrow">
              <span class="deploys-eyebrow-dot" aria-hidden="true" />
              No deploys yet
            </div>
            <h2 class="deploys-empty-title">
              Push to <code>main</code> to fire your first deploy.
            </h2>
            <p class="deploys-empty-sub">
              The platform polls{" "}
              <code class="deploys-mono">hetzner-deploy.yml</code> for every
              push. Each step (setup → git-pull → bun-install → build →
              db-migrate → restart-service → smoke-test) will render as a
              coloured pill on this page in real time.
            </p>
            <div class="deploys-empty-cli">
              <span class="deploys-empty-cli-label">CLI shortcut</span>
              <code>gh workflow run hetzner-deploy.yml -R {repo}</code>
            </div>
          </div>
        ) : (
          <section
            class="deploys-timeline"
            aria-label="Recent deploys"
          >
            <header class="deploys-timeline-head">
              <h2 class="deploys-timeline-title">Timeline</h2>
              <p class="deploys-timeline-sub">
                Last {rows.length} deploy{rows.length === 1 ? "" : "s"} ·
                most recent first
              </p>
            </header>
            <ol class="deploys-list">
              {rows.map((row, i) => {
                const steps = stepsByDeploy.get(row.id) || [];
                const hasSteps = steps.length > 0;
                const isFirst = i === 0;
                const statusClass =
                  row.status === "succeeded"
                    ? "is-succeeded"
                    : row.status === "failed"
                    ? "is-failed"
                    : "is-running";
                return (
                  <li
                    class={"deploys-row " + statusClass}
                    data-status={row.status}
                  >
                    <div class="deploys-row-head">
                      <a
                        class="deploys-sha-pill is-row"
                        href={`https://github.com/${repo}/commit/${row.sha}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={row.sha}
                      >
                        <span
                          class={`deploys-sha-dot is-${
                            row.status === "succeeded"
                              ? "green"
                              : row.status === "failed"
                              ? "failed"
                              : "rolling"
                          }`}
                          aria-hidden="true"
                        />
                        <code>{shortSha(row.sha)}</code>
                      </a>
                      <span class="deploys-row-source">{row.source}</span>
                      <span
                        class="deploys-row-when"
                        title={row.startedAt.toISOString()}
                      >
                        {relativeTime(row.startedAt)}
                      </span>
                      {isFirst && (
                        <span class="deploys-row-tag">latest</span>
                      )}
                      <span class="deploys-row-spacer" />
                      <span class="deploys-row-duration deploys-tabular">
                        {formatDuration(row.durationMs)}
                      </span>
                    </div>

                    {hasSteps ? (
                      <ul
                        class="deploys-steps"
                        aria-label="Deploy steps"
                      >
                        {steps.map((s) => (
                          <li
                            class={`deploys-step is-${s.status}`}
                            data-step={s.stepName}
                            title={`${s.stepName} · ${s.status}`}
                          >
                            <span
                              class="deploys-step-dot"
                              aria-hidden="true"
                            />
                            <span class="deploys-step-name">{s.stepName}</span>
                            <span class="deploys-step-dur deploys-tabular">
                              {formatStepDuration(s.durationMs)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div class="deploys-steps-muted">
                        No per-step data — older deploy or workflow predates
                        step streaming.
                      </div>
                    )}

                    {row.status === "failed" && row.error && (
                      <div class="deploys-error" title={row.error}>
                        <span
                          class="deploys-error-icon"
                          aria-hidden="true"
                        >
                          !
                        </span>
                        <span class="deploys-error-msg">
                          {row.error.slice(0, 220)}
                          {row.error.length > 220 ? "…" : ""}
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <footer class="deploys-timeline-foot">
              Manual trigger (CLI):{" "}
              <code class="deploys-mono">
                gh workflow run hetzner-deploy.yml -R {repo}
              </code>
            </footer>
          </section>
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: DEPLOYS_PAGE_CSS }} />

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
          style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;max-width:600px;width:92vw;padding:var(--space-4) var(--space-5);box-shadow:0 24px 64px rgba(0,0,0,0.5);font-size:14px;color:var(--text);max-height:80vh;overflow:auto"
        >
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-3);gap:var(--space-2)">
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
              style="background:transparent;border:0;color:var(--text-muted);cursor:pointer;font-size:18px;line-height:1;padding:var(--space-1) var(--space-2)"
            >
              ×
            </button>
          </div>
          <ol
            id="deploy-modal-steps"
            style="list-style:none;padding:0;margin:0 0 var(--space-3);display:flex;flex-direction:column;gap:6px"
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
                  style="display:flex;align-items:center;gap:var(--space-2);padding:6px var(--space-2);border-radius:6px;background:rgba(255,255,255,0.02)"
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

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.deploys-` so the operator's deploy
 * timeline can't bleed into the rest of the admin surface. Mirrors the
 * gradient-hairline hero + accent orb motif used by admin-integrations
 * and the shared error-page surface.
 * ───────────────────────────────────────────────────────────────────── */
const DEPLOYS_PAGE_CSS = `
  .deploys-wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }

  /* ─── Hero ─── */
  .deploys-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .deploys-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .deploys-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .deploys-hero-inner { position: relative; z-index: 1; }

  .deploys-hero-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .deploys-hero-text { flex: 1; min-width: 280px; }
  .deploys-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .deploys-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .deploys-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .deploys-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .deploys-title-grad.is-failed {
    background-image: linear-gradient(135deg, #fca5a5 0%, #f87171 50%, #ef4444 100%);
  }
  .deploys-title-grad.is-rolling {
    background-image: linear-gradient(135deg, #fde68a 0%, #fbbf24 50%, #f59e0b 100%);
  }
  .deploys-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 640px;
  }
  .deploys-mono-sub {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }

  .deploys-hero-actions {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
    align-items: center;
    flex-wrap: wrap;
  }
  .deploys-trigger-form,
  .deploys-rollback-form { margin: 0; }

  .deploys-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 10px 18px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
  }
  .deploys-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .deploys-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .deploys-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong, var(--border));
  }
  .deploys-btn-ghost:hover {
    background: rgba(248,113,113,0.06);
    border-color: rgba(248,113,113,0.40);
    color: #fecaca;
  }

  /* ─── Stats row ─── */
  .deploys-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  .deploys-stat {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .deploys-stat-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .deploys-stat-value {
    font-size: 18px;
    color: var(--text-strong);
    font-family: var(--font-display);
    font-weight: 700;
    letter-spacing: -0.012em;
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
  }
  .deploys-stat-sub {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-weight: 500;
    letter-spacing: 0;
  }
  .deploys-stat-empty { color: var(--text-muted); font-weight: 600; }
  .deploys-tabular { font-variant-numeric: tabular-nums; }

  .deploys-rate.is-good { color: #6ee7b7; }
  .deploys-rate.is-warn { color: #fde68a; }
  .deploys-rate.is-bad  { color: #fca5a5; }

  /* ─── SHA pill ─── */
  .deploys-sha-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 9999px;
    text-decoration: none;
    color: var(--text-strong);
    font-size: 12.5px;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .deploys-sha-pill:hover {
    background: rgba(140,109,255,0.10);
    border-color: rgba(140,109,255,0.40);
    text-decoration: none;
    color: var(--text-strong);
  }
  .deploys-sha-pill code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: inherit;
    background: transparent;
    padding: 0;
  }
  .deploys-sha-pill.is-row {
    background: transparent;
    border-color: rgba(255,255,255,0.10);
  }
  .deploys-sha-dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }
  .deploys-sha-dot.is-green { background: #34d399; box-shadow: 0 0 0 2px rgba(52,211,153,0.18); }
  .deploys-sha-dot.is-failed { background: #f87171; box-shadow: 0 0 0 2px rgba(248,113,113,0.20); }
  .deploys-sha-dot.is-rolling {
    background: #fbbf24;
    box-shadow: 0 0 0 2px rgba(251,191,36,0.22);
    animation: deploys-pulse 1.6s ease-in-out infinite;
  }
  .deploys-sha-dot.is-idle { background: var(--text-muted); }
  @keyframes deploys-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.45; }
  }
  @media (prefers-reduced-motion: reduce) {
    .deploys-sha-dot.is-rolling { animation: none; }
  }

  /* ─── Inflight banner ─── */
  .deploys-inflight {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    margin-bottom: var(--space-4);
    background: linear-gradient(135deg, rgba(251,191,36,0.10), rgba(251,191,36,0.04));
    border: 1px solid rgba(251,191,36,0.32);
    border-radius: 12px;
    color: #fde68a;
    font-size: 13.5px;
  }
  .deploys-inflight-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: #fbbf24;
    box-shadow: 0 0 0 3px rgba(251,191,36,0.20);
    animation: deploys-pulse 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }
  .deploys-inflight-text { flex: 1; font-weight: 600; }
  .deploys-inflight-link {
    color: #fde68a;
    font-weight: 700;
    text-decoration: none;
    border-bottom: 1px dashed rgba(253,230,138,0.55);
    padding-bottom: 1px;
  }
  .deploys-inflight-link:hover { color: #fef3c7; text-decoration: none; }

  /* ─── Last-good strip ─── */
  .deploys-lastgood {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    margin-bottom: var(--space-4);
    background: rgba(52,211,153,0.06);
    border: 1px solid rgba(52,211,153,0.25);
    border-radius: 10px;
    font-size: 13px;
    color: #bbf7d0;
    flex-wrap: wrap;
  }
  .deploys-lastgood-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-weight: 700;
    color: #6ee7b7;
  }
  .deploys-lastgood-body {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--text);
  }
  .deploys-lastgood-sep { color: var(--text-muted); opacity: 0.6; }
  .deploys-lastgood-source { color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; }
  .deploys-mono {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    padding: 2px 7px;
    border-radius: 5px;
    border: 1px solid var(--border);
  }

  /* ─── Empty state ─── */
  .deploys-empty {
    position: relative;
    padding: clamp(36px, 6vw, 56px) clamp(24px, 4vw, 44px);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 18px;
    background: rgba(255,255,255,0.015);
    text-align: left;
    overflow: hidden;
  }
  .deploys-empty-orb {
    position: absolute;
    inset: -40% -20% auto auto;
    width: 360px; height: 360px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.6;
    pointer-events: none;
  }
  .deploys-empty-eyebrow {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 12px;
  }
  .deploys-empty-title {
    position: relative;
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 28px);
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 12px;
    color: var(--text-strong);
  }
  .deploys-empty-title code {
    font-family: var(--font-mono);
    font-size: 0.85em;
    background: rgba(140,109,255,0.10);
    color: var(--text-link);
    padding: 1px 7px;
    border-radius: 6px;
  }
  .deploys-empty-sub {
    position: relative;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.55;
    margin: 0 0 20px;
    max-width: 620px;
  }
  .deploys-empty-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .deploys-empty-cli {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: rgba(0,0,0,0.28);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .deploys-empty-cli-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
  }
  .deploys-empty-cli code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
    background: transparent;
    padding: 0;
  }

  /* ─── Timeline ─── */
  .deploys-timeline {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .deploys-timeline-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
  }
  .deploys-timeline-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .deploys-timeline-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .deploys-timeline-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .deploys-timeline-foot code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }

  .deploys-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .deploys-row {
    position: relative;
    padding: 14px var(--space-5);
    border-bottom: 1px solid var(--border);
    transition: background 120ms ease, transform 120ms ease, box-shadow 120ms ease;
  }
  .deploys-row:last-child { border-bottom: 0; }
  .deploys-row:hover {
    background: rgba(255,255,255,0.022);
    transform: translateY(-1px);
    box-shadow: 0 8px 22px -16px rgba(0,0,0,0.5);
    z-index: 1;
  }
  .deploys-row.is-failed::before {
    content: '';
    position: absolute;
    left: 0; right: 0; top: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f87171 30%, #ef4444 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .deploys-row.is-running::after {
    content: '';
    position: absolute;
    left: 0; top: 14px; bottom: 14px;
    width: 2px;
    background: linear-gradient(180deg, #fbbf24, rgba(251,191,36,0.0));
    border-radius: 0 2px 2px 0;
    pointer-events: none;
  }

  .deploys-row-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .deploys-row-source {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    padding: 1px 7px;
    border-radius: 5px;
    border: 1px solid var(--border);
  }
  .deploys-row-when {
    font-size: 13px;
    color: var(--text);
  }
  .deploys-row-tag {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    font-weight: 700;
  }
  .deploys-row-spacer { flex: 1; }
  .deploys-row-duration {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    padding: 3px 10px;
    border-radius: 9999px;
    border: 1px solid var(--border);
  }

  /* ─── Step pills ─── */
  .deploys-steps {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .deploys-step {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11.5px;
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    color: var(--text);
    line-height: 1.4;
  }
  .deploys-step-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: var(--text-muted);
    flex-shrink: 0;
  }
  .deploys-step-name {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
  }
  .deploys-step-dur {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .deploys-step.is-succeeded {
    background: rgba(52,211,153,0.10);
    border-color: rgba(52,211,153,0.32);
    color: #bbf7d0;
  }
  .deploys-step.is-succeeded .deploys-step-dot { background: #34d399; }
  .deploys-step.is-succeeded .deploys-step-dur { color: #6ee7b7; }
  .deploys-step.is-failed {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.36);
    color: #fecaca;
  }
  .deploys-step.is-failed .deploys-step-dot { background: #f87171; }
  .deploys-step.is-failed .deploys-step-dur { color: #fca5a5; }
  .deploys-step.is-in_progress {
    background: rgba(251,191,36,0.10);
    border-color: rgba(251,191,36,0.36);
    color: #fde68a;
  }
  .deploys-step.is-in_progress .deploys-step-dot {
    background: #fbbf24;
    animation: deploys-pulse 1.4s ease-in-out infinite;
  }
  .deploys-step.is-in_progress .deploys-step-dur { color: #fcd34d; }
  .deploys-step.is-skipped {
    color: var(--text-muted);
    opacity: 0.6;
  }

  .deploys-steps-muted {
    margin-top: 10px;
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }

  /* ─── Failure error inline ─── */
  .deploys-error {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 10px;
    padding: 9px 12px;
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.30);
    border-radius: 8px;
    color: #fecaca;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .deploys-error-icon {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 9999px;
    background: rgba(248,113,113,0.20);
    color: #fecaca;
    font-weight: 800;
    font-size: 12px;
    line-height: 1;
  }
  .deploys-error-msg {
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ─── Light-theme tweaks ─── */
  :root[data-theme='light'] .deploys-hero {
    box-shadow: 0 1px 0 rgba(0,0,0,0.02), 0 12px 32px -10px rgba(15,16,28,0.10);
  }
  :root[data-theme='light'] .deploys-hero-orb,
  :root[data-theme='light'] .deploys-empty-orb {
    background: radial-gradient(circle, rgba(109,77,255,0.16), rgba(8,145,178,0.08) 45%, transparent 70%);
  }

  @media (max-width: 640px) {
    .deploys-wrap { padding: var(--space-4) var(--space-3) var(--space-8); }
    .deploys-hero-actions { width: 100%; }
    .deploys-btn { flex: 1 1 auto; }
    .deploys-row-head { gap: 8px; }
    .deploys-row-spacer { display: none; }
  }
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
  DEPLOYS_PAGE_CSS,
  formatStepDuration,
};

export default page;

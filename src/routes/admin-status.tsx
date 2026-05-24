/**
 * BLOCK S4 — Site-admin synthetic-monitor dashboard.
 *
 *   GET  /admin/status      — red/green dashboard (SSE-live)
 *   POST /admin/status/run  — run the suite synchronously
 *
 * Both gated behind `isSiteAdmin`. The public `/status` page (see
 * `src/routes/status.tsx`) stays open to everyone; this is the detailed
 * 14-row health table for the owner.
 *
 * Visual recipe (2026 polish — mirrors admin-integrations / admin-ops /
 * admin-deploys-page):
 *   - Gradient hairline strip across the top of the hero (purple→cyan, 2px)
 *   - Soft radial orb in the corner of the hero
 *   - Eyebrow with pill icon + actor name
 *   - Display headline with gradient-text on the verb ("Live now." /
 *     "Falling.")
 *   - Live-update banner with pulsing green dot + SSE event counter
 *   - Real-time activity feed: rows with tabular-nums timestamps, mono
 *     action verb with subtle accent, target check name
 *
 * Scoped CSS — every class prefixed `.status-` so this surface can't
 * bleed into other admin pages.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import {
  latestStatusByCheck,
  recentRedChecks,
  runSyntheticChecks,
  persistChecks,
  SSE_TOPIC,
  SYNTHETIC_CHECKS,
  type SyntheticCheckResult,
} from "../lib/synthetic-monitor";

const adminStatus = new Hono<AuthEnv>();
adminStatus.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/status");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="status-403">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
        <style dangerouslySetInnerHTML={{ __html: STATUS_CSS }} />
      </Layout>,
      403
    );
  }
  return { user };
}

function fmtAgo(checkedAt: Date | undefined): string {
  if (!checkedAt) return "never";
  const diffMs = Date.now() - checkedAt.getTime();
  if (diffMs < 0) return "just now";
  const s = Math.floor(diffMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function dotClass(status: SyntheticCheckResult["status"] | undefined): string {
  if (status === "green") return "is-green";
  if (status === "red") return "is-red";
  if (status === "yellow") return "is-yellow";
  return "is-idle";
}

function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}
function IconPulse() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

adminStatus.get("/admin/status", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const latest = await latestStatusByCheck();
  const recent = await recentRedChecks(24, 25);

  const allGreen = SYNTHETIC_CHECKS.every(
    (spec) => latest[spec.name]?.status === "green"
  );
  const redCount = SYNTHETIC_CHECKS.filter(
    (spec) => latest[spec.name]?.status === "red"
  ).length;

  // Find the most-recent checkedAt across all rows so we can render the
  // "last run Xs ago" badge.
  let lastRunAt: Date | null = null;
  for (const spec of SYNTHETIC_CHECKS) {
    const row = latest[spec.name];
    if (!row) continue;
    if (!lastRunAt || row.checkedAt > lastRunAt) lastRunAt = row.checkedAt;
  }

  // Headline state — green/falling/idle for the gradient-text variant.
  const headlineState: "green" | "falling" | "idle" = !lastRunAt
    ? "idle"
    : allGreen
    ? "green"
    : "falling";
  const headline =
    headlineState === "idle"
      ? "Idle."
      : headlineState === "green"
      ? "Live now."
      : "Falling.";

  return c.html(
    <Layout title="Synthetic monitor — admin" user={user}>
      <div class="status-wrap">
        {/* ─── Hero ─── */}
        <section class="status-hero">
          <div class="status-hero-orb" aria-hidden="true" />
          <div class="status-hero-inner">
            <div class="status-hero-top">
              <div class="status-hero-text">
                <div class="status-eyebrow">
                  <span class="status-eyebrow-pill" aria-hidden="true">
                    <IconPulse />
                  </span>
                  Synthetic monitor · Site admin · <span class="status-who">{user.username}</span>
                </div>
                <h1 class="status-title">
                  <span
                    class={
                      "status-title-grad " +
                      (headlineState === "falling"
                        ? "is-falling"
                        : headlineState === "idle"
                        ? "is-idle"
                        : "is-green")
                    }
                  >
                    {headline}
                  </span>
                </h1>
                <p class="status-sub">
                  {allGreen
                    ? "All synthetic checks are green. Runs every autopilot tick."
                    : `${redCount} check${redCount === 1 ? "" : "s"} red — see the table below for the failing rows.`}{" "}
                  Last run{" "}
                  <span data-last-run-at class="status-tabular">
                    {fmtAgo(lastRunAt ?? undefined)}
                  </span>
                  .
                </p>
              </div>
              <a href="/admin" class="status-hero-back">
                <IconArrowLeft />
                Back to admin
              </a>
            </div>
          </div>
        </section>

        {/* ─── Live SSE banner ─── */}
        <div
          class="status-live"
          role="status"
          aria-live="polite"
          data-sse-banner
        >
          <span class="status-live-dot" aria-hidden="true" />
          <span class="status-live-label" data-sse-state>
            SSE connecting…
          </span>
          <span class="status-live-sep" aria-hidden="true">·</span>
          <span class="status-live-rate">
            <span class="status-tabular" data-sse-rate>0</span> events / min
          </span>
          <span class="status-live-sep" aria-hidden="true">·</span>
          <span class="status-live-topic">
            topic <code>{SSE_TOPIC}</code>
          </span>
        </div>

        {/* ─── Synthetic-check table ─── */}
        <section class="status-section">
          <header class="status-section-head">
            <div class="status-section-head-text">
              <h3 class="status-section-title">Synthetic checks</h3>
              <p class="status-section-sub">
                {SYNTHETIC_CHECKS.length} probes — every row patches in place
                as the SSE stream fires.
              </p>
            </div>
            <form action="/admin/status/run" method="post" class="status-runform">
              <button type="submit" class="status-btn status-btn-primary">
                <IconPlay />
                Run all checks now
              </button>
            </form>
          </header>
          <div class="status-section-body status-section-body--flush">
            <table class="status-table" id="synthetic-table">
              <thead>
                <tr>
                  <th class="status-col-dot"></th>
                  <th class="status-col-name">Check</th>
                  <th class="status-col-num">Status</th>
                  <th class="status-col-num">Duration</th>
                  <th class="status-col-when">Last run</th>
                </tr>
              </thead>
              <tbody>
                {SYNTHETIC_CHECKS.map((spec) => {
                  const row = latest[spec.name];
                  return (
                    <tr data-check-name={spec.name}>
                      <td class="status-col-dot" data-cell="dot">
                        <span
                          class={"status-dot " + dotClass(row?.status)}
                          aria-label={row?.status ?? "idle"}
                        />
                      </td>
                      <td class="status-col-name">
                        <code class="status-action">{spec.name}</code>
                        {row?.error ? (
                          <div class="status-error" data-cell="error">
                            {row.error}
                          </div>
                        ) : null}
                      </td>
                      <td class="status-col-num status-tabular" data-cell="status-code">
                        {row?.statusCode ?? "—"}
                      </td>
                      <td class="status-col-num status-tabular" data-cell="duration">
                        {row ? `${row.durationMs}ms` : "—"}
                      </td>
                      <td class="status-col-when status-tabular" data-cell="ago">
                        {fmtAgo(row?.checkedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* ─── Recent activity feed (red checks in last 24h) ─── */}
        <section class="status-section">
          <header class="status-section-head">
            <div class="status-section-head-text">
              <h3 class="status-section-title">Recent activity</h3>
              <p class="status-section-sub">
                Red checks in the last 24 hours — most recent first.
              </p>
            </div>
          </header>
          <div class="status-section-body status-section-body--flush">
            {recent.length === 0 ? (
              <div class="status-empty">
                No red checks in the last 24 hours.
              </div>
            ) : (
              <ol class="status-feed" aria-label="Recent red checks">
                {recent.map((r) => (
                  <li class="status-feed-row">
                    <span
                      class="status-feed-when status-tabular"
                      title={r.checkedAt.toISOString()}
                    >
                      {fmtAgo(r.checkedAt)}
                    </span>
                    <span class="status-feed-action">
                      <span class="status-dot is-red" aria-hidden="true" />
                      <code>red</code>
                    </span>
                    <a
                      class="status-feed-target"
                      href={`#check-${r.name}`}
                      onclick={`var t=document.querySelector('tr[data-check-name="${r.name}"]');if(t){t.scrollIntoView({behavior:'smooth',block:'center'});t.classList.add('status-row-flash');setTimeout(function(){t.classList.remove('status-row-flash');},1600);}`}
                    >
                      {r.name}
                    </a>
                    <span class="status-feed-msg">
                      {r.error || "(no error message)"}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        {/* Live update via SSE. Each event is a SyntheticCheckResult; we
            patch the matching <tr data-check-name=...> in place. The
            banner counts events received in the last 60s. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
(function() {
  var bannerLabel = document.querySelector('[data-sse-state]');
  var bannerRate  = document.querySelector('[data-sse-rate]');
  var bannerEl    = document.querySelector('[data-sse-banner]');
  var eventTimes = [];
  function setBanner(state, cls) {
    if (bannerLabel) bannerLabel.textContent = state;
    if (bannerEl) {
      bannerEl.classList.remove('is-on','is-off','is-connecting');
      bannerEl.classList.add(cls);
    }
  }
  function tickRate() {
    var cutoff = Date.now() - 60000;
    while (eventTimes.length && eventTimes[0] < cutoff) eventTimes.shift();
    if (bannerRate) bannerRate.textContent = String(eventTimes.length);
  }
  setBanner('SSE connecting…', 'is-connecting');
  setInterval(tickRate, 1000);
  try {
    var src = new EventSource('/live-events/${SSE_TOPIC}');
    src.onopen = function(){ setBanner('SSE connected', 'is-on'); };
    src.onerror = function(){ setBanner('SSE reconnecting…', 'is-connecting'); };
    src.addEventListener('check', function(ev) {
      eventTimes.push(Date.now()); tickRate();
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      var row = document.querySelector('tr[data-check-name="' + data.name + '"]');
      if (!row) return;
      var dot = row.querySelector('[data-cell="dot"]');
      var statusCode = row.querySelector('[data-cell="status-code"]');
      var duration = row.querySelector('[data-cell="duration"]');
      var ago = row.querySelector('[data-cell="ago"]');
      if (dot) {
        var span = dot.querySelector('.status-dot');
        var cls = data.status === 'green' ? 'is-green'
                : data.status === 'red'   ? 'is-red'
                : data.status === 'yellow'? 'is-yellow' : 'is-idle';
        if (span) { span.className = 'status-dot ' + cls; }
      }
      if (statusCode) statusCode.textContent = data.statusCode != null ? String(data.statusCode) : '—';
      if (duration) duration.textContent = data.durationMs + 'ms';
      if (ago) ago.textContent = 'just now';
      var lastRun = document.querySelector('[data-last-run-at]');
      if (lastRun) lastRun.textContent = 'just now';
      row.classList.add('status-row-flash');
      setTimeout(function(){ row.classList.remove('status-row-flash'); }, 1100);
    });
  } catch (e) {
    setBanner('SSE unavailable', 'is-off');
  }
})();
`,
          }}
        />
      </div>
      <style dangerouslySetInnerHTML={{ __html: STATUS_CSS }} />
    </Layout>
  );
});

adminStatus.post("/admin/status/run", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;

  // Fire-and-forget the run so we don't block the redirect on a slow
  // network. Persist + SSE happens inside the helper.
  void (async () => {
    try {
      const results = await runSyntheticChecks();
      await persistChecks(results);
    } catch (err) {
      console.error("[admin-status] manual run failed:", err);
    }
  })();

  return c.redirect("/admin/status");
});

// ---------------------------------------------------------------------------
// Scoped CSS — every class prefixed `.status-` so the synthetic-monitor
// surface can't bleed into other admin pages. Mirrors the gradient-hairline
// hero + section-card motif from admin-ops / admin-deploys-page.
// ---------------------------------------------------------------------------

const STATUS_CSS = `
  .status-wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }
  .status-tabular { font-variant-numeric: tabular-nums; }

  /* ─── Hero ─── */
  .status-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .status-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .status-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(52,211,153,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .status-hero-inner { position: relative; z-index: 1; }
  .status-hero-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .status-hero-text { flex: 1; min-width: 280px; }
  .status-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 14px;
    letter-spacing: 0.02em;
  }
  .status-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.35);
  }
  .status-who { color: var(--accent); font-weight: 600; }
  .status-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .status-title-grad {
    background-image: linear-gradient(135deg, #6ee7b7 0%, #34d399 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .status-title-grad.is-falling {
    background-image: linear-gradient(135deg, #fca5a5 0%, #f87171 50%, #ef4444 100%);
  }
  .status-title-grad.is-idle {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
  }
  .status-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 640px;
  }
  .status-hero-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    font-size: 12.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 8px;
    text-decoration: none;
    font-weight: 500;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
    flex-shrink: 0;
  }
  .status-hero-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* ─── Live SSE banner ─── */
  .status-live {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    margin-bottom: var(--space-4);
    background: rgba(52,211,153,0.05);
    border: 1px solid rgba(52,211,153,0.22);
    border-radius: 10px;
    font-size: 12.5px;
    color: var(--text);
    flex-wrap: wrap;
  }
  .status-live.is-connecting {
    background: rgba(251,191,36,0.05);
    border-color: rgba(251,191,36,0.22);
    color: #fde68a;
  }
  .status-live.is-off {
    background: rgba(248,113,113,0.06);
    border-color: rgba(248,113,113,0.25);
    color: #fecaca;
  }
  .status-live-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: #34d399;
    box-shadow: 0 0 0 3px rgba(52,211,153,0.20);
    animation: status-pulse 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }
  .status-live.is-connecting .status-live-dot {
    background: #fbbf24;
    box-shadow: 0 0 0 3px rgba(251,191,36,0.22);
  }
  .status-live.is-off .status-live-dot {
    background: #f87171;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.22);
    animation: none;
  }
  @keyframes status-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.55; transform: scale(0.85); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-live-dot { animation: none; }
  }
  .status-live-label {
    font-family: var(--font-mono);
    font-size: 12px;
    color: inherit;
    font-weight: 600;
  }
  .status-live-rate { color: inherit; }
  .status-live-topic {
    color: var(--text-muted);
    margin-left: auto;
    font-size: 11.5px;
  }
  .status-live-topic code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text);
  }
  .status-live-sep { color: var(--text-muted); opacity: 0.45; }

  /* ─── Section cards ─── */
  .status-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .status-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .status-section-head-text { flex: 1; min-width: 240px; }
  .status-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .status-section-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .status-section-body { padding: var(--space-4) var(--space-5); }
  .status-section-body--flush { padding: 0; }

  .status-runform { margin: 0; }
  .status-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
  }
  .status-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .status-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
  }

  /* ─── Synthetic table ─── */
  .status-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .status-table thead th {
    padding: 10px 14px;
    text-align: left;
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    background: rgba(255,255,255,0.012);
    border-bottom: 1px solid var(--border);
  }
  .status-table tbody td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .status-table tbody tr:last-child td { border-bottom: 0; }
  .status-table tbody tr {
    transition: background 200ms ease;
  }
  .status-table tbody tr:hover {
    background: rgba(255,255,255,0.022);
  }
  .status-table .status-col-dot { width: 30px; }
  .status-table .status-col-num { width: 90px; }
  .status-table .status-col-when { width: 110px; color: var(--text-muted); }
  .status-row-flash {
    background: rgba(140,109,255,0.10) !important;
    animation: status-flash 1.1s ease-out;
  }
  @keyframes status-flash {
    0%   { background: rgba(140,109,255,0.30); }
    100% { background: rgba(140,109,255,0.00); }
  }

  .status-action {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-strong);
    background: linear-gradient(135deg, rgba(140,109,255,0.10), rgba(54,197,214,0.06));
    border: 1px solid rgba(140,109,255,0.20);
    padding: 2px 8px;
    border-radius: 5px;
  }
  .status-error {
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: #fca5a5;
    line-height: 1.4;
  }

  .status-dot {
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 9999px;
    background: var(--text-muted);
    box-shadow: 0 0 0 3px rgba(255,255,255,0.04);
    vertical-align: middle;
  }
  .status-dot.is-green {
    background: #34d399;
    box-shadow: 0 0 0 3px rgba(52,211,153,0.18), 0 0 8px rgba(52,211,153,0.40);
  }
  .status-dot.is-red {
    background: #f87171;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.20), 0 0 10px rgba(248,113,113,0.45);
    animation: status-pulse 1.6s ease-in-out infinite;
  }
  .status-dot.is-yellow {
    background: #fbbf24;
    box-shadow: 0 0 0 3px rgba(251,191,36,0.22);
  }
  .status-dot.is-idle { background: var(--text-muted); }
  @media (prefers-reduced-motion: reduce) {
    .status-dot.is-red { animation: none; }
  }

  /* ─── Feed ─── */
  .status-empty {
    padding: 22px 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
  .status-feed {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .status-feed-row {
    display: grid;
    grid-template-columns: 96px 84px minmax(140px, 220px) 1fr;
    gap: 14px;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .status-feed-row:last-child { border-bottom: 0; }
  .status-feed-row:hover { background: rgba(255,255,255,0.022); }
  .status-feed-when {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .status-feed-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #fca5a5;
  }
  .status-feed-action code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.28);
    padding: 1px 6px;
    border-radius: 4px;
    color: #fca5a5;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }
  .status-feed-target {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 8px;
    border-radius: 5px;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-feed-target:hover {
    background: rgba(140,109,255,0.10);
    border-color: rgba(140,109,255,0.40);
    color: var(--text-strong);
    text-decoration: none;
  }
  .status-feed-msg {
    color: var(--text-muted);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── 403 fallback ─── */
  .status-403 {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .status-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .status-403 p { color: var(--text-muted); margin: 0; font-size: 14px; }

  @media (max-width: 720px) {
    .status-wrap { padding: var(--space-4) var(--space-3) var(--space-8); }
    .status-feed-row {
      grid-template-columns: 96px 84px 1fr;
      grid-template-areas:
        'when action target'
        'when action msg';
    }
    .status-feed-msg { grid-column: 3 / 4; }
    .status-live-topic { margin-left: 0; }
  }
`;

export default adminStatus;

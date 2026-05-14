/**
 * BLOCK S4 — Site-admin synthetic-monitor dashboard.
 *
 *   GET  /admin/status      — red/green dashboard (SSE-live)
 *   POST /admin/status/run  — run the suite synchronously
 *
 * Both gated behind `isSiteAdmin`. The public `/status` page (see
 * `src/routes/status.tsx`) stays open to everyone; this is the detailed
 * 14-row health table for the owner.
 */

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

function statusDot(status: SyntheticCheckResult["status"] | undefined): string {
  if (status === "green") return "\u{1F7E2}"; // green circle
  if (status === "red") return "\u{1F534}"; // red circle
  if (status === "yellow") return "\u{1F7E1}"; // yellow circle
  return "⚪"; // white circle — never run
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

adminStatus.get("/admin/status", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const latest = await latestStatusByCheck();
  const recent = await recentRedChecks(24, 25);

  const allGreen = SYNTHETIC_CHECKS.every(
    (spec) => latest[spec.name]?.status === "green"
  );

  // Find the most-recent checkedAt across all rows so we can render the
  // "last run Xs ago" badge.
  let lastRunAt: Date | null = null;
  for (const spec of SYNTHETIC_CHECKS) {
    const row = latest[spec.name];
    if (!row) continue;
    if (!lastRunAt || row.checkedAt > lastRunAt) lastRunAt = row.checkedAt;
  }

  return c.html(
    <Layout title="Synthetic monitor — admin" user={user}>
      <div style="max-width: 960px; margin: 0 auto; padding: 24px 16px">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px">
          <span
            style={`display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: ${allGreen ? "var(--green, #2da44e)" : "var(--red, #cf222e)"}`}
          />
          <h1 style="margin: 0; font-size: 26px">
            {allGreen ? "All checks green" : "One or more checks failing"}
          </h1>
        </div>
        <p style="color: var(--text-muted); margin-bottom: 24px">
          Synthetic monitor — runs every autopilot tick. Last run{" "}
          <span data-last-run-at>{fmtAgo(lastRunAt)}</span>.
        </p>

        <div class="panel" style="margin-bottom: 20px">
          <table
            style="width: 100%; border-collapse: collapse; font-size: 14px"
            id="synthetic-table"
          >
            <thead>
              <tr style="text-align: left; color: var(--text-muted); font-size: 12px; text-transform: uppercase">
                <th style="padding: 8px 12px; width: 28px"></th>
                <th style="padding: 8px 12px">Check</th>
                <th style="padding: 8px 12px; width: 80px">Status</th>
                <th style="padding: 8px 12px; width: 90px">Duration</th>
                <th style="padding: 8px 12px; width: 110px">Last run</th>
              </tr>
            </thead>
            <tbody>
              {SYNTHETIC_CHECKS.map((spec) => {
                const row = latest[spec.name];
                return (
                  <tr
                    data-check-name={spec.name}
                    style="border-top: 1px solid var(--border)"
                  >
                    <td
                      style="padding: 8px 12px"
                      data-cell="dot"
                    >
                      {statusDot(row?.status)}
                    </td>
                    <td style="padding: 8px 12px">
                      <code>{spec.name}</code>
                      {row?.error ? (
                        <div
                          style="font-size: 11px; color: var(--red, #cf222e); margin-top: 2px"
                          data-cell="error"
                        >
                          {row.error}
                        </div>
                      ) : null}
                    </td>
                    <td style="padding: 8px 12px" data-cell="status-code">
                      {row?.statusCode ?? "—"}
                    </td>
                    <td style="padding: 8px 12px" data-cell="duration">
                      {row ? `${row.durationMs}ms` : "—"}
                    </td>
                    <td
                      style="padding: 8px 12px; color: var(--text-muted)"
                      data-cell="ago"
                    >
                      {fmtAgo(row?.checkedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <form
          action="/admin/status/run"
          method="post"
          style="margin-bottom: 32px"
        >
          <button class="btn-primary" type="submit">
            Run all checks now
          </button>
        </form>

        <h2 style="font-size: 16px; margin-bottom: 12px">
          Recent red checks (last 24h)
        </h2>
        {recent.length === 0 ? (
          <p style="color: var(--text-muted); font-size: 13px">
            No red checks in the last 24 hours.
          </p>
        ) : (
          <div class="panel">
            {recent.map((r) => (
              <div
                class="panel-item"
                style="justify-content: space-between; font-size: 13px"
              >
                <div>
                  <code>{r.name}</code>{" "}
                  <span style="color: var(--text-muted)">
                    — {r.error || "(no error message)"}
                  </span>
                </div>
                <span style="color: var(--text-muted); font-size: 12px">
                  {fmtAgo(r.checkedAt)}
                </span>
              </div>
            ))}
          </div>
        )}

        <script
          // Live update via SSE. Each event is a SyntheticCheckResult; we
          // patch the matching <tr data-check-name=...> in place.
          dangerouslySetInnerHTML={{
            __html: `
(function() {
  try {
    var src = new EventSource('/live-events/${SSE_TOPIC}');
    src.addEventListener('check', function(ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      var row = document.querySelector('tr[data-check-name="' + data.name + '"]');
      if (!row) return;
      var dot = row.querySelector('[data-cell="dot"]');
      var statusCode = row.querySelector('[data-cell="status-code"]');
      var duration = row.querySelector('[data-cell="duration"]');
      var ago = row.querySelector('[data-cell="ago"]');
      if (dot) dot.textContent = data.status === 'green' ? '\\uD83D\\uDFE2' : (data.status === 'red' ? '\\uD83D\\uDD34' : '\\uD83D\\uDFE1');
      if (statusCode) statusCode.textContent = data.statusCode != null ? String(data.statusCode) : '\\u2014';
      if (duration) duration.textContent = data.durationMs + 'ms';
      if (ago) ago.textContent = 'just now';
      var lastRun = document.querySelector('[data-last-run-at]');
      if (lastRun) lastRun.textContent = 'just now';
    });
  } catch (e) { /* SSE not available — page still renders the SSR snapshot */ }
})();
`,
          }}
        />
      </div>
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

export default adminStatus;

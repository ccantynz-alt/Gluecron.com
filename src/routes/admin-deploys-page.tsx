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
import { desc } from "drizzle-orm";
import { db } from "../db";
import { platformDeploys } from "../db/schema-deploys";
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
    </Layout>
  );
});

export const __test = {
  relativeTime,
  shortSha,
  formatDuration,
  fetchLatest,
  serialise,
};

export default page;

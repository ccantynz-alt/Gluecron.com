/**
 * Public /status — human-readable platform health dashboard.
 *
 * Unlike /healthz (LB liveness JSON) and /readyz (DB readiness JSON),
 * /status renders a full HTML page anyone can load. Shows DB reachability,
 * autopilot state, totals (users/repos/gate runs), and the most recent
 * autopilot tick's task breakdown.
 *
 * Accessible without auth. Uses softAuth so the nav bar renders correctly
 * for logged-in visitors.
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { users, repositories, gateRuns } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getLastTick, getTickCount } from "../lib/autopilot";

const status = new Hono<AuthEnv>();
status.use("*", softAuth);

const started = Date.now();

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

status.get("/status", async (c) => {
  const user = c.get("user");

  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  let userCount = 0;
  let repoCount = 0;
  let publicRepoCount = 0;
  let gateRunCount = 0;
  let greenRate: number | null = null;
  try {
    const [u] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    userCount = Number(u?.n ?? 0);
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(repositories);
    repoCount = Number(r?.n ?? 0);
    const [pr] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(repositories)
      .where(sql`${repositories.isPrivate} = false`);
    publicRepoCount = Number(pr?.n ?? 0);
    const [gr] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gateRuns);
    gateRunCount = Number(gr?.n ?? 0);
    if (gateRunCount > 0) {
      const [g] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(gateRuns)
        .where(sql`${gateRuns.status} IN ('passed','repaired')`);
      greenRate = (Number(g?.n ?? 0) / gateRunCount) * 100;
    }
  } catch {
    // counts stay 0
  }

  const tick = getLastTick();
  const ticks = getTickCount();
  const autopilotDisabled = process.env.AUTOPILOT_DISABLED === "1";
  const uptimeMs = Date.now() - started;

  const overallOk = dbOk;

  return c.html(
    <Layout title="Status — gluecron" user={user}>
      <div style="max-width: 960px; margin: 0 auto; padding: 24px 16px">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px">
          <span
            style={`display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: ${overallOk ? "var(--green, #2da44e)" : "var(--red, #cf222e)"}`}
          />
          <h1 style="margin: 0; font-size: 28px">
            {overallOk ? "All systems operational" : "Service degraded"}
          </h1>
        </div>
        <p style="color: var(--text-muted); margin-bottom: 32px">
          Live platform status. Reloads on refresh; no client-side polling.
        </p>

        <h2 style="margin-bottom: 12px; font-size: 18px">Components</h2>
        <div class="panel" style="margin-bottom: 24px">
          <div
            class="panel-item"
            style="justify-content: space-between; align-items: center"
          >
            <div>
              <strong>Database</strong>
              <div style="font-size: 12px; color: var(--text-muted)">
                Neon PostgreSQL
              </div>
            </div>
            <span
              style={`padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: ${dbOk ? "rgba(45, 164, 78, 0.15)" : "rgba(207, 34, 46, 0.15)"}; color: ${dbOk ? "var(--green, #2da44e)" : "var(--red, #cf222e)"}`}
            >
              {dbOk ? "operational" : "down"}
            </span>
          </div>
          <div
            class="panel-item"
            style="justify-content: space-between; align-items: center"
          >
            <div>
              <strong>Autopilot</strong>
              <div style="font-size: 12px; color: var(--text-muted)">
                Periodic platform-maintenance loop
              </div>
            </div>
            <span
              style={`padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: ${autopilotDisabled ? "rgba(150, 150, 150, 0.15)" : "rgba(45, 164, 78, 0.15)"}; color: ${autopilotDisabled ? "var(--text-muted)" : "var(--green, #2da44e)"}`}
            >
              {autopilotDisabled ? "disabled" : "running"}
            </span>
          </div>
          <div
            class="panel-item"
            style="justify-content: space-between; align-items: center"
          >
            <div>
              <strong>Git Smart HTTP</strong>
              <div style="font-size: 12px; color: var(--text-muted)">
                Clone, fetch, push
              </div>
            </div>
            <span style="padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: rgba(45, 164, 78, 0.15); color: var(--green, #2da44e)">
              operational
            </span>
          </div>
        </div>

        <h2 style="margin-bottom: 12px; font-size: 18px">Platform stats</h2>
        <div
          style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px"
        >
          <div class="panel" style="padding: 14px; text-align: center">
            <div style="font-size: 24px; font-weight: 700">
              {userCount.toLocaleString()}
            </div>
            <div
              style="font-size: 11px; color: var(--text-muted); text-transform: uppercase"
            >
              Developers
            </div>
          </div>
          <div class="panel" style="padding: 14px; text-align: center">
            <div style="font-size: 24px; font-weight: 700">
              {repoCount.toLocaleString()}
            </div>
            <div
              style="font-size: 11px; color: var(--text-muted); text-transform: uppercase"
            >
              Repositories
            </div>
          </div>
          <div class="panel" style="padding: 14px; text-align: center">
            <div style="font-size: 24px; font-weight: 700">
              {publicRepoCount.toLocaleString()}
            </div>
            <div
              style="font-size: 11px; color: var(--text-muted); text-transform: uppercase"
            >
              Public repos
            </div>
          </div>
          <div class="panel" style="padding: 14px; text-align: center">
            <div style="font-size: 24px; font-weight: 700">
              {gateRunCount.toLocaleString()}
            </div>
            <div
              style="font-size: 11px; color: var(--text-muted); text-transform: uppercase"
            >
              Gate runs
            </div>
          </div>
          <div class="panel" style="padding: 14px; text-align: center">
            <div style="font-size: 24px; font-weight: 700">
              {greenRate === null ? "—" : `${greenRate.toFixed(1)}%`}
            </div>
            <div
              style="font-size: 11px; color: var(--text-muted); text-transform: uppercase"
            >
              Green rate
            </div>
          </div>
          <div class="panel" style="padding: 14px; text-align: center">
            <div style="font-size: 24px; font-weight: 700">
              {fmtUptime(uptimeMs)}
            </div>
            <div
              style="font-size: 11px; color: var(--text-muted); text-transform: uppercase"
            >
              Uptime
            </div>
          </div>
        </div>

        <h2 style="margin-bottom: 12px; font-size: 18px">
          Latest autopilot tick
        </h2>
        {tick ? (
          <div class="panel" style="margin-bottom: 24px">
            <div
              class="panel-item"
              style="justify-content: space-between; font-size: 13px"
            >
              <span>Finished</span>
              <code>{tick.finishedAt}</code>
            </div>
            <div
              class="panel-item"
              style="justify-content: space-between; font-size: 13px"
            >
              <span>Total ticks this process</span>
              <code>{ticks}</code>
            </div>
            {tick.tasks.map((t) => (
              <div
                class="panel-item"
                style="justify-content: space-between; font-size: 13px"
              >
                <code>{t.name}</code>
                <span
                  style={
                    t.ok
                      ? "color: var(--green, #2da44e)"
                      : "color: var(--red, #cf222e)"
                  }
                >
                  {t.ok ? "ok" : `failed: ${t.error || "unknown"}`}
                  <span
                    style="color: var(--text-muted); margin-left: 8px"
                  >
                    {t.durationMs}ms
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p
            style="color: var(--text-muted); margin-bottom: 24px; font-size: 14px"
          >
            {autopilotDisabled
              ? "Autopilot is disabled via AUTOPILOT_DISABLED=1."
              : "No ticks have completed yet. Check back after the first 5-minute interval elapses."}
          </p>
        )}

        <p
          style="color: var(--text-muted); font-size: 12px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border)"
        >
          Liveness: <a href="/healthz">/healthz</a> &middot; Readiness:{" "}
          <a href="/readyz">/readyz</a> &middot; Metrics:{" "}
          <a href="/metrics">/metrics</a> &middot; Platform JSON:{" "}
          <a href="/api/platform-status">/api/platform-status</a>
        </p>
      </div>
    </Layout>
  );
});

/**
 * Shields-style status badge. Reads the latest autopilot tick + DB
 * reachability and returns an SVG. Embed in READMEs with:
 *   ![status](https://your-host/status.svg)
 */
status.get("/status.svg", async (c) => {
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const tick = getLastTick();
  const lastOk = tick ? tick.tasks.every((t) => t.ok) : true;
  const overall = dbOk && lastOk;
  const label = "gluecron";
  const value = overall ? "operational" : "degraded";
  const fill = overall ? "#2da44e" : "#cf222e";

  const labelW = 70;
  const valueW = overall ? 78 : 68;
  const totalW = labelW + valueW;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${value}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <rect width="${totalW}" height="20" rx="3" fill="#555"/>
  <rect x="${labelW}" width="${valueW}" height="20" rx="3" fill="${fill}"/>
  <rect width="${totalW}" height="20" rx="3" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15">${label}</text>
    <text x="${labelW + valueW / 2}" y="15">${value}</text>
  </g>
</svg>`;
  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  c.header("Cache-Control", "no-cache, max-age=0");
  return c.body(svg);
});

export default status;

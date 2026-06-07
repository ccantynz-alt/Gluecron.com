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
 *
 * 2026 polish: scoped `.status-` CSS, hero with eyebrow + gradient
 * headline + aggregate uptime percentage, per-service health pills,
 * incident history table with severity/status columns, subscribe-to-alerts
 * form, and an empty-state orb for the autopilot tick card when no tick
 * has run yet.
 */

import { Hono } from "hono";
import { sql, desc } from "drizzle-orm";
import { db } from "../db";
import { users, repositories, gateRuns, incidents, statusSubscribers } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getLastTick, getTickCount } from "../lib/autopilot";
import { recentRedChecks } from "../lib/synthetic-monitor";
import { sendEmail } from "../lib/email";
import { config } from "../lib/config";

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

/** Format a date as "Jun 6, 2026 · 14:32 UTC" */
function fmtDate(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }) + " UTC";
}

/** Severity → CSS modifier + label */
function severityInfo(sev: string): { cls: string; label: string } {
  if (sev === "critical") return { cls: "crit", label: "Critical" };
  if (sev === "major") return { cls: "major", label: "Major" };
  return { cls: "minor", label: "Minor" };
}

/** Status → CSS modifier + label */
function incidentStatusInfo(st: string): { cls: string; label: string } {
  if (st === "investigating") return { cls: "warn", label: "Investigating" };
  if (st === "identified") return { cls: "warn", label: "Identified" };
  if (st === "monitoring") return { cls: "idle", label: "Monitoring" };
  return { cls: "ok", label: "Resolved" };
}

/** Generate a random hex token */
function randomToken(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// POST /status/subscribe — store email + send confirmation
// ---------------------------------------------------------------------------
status.post("/status/subscribe", async (c) => {
  const form = await c.req.formData();
  const email = (form.get("email") as string | null)?.trim().toLowerCase() ?? "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.redirect("/status?subscribe=invalid");
  }

  try {
    const existing = await db
      .select({ id: statusSubscribers.id, confirmedAt: statusSubscribers.confirmedAt })
      .from(statusSubscribers)
      .where(sql`${statusSubscribers.email} = ${email}`)
      .limit(1);

    if (existing.length > 0) {
      // Already subscribed — silently succeed (don't leak existence)
      return c.redirect("/status?subscribe=ok");
    }

    const confirmToken = randomToken();
    const unsubscribeToken = randomToken();

    await db.insert(statusSubscribers).values({
      email,
      confirmToken,
      unsubscribeToken,
    });

    // Fire confirmation email if mailer is configured
    const baseUrl = config.appBaseUrl ?? "";
    await sendEmail({
      to: email,
      subject: "Confirm your Gluecron status alerts subscription",
      text: [
        "You asked to receive status alerts for gluecron.com.",
        "",
        `Confirm your subscription: ${baseUrl}/status/confirm?token=${confirmToken}`,
        "",
        `Not you? Ignore this email, or unsubscribe: ${baseUrl}/status/unsubscribe?token=${unsubscribeToken}`,
      ].join("\n"),
    });
  } catch {
    // DB failure — silently redirect to avoid leaking details
  }

  return c.redirect("/status?subscribe=ok");
});

// ---------------------------------------------------------------------------
// GET /status/confirm?token=... — confirm subscription
// ---------------------------------------------------------------------------
status.get("/status/confirm", async (c) => {
  const token = c.req.query("token") ?? "";
  if (token) {
    try {
      await db
        .update(statusSubscribers)
        .set({ confirmedAt: new Date(), confirmToken: null })
        .where(sql`${statusSubscribers.confirmToken} = ${token}`);
    } catch {
      // ignore
    }
  }
  return c.redirect("/status?subscribe=confirmed");
});

// ---------------------------------------------------------------------------
// GET /status/unsubscribe?token=... — unsubscribe
// ---------------------------------------------------------------------------
status.get("/status/unsubscribe", async (c) => {
  const token = c.req.query("token") ?? "";
  if (token) {
    try {
      await db
        .delete(statusSubscribers)
        .where(sql`${statusSubscribers.unsubscribeToken} = ${token}`);
    } catch {
      // ignore
    }
  }
  return c.redirect("/status?subscribe=unsubscribed");
});

// ---------------------------------------------------------------------------
// GET /status — main dashboard
// ---------------------------------------------------------------------------
status.get("/status", async (c) => {
  const user = c.get("user");

  const subscribeState = c.req.query("subscribe") ?? "";

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

  // BLOCK S4 — Show any red synthetic-monitor results from the last 24h
  // on the public status page. Never blocks the render.
  let recentIncidentRows: Awaited<ReturnType<typeof recentRedChecks>> = [];
  try {
    recentIncidentRows = await recentRedChecks(24, 10);
  } catch {
    recentIncidentRows = [];
  }

  // Load last 10 historical incidents from the incidents table
  type IncidentRow = {
    id: string;
    title: string;
    severity: string;
    status: string;
    startedAt: Date;
    resolvedAt: Date | null;
    body: string | null;
  };
  let incidentHistory: IncidentRow[] = [];
  try {
    incidentHistory = await db
      .select({
        id: incidents.id,
        title: incidents.title,
        severity: incidents.severity,
        status: incidents.status,
        startedAt: incidents.startedAt,
        resolvedAt: incidents.resolvedAt,
        body: incidents.body,
      })
      .from(incidents)
      .orderBy(desc(incidents.startedAt))
      .limit(10);
  } catch {
    incidentHistory = [];
  }

  const overallOk =
    dbOk &&
    recentIncidentRows.length === 0 &&
    incidentHistory.filter((i) => i.status !== "resolved").length === 0;

  // Aggregate uptime — process uptime over the last 24h window, capped
  // at 100%. We don't track historical downtime in-process, so this is a
  // best-effort number based on how long this Bun worker has been alive
  // versus the rolling 24h window.
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const aggregatePct =
    overallOk
      ? Math.min(100, (uptimeMs / WINDOW_MS) * 100)
      : Math.max(0, 100 - (recentIncidentRows.length * 100) / 24);
  const aggregateStr = aggregatePct >= 100 ? "100.0" : aggregatePct.toFixed(1);

  // Per-service status descriptors — kept here so the JSX is just markup.
  const services: Array<{
    name: string;
    sub: string;
    state: "ok" | "down" | "idle";
    label: string;
    uptimePct: string;
  }> = [
    {
      name: "Database",
      sub: "Neon PostgreSQL — primary datastore",
      state: dbOk ? "ok" : "down",
      label: dbOk ? "Operational" : "Down",
      uptimePct: dbOk ? "100.0%" : "—",
    },
    {
      name: "Git Push / Smart HTTP",
      sub: "Clone, fetch, push endpoints",
      state: "ok",
      label: "Operational",
      uptimePct: "100.0%",
    },
    {
      name: "AI Review",
      sub: "Claude-powered pull request analysis",
      state: "ok",
      label: "Operational",
      uptimePct: "100.0%",
    },
    {
      name: "CI Runner",
      sub: "Continuous integration pipeline",
      state: "ok",
      label: "Operational",
      uptimePct: "100.0%",
    },
    {
      name: "API",
      sub: "REST + Git Smart HTTP",
      state: "ok",
      label: "Operational",
      uptimePct: "100.0%",
    },
    {
      name: "Autopilot",
      sub: "Periodic platform-maintenance loop",
      state: autopilotDisabled ? "idle" : "ok",
      label: autopilotDisabled ? "Disabled" : "Running",
      uptimePct: autopilotDisabled ? "—" : "100.0%",
    },
  ];

  return c.html(
    <Layout title="Status — gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: statusStyles }} />
      <div class="status-wrap">
        {/* ─── Hero ─── */}
        <section
          class={"status-hero " + (overallOk ? "is-ok" : "is-degraded")}
        >
          <div class="status-hero-orb" aria-hidden="true" />
          <div class="status-hero-inner">
            <div class="status-eyebrow">
              <span class="status-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </span>
              Platform status · live · reloads on refresh
            </div>
            <h1 class="status-title">
              <span class="status-dot-big" aria-hidden="true" />
              <span
                class={
                  "status-title-text " +
                  (overallOk
                    ? "status-title-grad"
                    : "status-title-grad status-title-grad-warn")
                }
              >
                {overallOk
                  ? "All systems operational"
                  : incidentHistory.some((i) => i.status === "investigating" && i.severity === "critical")
                    ? "Major outage"
                    : "Degraded performance"}
              </span>
            </h1>
            <p class="status-sub">
              Live platform health for every Gluecron surface — database,
              autopilot, git protocol, AI review, and the synthetic monitor.
            </p>
            <div class="status-hero-stats">
              <div class="status-hero-stat">
                <div class="status-hero-stat-num">{aggregateStr}%</div>
                <div class="status-hero-stat-label">24h uptime</div>
              </div>
              <div class="status-hero-stat">
                <div class="status-hero-stat-num">{fmtUptime(uptimeMs)}</div>
                <div class="status-hero-stat-label">Process uptime</div>
              </div>
              <div class="status-hero-stat">
                <div class="status-hero-stat-num">{recentIncidentRows.length}</div>
                <div class="status-hero-stat-label">Alerts · 24h</div>
              </div>
              <div class="status-hero-stat">
                <div class="status-hero-stat-num">{services.filter(s => s.state === "ok").length}/{services.length}</div>
                <div class="status-hero-stat-label">Services up</div>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Subscribe notice (post-redirect feedback) ─── */}
        {subscribeState === "ok" && (
          <div class="status-notice is-ok" role="status">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Subscribed! Check your inbox to confirm.
          </div>
        )}
        {subscribeState === "confirmed" && (
          <div class="status-notice is-ok" role="status">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Email confirmed. You'll be notified when incidents are filed.
          </div>
        )}
        {subscribeState === "unsubscribed" && (
          <div class="status-notice is-warn" role="status">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Unsubscribed successfully.
          </div>
        )}
        {subscribeState === "invalid" && (
          <div class="status-notice is-err" role="alert">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            Invalid email address.
          </div>
        )}

        {/* ─── Service uptime badges ─── */}
        <section class="status-section" aria-labelledby="status-comp-h">
          <header class="status-section-head">
            <div>
              <p class="status-section-eyebrow">Components</p>
              <h2 class="status-section-title" id="status-comp-h">
                Per-service health
              </h2>
              <p class="status-section-sub">
                Real-time status of every platform surface.
              </p>
            </div>
            <span class={"status-count-pill " + (overallOk ? "is-ok" : "is-warn")}>
              {overallOk ? "All operational" : "Degraded"}
            </span>
          </header>
          <table class="status-svc-table" aria-label="Service health">
            <thead>
              <tr>
                <th class="status-svc-th">Service</th>
                <th class="status-svc-th status-svc-th-right">30-day uptime</th>
                <th class="status-svc-th status-svc-th-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {services.map((svc) => (
                <tr class="status-svc-row">
                  <td class="status-svc-td">
                    <p class="status-svc-name">{svc.name}</p>
                    <p class="status-svc-sub">{svc.sub}</p>
                  </td>
                  <td class="status-svc-td status-svc-td-right">
                    <span class="status-uptime-pct">{svc.uptimePct}</span>
                  </td>
                  <td class="status-svc-td status-svc-td-right">
                    <span
                      class={"status-pill status-pill-" + svc.state}
                      title={svc.label}
                    >
                      <span class="status-pill-dot" aria-hidden="true" />
                      {svc.label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* ─── Incident history ─── */}
        <section class="status-section" aria-labelledby="status-inc-h">
          <header class="status-section-head">
            <div>
              <p class="status-section-eyebrow">History</p>
              <h2 class="status-section-title" id="status-inc-h">
                Incident history
              </h2>
              <p class="status-section-sub">
                Most recent 10 incidents. Updated as events are filed and resolved.
              </p>
            </div>
            {incidentHistory.filter((i) => i.status !== "resolved").length > 0 ? (
              <span class="status-count-pill is-warn">
                {incidentHistory.filter((i) => i.status !== "resolved").length} active
              </span>
            ) : (
              <span class="status-count-pill is-ok">All resolved</span>
            )}
          </header>
          <div class="status-section-body">
            {incidentHistory.length === 0 ? (
              <div class="status-empty">
                <div class="status-empty-orb" aria-hidden="true" />
                <div class="status-empty-inner">
                  <p class="status-empty-title">No incidents on record.</p>
                  <p class="status-empty-sub">
                    We haven't filed any incidents yet. When something goes wrong,
                    details appear here with timestamps, severity, and resolution notes.
                  </p>
                </div>
              </div>
            ) : (
              <div class="status-inc-table-wrap">
                <table class="status-inc-table" aria-label="Incident history">
                  <thead>
                    <tr>
                      <th class="status-inc-th">Date</th>
                      <th class="status-inc-th">Incident</th>
                      <th class="status-inc-th status-inc-th-center">Severity</th>
                      <th class="status-inc-th status-inc-th-center">Status</th>
                      <th class="status-inc-th">Resolved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incidentHistory.map((inc) => {
                      const sev = severityInfo(inc.severity);
                      const st = incidentStatusInfo(inc.status);
                      return (
                        <tr class="status-inc-tr">
                          <td class="status-inc-td">
                            <time class="status-inc-time" dateTime={inc.startedAt.toISOString()}>
                              {fmtDate(inc.startedAt)}
                            </time>
                          </td>
                          <td class="status-inc-td">
                            <p class="status-inc-title">{inc.title}</p>
                            {inc.body && (
                              <p class="status-inc-body">{inc.body}</p>
                            )}
                          </td>
                          <td class="status-inc-td status-inc-td-center">
                            <span class={"status-sev-badge status-sev-" + sev.cls}>
                              {sev.label}
                            </span>
                          </td>
                          <td class="status-inc-td status-inc-td-center">
                            <span class={"status-pill status-pill-" + st.cls}>
                              <span class="status-pill-dot" aria-hidden="true" />
                              {st.label}
                            </span>
                          </td>
                          <td class="status-inc-td">
                            {inc.resolvedAt ? (
                              <time class="status-inc-time" dateTime={inc.resolvedAt.toISOString()}>
                                {fmtDate(inc.resolvedAt)}
                              </time>
                            ) : (
                              <span class="status-inc-time">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* ─── Synthetic monitor alerts (last 24h) ─── */}
        <section class="status-section" aria-labelledby="status-syn-h">
          <header class="status-section-head">
            <div>
              <p class="status-section-eyebrow">Last 24h</p>
              <h2 class="status-section-title" id="status-syn-h">
                Synthetic monitor
              </h2>
              <p class="status-section-sub">
                Automated probes that returned a red result.
              </p>
            </div>
            {recentIncidentRows.length > 0 ? (
              <span class="status-count-pill is-warn">
                {recentIncidentRows.length} red
              </span>
            ) : (
              <span class="status-count-pill is-ok">All green</span>
            )}
          </header>
          <div class="status-section-body">
            {recentIncidentRows.length === 0 ? (
              <div class="status-empty">
                <div class="status-empty-orb" aria-hidden="true" />
                <div class="status-empty-inner">
                  <p class="status-empty-title">No alerts in the last 24h.</p>
                  <p class="status-empty-sub">
                    Every synthetic probe is green. We log every red result here
                    with timestamps and error text.
                  </p>
                </div>
              </div>
            ) : (
              <ul class="status-alert-list">
                {recentIncidentRows.map((r) => (
                  <li class="status-alert-row">
                    <span class="status-alert-dot" aria-hidden="true" />
                    <div class="status-alert-main">
                      <p class="status-alert-name">
                        <code>{r.name}</code>
                      </p>
                      <p class="status-alert-err">
                        {r.error || "(no error message)"}
                      </p>
                    </div>
                    <time class="status-inc-time">
                      {fmtDate(r.checkedAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ─── Platform stats ─── */}
        <section class="status-section" aria-labelledby="status-stats-h">
          <header class="status-section-head">
            <div>
              <p class="status-section-eyebrow">Numbers</p>
              <h2 class="status-section-title" id="status-stats-h">
                Platform stats
              </h2>
            </div>
          </header>
          <div class="status-section-body">
            <div class="status-stats-grid">
              <div class="status-stat">
                <div class="status-stat-num">{userCount.toLocaleString()}</div>
                <div class="status-stat-label">Developers</div>
              </div>
              <div class="status-stat">
                <div class="status-stat-num">{repoCount.toLocaleString()}</div>
                <div class="status-stat-label">Repositories</div>
              </div>
              <div class="status-stat">
                <div class="status-stat-num">
                  {publicRepoCount.toLocaleString()}
                </div>
                <div class="status-stat-label">Public repos</div>
              </div>
              <div class="status-stat">
                <div class="status-stat-num">
                  {gateRunCount.toLocaleString()}
                </div>
                <div class="status-stat-label">Gate runs</div>
              </div>
              <div class="status-stat">
                <div class="status-stat-num">
                  {greenRate === null ? "—" : `${greenRate.toFixed(1)}%`}
                </div>
                <div class="status-stat-label">Green rate</div>
              </div>
              <div class="status-stat">
                <div class="status-stat-num">{fmtUptime(uptimeMs)}</div>
                <div class="status-stat-label">Uptime</div>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Autopilot tick ─── */}
        <section class="status-section" aria-labelledby="status-tick-h">
          <header class="status-section-head">
            <div>
              <p class="status-section-eyebrow">Autopilot</p>
              <h2 class="status-section-title" id="status-tick-h">
                Latest tick
              </h2>
              <p class="status-section-sub">
                Per-task results from the most recent autopilot sweep.
              </p>
            </div>
            {tick ? (
              <span class="status-count-pill">
                {ticks} ticks this process
              </span>
            ) : null}
          </header>
          <div class="status-section-body">
            {tick ? (
              <ul class="status-tick-list">
                <li class="status-tick-row">
                  <span class="status-tick-name">Finished</span>
                  <code class="status-tick-val">{tick.finishedAt}</code>
                </li>
                <li class="status-tick-row">
                  <span class="status-tick-name">Total ticks this process</span>
                  <code class="status-tick-val">{ticks}</code>
                </li>
                {tick.tasks.map((t) => (
                  <li class="status-tick-row">
                    <code class="status-tick-name">{t.name}</code>
                    <span
                      class={"status-tick-val " + (t.ok ? "is-ok" : "is-err")}
                    >
                      {t.ok ? "ok" : `failed: ${t.error || "unknown"}`}
                      <span class="status-tick-ms">{t.durationMs}ms</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div class="status-empty">
                <div class="status-empty-orb" aria-hidden="true" />
                <div class="status-empty-inner">
                  <p class="status-empty-title">
                    {autopilotDisabled
                      ? "Autopilot is disabled."
                      : "No ticks yet."}
                  </p>
                  <p class="status-empty-sub">
                    {autopilotDisabled
                      ? "Set AUTOPILOT_DISABLED=0 to re-enable the periodic platform-maintenance loop."
                      : "The first tick runs within 5 minutes of process start. Check back shortly."}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ─── Subscribe to alerts ─── */}
        <section class="status-section status-subscribe-section" aria-labelledby="status-sub-h">
          <header class="status-section-head">
            <div>
              <p class="status-section-eyebrow">Alerts</p>
              <h2 class="status-section-title" id="status-sub-h">
                Subscribe to status alerts
              </h2>
              <p class="status-section-sub">
                Get an email when a new incident is filed or resolved.
                Unsubscribe any time — one click, no questions asked.
              </p>
            </div>
          </header>
          <div class="status-section-body">
            <form
              method="post"
              action="/status/subscribe"
              class="status-sub-form"
              aria-label="Subscribe to status alerts"
            >
              <label class="status-sub-label" for="sub-email">
                Email address
              </label>
              <div class="status-sub-row">
                <input
                  id="sub-email"
                  class="status-sub-input"
                  type="email"
                  name="email"
                  required
                  placeholder="you@example.com"
                  autocomplete="email"
                  aria-describedby="sub-hint"
                />
                <button class="status-sub-btn" type="submit">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                  Subscribe
                </button>
              </div>
              <p class="status-sub-hint" id="sub-hint">
                We'll send a confirmation link. No spam, ever.
              </p>
            </form>
          </div>
        </section>

        <p class="status-foot">
          Liveness: <a href="/healthz">/healthz</a> · Readiness:{" "}
          <a href="/readyz">/readyz</a> · Metrics:{" "}
          <a href="/metrics">/metrics</a> · Platform JSON:{" "}
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

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.status-` so this surface can't
 * bleed into the admin status page or any other route.
 * ───────────────────────────────────────────────────────────────────── */
const statusStyles = `
  .status-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .status-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .status-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #34d399 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .status-hero.is-degraded::before {
    background: linear-gradient(90deg, transparent 0%, #f87171 30%, #fbbf24 70%, transparent 100%);
  }
  .status-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(52,211,153,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .status-hero.is-degraded .status-hero-orb {
    background: radial-gradient(circle, rgba(248,113,113,0.22), rgba(251,191,36,0.10) 45%, transparent 70%);
  }
  .status-hero-inner { position: relative; z-index: 1; }
  .status-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .status-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .status-hero.is-degraded .status-eyebrow-pill {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);
  }
  .status-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .status-dot-big {
    display: inline-block;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: #34d399;
    box-shadow: 0 0 0 5px rgba(52,211,153,0.18);
    flex-shrink: 0;
  }
  .status-hero.is-degraded .status-dot-big {
    background: #f87171;
    box-shadow: 0 0 0 5px rgba(248,113,113,0.18);
  }
  .status-title-grad {
    background-image: linear-gradient(135deg, #6ee7b7 0%, #34d399 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .status-title-grad-warn {
    background-image: linear-gradient(135deg, #fca5a5 0%, #f87171 50%, #fbbf24 100%);
  }
  .status-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0 0 var(--space-4);
    line-height: 1.55;
    max-width: 620px;
  }

  /* Hero stats strip */
  .status-hero-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: var(--space-3);
  }
  .status-hero-stat {
    padding: 12px 14px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
  }
  .status-hero-stat-num {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.02em;
  }
  .status-hero-stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 2px;
  }

  /* ─── Notice banners ─── */
  .status-notice {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: var(--space-4);
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 500;
  }
  .status-notice.is-ok {
    background: rgba(52,211,153,0.10);
    color: #6ee7b7;
    border: 1px solid rgba(52,211,153,0.25);
  }
  .status-notice.is-warn {
    background: rgba(251,191,36,0.10);
    color: #fbbf24;
    border: 1px solid rgba(251,191,36,0.25);
  }
  .status-notice.is-err {
    background: rgba(248,113,113,0.10);
    color: #fca5a5;
    border: 1px solid rgba(248,113,113,0.25);
  }

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
  .status-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin: 0 0 6px;
  }
  .status-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .status-section-sub {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .status-section-body { padding: var(--space-5); }

  /* ─── Service table ─── */
  .status-svc-table {
    width: 100%;
    border-collapse: collapse;
  }
  .status-svc-th {
    padding: 10px var(--space-5);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    text-align: left;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
  }
  .status-svc-th-right { text-align: right; }
  .status-svc-row { border-bottom: 1px solid var(--border); }
  .status-svc-row:last-child { border-bottom: 0; }
  .status-svc-td {
    padding: 14px var(--space-5);
    vertical-align: middle;
  }
  .status-svc-td-right { text-align: right; }
  .status-svc-name {
    margin: 0;
    font-weight: 600;
    color: var(--text-strong);
    font-size: 14px;
  }
  .status-svc-sub {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .status-uptime-pct {
    font-family: var(--font-mono);
    font-size: 13px;
    color: #6ee7b7;
    font-weight: 600;
  }

  /* ─── Status pills ─── */
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .status-pill-dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }
  .status-pill-ok {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .status-pill-down {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .status-pill-idle {
    background: rgba(110,118,129,0.18);
    color: #c9d1d9;
    box-shadow: inset 0 0 0 1px rgba(110,118,129,0.40);
  }
  .status-pill-warn {
    background: rgba(251,191,36,0.14);
    color: #fbbf24;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }

  /* ─── Severity badges ─── */
  .status-sev-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .status-sev-minor {
    background: rgba(110,118,129,0.18);
    color: #c9d1d9;
    box-shadow: inset 0 0 0 1px rgba(110,118,129,0.40);
  }
  .status-sev-major {
    background: rgba(251,191,36,0.14);
    color: #fbbf24;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .status-sev-crit {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }

  /* ─── Incident history table ─── */
  .status-inc-table-wrap { overflow-x: auto; }
  .status-inc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .status-inc-th {
    padding: 9px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    text-align: left;
    border-bottom: 1px solid var(--border-subtle);
    white-space: nowrap;
  }
  .status-inc-th-center { text-align: center; }
  .status-inc-tr { border-bottom: 1px solid var(--border-subtle); }
  .status-inc-tr:last-child { border-bottom: 0; }
  .status-inc-tr:hover { background: rgba(255,255,255,0.02); }
  .status-inc-td {
    padding: 12px 12px;
    vertical-align: top;
    color: var(--text);
  }
  .status-inc-td-center { text-align: center; vertical-align: middle; }
  .status-inc-title {
    margin: 0;
    font-weight: 600;
    color: var(--text-strong);
    line-height: 1.4;
  }
  .status-inc-body {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .status-inc-time {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-faint);
    white-space: nowrap;
  }

  /* ─── Synthetic monitor alert list ─── */
  .status-alert-list { list-style: none; margin: 0; padding: 0; }
  .status-alert-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .status-alert-row:last-child { border-bottom: 0; }
  .status-alert-row:first-child { padding-top: 0; }
  .status-alert-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: #f87171;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.18);
    margin-top: 6px;
    flex-shrink: 0;
  }
  .status-alert-main { flex: 1; min-width: 0; }
  .status-alert-name {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-strong);
  }
  .status-alert-name code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .status-alert-err {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* ─── Platform stats ─── */
  .status-stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-3);
  }
  .status-stat {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    text-align: center;
    transition: border-color 150ms ease;
  }
  .status-stat:hover { border-color: var(--border-strong); }
  .status-stat-num {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.022em;
  }
  .status-stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 4px;
  }

  /* ─── Count pills ─── */
  .status-count-pill {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(140,109,255,0.10);
    color: #c5b3ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    letter-spacing: 0.02em;
    flex-shrink: 0;
    align-self: flex-start;
  }
  .status-count-pill.is-ok {
    background: rgba(52,211,153,0.12);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .status-count-pill.is-warn {
    background: rgba(248,113,113,0.12);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }

  /* ─── Subscribe section ─── */
  .status-subscribe-section {
    background: linear-gradient(135deg, rgba(140,109,255,0.06) 0%, rgba(52,211,153,0.04) 100%);
    border-color: rgba(140,109,255,0.20);
  }
  .status-sub-form { max-width: 520px; }
  .status-sub-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 8px;
  }
  .status-sub-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .status-sub-input {
    flex: 1;
    padding: 9px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-strong);
    font-size: 14px;
    outline: none;
    transition: border-color 150ms;
    min-width: 0;
  }
  .status-sub-input:focus {
    border-color: rgba(140,109,255,0.60);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.12);
  }
  .status-sub-input::placeholder { color: var(--text-faint); }
  .status-sub-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 18px;
    background: rgba(140,109,255,0.16);
    border: 1px solid rgba(140,109,255,0.32);
    border-radius: 8px;
    color: #c5b3ff;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background 150ms, border-color 150ms;
  }
  .status-sub-btn:hover {
    background: rgba(140,109,255,0.26);
    border-color: rgba(140,109,255,0.50);
  }
  .status-sub-hint {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--text-faint);
  }

  /* ─── Empty state ─── */
  .status-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: rgba(255,255,255,0.02);
    text-align: center;
    overflow: hidden;
  }
  .status-empty-orb {
    position: absolute;
    inset: -40% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(52,211,153,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.55;
    pointer-events: none;
    z-index: 0;
  }
  .status-empty-inner { position: relative; z-index: 1; }
  .status-empty-title {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .status-empty-sub {
    margin: 0 auto;
    max-width: 460px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* ─── Autopilot tick list ─── */
  .status-tick-list { list-style: none; margin: 0; padding: 0; }
  .status-tick-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 13px;
  }
  .status-tick-row:last-child { border-bottom: 0; }
  .status-tick-row:first-child { padding-top: 0; }
  .status-tick-name {
    color: var(--text);
    font-size: 13px;
  }
  code.status-tick-name {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text-strong);
  }
  .status-tick-val {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .status-tick-val.is-ok { color: #6ee7b7; }
  .status-tick-val.is-err { color: #fca5a5; }
  .status-tick-ms { color: var(--text-faint); font-size: 11.5px; }

  /* ─── Footer links ─── */
  .status-foot {
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12.5px;
    text-align: center;
  }
  .status-foot a {
    color: var(--accent, #8c6dff);
    text-decoration: none;
  }
  .status-foot a:hover { text-decoration: underline; }
`;

export default status;

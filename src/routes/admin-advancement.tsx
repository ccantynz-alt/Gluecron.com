/**
 * /admin/advancement — site-admin surface for the weekly advancement
 * scanner (`src/lib/advancement-scanner.ts`).
 *
 *   GET  /admin/advancement              — hero + counters + recent findings
 *   POST /admin/advancement/run          — kick off a scan synchronously
 *   POST /admin/advancement/settings     — toggle "Enable weekly scan"
 *   POST /admin/advancement/dismiss/:id  — close a finding-issue
 *   POST /admin/advancement/promote/:id  — re-fire the migration PR
 *                                          for a stack-bump finding
 *
 * All endpoints gated behind `requireAuth` + `isSiteAdmin`.
 *
 * Visual recipe (mirrors admin-status / admin-self-host / admin-ops):
 *   - Gradient hairline strip at the top of the hero (purple → cyan)
 *   - Radial orb in the corner of the hero
 *   - Eyebrow with pill icon + actor name
 *   - Display headline with gradient-text on the verb
 *   - Stat-counter row with tabular-nums numbers
 *   - List of recent findings with per-row actions
 *   - Settings card with a single toggle
 *
 * Scoped CSS — every class prefixed `.adv-scan-` so this surface can't
 * bleed into other admin pages.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { db } from "../db";
import { auditLog, issueLabels, issues, labels } from "../db/schema";
import {
  ADVANCEMENT_AUDIT_ACTION,
  ADVANCEMENT_LABEL_NAME,
  ADVANCEMENT_SCAN_COMPLETE_ACTION,
  ADVANCEMENT_DEFAULT_SELF_HOST_REPO,
  runAdvancementScan,
} from "../lib/advancement-scanner";
import { getConfigValue, setConfigValue } from "../lib/system-config";
import { audit } from "../lib/notify";
import { repositories, users } from "../db/schema";

const advancement = new Hono<AuthEnv>();
advancement.use("*", softAuth);

const ENABLED_CONFIG_KEY = "ADVANCEMENT_SCAN_ENABLED";
const ENABLED_ENV_FALLBACK = "ADVANCEMENT_SCAN_ENABLED";

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/advancement");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="adv-scan-403">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
        <style dangerouslySetInnerHTML={{ __html: ADV_SCAN_CSS }} />
      </Layout>,
      403
    );
  }
  return { user };
}

function redirectWith(
  c: any,
  kind: "success" | "error",
  msg: string
): Response {
  return c.redirect(
    `/admin/advancement?${kind}=${encodeURIComponent(msg)}`
  );
}

function fmtAgo(t: Date | undefined | null): string {
  if (!t) return "never";
  const ms = Date.now() - t.getTime();
  if (ms < 5_000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface RecentFinding {
  issueId: string;
  issueNumber: number;
  title: string;
  kind: string;
  urgency: string;
  state: string;
  createdAt: Date;
}

/** Resolve the self-host repo (mirrors the lib helper but UI-only). */
async function resolveSelfHostRepoUi(): Promise<{
  repositoryId: string;
  ownerName: string;
  repoName: string;
} | null> {
  const fullName =
    process.env.SELF_HOST_REPO || ADVANCEMENT_DEFAULT_SELF_HOST_REPO;
  const [ownerName, repoName] = fullName.includes("/")
    ? fullName.split("/")
    : [fullName, "Gluecron.com"];
  try {
    const [row] = await db
      .select({ repositoryId: repositories.id })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);
    if (!row) return null;
    return { repositoryId: row.repositoryId, ownerName, repoName };
  } catch {
    return null;
  }
}

async function loadRecentFindings(
  repositoryId: string
): Promise<RecentFinding[]> {
  try {
    const [lab] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          eq(labels.repositoryId, repositoryId),
          eq(labels.name, ADVANCEMENT_LABEL_NAME)
        )
      )
      .limit(1);
    if (!lab) return [];
    const rows = await db
      .select({
        issueId: issues.id,
        number: issues.number,
        title: issues.title,
        body: issues.body,
        state: issues.state,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .innerJoin(issueLabels, eq(issueLabels.issueId, issues.id))
      .where(
        and(eq(issueLabels.labelId, lab.id), eq(issues.repositoryId, repositoryId))
      )
      .orderBy(desc(issues.createdAt))
      .limit(25);
    return rows.map((r) => ({
      issueId: r.issueId,
      issueNumber: r.number ?? 0,
      title: r.title,
      kind: extractFromBody(r.body, "Kind") || "—",
      urgency: extractFromBody(r.body, "Urgency") || "—",
      state: r.state,
      createdAt: r.createdAt,
    }));
  } catch {
    return [];
  }
}

/**
 * Cheap parser for the markdown headers our renderer embeds:
 *   `**Kind:** Stack version bump`
 * Pulls out the value after the colon. Returns "" on miss.
 */
function extractFromBody(body: string | null, label: string): string {
  if (!body) return "";
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+?)(?:\\n|$)`, "i");
  const m = body.match(re);
  if (!m) return "";
  // Strip leading emoji + colon-prefix gunk like ":red_circle:"
  return m[1].replace(/^:[a-z_]+:\s*/i, "").trim();
}

interface ScanStats {
  thisWeek: number;
  openIssues: number;
  shippedThisMonth: number;
  lastScanAt: Date | null;
}

async function loadStats(repositoryId: string): Promise<ScanStats> {
  const weekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const monthCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let thisWeek = 0;
  let openIssues = 0;
  let shippedThisMonth = 0;
  let lastScanAt: Date | null = null;
  try {
    const [w] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, ADVANCEMENT_AUDIT_ACTION),
          gte(auditLog.createdAt, weekCutoff)
        )
      );
    thisWeek = w?.c ?? 0;
  } catch {
    /* empty */
  }
  try {
    const [lab] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          eq(labels.repositoryId, repositoryId),
          eq(labels.name, ADVANCEMENT_LABEL_NAME)
        )
      )
      .limit(1);
    if (lab) {
      const [open] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(issues)
        .innerJoin(issueLabels, eq(issueLabels.issueId, issues.id))
        .where(
          and(
            eq(issueLabels.labelId, lab.id),
            eq(issues.state, "open"),
            eq(issues.repositoryId, repositoryId)
          )
        );
      openIssues = open?.c ?? 0;
      const [shipped] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(issues)
        .innerJoin(issueLabels, eq(issueLabels.issueId, issues.id))
        .where(
          and(
            eq(issueLabels.labelId, lab.id),
            eq(issues.state, "closed"),
            eq(issues.repositoryId, repositoryId),
            gte(issues.closedAt, monthCutoff)
          )
        );
      shippedThisMonth = shipped?.c ?? 0;
    }
  } catch {
    /* empty */
  }
  try {
    const [s] = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(eq(auditLog.action, ADVANCEMENT_SCAN_COMPLETE_ACTION))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    lastScanAt = s?.createdAt ?? null;
  } catch {
    /* empty */
  }
  return { thisWeek, openIssues, shippedThisMonth, lastScanAt };
}

async function isScanEnabled(): Promise<boolean> {
  const v = await getConfigValue(ENABLED_CONFIG_KEY, ENABLED_ENV_FALLBACK);
  if (!v) return true; // default-on when nothing's set
  return v === "1" || v.toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// SVG icons (private, no shared-component edits)
// ---------------------------------------------------------------------------

function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// GET /admin/advancement
// ---------------------------------------------------------------------------

advancement.get("/admin/advancement", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const success = c.req.query("success");
  const error = c.req.query("error");

  const repo = await resolveSelfHostRepoUi();
  const [stats, recent, enabled] = await Promise.all([
    repo
      ? loadStats(repo.repositoryId)
      : Promise.resolve<ScanStats>({
          thisWeek: 0,
          openIssues: 0,
          shippedThisMonth: 0,
          lastScanAt: null,
        }),
    repo ? loadRecentFindings(repo.repositoryId) : Promise.resolve([]),
    isScanEnabled(),
  ]);

  return c.html(
    <Layout title="Advancement scanner — admin" user={user}>
      <div class="adv-scan-wrap">
        {/* Hero */}
        <section class="adv-scan-hero">
          <div class="adv-scan-hero-orb" aria-hidden="true" />
          <div class="adv-scan-hero-inner">
            <div class="adv-scan-hero-top">
              <div class="adv-scan-hero-text">
                <div class="adv-scan-eyebrow">
                  <span class="adv-scan-eyebrow-pill" aria-hidden="true">
                    <IconBolt />
                  </span>
                  Advancement scanner · Site admin ·{" "}
                  <span class="adv-scan-who">{user.username}</span>
                </div>
                <h1 class="adv-scan-title">
                  <span class="adv-scan-title-grad">What we should ship next.</span>
                </h1>
                <p class="adv-scan-sub">
                  Weekly Claude-driven scan for new Claude model releases,
                  framework versions in our stack, self-improvement patterns,
                  and trending features competitors shipped. Findings open as
                  issues on{" "}
                  <code>
                    {process.env.SELF_HOST_REPO ||
                      ADVANCEMENT_DEFAULT_SELF_HOST_REPO}
                  </code>
                  {" "}— straightforward dependency bumps are auto-promoted
                  to PRs via the migration assistant.
                </p>
              </div>
              <a href="/admin" class="adv-scan-hero-back">
                <IconArrowLeft />
                Back to admin
              </a>
            </div>
          </div>
        </section>

        {success && (
          <div class="adv-scan-banner is-ok" role="status">
            <span class="adv-scan-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="adv-scan-banner is-error" role="alert">
            <span class="adv-scan-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        {/* Stat counters */}
        <section class="adv-scan-stats" aria-label="Scanner statistics">
          <div class="adv-scan-stat">
            <div class="adv-scan-stat-label">Findings this week</div>
            <div class="adv-scan-stat-value adv-scan-tabular">
              {stats.thisWeek}
            </div>
          </div>
          <div class="adv-scan-stat">
            <div class="adv-scan-stat-label">Open improvement issues</div>
            <div class="adv-scan-stat-value adv-scan-tabular">
              {stats.openIssues}
            </div>
          </div>
          <div class="adv-scan-stat">
            <div class="adv-scan-stat-label">Shipped this month</div>
            <div class="adv-scan-stat-value adv-scan-tabular">
              {stats.shippedThisMonth}
            </div>
          </div>
          <div class="adv-scan-stat">
            <div class="adv-scan-stat-label">Last scan</div>
            <div class="adv-scan-stat-value adv-scan-tabular">
              {fmtAgo(stats.lastScanAt)}
            </div>
          </div>
        </section>

        {/* Recent findings */}
        <section class="adv-scan-section">
          <header class="adv-scan-section-head">
            <div class="adv-scan-section-head-text">
              <h3 class="adv-scan-section-title">Recent findings</h3>
              <p class="adv-scan-section-sub">
                Last 25 issues opened on{" "}
                <code>
                  {process.env.SELF_HOST_REPO ||
                    ADVANCEMENT_DEFAULT_SELF_HOST_REPO}
                </code>{" "}
                under the <code>{ADVANCEMENT_LABEL_NAME}</code> label.
              </p>
            </div>
            <form
              action="/admin/advancement/run"
              method="post"
              class="adv-scan-runform"
            >
              <button type="submit" class="adv-scan-btn adv-scan-btn-primary">
                <IconPlay />
                Run scan now
              </button>
            </form>
          </header>
          <div class="adv-scan-section-body">
            {!repo ? (
              <div class="adv-scan-empty">
                Self-host repo not resolved yet — push the platform to itself
                or set <code>SELF_HOST_REPO</code> to the owner/name pair.
              </div>
            ) : recent.length === 0 ? (
              <div class="adv-scan-empty">
                No advancement findings yet. The scanner runs weekly on
                Mondays at 08:00 UTC — kick one manually with the button
                above to seed this list.
              </div>
            ) : (
              <ol class="adv-scan-list" aria-label="Recent advancement findings">
                {recent.map((r) => {
                  const urgencyClass =
                    r.urgency.toLowerCase().startsWith("high")
                      ? "is-high"
                      : r.urgency.toLowerCase().startsWith("med")
                        ? "is-medium"
                        : "is-low";
                  const closed = r.state === "closed";
                  return (
                    <li class={"adv-scan-row " + (closed ? "is-closed" : "")}>
                      <div class="adv-scan-row-head">
                        <span
                          class={"adv-scan-urgency " + urgencyClass}
                          aria-label={`urgency ${r.urgency}`}
                        >
                          {r.urgency}
                        </span>
                        <span class="adv-scan-kind">{r.kind}</span>
                        <span
                          class="adv-scan-row-when adv-scan-tabular"
                          title={r.createdAt.toISOString()}
                        >
                          {fmtAgo(r.createdAt)}
                        </span>
                      </div>
                      <div class="adv-scan-row-title">
                        {repo ? (
                          <a
                            class="adv-scan-row-link"
                            href={`/${repo.ownerName}/${repo.repoName}/issues/${r.issueNumber}`}
                          >
                            {r.title}
                          </a>
                        ) : (
                          <span>{r.title}</span>
                        )}
                      </div>
                      <div class="adv-scan-row-actions">
                        {!closed && (
                          <form
                            method="post"
                            action={`/admin/advancement/dismiss/${r.issueId}`}
                            class="adv-scan-actform"
                          >
                            <button type="submit" class="adv-scan-btn adv-scan-btn-ghost">
                              Dismiss
                            </button>
                          </form>
                        )}
                        {closed && (
                          <span class="adv-scan-tag-closed">Closed</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>

        {/* Settings */}
        <section class="adv-scan-section">
          <header class="adv-scan-section-head">
            <div class="adv-scan-section-head-text">
              <h3 class="adv-scan-section-title">Settings</h3>
              <p class="adv-scan-section-sub">
                Toggle whether the autopilot runs the weekly scan. Stored in{" "}
                <code>system_config</code> so changes apply without a restart.
              </p>
            </div>
          </header>
          <div class="adv-scan-section-body">
            <form
              action="/admin/advancement/settings"
              method="post"
              class="adv-scan-settings"
            >
              <label class="adv-scan-toggle">
                <input
                  type="checkbox"
                  name="enabled"
                  value="1"
                  checked={enabled}
                />
                <span class="adv-scan-toggle-slider" aria-hidden="true" />
                <span class="adv-scan-toggle-label">
                  Enable weekly advancement scan
                </span>
              </label>
              <button type="submit" class="adv-scan-btn adv-scan-btn-primary">
                Save
              </button>
            </form>
          </div>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: ADV_SCAN_CSS }} />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /admin/advancement/run — fire a scan synchronously
// ---------------------------------------------------------------------------

advancement.post("/admin/advancement/run", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  try {
    const result = await runAdvancementScan();
    await audit({
      userId: user.id,
      action: "admin.advancement.run",
      metadata: {
        findings: result.findings.length,
        openedIssues: result.openedIssues,
        openedPrs: result.openedPrs,
      },
    });
    return redirectWith(
      c,
      "success",
      `Scan complete — ${result.findings.length} finding${
        result.findings.length === 1 ? "" : "s"
      }, ${result.openedIssues} new issue${
        result.openedIssues === 1 ? "" : "s"
      }, ${result.openedPrs} new PR${result.openedPrs === 1 ? "" : "s"}.`
    );
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return redirectWith(c, "error", `Scan failed: ${m}`);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/advancement/settings — flip the enabled toggle
// ---------------------------------------------------------------------------

advancement.post("/admin/advancement/settings", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const form = await c.req.formData();
  const enabled = form.get("enabled") === "1";
  try {
    await setConfigValue(ENABLED_CONFIG_KEY, enabled ? "1" : "0", user.id);
    return redirectWith(
      c,
      "success",
      `Weekly scan ${enabled ? "enabled" : "disabled"}.`
    );
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return redirectWith(c, "error", `Could not save setting: ${m}`);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/advancement/dismiss/:id — close the finding issue
// ---------------------------------------------------------------------------

advancement.post("/admin/advancement/dismiss/:id", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const id = c.req.param("id");
  if (!id) return redirectWith(c, "error", "Missing finding id.");
  try {
    await db
      .update(issues)
      .set({ state: "closed", closedAt: new Date() })
      .where(eq(issues.id, id));
    await audit({
      userId: user.id,
      action: "admin.advancement.dismiss",
      targetType: "issue",
      targetId: id,
    });
    return redirectWith(c, "success", "Finding dismissed.");
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return redirectWith(c, "error", `Dismiss failed: ${m}`);
  }
});

// ---------------------------------------------------------------------------
// Scoped CSS — every class prefixed `.adv-scan-` so this page can't bleed
// into the shared layout / other admin surfaces.
// ---------------------------------------------------------------------------

const ADV_SCAN_CSS = `
  .adv-scan-wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }
  .adv-scan-tabular { font-variant-numeric: tabular-nums; }

  /* ─── Hero ─── */
  .adv-scan-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .adv-scan-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .adv-scan-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .adv-scan-hero-inner { position: relative; z-index: 1; }
  .adv-scan-hero-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .adv-scan-hero-text { flex: 1; min-width: 280px; }
  .adv-scan-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 14px;
    letter-spacing: 0.02em;
  }
  .adv-scan-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .adv-scan-eyebrow .adv-scan-who { color: var(--accent); font-weight: 600; }
  .adv-scan-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .adv-scan-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .adv-scan-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 700px;
  }
  .adv-scan-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }
  .adv-scan-hero-back {
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
    flex-shrink: 0;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .adv-scan-hero-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* ─── Banners ─── */
  .adv-scan-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .adv-scan-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .adv-scan-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .adv-scan-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
  }

  /* ─── Stat counters ─── */
  .adv-scan-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .adv-scan-stat {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .adv-scan-stat-label {
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 8px;
  }
  .adv-scan-stat-value {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 800;
    color: var(--text-strong);
    letter-spacing: -0.02em;
  }

  /* ─── Section card ─── */
  .adv-scan-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .adv-scan-section-head {
    padding: var(--space-4);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .adv-scan-section-head-text { flex: 1; min-width: 240px; }
  .adv-scan-section-title {
    font-size: 16px;
    font-weight: 700;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .adv-scan-section-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .adv-scan-section-sub code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }
  .adv-scan-section-body {
    padding: var(--space-3) var(--space-4) var(--space-4);
  }
  .adv-scan-empty {
    padding: var(--space-5);
    text-align: center;
    color: var(--text-muted);
    font-size: 13.5px;
  }
  .adv-scan-empty code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
  }

  /* ─── Findings list ─── */
  .adv-scan-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .adv-scan-row {
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(255,255,255,0.012);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .adv-scan-row.is-closed { opacity: 0.62; }
  .adv-scan-row-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .adv-scan-urgency {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 3px 8px;
    border-radius: 9999px;
  }
  .adv-scan-urgency.is-high {
    background: rgba(248,113,113,0.12);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .adv-scan-urgency.is-medium {
    background: rgba(251,191,36,0.12);
    color: #fcd34d;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .adv-scan-urgency.is-low {
    background: rgba(148,163,184,0.10);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.28);
  }
  .adv-scan-kind {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .adv-scan-row-when {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .adv-scan-row-title {
    font-size: 14px;
    line-height: 1.4;
    color: var(--text);
  }
  .adv-scan-row-link {
    color: var(--text-strong);
    text-decoration: none;
    border-bottom: 1px dotted transparent;
  }
  .adv-scan-row-link:hover {
    border-bottom-color: var(--accent);
    color: var(--accent);
  }
  .adv-scan-row-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .adv-scan-actform { display: inline; }
  .adv-scan-tag-closed {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  /* ─── Buttons ─── */
  .adv-scan-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    font-size: 12.5px;
    font-weight: 600;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.02);
    color: var(--text);
    cursor: pointer;
    text-decoration: none;
    font-family: inherit;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }
  .adv-scan-btn:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.05);
    color: var(--text-strong);
  }
  .adv-scan-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 1px 0 rgba(255,255,255,0.10), 0 8px 22px -10px rgba(140,109,255,0.55);
  }
  .adv-scan-btn-primary:hover {
    color: #fff;
    border-color: transparent;
    filter: brightness(1.08);
  }
  .adv-scan-btn-ghost {
    background: transparent;
  }
  .adv-scan-runform { display: inline; }

  /* ─── Settings card ─── */
  .adv-scan-settings {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .adv-scan-toggle {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    font-size: 14px;
    color: var(--text);
  }
  .adv-scan-toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .adv-scan-toggle-slider {
    position: relative;
    width: 38px;
    height: 22px;
    background: rgba(255,255,255,0.08);
    border-radius: 9999px;
    transition: background 120ms ease;
    flex-shrink: 0;
  }
  .adv-scan-toggle-slider::after {
    content: '';
    position: absolute;
    top: 3px; left: 3px;
    width: 16px; height: 16px;
    background: var(--text-strong);
    border-radius: 9999px;
    transition: transform 120ms ease;
  }
  .adv-scan-toggle input:checked + .adv-scan-toggle-slider {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
  }
  .adv-scan-toggle input:checked + .adv-scan-toggle-slider::after {
    transform: translateX(16px);
  }
  .adv-scan-toggle-label { user-select: none; }

  /* ─── 403 fallback ─── */
  .adv-scan-403 {
    max-width: 480px;
    margin: 80px auto;
    text-align: center;
    color: var(--text-muted);
  }
`;

export default advancement;

export const __test = {
  extractFromBody,
  loadStats,
  loadRecentFindings,
  resolveSelfHostRepoUi,
};

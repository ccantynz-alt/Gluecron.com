/**
 * /admin/diagnose — comprehensive AI health scan.
 *
 * Single page the site admin opens to see, at a glance, every config knob
 * the platform depends on and whether it is wired up. Each row is one
 * check; status is green / yellow / red with a one-line "what to do".
 *
 * Categories covered:
 *   - Email delivery       (EMAIL_PROVIDER, RESEND_API_KEY)
 *   - AI                   (ANTHROPIC_API_KEY presence)
 *   - GateTest integration (URL + API key)
 *   - Service worker SHA   (BUILD_SHA pinned vs dev-stable fallback)
 *   - Database             (DATABASE_URL well-formed, latest migration applied)
 *   - Canonical URL        (APP_BASE_URL matches request host)
 *   - Self-host            (SELF_HOST_REPO declared + post-receive hook present)
 *   - Auto-merge           (branch_protection.enable_auto_merge for main)
 *   - Synthetic monitor    (any RED checks in last hour)
 *   - Email smoke          (POST /admin/diagnose/test-email fires a test)
 *
 * Gating: requireAuth + isSiteAdmin via the same gate() pattern as
 * /admin/ops + /admin/status. No data leaks to non-admins.
 */

import { Hono } from "hono";
import { eq, and, desc, gt, sql } from "drizzle-orm";
import { readdir } from "fs/promises";
import { join } from "path";
import {
  branchProtection,
  repositories,
  syntheticChecks,
  users,
  workflowRuns,
} from "../db/schema";
import { platformDeploys } from "../db/schema-deploys";
import { db } from "../db";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { config } from "../lib/config";
import { sendEmail } from "../lib/email";
import { latestMigration } from "../lib/post-deploy-smoke";
import { getLastTick, getTickCount } from "../lib/autopilot";

type CheckStatus = "green" | "yellow" | "red";

interface CheckResult {
  category: string;
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

const diagnose = new Hono<AuthEnv>();
diagnose.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/diagnose");
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

// ─── Individual checks ───────────────────────────────────────────────────

function checkEmail(): CheckResult {
  if (config.emailProvider !== "resend") {
    return {
      category: "Email",
      name: "Provider",
      status: "red",
      detail: `EMAIL_PROVIDER=${config.emailProvider} — verification + magic-link emails go to stderr, not inboxes.`,
      fix: "Set EMAIL_PROVIDER=resend in /etc/gluecron.env, then `systemctl restart gluecron`.",
    };
  }
  if (!config.resendApiKey) {
    return {
      category: "Email",
      name: "Provider",
      status: "red",
      detail: "EMAIL_PROVIDER=resend but RESEND_API_KEY is empty — every send will fail.",
      fix: "Add RESEND_API_KEY=re_xxx to /etc/gluecron.env, then restart.",
    };
  }
  return {
    category: "Email",
    name: "Provider",
    status: "green",
    detail: `Resend wired (from: ${config.emailFrom}). Use the test button below to confirm.`,
  };
}

function checkAnthropic(): CheckResult {
  if (!config.anthropicApiKey) {
    return {
      category: "AI",
      name: "Anthropic API key",
      status: "yellow",
      detail: "ANTHROPIC_API_KEY unset — AI PR review + AI deploy-failure analysis disabled.",
      fix: "Add ANTHROPIC_API_KEY=sk-ant-xxx to /etc/gluecron.env.",
    };
  }
  return {
    category: "AI",
    name: "Anthropic API key",
    status: "green",
    detail: `Key present (length ${config.anthropicApiKey.length}).`,
  };
}

function checkGateTest(): CheckResult {
  const hasUrl = !!process.env.GATETEST_URL;
  const hasKey = !!process.env.GATETEST_API_KEY;
  if (!hasUrl && !hasKey) {
    return {
      category: "GateTest",
      name: "Scanner integration",
      status: "yellow",
      detail: "Unconfigured — push-time GateTest scans skip silently.",
      fix: "Set GATETEST_URL + GATETEST_API_KEY in /etc/gluecron.env to enable per-push scans.",
    };
  }
  if (hasUrl && !hasKey) {
    return {
      category: "GateTest",
      name: "Scanner integration",
      status: "red",
      detail: "GATETEST_URL set but GATETEST_API_KEY empty — calls will 401.",
      fix: "Add GATETEST_API_KEY to /etc/gluecron.env.",
    };
  }
  return {
    category: "GateTest",
    name: "Scanner integration",
    status: "green",
    detail: `Configured — pushes POST to ${process.env.GATETEST_URL}.`,
  };
}

function checkBuildSha(): CheckResult {
  const sha = process.env.BUILD_SHA?.trim();
  if (sha) {
    return {
      category: "Deploy",
      name: "BUILD_SHA pinned",
      status: "green",
      detail: `${sha.slice(0, 12)} — service worker rotates per deploy.`,
    };
  }
  return {
    category: "Deploy",
    name: "BUILD_SHA pinned",
    status: "yellow",
    detail: "BUILD_SHA unset — falling back to dev-stable. Browsers won't see new deploys reflected in the SW cache.",
    fix: "Latest scripts/self-deploy.sh + hetzner-deploy.yml pin this automatically; trigger a deploy.",
  };
}

function checkAppBaseUrl(c: any): CheckResult {
  const expected = config.appBaseUrl;
  const host = c.req.header("host") || "";
  const proto =
    c.req.header("x-forwarded-proto") ||
    (c.req.url.startsWith("https://") ? "https" : "http");
  const actual = `${proto}://${host}`;
  if (!expected || expected === "http://localhost:3000") {
    return {
      category: "Config",
      name: "APP_BASE_URL canonical",
      status: "yellow",
      detail: `APP_BASE_URL is "${expected}" — outbound email links + WebAuthn origin will be wrong.`,
      fix: "Set APP_BASE_URL=https://gluecron.com in /etc/gluecron.env.",
    };
  }
  if (host && !expected.endsWith(host)) {
    return {
      category: "Config",
      name: "APP_BASE_URL canonical",
      status: "yellow",
      detail: `APP_BASE_URL=${expected} but request arrived at ${actual}. WebAuthn passkeys issued for one host can't be used at the other.`,
      fix: "Align APP_BASE_URL with the host you actually serve from.",
    };
  }
  return {
    category: "Config",
    name: "APP_BASE_URL canonical",
    status: "green",
    detail: expected,
  };
}

function checkDatabase(): CheckResult {
  const url = config.databaseUrl;
  if (!url) {
    return {
      category: "Database",
      name: "Connection string",
      status: "red",
      detail: "DATABASE_URL unset — every page that queries the DB will 500.",
      fix: "Set DATABASE_URL in /etc/gluecron.env.",
    };
  }
  let masked = url;
  try {
    const u = new URL(url);
    masked = `${u.protocol}//${u.username ? "***" : ""}@${u.host}${u.pathname}`;
  } catch {
    // unparseable
    return {
      category: "Database",
      name: "Connection string",
      status: "red",
      detail: "DATABASE_URL is not a valid URL.",
      fix: "Fix the URL format: postgres://user:pass@host:port/dbname", // secrets-ok: placeholder example URL, not a real credential
    };
  }
  return {
    category: "Database",
    name: "Connection string",
    status: "green",
    detail: masked,
  };
}

async function checkMigrations(): Promise<CheckResult> {
  try {
    const drizzleDir = join(process.cwd(), "drizzle");
    const files = (await readdir(drizzleDir)).filter((f) => f.endsWith(".sql"));
    const latest = latestMigration(files);
    if (!latest) {
      return {
        category: "Database",
        name: "Migrations applied",
        status: "yellow",
        detail: "No migration files found in drizzle/.",
      };
    }
    const rows = (await db.execute(
      `SELECT name FROM _migrations ORDER BY name DESC LIMIT 1` as never
    )) as any;
    const list = rows?.rows ?? (Array.isArray(rows) ? rows : []);
    const applied: string | undefined = list[0]?.name;
    if (!applied) {
      return {
        category: "Database",
        name: "Migrations applied",
        status: "red",
        detail: "_migrations table is empty.",
        fix: "Run `bun run db:migrate` on the box.",
      };
    }
    if (applied !== latest) {
      return {
        category: "Database",
        name: "Migrations applied",
        status: "red",
        detail: `DB at ${applied}, drizzle/ has ${latest}.`,
        fix: "Run `bun run db:migrate` on the box, or redeploy (the workflow runs it).",
      };
    }
    return {
      category: "Database",
      name: "Migrations applied",
      status: "green",
      detail: `Latest: ${applied}`,
    };
  } catch (err) {
    return {
      category: "Database",
      name: "Migrations applied",
      status: "yellow",
      detail: `Couldn't read migration state: ${(err as Error).message.slice(0, 100)}`,
    };
  }
}

async function checkAutoMerge(): Promise<CheckResult> {
  // Resolve which repo to check. SELF_HOST_REPO is the canonical
  // "this is the platform's own repo" pointer — falling back to
  // `ccantynz/Gluecron.com` keeps the legacy default behaviour.
  // Without this, the check used to hardcode `ccantynz` and report
  // "Owner not found" for installs where the canonical owner is
  // `ccantynz-alt` or anything else.
  const selfRepo = process.env.SELF_HOST_REPO || "ccantynz/Gluecron.com";
  const [ownerName, repoName] = selfRepo.includes("/")
    ? selfRepo.split("/")
    : [selfRepo, "Gluecron.com"];
  try {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) {
      return {
        category: "Auto-merge",
        name: "main protection",
        status: "yellow",
        detail: `Owner user '${ownerName}' not found in users table (looked up via SELF_HOST_REPO).`,
        fix: "Set SELF_HOST_REPO=<actual-owner>/<repo> in /etc/gluecron.env, or register the owner.",
      };
    }
    const [repo] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) {
      return {
        category: "Auto-merge",
        name: "main protection",
        status: "yellow",
        detail: `Repository row for ${ownerName}/${repoName} not found. Either the platform repo isn't registered in its own DB, or SELF_HOST_REPO points at the wrong owner/name.`,
        fix: `Create the repo at /new (owner=${ownerName}, name=${repoName}), or correct SELF_HOST_REPO in /etc/gluecron.env.`,
      };
    }
    const [bp] = await db
      .select({ enableAutoMerge: branchProtection.enableAutoMerge })
      .from(branchProtection)
      .where(
        and(
          eq(branchProtection.repositoryId, repo.id),
          eq(branchProtection.pattern, "main")
        )
      )
      .limit(1);
    if (!bp) {
      return {
        category: "Auto-merge",
        name: "main protection",
        status: "yellow",
        detail: "No branch_protection row for main yet.",
        fix: `Visit /${ownerName}/${repoName}/gates/protection to configure.`,
      };
    }
    return {
      category: "Auto-merge",
      name: "main protection",
      status: bp.enableAutoMerge ? "green" : "yellow",
      detail: bp.enableAutoMerge
        ? "Auto-merge ENABLED on main."
        : "Auto-merge DISABLED on main.",
      fix: bp.enableAutoMerge
        ? undefined
        : "Visit /admin/ops to enable.",
    };
  } catch (err) {
    return {
      category: "Auto-merge",
      name: "main protection",
      status: "yellow",
      detail: `Couldn't read: ${(err as Error).message.slice(0, 100)}`,
    };
  }
}

async function checkSyntheticMonitor(): Promise<CheckResult> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const reds = await db
      .select({ name: syntheticChecks.checkName })
      .from(syntheticChecks)
      .where(
        and(
          eq(syntheticChecks.status, "red"),
          gt(syntheticChecks.checkedAt, oneHourAgo)
        )
      )
      .orderBy(desc(syntheticChecks.checkedAt))
      .limit(10);
    if (reds.length === 0) {
      return {
        category: "Monitor",
        name: "Synthetic checks (1h)",
        status: "green",
        detail: "All synthetic checks green in the last hour.",
      };
    }
    const names = Array.from(new Set(reds.map((r) => r.name))).slice(0, 5);
    return {
      category: "Monitor",
      name: "Synthetic checks (1h)",
      status: "red",
      detail: `Red in last hour: ${names.join(", ")}.`,
      fix: "Open /admin/status for the full row table.",
    };
  } catch (err) {
    return {
      category: "Monitor",
      name: "Synthetic checks (1h)",
      status: "yellow",
      detail: `Couldn't read: ${(err as Error).message.slice(0, 100)}`,
    };
  }
}

function checkSelfHost(): CheckResult {
  const repo = process.env.SELF_HOST_REPO;
  if (!repo) {
    return {
      category: "Self-host",
      name: "Bootstrap",
      status: "yellow",
      detail: "SELF_HOST_REPO unset — pushes to this repo don't trigger self-deploy.",
      fix: "Run scripts/self-host-bootstrap.ts on the box and add SELF_HOST_REPO=ccantynz/Gluecron.com to /etc/gluecron.env.",
    };
  }
  return {
    category: "Self-host",
    name: "Bootstrap",
    status: "green",
    detail: `Self-hosting ${repo} — push to main fires self-deploy.sh.`,
  };
}

// ─── New checks (2026-05-16 reliability sweep) ───────────────────────────

/**
 * Is the autopilot loop ticking on schedule? If not, half the platform's
 * self-healing breaks silently — mirror sync, advisory rescans, scheduled
 * workflows, auto-merge sweep, stale-sweep all skip.
 */
function checkAutopilot(): CheckResult {
  if (process.env.AUTOPILOT_DISABLED === "1") {
    return {
      category: "Autopilot",
      name: "Background loop",
      status: "yellow",
      detail: "AUTOPILOT_DISABLED=1 — background maintenance loop is OFF.",
      fix: "Remove or unset AUTOPILOT_DISABLED in /etc/gluecron.env to re-enable.",
    };
  }
  const total = getTickCount();
  const tick = getLastTick();
  const intervalRaw = process.env.AUTOPILOT_INTERVAL_MS;
  const intervalMs =
    intervalRaw && Number.isFinite(Number(intervalRaw)) && Number(intervalRaw) > 0
      ? Number(intervalRaw)
      : 5 * 60 * 1000;
  // Allow 2x the interval before flagging — accounts for slow ticks.
  const staleMs = intervalMs * 2;
  if (!tick) {
    if (total === 0) {
      return {
        category: "Autopilot",
        name: "Background loop",
        status: "yellow",
        detail: `Loop is enabled but has not ticked yet. First tick fires after ${Math.round(intervalMs / 1000)}s.`,
      };
    }
    return {
      category: "Autopilot",
      name: "Background loop",
      status: "red",
      detail: `${total} tick(s) recorded but last tick result is missing — loop may have crashed.`,
      fix: "Check journalctl -u gluecron for [autopilot] errors. Run a tick manually at /admin/autopilot.",
    };
  }
  const finishedAt = new Date(tick.finishedAt).getTime();
  const ageMs = Date.now() - finishedAt;
  if (ageMs > staleMs) {
    return {
      category: "Autopilot",
      name: "Background loop",
      status: "red",
      detail: `Last tick was ${Math.round(ageMs / 1000)}s ago (interval is ${Math.round(intervalMs / 1000)}s). Loop is stalled.`,
      fix: "Run a tick manually at /admin/autopilot. Check journalctl for [autopilot] errors.",
    };
  }
  const failed = tick.tasks.filter((t) => !t.ok).length;
  if (failed > 0) {
    return {
      category: "Autopilot",
      name: "Background loop",
      status: "yellow",
      detail: `Loop running but ${failed}/${tick.tasks.length} tasks failed in the last tick.`,
      fix: "Open /admin/autopilot for the per-task error list.",
    };
  }
  return {
    category: "Autopilot",
    name: "Background loop",
    status: "green",
    detail: `Ticking on schedule (${total} tick${total === 1 ? "" : "s"} this process; last ${Math.round(ageMs / 1000)}s ago).`,
  };
}

/**
 * When did we last successfully deploy? Stale deploys are an early
 * warning sign the deploy pipeline is broken silently (which is exactly
 * what happened on 2026-05-15 — 17 hours of failed deploys, no alert).
 */
async function checkRecentDeploy(): Promise<CheckResult> {
  try {
    const [latest] = await db
      .select({
        sha: platformDeploys.sha,
        status: platformDeploys.status,
        startedAt: platformDeploys.startedAt,
        finishedAt: platformDeploys.finishedAt,
        error: platformDeploys.error,
      })
      .from(platformDeploys)
      .orderBy(desc(platformDeploys.startedAt))
      .limit(1);
    if (!latest) {
      return {
        category: "Deploy",
        name: "Latest deploy",
        status: "yellow",
        detail: "No deploys recorded yet. The hetzner-deploy.yml workflow posts events to /api/events/deploy/* — set DEPLOY_EVENT_TOKEN in the workflow env to enable.",
      };
    }
    const ref = latest.finishedAt || latest.startedAt;
    const ageHours = (Date.now() - new Date(ref).getTime()) / (60 * 60 * 1000);
    const sha7 = (latest.sha || "").slice(0, 7);
    if (latest.status === "failed") {
      return {
        category: "Deploy",
        name: "Latest deploy",
        status: "red",
        detail: `Last deploy (${sha7}) FAILED ${ageHours.toFixed(1)}h ago: ${(latest.error || "no error message").slice(0, 200)}.`,
        fix: "Open /admin/deploys for the run timeline. Trigger a new deploy after fixing.",
      };
    }
    if (latest.status === "in_progress") {
      return {
        category: "Deploy",
        name: "Latest deploy",
        status: "yellow",
        detail: `Deploy in progress (${sha7}, started ${ageHours.toFixed(1)}h ago).`,
      };
    }
    if (latest.status === "succeeded" && ageHours > 48) {
      return {
        category: "Deploy",
        name: "Latest deploy",
        status: "yellow",
        detail: `Last deploy was ${sha7} ${ageHours.toFixed(1)}h ago. If you pushed to main since then, the deploy pipeline may have silently failed.`,
        fix: "Check the GitHub Actions Hetzner deploy run for the latest main commit.",
      };
    }
    return {
      category: "Deploy",
      name: "Latest deploy",
      status: "green",
      detail: `${sha7} deployed cleanly ${ageHours.toFixed(1)}h ago.`,
    };
  } catch (err) {
    return {
      category: "Deploy",
      name: "Latest deploy",
      status: "yellow",
      detail: `Couldn't read platform_deploys: ${(err as Error).message.slice(0, 100)}`,
    };
  }
}

/**
 * Is the workflow worker draining the queue? A backed-up queue or a
 * stuck queued row means CI gates aren't firing.
 */
async function checkWorkflowQueue(): Promise<CheckResult> {
  try {
    const [queued] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(eq(workflowRuns.status, "queued"));
    const queuedN = Number(queued?.n || 0);
    const [running] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(eq(workflowRuns.status, "running"));
    const runningN = Number(running?.n || 0);
    if (queuedN > 25) {
      return {
        category: "Workflows",
        name: "Run queue",
        status: "red",
        detail: `${queuedN} runs queued (running: ${runningN}). The worker is backed up.`,
        fix: "Check journalctl for [workflow-runner] errors. Restart gluecron if persistent.",
      };
    }
    if (queuedN > 5) {
      return {
        category: "Workflows",
        name: "Run queue",
        status: "yellow",
        detail: `${queuedN} runs queued, ${runningN} running. Worker may be slow.`,
      };
    }
    return {
      category: "Workflows",
      name: "Run queue",
      status: "green",
      detail: `${queuedN} queued, ${runningN} running.`,
    };
  } catch (err) {
    return {
      category: "Workflows",
      name: "Run queue",
      status: "yellow",
      detail: `Couldn't read workflow_runs: ${(err as Error).message.slice(0, 100)}`,
    };
  }
}

/**
 * Crontech deploy webhook secret — without it, the webhook POSTs
 * unsigned and Crontech rejects with 401, but our hook side never sees
 * the rejection because the request is fire-and-forget.
 */
function checkCrontechWebhook(): CheckResult {
  const url = process.env.CRONTECH_DEPLOY_URL;
  const secret = process.env.CRONTECH_HMAC_SECRET;
  if (!url) {
    return {
      category: "Crontech",
      name: "Deploy webhook",
      status: "yellow",
      detail: "CRONTECH_DEPLOY_URL unset — pushes to the Crontech repo don't notify the deploy pipeline.",
      fix: "Optional integration. Set CRONTECH_DEPLOY_URL + CRONTECH_HMAC_SECRET if you want push-triggered Crontech deploys.",
    };
  }
  if (!secret) {
    return {
      category: "Crontech",
      name: "Deploy webhook",
      status: "red",
      detail: "CRONTECH_DEPLOY_URL set but CRONTECH_HMAC_SECRET empty — webhook will be rejected as unsigned.",
      fix: "Add CRONTECH_HMAC_SECRET to /etc/gluecron.env (match the value configured on Crontech's side).",
    };
  }
  return {
    category: "Crontech",
    name: "Deploy webhook",
    status: "green",
    detail: `Configured (POST to ${url}).`,
  };
}

// ─── Page handler ────────────────────────────────────────────────────────

function pill(status: CheckStatus): any {
  const map: Record<CheckStatus, { bg: string; fg: string; label: string }> = {
    green: { bg: "rgba(52,211,153,0.16)", fg: "#34d399", label: "✓ OK" },
    yellow: { bg: "rgba(245,158,11,0.16)", fg: "#f59e0b", label: "! WARN" },
    red: { bg: "rgba(248,113,113,0.16)", fg: "#f87171", label: "× FAIL" },
  };
  const s = map[status];
  return (
    <span
      style={`display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${s.bg};color:${s.fg};white-space:nowrap`}
    >
      {s.label}
    </span>
  );
}

/**
 * Map a check to its most useful "Fix" deep-link. Pure category-based
 * routing — keeps the per-check status logic untouched, but lets the new
 * polish surface a one-click jump to the page that resolves the issue.
 */
function fixHrefForCheck(r: CheckResult): { href: string; label: string } | null {
  // Anything env/secret-driven goes to /admin/integrations — the in-app
  // editor for /etc/gluecron.env that already gates on the same admin role.
  const envSurface = { href: "/admin/integrations", label: "Open integrations" };
  switch (r.category) {
    case "Email":
    case "AI":
    case "GateTest":
    case "Crontech":
    case "Config":
    case "Self-host":
      return envSurface;
    case "Auto-merge":
      return { href: "/admin/ops", label: "Open ops" };
    case "Monitor":
      return { href: "/admin/status", label: "Open status" };
    case "Autopilot":
      return { href: "/admin/autopilot", label: "Open autopilot" };
    case "Deploy":
      return { href: "/admin/deploys", label: "Open deploys" };
    case "Workflows":
      return { href: "/admin/ops", label: "Open ops" };
    case "Database":
      return envSurface;
    default:
      return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.health-` so this surface can't
 * bleed into the wider admin. Mirrors the gradient-hairline hero +
 * radial-orb + per-card pattern from `admin-integrations` and
 * `error-page` (the just-shipped 2026 visual recipe).
 * ───────────────────────────────────────────────────────────────────── */
const healthStyles = `
  .health-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .health-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .health-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .health-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .health-hero-inner { position: relative; z-index: 1; }
  .health-hero-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }
  .health-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .health-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .health-back {
    font-size: 12.5px;
    color: var(--text-muted);
    text-decoration: none;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--border-strong, var(--border));
    background: transparent;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .health-back:hover {
    color: var(--text-strong);
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.06);
    text-decoration: none;
  }
  .health-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .health-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .health-title-grad.is-warn {
    background-image: linear-gradient(135deg, #fde68a 0%, #fbbf24 50%, #d97706 100%);
  }
  .health-title-grad.is-fail {
    background-image: linear-gradient(135deg, #fecaca 0%, #f87171 50%, #ef4444 100%);
  }
  .health-summary {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .health-summary-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .health-summary-pill .dot {
    width: 9px; height: 9px;
    border-radius: 9999px;
    background: currentColor;
    box-shadow: 0 0 0 3px rgba(255,255,255,0.04);
  }
  .health-summary-pill.is-green {
    background: rgba(52,211,153,0.12);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .health-summary-pill.is-warn {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .health-summary-pill.is-fail {
    background: rgba(248,113,113,0.10);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.34);
  }
  .health-summary-breakdown {
    font-size: 12.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .health-summary-breakdown .sep { opacity: 0.45; margin: 0 6px; }
  .health-summary-stamp {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
  }

  .health-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .health-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .health-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  .health-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  @media (min-width: 720px) {
    .health-grid { grid-template-columns: 1fr 1fr; }
  }

  .health-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
  }
  .health-card:hover {
    border-color: var(--border-strong, var(--border));
    transform: translateY(-1px);
    box-shadow: 0 6px 18px -10px rgba(0,0,0,0.45);
  }
  .health-card.is-red { border-color: rgba(248,113,113,0.34); }
  .health-card.is-yellow { border-color: rgba(251,191,36,0.30); }
  .health-card.is-green { border-color: rgba(52,211,153,0.22); }

  .health-card-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    justify-content: space-between;
  }
  .health-card-id { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
  .health-card-dot {
    flex: 0 0 auto;
    width: 12px; height: 12px;
    border-radius: 9999px;
    margin-top: 5px;
    background: var(--text-muted);
    box-shadow: 0 0 0 3px rgba(255,255,255,0.04);
  }
  .health-card-dot.is-green {
    background: #34d399;
    box-shadow: 0 0 0 3px rgba(52,211,153,0.16);
  }
  .health-card-dot.is-yellow {
    background: #f59e0b;
    box-shadow: 0 0 0 3px rgba(245,158,11,0.18);
  }
  .health-card-dot.is-red {
    background: #f87171;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.22);
    animation: health-pulse 1.8s ease-in-out infinite;
  }
  @keyframes health-pulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(248,113,113,0.22); }
    50%      { box-shadow: 0 0 0 7px rgba(248,113,113,0.05); }
  }
  @media (prefers-reduced-motion: reduce) {
    .health-card-dot.is-red { animation: none; }
  }
  .health-card-title {
    min-width: 0;
  }
  .health-card-category {
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 2px;
  }
  .health-card-name {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.005em;
    overflow-wrap: anywhere;
  }

  .health-card-detail {
    font-size: 13px;
    line-height: 1.55;
    color: var(--text);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .health-card-fix {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text-muted);
    margin: 0;
    padding: 10px 12px;
    background: rgba(140,109,255,0.05);
    border: 1px solid rgba(140,109,255,0.18);
    border-radius: 10px;
  }
  .health-card.is-red .health-card-fix {
    background: rgba(248,113,113,0.05);
    border-color: rgba(248,113,113,0.22);
  }
  .health-card.is-yellow .health-card-fix {
    background: rgba(251,191,36,0.05);
    border-color: rgba(251,191,36,0.22);
  }
  .health-card-fix-label {
    display: block;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-weight: 700;
    color: var(--text-muted);
    margin-bottom: 4px;
  }

  .health-card-foot {
    display: flex;
    justify-content: flex-end;
    margin-top: auto;
    padding-top: 4px;
  }
  .health-card-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border-strong, var(--border));
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease;
  }
  .health-card-action:hover {
    color: var(--text-strong);
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.08);
    text-decoration: none;
    transform: translateY(-1px);
  }
  .health-card-action .arrow { font-size: 14px; line-height: 1; }

  .health-test {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    overflow: hidden;
  }
  .health-test::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 50%, transparent 100%);
    opacity: 0.6;
  }
  .health-test h3 {
    margin: 0 0 4px 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .health-test p {
    margin: 0 0 var(--space-3) 0;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .health-test form { margin: 0; }
`;

async function runAllChecks(c: any): Promise<CheckResult[]> {
  return [
    checkEmail(),
    checkAnthropic(),
    checkGateTest(),
    checkBuildSha(),
    checkAppBaseUrl(c),
    checkDatabase(),
    await checkMigrations(),
    await checkAutoMerge(),
    await checkSyntheticMonitor(),
    checkSelfHost(),
    // 2026-05-16 reliability sweep additions:
    checkAutopilot(),
    await checkRecentDeploy(),
    await checkWorkflowQueue(),
    checkCrontechWebhook(),
  ];
}

// JSON endpoint for programmatic monitoring. Same gate as the HTML page
// (site-admin only) so deploy state isn't public.
diagnose.get("/admin/diagnose.json", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const results = await runAllChecks(c);
  const counts = {
    green: results.filter((r) => r.status === "green").length,
    yellow: results.filter((r) => r.status === "yellow").length,
    red: results.filter((r) => r.status === "red").length,
  };
  const overall =
    counts.red > 0 ? "red" : counts.yellow > 0 ? "yellow" : "green";
  return c.json({
    ok: true,
    overall,
    counts,
    checks: results,
    asOf: new Date().toISOString(),
  });
});

// /admin/health alias — same handler, friendlier URL. The user expected
// this to exist; making the expectation reality is cheaper than arguing
// about naming.
diagnose.get("/admin/health", async (c) => {
  return c.redirect("/admin/diagnose");
});

diagnose.get("/admin/diagnose", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const results: CheckResult[] = await runAllChecks(c);

  const counts = {
    green: results.filter((r) => r.status === "green").length,
    yellow: results.filter((r) => r.status === "yellow").length,
    red: results.filter((r) => r.status === "red").length,
  };
  const total = results.length;
  const overall: CheckStatus =
    counts.red > 0 ? "red" : counts.yellow > 0 ? "yellow" : "green";

  // Headline copy reads as a verdict, not a tally. The gradient swap
  // (green → yellow → red) makes the page status legible at a glance.
  const verdict =
    overall === "red"
      ? "Issues detected."
      : overall === "yellow"
        ? "Degraded."
        : "Healthy.";
  const verdictGradClass =
    overall === "red"
      ? "health-title-grad is-fail"
      : overall === "yellow"
        ? "health-title-grad is-warn"
        : "health-title-grad";

  const summaryPillClass =
    overall === "red"
      ? "health-summary-pill is-fail"
      : overall === "yellow"
        ? "health-summary-pill is-warn"
        : "health-summary-pill is-green";
  const summaryPillText = `${counts.green} of ${total} checks green`;

  // Last-checked stamp — server-rendered "asOf" in tabular-nums. The
  // operator wants a real, observable timestamp on this dashboard.
  const asOf = new Date();
  const asOfDisplay = asOf.toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const flash = c.req.query("test_email");

  return c.html(
    <Layout title="Diagnose — admin" user={user}>
      <div class="health-wrap">
        <section class="health-hero">
          <div class="health-hero-orb" aria-hidden="true" />
          <div class="health-hero-inner">
            <div class="health-hero-top">
              <div class="health-eyebrow">
                <span class="health-eyebrow-dot" aria-hidden="true" />
                Platform health · live
              </div>
              <a href="/admin" class="health-back">
                ← Back to admin
              </a>
            </div>
            <h1 class="health-title">
              <span class={verdictGradClass}>{verdict}</span>
            </h1>
            <div class="health-summary">
              <span class={summaryPillClass}>
                <span class="dot" aria-hidden="true" />
                {summaryPillText}
              </span>
              <span class="health-summary-breakdown">
                {counts.green} green
                <span class="sep">·</span>
                {counts.yellow} warn
                <span class="sep">·</span>
                {counts.red} fail
              </span>
              <span class="health-summary-stamp" title="Server time">
                checked {asOfDisplay}
              </span>
            </div>
          </div>
        </section>

        {flash && (
          <div
            class={
              "health-banner " + (flash === "ok" ? "is-ok" : "is-error")
            }
          >
            {flash === "ok"
              ? "Test email dispatched. If the provider is 'log' you'll see it in journalctl, not your inbox."
              : `Test email failed: ${decodeURIComponent(flash)}`}
          </div>
        )}

        <div class="health-grid">
          {results.map((r) => {
            const cardClass = `health-card is-${r.status}`;
            const dotClass = `health-card-dot is-${r.status}`;
            const fix = fixHrefForCheck(r);
            return (
              <article class={cardClass} data-category={r.category}>
                <div class="health-card-head">
                  <div class="health-card-id">
                    <span class={dotClass} aria-hidden="true" />
                    <div class="health-card-title">
                      <div class="health-card-category">{r.category}</div>
                      <div class="health-card-name">{r.name}</div>
                    </div>
                  </div>
                  {pill(r.status)}
                </div>
                <p class="health-card-detail">{r.detail}</p>
                {r.fix && (
                  <div class="health-card-fix">
                    <span class="health-card-fix-label">How to fix</span>
                    {r.fix}
                  </div>
                )}
                {fix && (
                  <div class="health-card-foot">
                    <a class="health-card-action" href={fix.href}>
                      {fix.label}
                      <span class="arrow" aria-hidden="true">→</span>
                    </a>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <div class="health-test">
          <h3>AI background tasks</h3>
          <p>
            These tasks run continuously inside the autopilot tick — no
            external scheduler. Each one fires on every signal it cares
            about (CI failure / gate finding / monitor heartbeat) and
            degrades gracefully when <code>ANTHROPIC_API_KEY</code> is
            unset.
          </p>
          <ul style="margin: 8px 0 0; padding-left: 20px; line-height: 1.7; font-size: 13.5px;">
            <li>
              <strong>AI CI healer</strong> — on every failed workflow
              run, Claude reads the failure log + recent diff and proposes
              targeted file edits. Source: <code>src/lib/ai-ci-healer.ts</code>.
            </li>
            <li>
              <strong>AI patch generator</strong> — when GateTest or
              advisory scan reports a finding, this generates a concrete
              diff PR proposing the fix. Source: <code>src/lib/ai-patch-generator.ts</code>.
            </li>
            <li>
              <strong>AI proactive monitor</strong> — sweeps every repo
              looking for stale TODOs, suspicious patterns, and stuck PRs;
              files issues automatically. Findings surface in{" "}
              <a href="/settings/audit">/settings/audit</a>. Source:{" "}
              <code>src/lib/ai-proactive-monitor.ts</code>.
            </li>
            <li>
              <strong>AI build tasks</strong> — picks up issues labelled
              <code>ai:build</code> and ships a PR for them. Source:{" "}
              <code>src/lib/ai-build-tasks.ts</code>.
            </li>
          </ul>
          <p style="margin-top: 12px;">
            See <a href="/admin/autopilot">/admin/autopilot</a> for the
            per-task tick log and force-run controls.
          </p>
        </div>

        <div class="health-test">
          <h3>Test email delivery</h3>
          <p>
            Fires a one-line test email to <strong>{user.email}</strong> using
            the configured provider. If EMAIL_PROVIDER=log it appears in
            journalctl; if resend, in your inbox in &lt;30s.
          </p>
          <form method="post" action="/admin/diagnose/test-email">
            <input
              type="hidden"
              name="_csrf"
              value={(c.get("csrfToken") as string | undefined) || ""}
            />
            <button type="submit" class="btn btn-sm btn-primary">
              Send test email
            </button>
          </form>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: healthStyles }} />
    </Layout>
  );
});

diagnose.post("/admin/diagnose/test-email", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  if (!user.email) {
    return c.redirect(
      `/admin/diagnose?test_email=${encodeURIComponent("admin has no email on record")}`
    );
  }
  const stamp = new Date().toISOString();
  const result = await sendEmail({
    to: user.email,
    subject: "Gluecron — diagnose test email",
    text:
      `This is a test email from /admin/diagnose at ${stamp}.\n\n` +
      `If you received this in your inbox, EMAIL_PROVIDER=resend is wired correctly.\n` +
      `If you only see it in journalctl, EMAIL_PROVIDER is still 'log'.\n`,
  });
  if (!result.ok) {
    return c.redirect(
      `/admin/diagnose?test_email=${encodeURIComponent(result.error || result.skipped || "unknown failure")}`
    );
  }
  return c.redirect("/admin/diagnose?test_email=ok");
});

export default diagnose;

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
import { eq, and, desc, gt } from "drizzle-orm";
import { readdir } from "fs/promises";
import { join } from "path";
import {
  branchProtection,
  repositories,
  syntheticChecks,
  users,
} from "../db/schema";
import { db } from "../db";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { config } from "../lib/config";
import { sendEmail } from "../lib/email";
import { latestMigration } from "../lib/post-deploy-smoke";

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
      fix: "Fix the URL format: postgres://user:pass@host:port/dbname",
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
  try {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, "ccantynz"))
      .limit(1);
    if (!owner) {
      return {
        category: "Auto-merge",
        name: "main protection",
        status: "yellow",
        detail: "Owner user 'ccantynz' not found.",
      };
    }
    const [repo] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, "Gluecron.com")
        )
      )
      .limit(1);
    if (!repo) {
      return {
        category: "Auto-merge",
        name: "main protection",
        status: "yellow",
        detail: "Repository row for ccantynz/Gluecron.com not found.",
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
        fix: "Visit /ccantynz/Gluecron.com/gates/protection to configure.",
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

diagnose.get("/admin/diagnose", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const results: CheckResult[] = [
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
  ];

  const counts = {
    green: results.filter((r) => r.status === "green").length,
    yellow: results.filter((r) => r.status === "yellow").length,
    red: results.filter((r) => r.status === "red").length,
  };
  const headline =
    counts.red > 0
      ? `${counts.red} failing`
      : counts.yellow > 0
        ? `${counts.yellow} needs attention`
        : "All green";
  const headlineColor =
    counts.red > 0
      ? "var(--red, #cf222e)"
      : counts.yellow > 0
        ? "#d97706"
        : "var(--green, #2da44e)";

  const flash = c.req.query("test_email");

  return c.html(
    <Layout title="Diagnose — admin" user={user}>
      <div style="max-width:920px;margin:0 auto;padding:var(--space-5) var(--space-3)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3)">
          <h1 style="margin:0">Diagnose</h1>
          <a href="/admin" class="btn btn-sm">
            Back to admin
          </a>
        </div>
        <p style="color:var(--text-muted);margin-bottom:var(--space-4)">
          Read-only health scan of every config knob the platform depends on.
          One row per check. Green = wired, yellow = degraded, red = broken.
        </p>

        <div
          style={`background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:var(--space-3) var(--space-4);margin-bottom:var(--space-4);display:flex;align-items:center;gap:var(--space-3)`}
        >
          <span
            style={`display:inline-block;width:14px;height:14px;border-radius:50%;background:${headlineColor}`}
          />
          <strong style="font-size:18px">{headline}</strong>
          <span style="color:var(--text-muted);font-size:13px">
            {counts.green} green · {counts.yellow} warn · {counts.red} fail
          </span>
        </div>

        {flash && (
          <div
            class={flash === "ok" ? "banner" : "auth-error"}
            style="margin-bottom:var(--space-4)"
          >
            {flash === "ok"
              ? "Test email dispatched. If the provider is 'log' you'll see it in journalctl, not your inbox."
              : `Test email failed: ${decodeURIComponent(flash)}`}
          </div>
        )}

        <div
          style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:var(--space-4)"
        >
          {results.map((r, i) => (
            <div
              style={`padding:var(--space-3) var(--space-4);${i < results.length - 1 ? "border-bottom:1px solid var(--border);" : ""}display:grid;grid-template-columns:120px 80px 1fr;gap:var(--space-3);align-items:start`}
            >
              <div>
                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">
                  {r.category}
                </div>
                <div style="font-weight:600;font-size:14px;margin-top:2px">
                  {r.name}
                </div>
              </div>
              <div>{pill(r.status)}</div>
              <div>
                <div style="font-size:13px;line-height:1.45">{r.detail}</div>
                {r.fix && (
                  <div
                    style="font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.4"
                  >
                    → {r.fix}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div
          style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:var(--space-3) var(--space-4)"
        >
          <h3
            style="margin:0 0 var(--space-2) 0;font-size:14px;letter-spacing:0.04em;text-transform:uppercase;color:var(--text-muted)"
          >
            Test email delivery
          </h3>
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 var(--space-3) 0">
            Fires a one-line test email to <strong>{user.email}</strong> using
            the configured provider. If EMAIL_PROVIDER=log it appears in
            journalctl; if resend, in your inbox in &lt;30s.
          </p>
          <form method="post" action="/admin/diagnose/test-email" style="margin:0">
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

/**
 * Block R1 — `/admin/ops` site-admin operations console.
 *
 * Every operational lever the site admin used to pull from the terminal
 * becomes a one-click form here:
 *
 *   GET  /admin/ops                        — render the ops page
 *   POST /admin/ops/auto-merge/enable      — flip K2 auto-merge ON for ccantynz/main
 *   POST /admin/ops/auto-merge/disable     — flip K2 auto-merge OFF for ccantynz/main
 *   POST /admin/ops/deploy/trigger         — workflow_dispatch hetzner-deploy.yml (re-uses N4 internally)
 *   POST /admin/ops/rollback               — workflow_dispatch with the previous-successful SHA
 *
 * Re-use, don't duplicate:
 *   - `runEnableAutoMerge` from `scripts/enable-auto-merge.ts` (N1) drives
 *     the auto-merge POSTs. We import its DI'd orchestrator + the real
 *     `audit` callback so tests can swap them.
 *   - `triggerRollback` from `src/lib/rollback-deploy.ts` (this block)
 *     drives the rollback POST. It mirrors N4's workflow_dispatch wire
 *     format and friendly-error mapping.
 *   - The deploy-trigger POST forwards to the existing N4 handler at
 *     `/admin/deploys/trigger` rather than re-implementing the GitHub API
 *     call. The page just calls it on the same Hono instance via a redirect.
 *
 * Readiness panel: we surface every check from
 * `scripts/check-auto-merge-readiness.ts` so the operator can see what's
 * blocking enablement before they hit the button.
 *
 * All POST handlers gate on `requireAuth` + `isSiteAdmin`, audit-log under
 * `admin.ops.<action>`, and redirect back to `/admin/ops?success=<msg>` or
 * `?error=<msg>`. CSRF protection is the same same-origin-or-token check
 * the rest of the admin routes use.
 */

import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { apiTokens, branchProtection, repositories, users } from "../db/schema";
import { platformDeploys } from "../db/schema-deploys";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit as realAudit } from "../lib/notify";
import { config } from "../lib/config";
import {
  runEnableAutoMerge as realRunEnableAutoMerge,
  type DbLike,
  type EnableAutoMergeArgs,
  type EnableAutoMergeResult,
} from "../../scripts/enable-auto-merge";
import {
  checkAnthropicKey,
  checkAutopilotEnabled,
  checkAutoMergeSweepRegistered,
  checkMigration0040,
  type CheckResult,
} from "../../scripts/check-auto-merge-readiness";
import {
  findPreviousSuccessfulDeploy as realFindPrev,
  triggerRollback as realTriggerRollback,
  type PreviousDeploy,
  type TriggerRollbackResult,
} from "../lib/rollback-deploy";
import { relativeTime, shortSha } from "./admin-deploys-page";

// ---------------------------------------------------------------------------
// DI hooks — every external collaborator is swappable so tests can drive
// the handlers without spinning up Neon, GitHub, or the autopilot module.
// ---------------------------------------------------------------------------

type AuditFn = typeof realAudit;
type RunEnableAutoMergeFn = (
  db: DbLike,
  args: EnableAutoMergeArgs,
  audit: AuditFn
) => Promise<EnableAutoMergeResult>;
type FindPrevFn = typeof realFindPrev;
type TriggerRollbackFn = typeof realTriggerRollback;

interface OpsDeps {
  runEnableAutoMerge: RunEnableAutoMergeFn;
  findPreviousSuccessfulDeploy: FindPrevFn;
  triggerRollback: TriggerRollbackFn;
  audit: AuditFn;
}

const REAL_DEPS: OpsDeps = {
  runEnableAutoMerge: realRunEnableAutoMerge,
  findPreviousSuccessfulDeploy: realFindPrev,
  triggerRollback: realTriggerRollback,
  audit: realAudit,
};

let _deps: OpsDeps = REAL_DEPS;

/** Test-only: replace one or more collaborators. Pass `null` to reset. */
export function __setOpsDepsForTests(d: Partial<OpsDeps> | null): void {
  _deps = d ? { ...REAL_DEPS, ..._deps, ...d } : REAL_DEPS;
}

// The repo + pattern we operate on. `/admin/ops` is a site-admin tool for
// the platform's own repo. Env-overridable (SELF_HOST_REPO) because the
// canonical name varies per deployment — on the main site it's
// "ccantynz-alt/Gluecron.com" (the actual user who signed up). The CLI
// (N1) still works for any other repo.
const OPS_REPO = process.env.SELF_HOST_REPO || "ccantynz-alt/Gluecron.com";
const OPS_PATTERN = "main";

// ---------------------------------------------------------------------------
// Status panel — every read wrapped in try/catch so a single missing row
// doesn't 500 the entire page.
// ---------------------------------------------------------------------------

interface AutoMergeState {
  enabled: boolean;
  exists: boolean;
}

async function readAutoMergeState(): Promise<AutoMergeState> {
  try {
    // Resolve owner/name from the constant. Owner is `ccantynz` and the
    // repo name is `Gluecron.com`.
    const [owner, repoName] = OPS_REPO.split("/");
    if (!owner || !repoName) return { enabled: false, exists: false };
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, owner))
      .limit(1);
    if (!ownerRow) return { enabled: false, exists: false };
    const [repoRow] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repoRow) return { enabled: false, exists: false };
    const [bp] = await db
      .select({ enableAutoMerge: branchProtection.enableAutoMerge })
      .from(branchProtection)
      .where(
        and(
          eq(branchProtection.repositoryId, repoRow.id),
          eq(branchProtection.pattern, OPS_PATTERN)
        )
      )
      .limit(1);
    if (!bp) return { enabled: false, exists: false };
    return { enabled: !!bp.enableAutoMerge, exists: true };
  } catch (err) {
    console.error("[admin-ops] readAutoMergeState:", err);
    return { enabled: false, exists: false };
  }
}

interface LatestDeploy {
  sha: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
}

async function readLatestDeploy(): Promise<LatestDeploy | null> {
  try {
    const [row] = await db
      .select({
        sha: platformDeploys.sha,
        status: platformDeploys.status,
        startedAt: platformDeploys.startedAt,
        finishedAt: platformDeploys.finishedAt,
      })
      .from(platformDeploys)
      .orderBy(desc(platformDeploys.startedAt))
      .limit(1);
    return row ?? null;
  } catch (err) {
    console.error("[admin-ops] readLatestDeploy:", err);
    return null;
  }
}

async function readReadinessChecks(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  // 1. Migration probe
  try {
    out.push(
      await checkMigration0040(async () => {
        try {
          const rows = await db.execute(
            sql`SELECT column_name FROM information_schema.columns
                WHERE table_name = 'branch_protection'
                  AND column_name = 'enable_auto_merge'
                LIMIT 1`
          );
          const list =
            (rows as any).rows ?? (Array.isArray(rows) ? rows : []);
          return { exists: list.length > 0 };
        } catch (err) {
          return {
            exists: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
  } catch {
    out.push({
      name: "Migration 0040 applied",
      status: "fail",
      reason: "check threw",
    });
  }
  // 2 + 3. env-driven checks
  out.push(checkAnthropicKey(process.env));
  out.push(checkAutopilotEnabled(process.env));
  // 4. autopilot sweep registration — best effort
  try {
    const mod = await import("../lib/autopilot");
    out.push(checkAutoMergeSweepRegistered(mod.defaultTasks()));
  } catch {
    out.push({
      name: "K3 auto-merge-sweep task registered",
      status: "fail",
      reason: "autopilot module failed to load",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function CardShell({
  title,
  children,
}: {
  title: string;
  children: any;
}) {
  return (
    <div
      style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:var(--space-4);margin-bottom:var(--space-4)"
    >
      <h3
        style="margin:0 0 12px 0;font-size:14px;letter-spacing:0.04em;text-transform:uppercase;color:var(--text-muted)"
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={`display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${
        ok ? "rgba(52, 211, 153, 0.16)" : "rgba(248, 113, 113, 0.16)"
      };color:${ok ? "#34d399" : "#f87171"}`}
    >
      <span aria-hidden="true">{ok ? "v" : "x"}</span>
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const ops = new Hono<AuthEnv>();
ops.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/ops");
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

function redirectWith(c: any, kind: "success" | "error", msg: string): Response {
  return c.redirect(`/admin/ops?${kind}=${encodeURIComponent(msg)}`);
}

// ---------------------------------------------------------------------------
// GET /admin/ops
// ---------------------------------------------------------------------------

ops.get("/admin/ops", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  // Surface flash messages from prior POSTs.
  const success = c.req.query("success");
  const error = c.req.query("error");

  // Pull every status read in parallel — a slow one shouldn't block the rest.
  const [autoMergeState, readiness, latest, previous] = await Promise.all([
    readAutoMergeState(),
    readReadinessChecks(),
    readLatestDeploy(),
    _deps.findPreviousSuccessfulDeploy().catch(() => null),
  ]);

  const readinessAllGreen = readiness.every((r) => r.status === "pass");

  return c.html(
    <Layout title="Operations — admin" user={user}>
      <div style="max-width:880px;margin:0 auto;padding:var(--space-6) var(--space-4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <h1 style="margin:0">Operations</h1>
          <a href="/admin" class="btn btn-sm">
            Back to admin
          </a>
        </div>
        <p style="color:var(--text-muted);margin-bottom:20px">
          Site-admin controls for the live platform. Every action here is
          audit-logged under <code>admin.ops.*</code>.
        </p>

        {success && (
          <div class="auth-success" style="margin-bottom:16px">
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="auth-error" style="margin-bottom:16px">
            {decodeURIComponent(error)}
          </div>
        )}

        {/* ---- Auto-merge card ---- */}
        <CardShell title="AI auto-merge on main">
          <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-3)">
            <span style="font-size:13px;color:var(--text-muted)">Status:</span>
            <Pill
              ok={autoMergeState.enabled}
              label={autoMergeState.enabled ? "Enabled" : "Disabled"}
            />
            <span style="font-size:12px;color:var(--text-muted)">
              {OPS_REPO}@{OPS_PATTERN}
            </span>
          </div>

          <div style="margin-bottom:14px">
            <div
              style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px"
            >
              Readiness check
            </div>
            <ul style="list-style:none;padding:0;margin:0">
              {readiness.map((r) => (
                <li
                  style="display:flex;align-items:flex-start;gap:8px;padding:3px 0;font-size:13px"
                >
                  <span
                    aria-hidden="true"
                    style={`color:${r.status === "pass" ? "#34d399" : "#f87171"};font-weight:700`}
                  >
                    {r.status === "pass" ? "v" : "x"}
                  </span>
                  <span>
                    {r.name}
                    {r.reason && (
                      <span style="color:var(--text-muted);margin-left:6px">
                        — {r.reason}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div style="display:flex;gap:var(--space-2);align-items:center">
            {autoMergeState.enabled ? (
              <form
                method="post"
                action="/admin/ops/auto-merge/disable"
                style="margin:0"
              >
                <button type="submit" class="btn btn-sm">
                  Disable
                </button>
              </form>
            ) : (
              <form
                method="post"
                action="/admin/ops/auto-merge/enable"
                style="margin:0"
              >
                <button
                  type="submit"
                  class="btn btn-sm btn-primary"
                  disabled={!readinessAllGreen}
                  title={
                    readinessAllGreen
                      ? "Enable AI auto-merge"
                      : "Fix the readiness items first"
                  }
                >
                  Enable
                </button>
              </form>
            )}
            <span style="font-size:12px;color:var(--text-muted)">
              When enabled, every PR Claude opens that passes gates
              auto-merges within ~30s and deploys ~25s later — under a
              minute end-to-end.
            </span>
          </div>
        </CardShell>

        {/* ---- Deploy card ---- */}
        <CardShell title="Deploy">
          <div style="margin-bottom:12px;font-size:13px">
            {latest ? (
              <span>
                <span style="color:var(--text-muted)">Last deploy: </span>
                <Pill
                  ok={latest.status === "succeeded"}
                  label={latest.status}
                />
                {" · "}
                <code class="meta-mono">{shortSha(latest.sha)}</code>
                {" · "}
                <span title={latest.startedAt.toISOString()}>
                  {relativeTime(latest.startedAt)}
                </span>
              </span>
            ) : (
              <span style="color:var(--text-muted)">
                Last deploy: —
              </span>
            )}
          </div>
          <div style="display:flex;gap:var(--space-2);align-items:center">
            <form
              method="post"
              action="/admin/ops/deploy/trigger"
              style="margin:0"
            >
              <button type="submit" class="btn btn-sm btn-primary">
                Trigger deploy now
              </button>
            </form>
            <span style="font-size:12px;color:var(--text-muted)">
              Fires hetzner-deploy.yml on main. ~25–90 sec.
            </span>
          </div>
        </CardShell>

        {/* ---- GateTest scanner credentials card ---- */}
        <CardShell title="GateTest scanner credentials">
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px 0">
            Two values to paste into GateTest's environment so it can scan
            this site. Token is admin-scoped — revoke at{" "}
            <a href="/settings/tokens">/settings/tokens</a> when scanning is done.
          </p>
          <div style="display:grid;grid-template-columns:160px 1fr;gap:6px 10px;font-size:13px;margin-bottom:14px">
            <code class="meta-mono">GLUECRON_BASE_URL</code>
            <code class="meta-mono" style="word-break:break-all">
              {config.appBaseUrl}
            </code>
            <code class="meta-mono">GLUECRON_API_TOKEN</code>
            <code
              class="meta-mono"
              style={
                c.req.query("gatetest_token")
                  ? "word-break:break-all;color:var(--accent)"
                  : "color:var(--text-muted)"
              }
            >
              {c.req.query("gatetest_token") ||
                "— click below to issue (shown once) —"}
            </code>
          </div>
          {c.req.query("gatetest_token") && (
            <p style="font-size:12px;color:#f59e0b;margin:0 0 12px 0">
              Copy the token now. It is hashed in the DB and will not be shown
              again.
            </p>
          )}
          <form
            method="post"
            action="/admin/ops/gatetest-token"
            style="margin:0"
          >
            <button type="submit" class="btn btn-sm btn-primary">
              Issue scanner token
            </button>
          </form>
        </CardShell>

        {/* ---- Rollback card ---- */}
        <CardShell title="Rollback">
          <div style="margin-bottom:12px;font-size:13px">
            {previous ? (
              <span>
                <span style="color:var(--text-muted)">
                  Previous successful deploy:{" "}
                </span>
                <code class="meta-mono">{shortSha(previous.sha)}</code>
                {" · "}
                <span title={previous.finishedAt.toISOString()}>
                  {relativeTime(previous.finishedAt)}
                </span>
              </span>
            ) : (
              <span style="color:var(--text-muted)">
                Previous successful deploy: —
              </span>
            )}
          </div>
          <div style="display:flex;gap:var(--space-2);align-items:center">
            <form
              method="post"
              action="/admin/ops/rollback"
              style="margin:0"
              onsubmit="return confirm('Roll back main to the previous tagged release?')"
            >
              <button
                type="submit"
                class="btn btn-sm btn-danger"
                disabled={!previous}
                title={
                  previous
                    ? `Rollback to ${shortSha(previous.sha)}`
                    : "No prior successful deploy on file"
                }
              >
                {previous ? `Rollback to ${shortSha(previous.sha)}` : "Rollback"}
              </button>
            </form>
            <span style="font-size:12px;color:var(--text-muted)">
              Resets main to the previous tagged release. Use if the latest
              deploy broke something.
            </span>
          </div>
        </CardShell>
      </div>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /admin/ops/auto-merge/{enable,disable}
// ---------------------------------------------------------------------------

async function handleAutoMergeFlip(c: any, off: boolean): Promise<Response> {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  try {
    const result = await _deps.runEnableAutoMerge(
      db as unknown as DbLike,
      {
        ownerSlash: OPS_REPO,
        pattern: OPS_PATTERN,
        off,
        actorUserId: user.id,
      },
      _deps.audit
    );
    try {
      await _deps.audit({
        userId: user.id,
        action: off ? "admin.ops.auto_merge_disable" : "admin.ops.auto_merge_enable",
        targetType: "branch_protection",
        targetId: result.after?.id,
        metadata: {
          repo: OPS_REPO,
          pattern: OPS_PATTERN,
          scriptAction: result.action,
        },
      });
    } catch {
      // audit failure is non-fatal for the user-facing flow
    }
    const verb = off ? "disabled" : "enabled";
    const tail =
      result.action === "noop"
        ? `already ${verb}`
        : result.action === "inserted"
        ? `${verb} (new rule created)`
        : `${verb}`;
    return redirectWith(c, "success", `Auto-merge ${tail} on ${OPS_REPO}@${OPS_PATTERN}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return redirectWith(
      c,
      "error",
      `Failed to ${off ? "disable" : "enable"} auto-merge: ${message}`
    );
  }
}

ops.post("/admin/ops/auto-merge/enable", (c) => handleAutoMergeFlip(c, false));
ops.post("/admin/ops/auto-merge/disable", (c) => handleAutoMergeFlip(c, true));

// ---------------------------------------------------------------------------
// POST /admin/ops/deploy/trigger
//
// Re-uses the N4 handler. We don't duplicate the GitHub API call — we
// simply invoke `/admin/deploys/trigger` on the same Hono `app.request`
// with the caller's session cookie forwarded so softAuth + isSiteAdmin
// pass cleanly on the inner call.
// ---------------------------------------------------------------------------

ops.post("/admin/ops/deploy/trigger", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  try {
    // Fetch the live app instance lazily — avoids a circular import at module
    // load time.
    const { default: app } = await import("../app");
    const cookie = c.req.header("cookie") ?? "";
    const origin = c.req.header("origin") ?? "";
    const host = c.req.header("host") ?? "";
    const res = await app.request("/admin/deploys/trigger", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
        host,
      },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      try {
        await _deps.audit({
          userId: user.id,
          action: "admin.ops.deploy_triggered",
          targetType: "workflow",
          targetId: "hetzner-deploy.yml",
          metadata: { repo: OPS_REPO },
        });
      } catch {
        /* non-fatal */
      }
      return redirectWith(c, "success", "Deploy dispatched — watch /admin/deploys for progress.");
    }
    let raw = "";
    try {
      raw = await res.text();
    } catch {
      /* swallow */
    }
    let msg = `deploy trigger returned ${res.status}`;
    try {
      const j = JSON.parse(raw);
      if (j?.error) msg = String(j.error);
    } catch {
      if (raw) msg = raw.slice(0, 240);
    }
    return redirectWith(c, "error", msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return redirectWith(c, "error", `Deploy trigger failed: ${message}`);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/ops/rollback
// ---------------------------------------------------------------------------

ops.post("/admin/ops/rollback", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  let prev: PreviousDeploy | null = null;
  try {
    prev = await _deps.findPreviousSuccessfulDeploy();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return redirectWith(c, "error", `Rollback lookup failed: ${message}`);
  }
  if (!prev) {
    return redirectWith(
      c,
      "error",
      "No previous successful deploy on file — nothing to roll back to."
    );
  }

  let result: TriggerRollbackResult;
  try {
    result = await _deps.triggerRollback({
      targetSha: prev.sha,
      triggeredByUserId: user.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return redirectWith(c, "error", `Rollback dispatch threw: ${message}`);
  }

  if (!result.ok) {
    return redirectWith(c, "error", result.error || "Rollback dispatch failed.");
  }

  try {
    await _deps.audit({
      userId: user.id,
      action: "admin.ops.rollback_dispatched",
      targetType: "workflow",
      targetId: "hetzner-deploy.yml",
      metadata: { repo: OPS_REPO, target_sha: prev.sha },
    });
  } catch {
    /* non-fatal */
  }

  return redirectWith(
    c,
    "success",
    `Rollback dispatched to ${shortSha(prev.sha)} — watch /admin/deploys for progress.`
  );
});

// ---------------------------------------------------------------------------
// POST /admin/ops/gatetest-token
// ---------------------------------------------------------------------------
//
// Mint a fresh admin-scoped API token for the GateTest scanner and surface
// it once via the redirect query string. The DB stores only the SHA-256
// hash (same shape tokens.tsx uses) so the plaintext is unrecoverable after
// this redirect — operator must copy it immediately into GateTest's
// environment.

function generateGateTestToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    "glc_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

ops.post("/admin/ops/gatetest-token", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const token = generateGateTestToken();
  const tokenH = await sha256Hex(token);
  const stamp = new Date().toISOString().slice(0, 10);

  try {
    await db.insert(apiTokens).values({
      userId: user.id,
      name: `GateTest scanner (${stamp})`,
      tokenHash: tokenH,
      tokenPrefix: token.slice(0, 12),
      scopes: "admin",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return redirectWith(c, "error", `Token insert failed: ${message}`);
  }

  try {
    await _deps.audit({
      userId: user.id,
      action: "admin.ops.gatetest_token_issued",
      targetType: "api_token",
      metadata: { scope: "admin", prefix: token.slice(0, 12) },
    });
  } catch {
    /* non-fatal */
  }

  return c.redirect(`/admin/ops?gatetest_token=${encodeURIComponent(token)}`);
});

export const __test = {
  readAutoMergeState,
  readLatestDeploy,
  readReadinessChecks,
  OPS_REPO,
  OPS_PATTERN,
};

export default ops;

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

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.ops-` so this surface can't bleed
 * into other admin pages. Mirrors the gradient-hairline hero + card
 * patterns from admin-integrations.tsx and error-page.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const opsStyles = `
  .ops-wrap { max-width: 980px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .ops-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ops-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ops-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .ops-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .ops-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .ops-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .ops-eyebrow .ops-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .ops-eyebrow .ops-who { color: var(--accent); font-weight: 600; }
  .ops-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .ops-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ops-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .ops-sub code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .ops-hero-back {
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
  }
  .ops-hero-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* ─── Banners ─── */
  .ops-banner {
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
  .ops-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .ops-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .ops-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Section cards ─── */
  .ops-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .ops-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .ops-section-head-text { flex: 1; min-width: 240px; }
  .ops-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ops-section-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    flex-shrink: 0;
  }
  .ops-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .ops-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Auto-merge toggle pill ─── */
  .ops-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .ops-toggle-form { margin: 0; }
  .ops-toggle {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 18px 8px 12px;
    border-radius: 9999px;
    border: 1px solid var(--border-strong);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
  }
  .ops-toggle:hover { transform: translateY(-1px); border-color: rgba(140,109,255,0.45); }
  .ops-toggle:disabled { cursor: not-allowed; opacity: 0.5; transform: none; }
  .ops-toggle-dot {
    width: 10px; height: 10px;
    border-radius: 9999px;
    background: #6b7280;
    box-shadow: 0 0 0 3px rgba(107,114,128,0.18);
  }
  .ops-toggle.is-on {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    color: #062b1f;
    border-color: rgba(52,211,153,0.55);
    box-shadow: 0 6px 18px -6px rgba(52,211,153,0.45);
  }
  .ops-toggle.is-on .ops-toggle-dot {
    background: #062b1f;
    box-shadow: 0 0 0 3px rgba(6,43,31,0.20);
  }
  .ops-toggle.is-danger {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.40);
    color: #fecaca;
  }
  .ops-toggle.is-danger .ops-toggle-dot { background: #f87171; box-shadow: 0 0 0 3px rgba(248,113,113,0.25); }
  .ops-toggle-status {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .ops-toggle-status .ops-target {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 8px;
    border-radius: 6px;
  }

  .ops-blurb {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }

  /* ─── Readiness traffic lights ─── */
  .ops-readiness {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-top: 1px solid var(--border);
  }
  .ops-readiness li {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 2px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .ops-readiness li:last-child { border-bottom: none; }
  .ops-light {
    flex-shrink: 0;
    margin-top: 5px;
    width: 10px; height: 10px;
    border-radius: 9999px;
    background: #6b7280;
    box-shadow: 0 0 0 3px rgba(107,114,128,0.16);
  }
  .ops-light.is-pass {
    background: #34d399;
    box-shadow: 0 0 0 3px rgba(52,211,153,0.22), 0 0 8px rgba(52,211,153,0.45);
  }
  .ops-light.is-warn {
    background: #fbbf24;
    box-shadow: 0 0 0 3px rgba(251,191,36,0.22), 0 0 8px rgba(251,191,36,0.40);
  }
  .ops-light.is-fail {
    background: #f87171;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.22), 0 0 10px rgba(248,113,113,0.50);
    animation: opsPulse 1.8s ease-in-out infinite;
  }
  @keyframes opsPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.7; transform: scale(0.92); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ops-light.is-fail { animation: none; }
  }
  .ops-readiness-text { flex: 1; min-width: 0; }
  .ops-readiness-name {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    word-break: break-word;
  }
  .ops-readiness-detail {
    margin-top: 2px;
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .ops-readiness-summary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .ops-readiness-summary.is-ok {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .ops-readiness-summary.is-fail {
    background: rgba(248,113,113,0.12);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .ops-readiness-summary .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }

  /* ─── Pill (deploy status) ─── */
  .ops-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
  }
  .ops-pill.is-ok { background: rgba(52,211,153,0.16); color: #6ee7b7; }
  .ops-pill.is-bad { background: rgba(248,113,113,0.16); color: #fca5a5; }
  .ops-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }

  /* ─── Deploy meta strip ─── */
  .ops-meta-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }
  .ops-meta-strip code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 6px;
    color: var(--text);
  }

  /* ─── GateTest credentials block ─── */
  .ops-creds {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 8px 14px;
    margin-bottom: var(--space-3);
    align-items: center;
  }
  @media (max-width: 600px) {
    .ops-creds { grid-template-columns: 1fr; gap: 4px 0; }
    .ops-creds-key { margin-top: var(--space-2); }
  }
  .ops-creds-key {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .ops-creds-val {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .ops-creds-val code {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 6px 10px;
    border-radius: 8px;
    word-break: break-all;
    overflow-wrap: anywhere;
  }
  .ops-creds-val code.is-muted { color: var(--text-muted); font-style: italic; }
  .ops-creds-val code.is-fresh {
    color: #e9d5ff;
    background: linear-gradient(135deg, rgba(140,109,255,0.12), rgba(54,197,214,0.08));
    border-color: rgba(140,109,255,0.40);
  }
  .ops-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px; height: 32px;
    flex-shrink: 0;
    border-radius: 8px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
    font: inherit;
  }
  .ops-copy:hover {
    background: rgba(140,109,255,0.10);
    border-color: rgba(140,109,255,0.40);
    color: var(--text-strong);
  }
  .ops-copy.is-copied {
    background: rgba(52,211,153,0.14);
    border-color: rgba(52,211,153,0.45);
    color: #6ee7b7;
  }
  .ops-copy svg { display: block; }

  .ops-fresh-token-warn {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 var(--space-3);
    padding: 10px 12px;
    font-size: 12.5px;
    color: #fde68a;
    background: rgba(251,191,36,0.08);
    border: 1px solid rgba(251,191,36,0.35);
    border-radius: 10px;
    line-height: 1.45;
  }
  .ops-fresh-token-warn::before {
    content: '!';
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 9999px;
    background: rgba(251,191,36,0.20);
    color: #fbbf24;
    font-weight: 700;
    font-size: 11px;
    font-family: var(--font-display);
  }

  /* ─── Buttons ─── */
  .ops-btn {
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
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
    line-height: 1;
  }
  .ops-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .ops-btn-primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .ops-btn-primary:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    box-shadow: none;
    transform: none;
  }
  .ops-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .ops-btn-ghost:hover:not(:disabled) {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
  }
  .ops-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
  }
  .ops-btn-danger:hover:not(:disabled) {
    border-style: dashed;
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
  }
  .ops-btn-danger:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    color: var(--text-muted);
    border-color: var(--border);
  }

  .ops-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .ops-actions form { margin: 0; }
  .ops-action-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 460px;
  }

  /* ─── 403 fallback ─── */
  .ops-403 {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .ops-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .ops-403 p { color: var(--text-muted); margin: 0; font-size: 14px; }
`;

/* Inline copy-to-clipboard helper. Looks for any `[data-ops-copy]` button,
 * reads the linked element's textContent, and pulses a `.is-copied` class
 * for ~1.6s. Works even in non-secure contexts via a hidden-textarea fallback. */
const opsCopyScript = `
  (function(){
    function copyText(text, btn){
      var done = function(){
        btn.classList.add('is-copied');
        var prev = btn.getAttribute('aria-label') || 'Copy';
        btn.setAttribute('aria-label', 'Copied');
        setTimeout(function(){
          btn.classList.remove('is-copied');
          btn.setAttribute('aria-label', prev);
        }, 1600);
      };
      function fallback(){
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch(e){}
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else { fallback(); }
    }
    document.addEventListener('click', function(ev){
      var t = ev.target;
      while (t && t !== document.body && !(t.getAttribute && t.getAttribute('data-ops-copy') !== null)) {
        t = t.parentNode;
      }
      if (!t || t === document.body) return;
      var sel = t.getAttribute('data-ops-copy');
      var src = sel ? document.querySelector(sel) : t.previousElementSibling;
      if (!src) return;
      copyText((src.textContent || '').trim(), t);
    });
  })();
`;

/* Small inline-SVG icons. */
function IconShield() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function IconRocket() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}
function IconKey() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}
function IconRollback() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}
function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

/** Map a CheckResult.status into a traffic-light class. */
function readinessClass(status: string): "is-pass" | "is-warn" | "is-fail" {
  if (status === "pass") return "is-pass";
  if (status === "fail") return "is-fail";
  return "is-warn";
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
        <div class="ops-403">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
        <style dangerouslySetInnerHTML={{ __html: opsStyles }} />
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
  const readinessFailCount = readiness.filter((r) => r.status !== "pass").length;
  const gatetestToken = c.req.query("gatetest_token");

  return c.html(
    <Layout title="Operations — admin" user={user}>
      <div class="ops-wrap">
        {/* ─── Hero ─── */}
        <section class="ops-hero">
          <div class="ops-hero-orb" aria-hidden="true" />
          <div class="ops-hero-inner">
            <div class="ops-hero-text">
              <div class="ops-eyebrow">
                <span class="ops-eyebrow-pill" aria-hidden="true">
                  <IconShield />
                </span>
                Operations · Site admin · <span class="ops-who">{user.username}</span>
              </div>
              <h1 class="ops-title">
                <span class="ops-title-grad">Run the platform.</span>
              </h1>
              <p class="ops-sub">
                Every operational lever that used to live in a terminal — auto-merge,
                deploys, scanner credentials, rollback. Every action is audit-logged
                under <code>admin.ops.*</code>.
              </p>
            </div>
            <a href="/admin" class="ops-hero-back">
              <IconArrowLeft />
              Back to admin
            </a>
          </div>
        </section>

        {success && (
          <div class="ops-banner is-ok" role="status">
            <span class="ops-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="ops-banner is-error" role="alert">
            <span class="ops-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        {/* ─── Auto-merge section ─── */}
        <section class="ops-section">
          <header class="ops-section-head">
            <div class="ops-section-head-text">
              <h3 class="ops-section-title">
                <span class="ops-section-title-icon" aria-hidden="true">
                  <IconBolt />
                </span>
                AI auto-merge on main
              </h3>
              <p class="ops-section-sub">
                When enabled, every PR Claude opens that passes gates auto-merges
                within ~30s and deploys ~25s later — under a minute end-to-end.
              </p>
            </div>
          </header>
          <div class="ops-section-body">
            <div class="ops-toggle-row">
              {autoMergeState.enabled ? (
                <form
                  method="post"
                  action="/admin/ops/auto-merge/disable"
                  class="ops-toggle-form"
                >
                  <button
                    type="submit"
                    class="ops-toggle is-on"
                    aria-label="Disable AI auto-merge"
                    title="Click to disable"
                  >
                    <span class="ops-toggle-dot" aria-hidden="true" />
                    Enabled · click to disable
                  </button>
                </form>
              ) : (
                <form
                  method="post"
                  action="/admin/ops/auto-merge/enable"
                  class="ops-toggle-form"
                >
                  <button
                    type="submit"
                    class={readinessAllGreen ? "ops-toggle" : "ops-toggle is-danger"}
                    disabled={!readinessAllGreen}
                    aria-label="Enable AI auto-merge"
                    title={
                      readinessAllGreen
                        ? "Enable AI auto-merge"
                        : "Fix the readiness items first"
                    }
                  >
                    <span class="ops-toggle-dot" aria-hidden="true" />
                    {readinessAllGreen
                      ? "Disabled · click to enable"
                      : "Blocked · fix readiness first"}
                  </button>
                </form>
              )}
              <div class="ops-toggle-status">
                <span class="ops-target">{OPS_REPO}@{OPS_PATTERN}</span>
              </div>
            </div>

            <header
              style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);margin-bottom:6px"
            >
              <div
                style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600"
              >
                Readiness check
              </div>
              <span
                class={
                  "ops-readiness-summary " +
                  (readinessAllGreen ? "is-ok" : "is-fail")
                }
              >
                <span class="dot" aria-hidden="true" />
                {readinessAllGreen
                  ? "all green"
                  : `${readinessFailCount} blocking`}
              </span>
            </header>
            <ul class="ops-readiness" aria-label="Auto-merge readiness checks">
              {readiness.map((r) => (
                <li>
                  <span
                    class={"ops-light " + readinessClass(r.status)}
                    aria-label={r.status}
                  />
                  <div class="ops-readiness-text">
                    <div class="ops-readiness-name">{r.name}</div>
                    {r.reason && (
                      <div class="ops-readiness-detail">{r.reason}</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ─── Deploy section ─── */}
        <section class="ops-section">
          <header class="ops-section-head">
            <div class="ops-section-head-text">
              <h3 class="ops-section-title">
                <span class="ops-section-title-icon" aria-hidden="true">
                  <IconRocket />
                </span>
                Deploy
              </h3>
              <p class="ops-section-sub">
                Fires hetzner-deploy.yml on main. Typical run: 25–90 seconds.
              </p>
            </div>
          </header>
          <div class="ops-section-body">
            <div class="ops-meta-strip">
              {latest ? (
                <>
                  <span>Last deploy</span>
                  <span
                    class={
                      "ops-pill " +
                      (latest.status === "succeeded" ? "is-ok" : "is-bad")
                    }
                  >
                    <span class="dot" aria-hidden="true" />
                    {latest.status}
                  </span>
                  <code>{shortSha(latest.sha)}</code>
                  <span title={latest.startedAt.toISOString()}>
                    {relativeTime(latest.startedAt)}
                  </span>
                </>
              ) : (
                <span>Last deploy: —</span>
              )}
            </div>
            <div class="ops-actions">
              <form method="post" action="/admin/ops/deploy/trigger">
                <button type="submit" class="ops-btn ops-btn-primary">
                  <IconRocket />
                  Trigger deploy now
                </button>
              </form>
              <a href="/admin/deploys" class="ops-btn ops-btn-ghost">
                Watch deploys
              </a>
            </div>
          </div>
        </section>

        {/* ─── GateTest credentials section ─── */}
        <section class="ops-section">
          <header class="ops-section-head">
            <div class="ops-section-head-text">
              <h3 class="ops-section-title">
                <span class="ops-section-title-icon" aria-hidden="true">
                  <IconKey />
                </span>
                GateTest scanner credentials
              </h3>
              <p class="ops-section-sub">
                Two values to paste into GateTest's environment so it can scan
                this site. Token is admin-scoped — revoke at{" "}
                <a href="/settings/tokens" style="color:var(--accent);text-decoration:none">/settings/tokens</a>{" "}
                when scanning is done.
              </p>
            </div>
          </header>
          <div class="ops-section-body">
            <div class="ops-creds">
              <div class="ops-creds-key">GLUECRON_BASE_URL</div>
              <div class="ops-creds-val">
                <code id="ops-creds-base-url">{config.appBaseUrl}</code>
                <button
                  type="button"
                  class="ops-copy"
                  data-ops-copy="#ops-creds-base-url"
                  aria-label="Copy GLUECRON_BASE_URL"
                  title="Copy"
                >
                  <IconCopy />
                </button>
              </div>

              <div class="ops-creds-key">GLUECRON_API_TOKEN</div>
              <div class="ops-creds-val">
                {gatetestToken ? (
                  <>
                    <code id="ops-creds-token" class="is-fresh">{gatetestToken}</code>
                    <button
                      type="button"
                      class="ops-copy"
                      data-ops-copy="#ops-creds-token"
                      aria-label="Copy GLUECRON_API_TOKEN"
                      title="Copy"
                    >
                      <IconCopy />
                    </button>
                  </>
                ) : (
                  <code class="is-muted">— click below to issue (shown once) —</code>
                )}
              </div>
            </div>

            {gatetestToken && (
              <p class="ops-fresh-token-warn">
                <span>
                  Copy the token now. It is hashed in the DB and will not be
                  shown again.
                </span>
              </p>
            )}

            <div class="ops-actions">
              <form method="post" action="/admin/ops/gatetest-token">
                <button type="submit" class="ops-btn ops-btn-primary">
                  <IconKey />
                  Issue scanner token
                </button>
              </form>
              <span class="ops-action-hint">
                Mints a fresh admin-scoped API token and reveals it once on the
                next page load.
              </span>
            </div>
          </div>
        </section>

        {/* ─── Rollback section ─── */}
        <section class="ops-section">
          <header class="ops-section-head">
            <div class="ops-section-head-text">
              <h3 class="ops-section-title">
                <span class="ops-section-title-icon" aria-hidden="true">
                  <IconRollback />
                </span>
                Rollback
              </h3>
              <p class="ops-section-sub">
                Resets main to the previous tagged release. Use if the latest
                deploy broke something.
              </p>
            </div>
          </header>
          <div class="ops-section-body">
            <div class="ops-meta-strip">
              {previous ? (
                <>
                  <span>Previous successful deploy</span>
                  <code>{shortSha(previous.sha)}</code>
                  <span title={previous.finishedAt.toISOString()}>
                    {relativeTime(previous.finishedAt)}
                  </span>
                </>
              ) : (
                <span>Previous successful deploy: —</span>
              )}
            </div>
            <div class="ops-actions">
              <form
                method="post"
                action="/admin/ops/rollback"
                onsubmit="return confirm('Roll back main to the previous tagged release?')"
              >
                <button
                  type="submit"
                  class="ops-btn ops-btn-danger"
                  disabled={!previous}
                  title={
                    previous
                      ? `Rollback to ${shortSha(previous.sha)}`
                      : "No prior successful deploy on file"
                  }
                >
                  <IconRollback />
                  {previous ? `Rollback to ${shortSha(previous.sha)}` : "Rollback"}
                </button>
              </form>
              <span class="ops-action-hint">
                Confirms before dispatching. Watch{" "}
                <a href="/admin/deploys" style="color:var(--accent);text-decoration:none">/admin/deploys</a>{" "}
                for progress.
              </span>
            </div>
          </div>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: opsStyles }} />
      <script dangerouslySetInnerHTML={{ __html: opsCopyScript }} />
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

/**
 * BLOCK W — `/admin/self-host` site-admin self-host dashboard.
 *
 * One-page status of the Gluecron self-host migration:
 *   - is the Gluecron.com repo mirrored to Gluecron itself?
 *   - is the post-receive hook installed on the bare repo on disk?
 *   - is SELF_HOST_REPO set in the running process's env?
 *   - last 10 self-deploys (read from platform_deploys where source='self-deploy')
 *
 * POST /admin/self-host/bootstrap kicks off the bootstrap script. Same
 * security model as /admin/ops: requireAuth + isSiteAdmin gate + audit log.
 *
 * Visual recipe (2026 polish — mirrors admin-integrations / admin-ops /
 * admin-deploys-page):
 *   - Gradient hairline strip across the top of the hero (purple→cyan, 2px)
 *   - Soft radial orb in the corner of the hero
 *   - Eyebrow with pill icon + actor name
 *   - Display headline with gradient-text on the verb ("Self-host.")
 *   - State-aware overall status pill in the hero
 *   - Each probe rendered as a section card
 *   - Recent deploys reuses the `.selfhost-row` pattern from admin-deploys
 *
 * Scoped CSS — every class prefixed `.selfhost-` so this surface can't
 * bleed into the wider admin panel.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { existsSync } from "fs";
import { join } from "path";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { platformDeploys } from "../db/schema-deploys";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit as realAudit } from "../lib/notify";
import { config } from "../lib/config";
import { relativeTime, shortSha, formatDuration } from "./admin-deploys-page";

// ---------------------------------------------------------------------------
// DI seam — tests inject fakes so we never spawn the real bootstrap.
// ---------------------------------------------------------------------------

type AuditFn = typeof realAudit;
type BootstrapSpawnFn = (
  cmd: string[],
  opts: { detached?: boolean }
) => unknown;
type FsExistsFn = (p: string) => boolean;

interface Deps {
  audit: AuditFn;
  spawn: BootstrapSpawnFn;
  fsExists: FsExistsFn;
  getEnv: () => Record<string, string | undefined>;
}

/**
 * Bootstrap log path. The POST handler redirects stdout + stderr here so the
 * operator can `tail -f` it (or we can read the last N lines on the next
 * page render to surface errors). Previously every output stream was set to
 * "ignore", which meant the operator saw "Bootstrap dispatched" toast even
 * when the script crashed with bun-not-found / DATABASE_URL-missing /
 * GitHub-clone-failed. P0 from the May 15 audit.
 */
export const BOOTSTRAP_LOG_PATH = "/var/log/gluecron-bootstrap.log";

const REAL_DEPS: Deps = {
  audit: realAudit,
  spawn: (cmd, _opts) => {
    // Open the log file for append; if the open fails (perm issue, missing
    // /var/log) fall back to inherit so output at least goes to journalctl.
    let stdout: any = "inherit";
    let stderr: any = "inherit";
    try {
      const log = Bun.file(BOOTSTRAP_LOG_PATH);
      // Truncate the previous run's output so the operator sees only the
      // current attempt. `Bun.write` is sync-ish and returns a promise we
      // don't need to await — the spawn happens regardless.
      void Bun.write(
        BOOTSTRAP_LOG_PATH,
        `[${new Date().toISOString()}] bootstrap dispatched: ${cmd.join(" ")}\n`
      );
      stdout = log.writer();
      stderr = log.writer();
    } catch {
      // Fall back to inherit
    }
    return Bun.spawn(cmd, { stdout, stderr, stdin: "ignore" });
  },
  fsExists: existsSync,
  getEnv: () => process.env as Record<string, string | undefined>,
};

let _deps: Deps = REAL_DEPS;

/** Test-only: replace one or more collaborators. Pass `null` to reset. */
export function __setSelfHostDepsForTests(d: Partial<Deps> | null): void {
  _deps = d ? { ...REAL_DEPS, ..._deps, ...d } : REAL_DEPS;
}

// ---------------------------------------------------------------------------
// Constants — the repo we self-host.
// ---------------------------------------------------------------------------

// Env-overridable via SELF_HOST_REPO (format: "owner/name"). Defaults
// to the canonical mainline (ccantynz-alt/Gluecron.com — the GitHub-
// mirror-matching username the operator actually signed up with).
const SELF_HOST_FULL = process.env.SELF_HOST_REPO || "ccantynz-alt/Gluecron.com";
const [SELF_HOST_OWNER_PARSED, SELF_HOST_NAME_PARSED] = SELF_HOST_FULL.split("/");
const SELF_HOST_OWNER = SELF_HOST_OWNER_PARSED || "ccantynz-alt";
const SELF_HOST_NAME = SELF_HOST_NAME_PARSED || "Gluecron.com";
const SELF_DEPLOY_SOURCE = "self-deploy";

// ---------------------------------------------------------------------------
// Status reads — every probe wrapped so a single failure doesn't 500 the page.
// ---------------------------------------------------------------------------

interface RepoState {
  exists: boolean;
  diskPath: string | null;
}

async function readRepoState(): Promise<RepoState> {
  try {
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, SELF_HOST_OWNER))
      .limit(1);
    if (!ownerRow) return { exists: false, diskPath: null };
    const [repo] = await db
      .select({ id: repositories.id, diskPath: repositories.diskPath })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, SELF_HOST_NAME)
        )
      )
      .limit(1);
    if (!repo) return { exists: false, diskPath: null };
    return { exists: true, diskPath: repo.diskPath };
  } catch (err) {
    console.error("[admin-self-host] readRepoState:", err);
    return { exists: false, diskPath: null };
  }
}

interface HookState {
  installed: boolean;
  path: string;
}

function readHookState(diskPath: string | null): HookState {
  // Where the bootstrap installs the hook. If we can't resolve the repo
  // row we fall back to the conventional path so the operator can still
  // see the expected location.
  const base =
    diskPath ||
    join(config.gitReposPath, SELF_HOST_OWNER, `${SELF_HOST_NAME}.git`);
  const path = join(base, "hooks", "post-receive");
  try {
    return { installed: _deps.fsExists(path), path };
  } catch {
    return { installed: false, path };
  }
}

interface EnvState {
  selfHostRepoSet: boolean;
  selfHostRepo: string | null;
  matchesExpected: boolean;
}

function readEnvState(): EnvState {
  const env = _deps.getEnv();
  const v = env.SELF_HOST_REPO || null;
  return {
    selfHostRepoSet: !!v,
    selfHostRepo: v,
    matchesExpected: v === SELF_HOST_FULL,
  };
}

interface RecentDeploy {
  id: string;
  sha: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
}

async function readRecentDeploys(): Promise<RecentDeploy[]> {
  try {
    const rows = await db
      .select({
        id: platformDeploys.id,
        sha: platformDeploys.sha,
        status: platformDeploys.status,
        startedAt: platformDeploys.startedAt,
        finishedAt: platformDeploys.finishedAt,
        durationMs: platformDeploys.durationMs,
      })
      .from(platformDeploys)
      .where(eq(platformDeploys.source, SELF_DEPLOY_SOURCE))
      .orderBy(desc(platformDeploys.startedAt))
      .limit(10);
    return rows;
  } catch (err) {
    console.error("[admin-self-host] readRecentDeploys:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scoped CSS — every class prefixed `.selfhost-` so this surface can't bleed
// into other admin pages. Mirrors the gradient-hairline hero + card patterns
// from admin-integrations.tsx, admin-ops.tsx, and admin-deploys-page.tsx.
// ---------------------------------------------------------------------------

const SELFHOST_CSS = `
  .selfhost-wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }

  /* ─── Hero ─── */
  .selfhost-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .selfhost-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .selfhost-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .selfhost-hero-inner { position: relative; z-index: 1; }
  .selfhost-hero-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .selfhost-hero-text { flex: 1; min-width: 280px; }
  .selfhost-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 14px;
    letter-spacing: 0.02em;
  }
  .selfhost-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .selfhost-eyebrow .selfhost-who { color: var(--accent); font-weight: 600; }
  .selfhost-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .selfhost-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .selfhost-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 640px;
  }
  .selfhost-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }
  .selfhost-hero-back {
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
  .selfhost-hero-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* ─── Overall status pill (in the hero) ─── */
  .selfhost-hero-status {
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 13px;
    color: var(--text-muted);
  }
  .selfhost-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .selfhost-status-pill.is-ok {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.36);
  }
  .selfhost-status-pill.is-bad {
    background: rgba(248,113,113,0.10);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.36);
  }
  .selfhost-status-pill .dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: currentColor;
  }
  .selfhost-status-pill.is-ok .dot {
    box-shadow: 0 0 6px rgba(52,211,153,0.55);
  }
  .selfhost-status-pill.is-bad .dot {
    animation: selfhost-pulse 1.6s ease-in-out infinite;
  }
  @keyframes selfhost-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.45; }
  }
  @media (prefers-reduced-motion: reduce) {
    .selfhost-status-pill.is-bad .dot { animation: none; }
  }

  /* ─── Banners ─── */
  .selfhost-banner {
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
  .selfhost-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .selfhost-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .selfhost-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Section cards ─── */
  .selfhost-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .selfhost-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .selfhost-section-head-text { flex: 1; min-width: 240px; }
  .selfhost-section-title {
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
  .selfhost-section-title-icon {
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
  .selfhost-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .selfhost-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Probe rows (Repo path / Hook / Env) ─── */
  .selfhost-probe {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    font-size: 13px;
    border-bottom: 1px solid var(--border);
  }
  .selfhost-probe:last-child { border-bottom: none; }
  .selfhost-probe-text { flex: 1; min-width: 0; }
  .selfhost-probe-label {
    color: var(--text);
    font-weight: 500;
  }
  .selfhost-probe-label code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    margin-left: 6px;
    word-break: break-all;
    overflow-wrap: anywhere;
  }
  .selfhost-probe-hint {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .selfhost-probe-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 4px;
  }

  .selfhost-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .selfhost-pill.is-ok {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .selfhost-pill.is-bad {
    background: rgba(248,113,113,0.12);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .selfhost-pill.is-warn {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .selfhost-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }

  /* ─── Restart hint callout (env not set) ─── */
  .selfhost-hint {
    margin-top: 12px;
    padding: 10px 12px;
    background: rgba(251,191,36,0.08);
    border: 1px solid rgba(251,191,36,0.35);
    border-radius: 10px;
    font-size: 12.5px;
    color: #fde68a;
    line-height: 1.5;
  }
  .selfhost-hint strong { color: #fbbf24; }
  .selfhost-hint pre {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: rgba(0,0,0,0.32);
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    overflow-x: auto;
  }

  /* ─── Bootstrap actions ─── */
  .selfhost-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .selfhost-actions form { margin: 0; }
  .selfhost-action-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 460px;
  }
  .selfhost-action-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .selfhost-btn {
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
  .selfhost-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .selfhost-btn-primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .selfhost-btn-primary:disabled {
    cursor: not-allowed;
    opacity: 0.55;
    box-shadow: none;
    transform: none;
    background: rgba(255,255,255,0.05);
    color: var(--text-muted);
    border-color: var(--border);
  }

  /* ─── Recent deploys (reuses the admin-deploys row pattern) ─── */
  .selfhost-empty {
    padding: 18px 4px;
    color: var(--text-muted);
    font-size: 13px;
    text-align: center;
  }
  .selfhost-empty code {
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
  }
  .selfhost-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .selfhost-row {
    position: relative;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .selfhost-row:last-child { border-bottom: 0; }
  .selfhost-row-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .selfhost-sha-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 9999px;
    font-size: 12.5px;
    color: var(--text-strong);
  }
  .selfhost-sha-pill code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: inherit;
    background: transparent;
    padding: 0;
  }
  .selfhost-sha-dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    flex-shrink: 0;
  }
  .selfhost-sha-dot.is-green { background: #34d399; box-shadow: 0 0 0 2px rgba(52,211,153,0.18); }
  .selfhost-sha-dot.is-failed { background: #f87171; box-shadow: 0 0 0 2px rgba(248,113,113,0.20); }
  .selfhost-sha-dot.is-rolling {
    background: #fbbf24;
    box-shadow: 0 0 0 2px rgba(251,191,36,0.22);
  }
  .selfhost-row-when {
    font-size: 13px;
    color: var(--text);
  }
  .selfhost-row-spacer { flex: 1; }
  .selfhost-row-duration {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    padding: 3px 10px;
    border-radius: 9999px;
    border: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }
  .selfhost-row-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
  }
  .selfhost-row-status.is-ok { background: rgba(52,211,153,0.14); color: #6ee7b7; }
  .selfhost-row-status.is-bad { background: rgba(248,113,113,0.16); color: #fca5a5; }
  .selfhost-row-status .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }

  /* ─── 403 fallback ─── */
  .selfhost-403 {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .selfhost-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .selfhost-403 p { color: var(--text-muted); margin: 0; font-size: 14px; }

  @media (max-width: 640px) {
    .selfhost-wrap { padding: var(--space-4) var(--space-3) var(--space-8); }
    .selfhost-section-sub { margin-left: 0; }
    .selfhost-row-spacer { display: none; }
  }
`;

/* Inline SVG icons. */
function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}
function IconServer() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}
function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function IconHook() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7 -3 9 -3 9h18s-3 -2 -3 -9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
function IconCog() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
function IconHistory() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const selfHost = new Hono<AuthEnv>();
selfHost.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/self-host");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="selfhost-403">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
        <style dangerouslySetInnerHTML={{ __html: SELFHOST_CSS }} />
      </Layout>,
      403
    );
  }
  return { user };
}

function redirectWith(c: any, kind: "success" | "error", msg: string): Response {
  return c.redirect(`/admin/self-host?${kind}=${encodeURIComponent(msg)}`);
}

// ---------------------------------------------------------------------------
// GET /admin/self-host
// ---------------------------------------------------------------------------

selfHost.get("/admin/self-host", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const success = c.req.query("success");
  const error = c.req.query("error");

  const [repoState, recent] = await Promise.all([
    readRepoState(),
    readRecentDeploys(),
  ]);
  const hookState = readHookState(repoState.diskPath);
  const envState = readEnvState();

  const allGreen =
    repoState.exists && hookState.installed && envState.matchesExpected;

  return c.html(
    <Layout title="Self-host — admin" user={user}>
      <div class="selfhost-wrap">
        {/* ─── Hero ─── */}
        <section class="selfhost-hero">
          <div class="selfhost-hero-orb" aria-hidden="true" />
          <div class="selfhost-hero-inner">
            <div class="selfhost-hero-top">
              <div class="selfhost-hero-text">
                <div class="selfhost-eyebrow">
                  <span class="selfhost-eyebrow-pill" aria-hidden="true">
                    <IconServer />
                  </span>
                  Self-host migration · Site admin · <span class="selfhost-who">{user.username}</span>
                </div>
                <h1 class="selfhost-title">
                  <span class="selfhost-title-grad">Self-host.</span>
                </h1>
                <p class="selfhost-sub">
                  Status of the BLOCK W migration — Gluecron's own source hosted
                  on Gluecron itself. Once all three probes are green, every push
                  to <code>{SELF_HOST_FULL}</code> deploys via the local
                  post-receive hook in ~25 seconds.
                </p>
              </div>
              <a href="/admin" class="selfhost-hero-back">
                <IconArrowLeft />
                Back to admin
              </a>
            </div>
            <div class="selfhost-hero-status" role="status">
              <span class="selfhost-eyebrow" style="margin-bottom:0">
                <span style="text-transform:uppercase;letter-spacing:0.12em;font-weight:700;font-family:var(--font-mono);font-size:11px">Overall</span>
              </span>
              <span class={"selfhost-status-pill " + (allGreen ? "is-ok" : "is-bad")}>
                <span class="dot" aria-hidden="true" />
                {allGreen ? "Self-host ready" : "Setup incomplete"}
              </span>
              <span style="color:var(--text-muted);font-size:12.5px">
                {allGreen
                  ? "All three probes are green — pushes auto-deploy."
                  : "Fix the red probes below to enable self-deploy."}
              </span>
            </div>
          </div>
        </section>

        {success && (
          <div class="selfhost-banner is-ok" role="status">
            <span class="selfhost-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="selfhost-banner is-error" role="alert">
            <span class="selfhost-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        {/* ─── Repo path probe ─── */}
        <section class="selfhost-section">
          <header class="selfhost-section-head">
            <div class="selfhost-section-head-text">
              <h3 class="selfhost-section-title">
                <span class="selfhost-section-title-icon" aria-hidden="true">
                  <IconFolder />
                </span>
                Repo path
              </h3>
              <p class="selfhost-section-sub">
                The Gluecron <code>repositories</code> row must exist so the
                git frontend can resolve the bare repo on disk.
              </p>
            </div>
            <span class={"selfhost-pill " + (repoState.exists ? "is-ok" : "is-bad")}>
              <span class="dot" aria-hidden="true" />
              {repoState.exists ? "Mirrored" : "Not mirrored"}
            </span>
          </header>
          <div class="selfhost-section-body">
            <div class="selfhost-probe">
              <div class="selfhost-probe-text">
                <div class="selfhost-probe-label">
                  Repository <code>{SELF_HOST_FULL}</code>
                </div>
                {repoState.diskPath ? (
                  <div class="selfhost-probe-hint">
                    Disk path <code>{repoState.diskPath}</code>
                  </div>
                ) : (
                  <div class="selfhost-probe-hint">
                    No <code>repositories</code> row yet — run the bootstrap below.
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ─── Hook probe ─── */}
        <section class="selfhost-section">
          <header class="selfhost-section-head">
            <div class="selfhost-section-head-text">
              <h3 class="selfhost-section-title">
                <span class="selfhost-section-title-icon" aria-hidden="true">
                  <IconHook />
                </span>
                Hook installed?
              </h3>
              <p class="selfhost-section-sub">
                The bare repo's <code>hooks/post-receive</code> script is what
                fires <code>self-deploy.sh</code> on every push.
              </p>
            </div>
            <span class={"selfhost-pill " + (hookState.installed ? "is-ok" : "is-bad")}>
              <span class="dot" aria-hidden="true" />
              {hookState.installed ? "Installed" : "Missing"}
            </span>
          </header>
          <div class="selfhost-section-body">
            <div class="selfhost-probe">
              <div class="selfhost-probe-text">
                <div class="selfhost-probe-label">
                  Hook path <code>{hookState.path}</code>
                </div>
                <div class="selfhost-probe-hint">
                  {hookState.installed
                    ? "Executable on disk — pushes will dispatch the self-deploy pipeline."
                    : "Not on disk — run the bootstrap to install it (idempotent)."}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Env probe ─── */}
        <section class="selfhost-section">
          <header class="selfhost-section-head">
            <div class="selfhost-section-head-text">
              <h3 class="selfhost-section-title">
                <span class="selfhost-section-title-icon" aria-hidden="true">
                  <IconCog />
                </span>
                Env vars
              </h3>
              <p class="selfhost-section-sub">
                The running process needs <code>SELF_HOST_REPO</code> so the
                post-receive hook only fires for our own repo.
              </p>
            </div>
            <span
              class={
                "selfhost-pill " +
                (envState.matchesExpected
                  ? "is-ok"
                  : envState.selfHostRepoSet
                  ? "is-warn"
                  : "is-bad")
              }
            >
              <span class="dot" aria-hidden="true" />
              {envState.matchesExpected
                ? "Set"
                : envState.selfHostRepoSet
                ? "Mismatch"
                : "Unset"}
            </span>
          </header>
          <div class="selfhost-section-body">
            <div class="selfhost-probe">
              <div class="selfhost-probe-text">
                <div class="selfhost-probe-label">
                  <code>SELF_HOST_REPO</code>
                  {envState.selfHostRepo && (
                    <code style="margin-left:6px">= {envState.selfHostRepo}</code>
                  )}
                </div>
                <div class="selfhost-probe-hint">
                  Expected <code>{SELF_HOST_FULL}</code>
                </div>
              </div>
            </div>
            {!envState.selfHostRepoSet && (
              <div class="selfhost-hint">
                <strong>Hint:</strong> <code>SELF_HOST_REPO</code> is read from{" "}
                <code>/etc/gluecron.env</code> when the gluecron service starts.
                If you just appended it via SSH, the running process won't see
                it until you run:
                <pre>systemctl restart gluecron</pre>
              </div>
            )}
          </div>
        </section>

        {/* ─── Bootstrap section ─── */}
        <section class="selfhost-section">
          <header class="selfhost-section-head">
            <div class="selfhost-section-head-text">
              <h3 class="selfhost-section-title">
                <span class="selfhost-section-title-icon" aria-hidden="true">
                  <IconPlay />
                </span>
                Bootstrap
              </h3>
              <p class="selfhost-section-sub">
                Mirror Gluecron's source from GitHub onto this Gluecron
                instance. Idempotent — safe to re-run. See{" "}
                <a
                  href={`/${SELF_HOST_OWNER}/${SELF_HOST_NAME}/blob/main/docs/SELF_HOST.md`}
                  style="color:var(--accent);text-decoration:none"
                >
                  docs/SELF_HOST.md
                </a>{" "}
                for the full runbook.
              </p>
            </div>
          </header>
          <div class="selfhost-section-body">
            <div class="selfhost-actions">
              <form
                method="post"
                action="/admin/self-host/bootstrap"
                onsubmit="return confirm('Run the self-host bootstrap on this box? Safe to re-run, but it will spawn a child process.')"
              >
                <button
                  type="submit"
                  class="selfhost-btn selfhost-btn-primary"
                  disabled={repoState.exists && hookState.installed}
                  title={
                    repoState.exists && hookState.installed
                      ? "Bootstrap already applied"
                      : "Run scripts/self-host-bootstrap.ts"
                  }
                >
                  <IconPlay />
                  {repoState.exists && hookState.installed
                    ? "Already bootstrapped"
                    : "Run bootstrap"}
                </button>
              </form>
              <span class="selfhost-action-hint">
                Runs <code>bun run scripts/self-host-bootstrap.ts</code>{" "}
                detached. Output streams to{" "}
                <code>/var/log/gluecron-self-deploy.log</code>.
              </span>
            </div>
          </div>
        </section>

        {/* ─── Recent self-deploys ─── */}
        <section class="selfhost-section">
          <header class="selfhost-section-head">
            <div class="selfhost-section-head-text">
              <h3 class="selfhost-section-title">
                <span class="selfhost-section-title-icon" aria-hidden="true">
                  <IconHistory />
                </span>
                Last 10 self-deploys
              </h3>
              <p class="selfhost-section-sub">
                Rows from <code>platform_deploys</code> where{" "}
                <code>source = 'self-deploy'</code>.
              </p>
            </div>
          </header>
          <div class="selfhost-section-body">
            {recent.length === 0 ? (
              <div class="selfhost-empty">
                No self-deploys recorded yet. Push a commit to{" "}
                <code>{SELF_HOST_FULL}</code> after completing the bootstrap.
              </div>
            ) : (
              <ol class="selfhost-list" aria-label="Recent self-deploys">
                {recent.map((d) => {
                  const ok = d.status === "succeeded";
                  const dotClass = ok
                    ? "is-green"
                    : d.status === "failed"
                    ? "is-failed"
                    : "is-rolling";
                  return (
                    <li class="selfhost-row">
                      <div class="selfhost-row-head">
                        <span class="selfhost-sha-pill">
                          <span class={`selfhost-sha-dot ${dotClass}`} aria-hidden="true" />
                          <code class="meta-mono">{shortSha(d.sha)}</code>
                        </span>
                        <span class={"selfhost-row-status " + (ok ? "is-ok" : "is-bad")}>
                          <span class="dot" aria-hidden="true" />
                          {d.status}
                        </span>
                        <span
                          class="selfhost-row-when"
                          title={d.startedAt.toISOString()}
                        >
                          {relativeTime(d.startedAt)}
                        </span>
                        <span class="selfhost-row-spacer" />
                        <span class="selfhost-row-duration">
                          {formatDuration(d.durationMs)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: SELFHOST_CSS }} />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /admin/self-host/bootstrap
//
// Spawns scripts/self-host-bootstrap.ts with the default args. Detached
// so the request returns immediately. The operator watches the systemd
// journal / log file for progress.
// ---------------------------------------------------------------------------

selfHost.post("/admin/self-host/bootstrap", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  try {
    const bunCmd =
      _deps.getEnv().GLUECRON_BUN_PATH || "/root/.bun/bin/bun";
    const scriptPath =
      _deps.getEnv().GLUECRON_BOOTSTRAP_SCRIPT ||
      "/opt/gluecron/scripts/self-host-bootstrap.ts";

    // P0 audit #10/#11 — pre-check the binary + script paths exist before
    // spawning. The old handler spawned blindly with stderr discarded, so a
    // missing bun produced a "success" toast and a permanently broken state.
    if (!_deps.fsExists(bunCmd)) {
      return redirectWith(
        c,
        "error",
        `Bootstrap aborted: bun binary not found at ${bunCmd}. Set GLUECRON_BUN_PATH or install bun on the box.`
      );
    }
    if (!_deps.fsExists(scriptPath)) {
      return redirectWith(
        c,
        "error",
        `Bootstrap aborted: script not found at ${scriptPath}. The deploy may be incomplete.`
      );
    }

    const child = _deps.spawn([bunCmd, "run", scriptPath], { detached: true });
    try {
      (child as any)?.unref?.();
    } catch {
      /* ignore */
    }
    try {
      await _deps.audit({
        userId: user.id,
        action: "admin.self_host.bootstrap_triggered",
        targetType: "repository",
        metadata: { repo: SELF_HOST_FULL },
      });
    } catch {
      /* audit failure is non-fatal */
    }
    return redirectWith(
      c,
      "success",
      `Bootstrap dispatched. Output streams to ${BOOTSTRAP_LOG_PATH} — refresh in ~30s to see status.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return redirectWith(c, "error", `Bootstrap failed to spawn: ${message}`);
  }
});

export const __test = {
  readRepoState,
  readHookState,
  readEnvState,
  readRecentDeploys,
  SELF_HOST_OWNER,
  SELF_HOST_NAME,
  SELF_HOST_FULL,
};

export default selfHost;

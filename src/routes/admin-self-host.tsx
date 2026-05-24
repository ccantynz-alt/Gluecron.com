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
import { relativeTime, shortSha } from "./admin-deploys-page";

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
// Render helpers
// ---------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: any }) {
  return (
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:var(--space-4);margin-bottom:var(--space-4)">
      <h3 style="margin:0 0 12px 0;font-size:14px;letter-spacing:0.04em;text-transform:uppercase;color:var(--text-muted)">
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

const selfHost = new Hono<AuthEnv>();
selfHost.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/self-host");
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
      <div style="max-width:880px;margin:0 auto;padding:var(--space-6) var(--space-4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <h1 style="margin:0">Self-host</h1>
          <a href="/admin" class="btn btn-sm">
            Back to admin
          </a>
        </div>
        <p style="color:var(--text-muted);margin-bottom:20px">
          Status of the BLOCK W migration — Gluecron's own source hosted
          on Gluecron itself. Once all three cards are green, every push
          to <code>{SELF_HOST_FULL}</code> deploys via the local
          post-receive hook in ~25 seconds.
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

        <Card title="Status">
          <ul style="list-style:none;padding:0;margin:0">
            <li style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px">
              <Pill
                ok={repoState.exists}
                label={repoState.exists ? "Mirrored" : "Not mirrored"}
              />
              <span>
                Gluecron repo row exists ({SELF_HOST_FULL})
                {repoState.diskPath && (
                  <code style="margin-left:8px;color:var(--text-muted);font-size:12px">
                    {repoState.diskPath}
                  </code>
                )}
              </span>
            </li>
            <li style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px">
              <Pill
                ok={hookState.installed}
                label={hookState.installed ? "Installed" : "Missing"}
              />
              <span>
                Bare-repo post-receive hook
                <code style="margin-left:8px;color:var(--text-muted);font-size:12px">
                  {hookState.path}
                </code>
              </span>
            </li>
            <li style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px">
              <Pill
                ok={envState.matchesExpected}
                label={
                  envState.matchesExpected
                    ? "Set"
                    : envState.selfHostRepoSet
                    ? "Mismatch"
                    : "Unset"
                }
              />
              <span>
                <code>SELF_HOST_REPO</code> env
                {envState.selfHostRepo && (
                  <code style="margin-left:8px;color:var(--text-muted);font-size:12px">
                    = {envState.selfHostRepo}
                  </code>
                )}
                {!envState.selfHostRepoSet && (
                  <span style="margin-left:8px;color:var(--text-muted);font-size:12px">
                    expected <code>{SELF_HOST_FULL}</code>
                  </span>
                )}
              </span>
            </li>
          </ul>
          {!envState.selfHostRepoSet && (
            <div style="margin-top:12px;padding:10px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:6px;font-size:12px;line-height:1.5">
              <strong style="color:#f59e0b">Hint:</strong>{" "}
              <code>SELF_HOST_REPO</code> is read from{" "}
              <code>/etc/gluecron.env</code> when the gluecron service starts.
              If you just appended it via SSH, the running process won't see
              it until you run:
              <pre style="margin:8px 0 0 0;padding:6px 8px;background:var(--bg);border-radius:4px;font-size:11px;overflow-x:auto">systemctl restart gluecron</pre>
            </div>
          )}
          <div style="margin-top:14px;font-size:12px;color:var(--text-muted)">
            Overall:{" "}
            <Pill
              ok={allGreen}
              label={allGreen ? "Self-host ready" : "Setup incomplete"}
            />
          </div>
        </Card>

        <Card title="Bootstrap">
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 10px 0">
            Mirror Gluecron's source from GitHub onto this Gluecron
            instance. Idempotent — safe to re-run. See{" "}
            <a href={`/${SELF_HOST_OWNER}/${SELF_HOST_NAME}/blob/main/docs/SELF_HOST.md`}>
              docs/SELF_HOST.md
            </a>{" "}
            for the full runbook.
          </p>
          <div style="display:flex;gap:var(--space-2);align-items:center">
            <form
              method="post"
              action="/admin/self-host/bootstrap"
              style="margin:0"
              onsubmit="return confirm('Run the self-host bootstrap on this box? Safe to re-run, but it will spawn a child process.')"
            >
              <button
                type="submit"
                class="btn btn-sm btn-primary"
                disabled={repoState.exists && hookState.installed}
                title={
                  repoState.exists && hookState.installed
                    ? "Bootstrap already applied"
                    : "Run scripts/self-host-bootstrap.ts"
                }
              >
                {repoState.exists && hookState.installed
                  ? "Already bootstrapped"
                  : "Run bootstrap"}
              </button>
            </form>
            <span style="font-size:12px;color:var(--text-muted)">
              Runs <code>bun run scripts/self-host-bootstrap.ts</code>{" "}
              detached. Watch the systemd journal or{" "}
              <code>/var/log/gluecron-self-deploy.log</code>.
            </span>
          </div>
        </Card>

        <Card title="Last 10 self-deploys">
          {recent.length === 0 ? (
            <p style="color:var(--text-muted);font-size:13px;margin:0">
              No self-deploys recorded yet. Push a commit to{" "}
              <code>{SELF_HOST_FULL}</code> after completing the bootstrap.
            </p>
          ) : (
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="text-align:left;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:0.04em">
                  <th style="padding:6px 4px;border-bottom:1px solid var(--border)">
                    SHA
                  </th>
                  <th style="padding:6px 4px;border-bottom:1px solid var(--border)">
                    Status
                  </th>
                  <th style="padding:6px 4px;border-bottom:1px solid var(--border)">
                    Started
                  </th>
                  <th style="padding:6px 4px;border-bottom:1px solid var(--border);text-align:right">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((d) => (
                  <tr>
                    <td style="padding:6px 4px;border-bottom:1px solid var(--border)">
                      <code class="meta-mono">{shortSha(d.sha)}</code>
                    </td>
                    <td style="padding:6px 4px;border-bottom:1px solid var(--border)">
                      <Pill
                        ok={d.status === "succeeded"}
                        label={d.status}
                      />
                    </td>
                    <td
                      style="padding:6px 4px;border-bottom:1px solid var(--border)"
                      title={d.startedAt.toISOString()}
                    >
                      {relativeTime(d.startedAt)}
                    </td>
                    <td style="padding:6px 4px;border-bottom:1px solid var(--border);text-align:right">
                      {d.durationMs != null
                        ? `${(d.durationMs / 1000).toFixed(1)}s`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
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

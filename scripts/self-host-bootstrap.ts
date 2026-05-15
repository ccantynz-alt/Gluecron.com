/**
 * BLOCK W — Self-host bootstrap.
 *
 * Mirror Gluecron's source from GitHub onto Gluecron itself, ONCE.
 *
 * Usage (run as root on the box, or anywhere DATABASE_URL + GIT_REPOS_PATH
 * resolve to the production values):
 *
 *   bun run scripts/self-host-bootstrap.ts \
 *     [--owner=ccantynz] \
 *     [--name=Gluecron.com] \
 *     [--source=https://github.com/ccantynz-alt/Gluecron.com.git] \
 *     [--dry-run]
 *
 * Idempotent — safe to re-run. Every step prints `v`/`x`/`!` and only
 * fails the script when a step truly cannot proceed.
 *
 * Pre-flight (operator's responsibility BEFORE invoking):
 *   - DATABASE_URL points at the live Neon db (the one the running site reads)
 *   - GIT_REPOS_PATH is set (or default /opt/gluecron/repos is writable)
 *   - `git` is on PATH
 *   - At least one user row exists in `users` (we pick the site-admin or oldest)
 *   - Disk has room for a mirror clone (~200 MB working set + ~50 MB bare repo)
 *
 * What it does:
 *   1. Read env
 *   2. Look up the operator (site_admins → oldest user fallback)
 *   3. INSERT the `repositories` row (skip if it exists)
 *   4. `git init --bare` the on-disk repo (skip if it exists)
 *   5. `git push --mirror` from a temp clone of the GitHub source
 *   6. Install the self-host post-receive hook on the bare repo
 *   7. Print cutover instructions
 *
 * The post-receive hook script just forwards to the runtime
 * `src/hooks/post-receive.ts` entry point via the routes/git.ts pathway —
 * we don't replicate any of the locked Block §4.2 logic. The deploy
 * trigger lives inside the existing hook (the additive SELF_HOST_REPO
 * block at the end of `onPostReceive`).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { and, eq, asc } from "drizzle-orm";
import { existsSync } from "fs";
import { mkdir, writeFile, chmod, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// ── pretty printers (match scripts/bootstrap-hetzner.sh + install.sh) ──────
function say(msg: string): void {
  console.log("");
  console.log(`==> ${msg}`);
}
function ok(msg: string): void {
  console.log(`    v ${msg}`);
}
function warn(msg: string): void {
  console.log(`    ! ${msg}`);
}
function bad(msg: string): void {
  console.error(`    x ${msg}`);
}

// ── arg parse ──────────────────────────────────────────────────────────────
export interface BootstrapArgs {
  owner: string;
  name: string;
  source: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): BootstrapArgs {
  const out: BootstrapArgs = {
    owner: "ccantynz",
    name: "Gluecron.com",
    source: "https://github.com/ccantynz-alt/Gluecron.com.git",
    dryRun: false,
  };
  for (const a of argv) {
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "owner") out.owner = v!;
    else if (k === "name") out.name = v!;
    else if (k === "source") out.source = v!;
  }
  return out;
}

// ── shell helper (small wrapper around Bun.spawn) ──────────────────────────
export async function sh(
  cmd: string[],
  opts: { cwd?: string } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout, stderr, exitCode };
}

// ── DI seam for the orchestrator (tests inject fakes) ──────────────────────
export interface BootstrapDeps {
  db: any;
  schema: {
    users: any;
    repositories: any;
    siteAdmins: any;
  };
  reposPath: string;
  sh: typeof sh;
  fsExists: (p: string) => boolean;
  fsMkdir: (p: string, opts?: { recursive?: boolean }) => Promise<unknown>;
  fsWrite: (p: string, body: string) => Promise<unknown>;
  fsChmod: (p: string, mode: number) => Promise<unknown>;
  fsRm: (p: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<unknown>;
  log: {
    say: (m: string) => void;
    ok: (m: string) => void;
    warn: (m: string) => void;
    bad: (m: string) => void;
    info: (m: string) => void;
  };
  tmpRoot: string;
}

export interface BootstrapResult {
  ok: boolean;
  steps: {
    operator: { id: string; username: string } | null;
    repoRow: { id: string; created: boolean } | null;
    bareRepoCreated: boolean;
    mirrored: boolean;
    hookInstalled: boolean;
  };
  error?: string;
}

// ── 2. Find operator: site_admins LIMIT 1 → oldest user fallback ──────────
export async function findOperator(deps: BootstrapDeps): Promise<{
  id: string;
  username: string;
} | null> {
  const { db, schema } = deps;
  // Try site_admins first.
  try {
    const rows = await db
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.siteAdmins)
      .innerJoin(schema.users, eq(schema.siteAdmins.userId, schema.users.id))
      .limit(1);
    if (rows.length > 0 && rows[0]?.id) {
      return { id: rows[0].id, username: rows[0].username };
    }
  } catch (err) {
    deps.log.warn(
      `site_admins lookup failed (${(err as Error).message}) — falling back to oldest user`
    );
  }
  // Fallback: oldest user (the bootstrap rule, matches lib/admin.ts).
  try {
    const rows = await db
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .orderBy(asc(schema.users.createdAt))
      .limit(1);
    if (rows.length > 0 && rows[0]?.id) {
      return { id: rows[0].id, username: rows[0].username };
    }
  } catch (err) {
    deps.log.warn(`users lookup failed: ${(err as Error).message}`);
  }
  return null;
}

// ── 3. Ensure repositories row ────────────────────────────────────────────
export async function ensureRepoRow(
  deps: BootstrapDeps,
  args: { owner: string; name: string; ownerUserId: string; diskPath: string }
): Promise<{ id: string; created: boolean } | null> {
  const { db, schema } = deps;
  try {
    const existing = await db
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(
        and(
          eq(schema.repositories.ownerId, args.ownerUserId),
          eq(schema.repositories.name, args.name)
        )
      )
      .limit(1);
    if (existing.length > 0 && existing[0]?.id) {
      return { id: existing[0].id, created: false };
    }
    const inserted = await db
      .insert(schema.repositories)
      .values({
        name: args.name,
        ownerId: args.ownerUserId,
        isPrivate: false,
        defaultBranch: "main",
        diskPath: args.diskPath,
        description: "Gluecron itself — self-hosted on Gluecron.",
      })
      .returning({ id: schema.repositories.id });
    return { id: inserted[0]?.id ?? "", created: true };
  } catch (err) {
    deps.log.bad(
      `repositories insert/select failed: ${(err as Error).message}`
    );
    return null;
  }
}

// ── 4. git init --bare (idempotent) ───────────────────────────────────────
export async function ensureBareRepo(
  deps: BootstrapDeps,
  barePath: string
): Promise<boolean> {
  if (deps.fsExists(join(barePath, "HEAD"))) {
    deps.log.ok(`bare repo already exists at ${barePath}`);
    return false;
  }
  await deps.fsMkdir(barePath, { recursive: true });
  const init = await deps.sh(["git", "init", "--bare", barePath]);
  if (!init.ok) {
    deps.log.bad(`git init --bare failed: ${init.stderr.trim()}`);
    throw new Error("git init --bare failed");
  }
  // Default branch = main.
  const sym = await deps.sh(
    ["git", "symbolic-ref", "HEAD", "refs/heads/main"],
    { cwd: barePath }
  );
  if (!sym.ok) deps.log.warn(`symbolic-ref main failed: ${sym.stderr.trim()}`);
  deps.log.ok(`created bare repo at ${barePath}`);
  return true;
}

// ── 5. Mirror from GitHub source ──────────────────────────────────────────
export async function mirrorFromSource(
  deps: BootstrapDeps,
  source: string,
  barePath: string
): Promise<boolean> {
  const stamp = Date.now().toString(36);
  const tmp = join(deps.tmpRoot, `gluecron-mirror-${stamp}.git`);
  try {
    const clone = await deps.sh(["git", "clone", "--mirror", source, tmp]);
    if (!clone.ok) {
      deps.log.bad(`git clone --mirror failed: ${clone.stderr.trim()}`);
      return false;
    }
    deps.log.ok(`cloned ${source} → ${tmp}`);
    const push = await deps.sh(["git", "push", "--mirror", barePath], {
      cwd: tmp,
    });
    if (!push.ok) {
      deps.log.bad(`git push --mirror failed: ${push.stderr.trim()}`);
      return false;
    }
    deps.log.ok(`mirrored every ref into ${barePath}`);
    return true;
  } finally {
    // Best-effort cleanup.
    try {
      await deps.fsRm(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── 6. Install post-receive hook on the bare repo ─────────────────────────
//
// The hook script forwards every push through the Gluecron HTTP receive-
// pack pipeline. In practice the in-process post-receive logic fires from
// `src/routes/git.ts` after `serviceRpc(...)`, not from this on-disk hook
// — but we still install a hook here so external `git push` over SSH (the
// future protocol) goes through the same intelligence path.
//
// For HTTP receive-pack today, this hook acts as a marker + diagnostic
// breadcrumb: when present, the operator knows the bare repo is wired for
// self-host. We log to /var/log/gluecron-self-deploy.log via the
// scripts/self-deploy.sh helper.
export const SELF_HOST_HOOK_BODY = `#!/usr/bin/env bash
# Auto-installed by scripts/self-host-bootstrap.ts (BLOCK W).
# Forwards post-receive notification to the Gluecron self-deploy script.
# The Gluecron HTTP receive-pack path already invokes the in-process
# onPostReceive() (src/hooks/post-receive.ts) and triggers self-deploy when
# SELF_HOST_REPO matches. This hook is the equivalent breadcrumb for SSH
# receive-pack and external direct-push scenarios.
set -euo pipefail
# Source the operator env file so GLUECRON_SELF_DEPLOY_SCRIPT and any other
# overrides set by the operator are visible to this shell hook. systemd's
# EnvironmentFile only flows to the gluecron service, not to git hooks
# invoked by direct receive-pack — without this source the hook used the
# baked-in defaults which silently disagreed with /etc/gluecron.env.
if [ -f /etc/gluecron.env ]; then
  set -a
  . /etc/gluecron.env
  set +a
fi
SELF_DEPLOY="\${GLUECRON_SELF_DEPLOY_SCRIPT:-/opt/gluecron/scripts/self-deploy.sh}"
LOG="\${GLUECRON_SELF_DEPLOY_LOG:-/var/log/gluecron-self-deploy.log}"
if [ -x "$SELF_DEPLOY" ]; then
  # Read each pushed ref from stdin and only fire on main.
  while read -r oldsha newsha refname; do
    if [ "$refname" = "refs/heads/main" ]; then
      # Detach so git push returns immediately.
      nohup "$SELF_DEPLOY" "$oldsha" "$newsha" >>"$LOG" 2>&1 &
      disown || true
      echo "[self-host] dispatched $SELF_DEPLOY for $newsha" >&2
    fi
  done
fi
exit 0
`;

export async function installPostReceiveHook(
  deps: BootstrapDeps,
  barePath: string
): Promise<boolean> {
  const hookPath = join(barePath, "hooks", "post-receive");
  try {
    await deps.fsMkdir(join(barePath, "hooks"), { recursive: true });
    await deps.fsWrite(hookPath, SELF_HOST_HOOK_BODY);
    await deps.fsChmod(hookPath, 0o755);
    deps.log.ok(`installed post-receive hook at ${hookPath}`);
    return true;
  } catch (err) {
    deps.log.bad(`hook install failed: ${(err as Error).message}`);
    return false;
  }
}

// ── orchestrator (pure, DI'd) ─────────────────────────────────────────────
export async function runBootstrap(
  args: BootstrapArgs,
  deps: BootstrapDeps
): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    ok: false,
    steps: {
      operator: null,
      repoRow: null,
      bareRepoCreated: false,
      mirrored: false,
      hookInstalled: false,
    },
  };

  deps.log.say(`gluecron self-host bootstrap — ${args.owner}/${args.name}`);
  deps.log.info(`source : ${args.source}`);
  deps.log.info(`repos  : ${deps.reposPath}`);
  if (args.dryRun) deps.log.info("dry-run : no DB writes, no on-disk changes");

  // 1. Operator
  deps.log.say("[1/6] locating operator (site_admins → oldest user)");
  const op = await findOperator(deps);
  if (!op) {
    result.error = "no users exist — register an account first";
    deps.log.bad(result.error);
    return result;
  }
  result.steps.operator = op;
  deps.log.ok(`operator: ${op.username} (${op.id})`);

  // 2. Compute disk path
  const barePath = join(deps.reposPath, args.owner, `${args.name}.git`);
  deps.log.info(`bare path: ${barePath}`);

  // 3. Ensure repositories row
  deps.log.say("[2/6] ensuring repositories row exists");
  if (args.dryRun) {
    deps.log.info(
      `dry-run: would INSERT repositories(name=${args.name}, ownerId=${op.id})`
    );
    result.steps.repoRow = { id: "(dry-run)", created: false };
  } else {
    const row = await ensureRepoRow(deps, {
      owner: args.owner,
      name: args.name,
      ownerUserId: op.id,
      diskPath: barePath,
    });
    if (!row) {
      result.error = "could not create repositories row — aborting";
      return result;
    }
    result.steps.repoRow = row;
    deps.log.ok(
      row.created
        ? `inserted repositories row id=${row.id}`
        : `repositories row already exists id=${row.id}`
    );
  }

  // 4. Bare repo
  deps.log.say("[3/6] ensuring bare git repo on disk");
  if (args.dryRun) {
    deps.log.info(`dry-run: would git init --bare ${barePath}`);
  } else {
    try {
      result.steps.bareRepoCreated = await ensureBareRepo(deps, barePath);
    } catch (err) {
      result.error = `bare repo init failed: ${(err as Error).message}`;
      return result;
    }
  }

  // 5. Mirror
  deps.log.say("[4/6] mirroring source → bare repo");
  if (args.dryRun) {
    deps.log.info(`dry-run: would git clone --mirror ${args.source} | push --mirror`);
    result.steps.mirrored = true;
  } else {
    result.steps.mirrored = await mirrorFromSource(deps, args.source, barePath);
    if (!result.steps.mirrored) {
      result.error = "mirror failed — see above";
      return result;
    }
  }

  // 6. Hook
  deps.log.say("[5/6] installing self-host post-receive hook");
  if (args.dryRun) {
    deps.log.info(`dry-run: would write ${join(barePath, "hooks/post-receive")}`);
    result.steps.hookInstalled = true;
  } else {
    result.steps.hookInstalled = await installPostReceiveHook(deps, barePath);
  }

  // 7. Cutover instructions
  deps.log.say("[6/6] done — cutover instructions");
  result.ok =
    result.steps.repoRow !== null &&
    result.steps.mirrored &&
    result.steps.hookInstalled;
  printCutover(args, deps);
  return result;
}

export function printCutover(args: BootstrapArgs, deps: BootstrapDeps): void {
  const repoUrl = `https://gluecron.com/${args.owner}/${args.name}.git`;
  deps.log.info("");
  deps.log.info("=============================================================");
  deps.log.info("  Self-host complete. Next steps (in order):");
  deps.log.info("=============================================================");
  deps.log.info("");
  deps.log.info("  1. On your laptop (this terminal):");
  deps.log.info(`       git remote set-url origin ${repoUrl}`);
  deps.log.info("");
  deps.log.info("  2. On the production box (same change in /opt/gluecron):");
  deps.log.info(`       cd /opt/gluecron && git remote set-url origin ${repoUrl}`);
  deps.log.info("");
  deps.log.info("  3. Add to /etc/gluecron.env (so the post-receive hook fires):");
  deps.log.info(`       SELF_HOST_REPO=${args.owner}/${args.name}`);
  deps.log.info("");
  deps.log.info("  4. Push a no-op change to verify end-to-end:");
  deps.log.info("       git commit --allow-empty -m 'self-host smoke' && git push");
  deps.log.info("");
  deps.log.info("  From this moment, `git push` deploys directly via Gluecron's");
  deps.log.info("  post-receive hook in ~25 seconds. No GitHub Actions in the");
  deps.log.info("  middle. Watch /admin/deploys for the live timeline.");
  deps.log.info("");
}

// ── CLI entrypoint ────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error(
      "FATAL: DATABASE_URL is not set. Source /etc/gluecron.env or export it manually."
    );
    process.exit(2);
  }

  // Lazy import the real DB only at CLI-entry time (same pattern as
  // scripts/enable-auto-merge.ts) so unit tests can import this module
  // without booting a Neon connection.
  const { db } = await import("../src/db");
  const schemaMod = await import("../src/db/schema");
  const { config } = await import("../src/lib/config");

  const deps: BootstrapDeps = {
    db,
    schema: {
      users: schemaMod.users,
      repositories: schemaMod.repositories,
      siteAdmins: schemaMod.siteAdmins,
    },
    reposPath: config.gitReposPath,
    sh,
    fsExists: existsSync,
    fsMkdir: mkdir,
    fsWrite: (p, body) => writeFile(p, body, "utf8"),
    fsChmod: chmod,
    fsRm: rm,
    log: { say, ok, warn, bad, info: (m) => console.log(`    ${m}`) },
    tmpRoot: tmpdir(),
  };

  const result = await runBootstrap(args, deps);
  if (!result.ok) {
    if (result.error) bad(result.error);
    process.exit(1);
  }
}

// Only run when invoked as a script (not when imported by tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

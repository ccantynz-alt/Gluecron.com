/**
 * Server-target driver (Block ST).
 *
 * Drives the SSH/scp subprocess pipeline that takes a `server_targets` row
 * and either tests the connection or runs a deploy on the box. All process
 * spawning is funnelled through a single injectable seam (`__setSpawnForTests`)
 * so the test suite can drive the lib without actually shelling out.
 *
 * Design notes:
 *   - We use the host's `ssh`/`scp` CLI rather than a Node SSH library. It
 *     keeps the surface tiny (no new deps) and lets the operator manage
 *     ciphers/algorithms via /etc/ssh/ssh_config like any other server tool.
 *   - The private key is materialised into a Bun temp file with mode 0600,
 *     used for the call, then unlinked in a `finally`. Never touches /tmp
 *     persistently and never sits on disk longer than the call.
 *   - Host-key verification uses TOFU: on first connect (status='unverified'
 *     and no host_fingerprint) we accept-new and record the fingerprint.
 *     Subsequent connects pin against that fingerprint. A mismatch aborts.
 *
 * Public surface:
 *   - `testConnection(target)`     → returns ok/fail + pinned fingerprint
 *   - `deployToTarget(target, ctx)`→ uploads env, runs deploy_script
 *   - `materializeEnv(env)`        → render env-vars map to a .env body
 */

import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { decryptValue, renderDotenv } from "./server-targets-crypto";
import type { ServerTarget } from "../db/schema";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Subprocess seam. Production calls `Bun.spawn`; tests override.
 *
 * Returns the captured stdout/stderr + exit code. `stdin` is optional; when
 * provided, it's written and closed before the process is awaited so we can
 * pipe a .env body in without a temp file.
 */
export type SpawnFn = (
  cmd: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string> }
) => Promise<SpawnResult>;

const defaultSpawn: SpawnFn = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    stdin: opts.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin) {
    proc.stdin?.write(opts.stdin);
    proc.stdin?.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

let _spawn: SpawnFn = defaultSpawn;
export function __setSpawnForTests(fn: SpawnFn | null): void {
  _spawn = fn ?? defaultSpawn;
}

/**
 * Run a fn with the decrypted SSH private key written to a 0600 file in a
 * private temp dir. The dir is rm -rf'd in `finally`, no matter what.
 */
async function withKeyFile<T>(
  encryptedKey: string,
  fn: (keyPath: string) => Promise<T>
): Promise<T> {
  const dec = decryptValue(encryptedKey);
  if (!dec.ok) {
    throw new Error(`decrypt private key: ${dec.error}`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), "gluecron-st-"));
  const keyPath = path.join(dir, "id");
  await writeFile(keyPath, dec.plaintext, { mode: 0o600 });
  try {
    return await fn(keyPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Build the common `ssh` arg list. On a target with no pinned fingerprint we
 * pass `accept-new`; once pinned we require strict host-key checking via the
 * known-hosts file we materialise alongside the key.
 *
 * Returns the args up to (but not including) the remote command — the
 * caller appends `[user@host, ...cmd]` or scp paths.
 */
function sshBaseArgs(target: ServerTarget, keyPath: string): string[] {
  const knownHostsArg = target.hostFingerprint
    ? // Pinned: hand ssh a known_hosts line via -o KnownHostsCommand-ish
      // bypass — easier route is a temp file passed via UserKnownHostsFile.
      // We can't easily inline a fingerprint without the full key, so we
      // fall back to strict checking against a per-target known_hosts file
      // written next to the key. With no host_fingerprint we accept-new.
      ["-o", "StrictHostKeyChecking=yes"]
    : ["-o", "StrictHostKeyChecking=accept-new"];
  return [
    "-i",
    keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    `UserKnownHostsFile=${path.join(path.dirname(keyPath), "known_hosts")}`,
    ...knownHostsArg,
    "-p",
    String(target.port),
  ];
}

/**
 * Test connectivity. Returns the host fingerprint (SHA256 of the host key)
 * captured via `ssh-keyscan` so the caller can pin it on the row.
 *
 * Flow:
 *   1. ssh-keyscan -p <port> <host>            → host key text
 *   2. ssh-keygen -lf <keyfile>                → SHA256:<fp> fingerprint
 *   3. ssh -i <key> user@host 'echo gluecron'  → confirms key works
 *
 * Any step's non-zero exit collapses to {ok:false}. Never throws.
 */
export async function testConnection(
  target: ServerTarget
): Promise<
  | { ok: true; fingerprint: string }
  | { ok: false; error: string; stage: "scan" | "fingerprint" | "auth" }
> {
  try {
    return await withKeyFile(target.encryptedPrivateKey, async (keyPath) => {
      const dir = path.dirname(keyPath);
      const scan = await _spawn(
        ["ssh-keyscan", "-T", "5", "-p", String(target.port), target.host],
        {}
      );
      if (scan.exitCode !== 0 || !scan.stdout.trim()) {
        return {
          ok: false as const,
          error: scan.stderr.trim() || "ssh-keyscan returned nothing",
          stage: "scan" as const,
        };
      }
      const knownHostsPath = path.join(dir, "known_hosts");
      await writeFile(knownHostsPath, scan.stdout);

      const fp = await _spawn(["ssh-keygen", "-lf", knownHostsPath], {});
      if (fp.exitCode !== 0) {
        return {
          ok: false as const,
          error: fp.stderr.trim() || "ssh-keygen failed",
          stage: "fingerprint" as const,
        };
      }
      // Output format: "<bits> SHA256:<base64> comment (TYPE)"
      const match = fp.stdout.match(/SHA256:[A-Za-z0-9+/=]+/);
      const fingerprint = match ? match[0] : fp.stdout.trim().split(/\s+/)[1] || "";

      const probe = await _spawn(
        [
          "ssh",
          ...sshBaseArgs(target, keyPath),
          `${target.sshUser}@${target.host}`,
          "echo gluecron-ok",
        ],
        {}
      );
      if (probe.exitCode !== 0 || !probe.stdout.includes("gluecron-ok")) {
        return {
          ok: false as const,
          error: probe.stderr.trim() || "ssh probe failed",
          stage: "auth" as const,
        };
      }
      return { ok: true as const, fingerprint };
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stage: "auth",
    };
  }
}

export interface DeployContext {
  commitSha?: string;
  ref?: string;
  /** Decrypted env-var map (KEY → value). Render to .env before upload. */
  env: Record<string, string>;
}

export interface DeployResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the deploy on the target box.
 *
 * Sequence:
 *   1. Write env map → /tmp/gluecron-<rand>.env (locally), scp to
 *      `<deploy_path>/.env.gluecron` on the box (0600 via umask).
 *   2. ssh user@host 'cd <deploy_path> && set -a && . ./.env.gluecron \
 *                     && set +a && <deploy_script>'
 *   3. Capture stdout+stderr+exit and return.
 *
 * Never throws — every failure is folded into the DeployResult with the
 * stderr line that explains why. Caller is responsible for inserting the
 * `server_target_deployments` row.
 */
export async function deployToTarget(
  target: ServerTarget,
  ctx: DeployContext
): Promise<DeployResult> {
  try {
    return await withKeyFile(target.encryptedPrivateKey, async (keyPath) => {
      const dir = path.dirname(keyPath);

      // Materialise known_hosts up front so we can run ssh in strict mode
      // for a target that's already been pinned.
      if (target.hostFingerprint) {
        // We don't have the raw host key, only the fingerprint, so we
        // re-scan and verify the fingerprint matches before writing the
        // known_hosts file. A mismatch is a hard abort.
        const scan = await _spawn(
          ["ssh-keyscan", "-T", "5", "-p", String(target.port), target.host],
          {}
        );
        if (scan.exitCode !== 0 || !scan.stdout.trim()) {
          return {
            ok: false,
            exitCode: scan.exitCode,
            stdout: "",
            stderr: `ssh-keyscan: ${scan.stderr.trim() || "no host key returned"}`,
          };
        }
        const knownHostsPath = path.join(dir, "known_hosts");
        await writeFile(knownHostsPath, scan.stdout);
        const fp = await _spawn(["ssh-keygen", "-lf", knownHostsPath], {});
        const live = (fp.stdout.match(/SHA256:[A-Za-z0-9+/=]+/) || [""])[0];
        if (!live || live !== target.hostFingerprint) {
          return {
            ok: false,
            exitCode: 255,
            stdout: "",
            stderr: `host key fingerprint mismatch — pinned=${target.hostFingerprint} live=${live || "<none>"}. Aborting deploy.`,
          };
        }
      }

      const dotenv = renderDotenv(ctx.env);
      const envPath = path.join(dir, "deploy.env");
      await writeFile(envPath, dotenv, { mode: 0o600 });

      // scp the .env up. The remote path is fixed for predictability.
      const remoteEnv = `${target.deployPath.replace(/\/$/, "")}/.env.gluecron`;
      const scp = await _spawn(
        [
          "scp",
          ...sshBaseArgs(target, keyPath),
          envPath,
          `${target.sshUser}@${target.host}:${remoteEnv}`,
        ],
        {}
      );
      if (scp.exitCode !== 0) {
        return {
          ok: false,
          exitCode: scp.exitCode,
          stdout: scp.stdout,
          stderr: `scp env: ${scp.stderr.trim()}`,
        };
      }

      const commitExport = ctx.commitSha
        ? `export GLUECRON_COMMIT_SHA='${ctx.commitSha.replace(/'/g, "")}'; `
        : "";
      const refExport = ctx.ref
        ? `export GLUECRON_REF='${ctx.ref.replace(/'/g, "")}'; `
        : "";
      const remoteCmd =
        `cd '${target.deployPath.replace(/'/g, "'\\''")}' && ` +
        `set -a && . ./.env.gluecron && set +a && ` +
        commitExport +
        refExport +
        target.deployScript;

      const run = await _spawn(
        [
          "ssh",
          ...sshBaseArgs(target, keyPath),
          `${target.sshUser}@${target.host}`,
          remoteCmd,
        ],
        {}
      );
      return {
        ok: run.exitCode === 0,
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
      };
    });
  } catch (err) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

export { renderDotenv } from "./server-targets-crypto";

/** Test-only access to internal seams. */
export const __test = {
  sshBaseArgs,
  withKeyFile,
};

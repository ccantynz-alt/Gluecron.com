/**
 * SSH git server — Block SSH-1.
 *
 * Listens on SSH_PORT (default 2222) and accepts git-upload-pack /
 * git-receive-pack commands authenticated by SSH public key.
 *
 * Auth flow:
 *   1. Client presents public key (phase 1 — no signature yet).
 *      Server checks key blob against the `ssh_keys` table; if found,
 *      calls ctx.accept() to let the client proceed to phase 2.
 *   2. Client sends the signed blob (phase 2).
 *      Server verifies the signature with the presented public key, then
 *      calls ctx.accept() to establish the session.
 *
 * Git flow:
 *   - Exec command "git-upload-pack '/owner/repo.git'" → clone / fetch.
 *   - Exec command "git-receive-pack '/owner/repo.git'" → push.
 *   - Shell sessions are rejected with a friendly message.
 *   - All other exec commands are rejected.
 *
 * Post-receive:
 *   For push, we snapshot refs before + after via `git show-ref` to
 *   compute the ref diff, then call onPostReceive exactly as the HTTP
 *   handler does.  Pack-content policies (message patterns, file-path
 *   rules) that require pack inspection are v2 work.
 *
 * Host key:
 *   Loaded from SSH_HOST_KEY env var (PEM) or auto-generated (ephemeral,
 *   fine for dev but triggers "host key changed" on restart in prod).
 */

// ssh2 ships no TypeScript declarations; suppress until @types/ssh2 is available.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no types
import { Server as SshServer, utils as sshUtils } from "ssh2";
// @ts-expect-error no types
import type { AuthContext, Connection, ServerChannel } from "ssh2";
import { spawn } from "child_process";
import { generateKeyPairSync } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, sshKeys, users } from "../db/schema";
import { config } from "./config";
import { repoExists } from "../git/repository";
import { invalidateRepoCache } from "./cache";
import { onPostReceive } from "../hooks/post-receive";
import { evaluatePushPolicy, formatPolicyError, installPackInspectionHookForRepo } from "./push-policy";
import {
  resolveRepoAccess,
  satisfiesAccess,
} from "../middleware/repo-access";
import { audit } from "./notify";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PushRef = { oldSha: string; newSha: string; refName: string };

// ---------------------------------------------------------------------------
// Host key
// ---------------------------------------------------------------------------

function loadOrGenerateHostKey(): Buffer {
  const raw = config.sshHostKey;
  if (raw) {
    // Support \\n escapes (common in env-var values from .env files)
    return Buffer.from(raw.replace(/\\n/g, "\n"), "utf8");
  }
  console.warn(
    "[ssh] SSH_HOST_KEY not set — generating an ephemeral Ed25519 key. " +
      "Clients will see 'host key changed' on restart. " +
      "Set SSH_HOST_KEY to a persistent PEM Ed25519 private key in production."
  );
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return Buffer.from(privateKey, "utf8");
}

// Lazily initialised so tests that don't start the server don't trigger
// key generation at import time.
let _hostKey: Buffer | null = null;
function getHostKey(): Buffer {
  if (!_hostKey) _hostKey = loadOrGenerateHostKey();
  return _hostKey;
}

// ---------------------------------------------------------------------------
// Public key lookup
// ---------------------------------------------------------------------------

/**
 * Find the Gluecron user who owns the given SSH public key blob.
 * The blob is the raw SSH wire-format bytes that ssh2 gives us in
 * ctx.key.data.  The stored authorized_keys format is "algo base64blob
 * [comment]" — we extract the blob component for the byte comparison.
 */
export async function resolveUserByKeyBlob(
  keyBlob: Buffer
): Promise<{ userId: string; username: string; keyId: string } | null> {
  const targetB64 = keyBlob.toString("base64");
  try {
    const rows = await db
      .select({
        id: sshKeys.id,
        userId: sshKeys.userId,
        publicKey: sshKeys.publicKey,
      })
      .from(sshKeys);

    for (const row of rows) {
      // Stored format: "<algo> <base64blob> [comment]"
      const parts = row.publicKey.trim().split(/\s+/);
      if (parts.length < 2) continue;
      if (parts[1] === targetB64) {
        const [u] = await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(eq(users.id, row.userId))
          .limit(1);
        if (!u) continue;
        return { userId: u.id, username: u.username, keyId: row.id };
      }
    }
  } catch {
    // fail closed — unknown key is treated as not found
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git command parsing
// ---------------------------------------------------------------------------

/**
 * Parse the exec command that git sends over SSH.
 *
 * Expected forms (git always quotes the path):
 *   git-upload-pack '/owner/repo.git'
 *   git-receive-pack '/owner/repo.git'
 *   git-upload-pack 'owner/repo.git'   (some clients omit leading /)
 *
 * Returns null for anything that doesn't match.
 */
export function parseGitCommand(cmd: string): {
  service: "git-upload-pack" | "git-receive-pack";
  owner: string;
  repo: string;
} | null {
  const m =
    /^(git-upload-pack|git-receive-pack)\s+'?\/?([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+?)(?:\.git)?'?\s*$/.exec(
      cmd.trim()
    );
  if (!m) return null;
  return {
    service: m[1] as "git-upload-pack" | "git-receive-pack",
    owner: m[2],
    repo: m[3],
  };
}

// ---------------------------------------------------------------------------
// Ref snapshotting (for post-receive hook parity with HTTP handler)
// ---------------------------------------------------------------------------

async function getShowRef(
  repoPath: string
): Promise<Array<{ sha: string; ref: string }>> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["show-ref"], { cwd: repoPath });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    proc.on("close", () => {
      const refs: Array<{ sha: string; ref: string }> = [];
      for (const line of out.trim().split("\n")) {
        const parts = line.trim().split(/\s+/, 2);
        if (parts.length === 2 && parts[0] && parts[1]) {
          refs.push({ sha: parts[0], ref: parts[1] });
        }
      }
      resolve(refs);
    });
    proc.on("error", () => resolve([]));
  });
}

export function computePushedRefs(
  before: Array<{ sha: string; ref: string }>,
  after: Array<{ sha: string; ref: string }>
): PushRef[] {
  const beforeMap = new Map(before.map((r) => [r.ref, r.sha]));
  const afterMap = new Map(after.map((r) => [r.ref, r.sha]));
  const pushed: PushRef[] = [];
  const ZERO = "0".repeat(40);

  for (const [ref, sha] of afterMap) {
    const old = beforeMap.get(ref) ?? ZERO;
    if (old !== sha) pushed.push({ oldSha: old, newSha: sha, refName: ref });
  }
  for (const [ref, sha] of beforeMap) {
    if (!afterMap.has(ref)) {
      pushed.push({ oldSha: sha, newSha: ZERO, refName: ref });
    }
  }
  return pushed;
}

// ---------------------------------------------------------------------------
// Repo lookup (DB)
// ---------------------------------------------------------------------------

async function loadRepoInfo(
  owner: string,
  repo: string
): Promise<{ id: string; isPrivate: boolean } | null> {
  try {
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, owner))
      .limit(1);
    if (!ownerRow) return null;

    const [repoRow] = await db
      .select({ id: repositories.id, isPrivate: repositories.isPrivate })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, repo)
        )
      )
      .limit(1);
    return repoRow ? { id: repoRow.id, isPrivate: repoRow.isPrivate } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git stdio bridge (Node child_process → ssh2 channel)
// ---------------------------------------------------------------------------

/**
 * Spawn a git service process and pipe its I/O to the SSH channel.
 * Returns the process exit code.
 *
 * We use child_process.spawn (not Bun.spawn) because it gives us
 * Node.js Readable/Writable streams that ssh2 channels can .pipe()
 * directly without a Web ↔ Node stream conversion.
 */
function pipeGitToChannel(
  service: string,
  absRepoPath: string,
  channel: ServerChannel,
  extraEnv?: Record<string, string>
): Promise<number> {
  return new Promise((resolve) => {
    const gitProc = spawn(service, [absRepoPath], {
      env: { ...process.env, HOME: process.env.HOME ?? "/tmp", ...extraEnv },
    });

    // Client → git stdin
    channel.pipe(gitProc.stdin);

    // git stdout → client  (end:false so we control channel teardown)
    gitProc.stdout.pipe(channel, { end: false });

    // git stderr → client stderr  (end:false for same reason)
    gitProc.stderr.pipe(channel.stderr, { end: false });

    // If the client disconnects mid-stream, kill the git process.
    channel.on("close", () => {
      try {
        gitProc.kill();
      } catch {}
    });

    gitProc.on("error", (err) => {
      console.error(`[ssh-git] spawn failed for ${service}:`, err.message);
      try {
        channel.stderr.write(`remote: git error: ${err.message}\n`);
        channel.exit(1);
        channel.end();
      } catch {}
      resolve(1);
    });

    gitProc.on("close", (code) => {
      const exitCode = code ?? 0;
      try {
        channel.exit(exitCode);
        channel.end();
      } catch {}
      resolve(exitCode);
    });
  });
}

// ---------------------------------------------------------------------------
// Main command handler
// ---------------------------------------------------------------------------

async function handleGitCommand(
  service: "git-upload-pack" | "git-receive-pack",
  owner: string,
  repo: string,
  userId: string | null,
  channel: ServerChannel
): Promise<void> {
  const absRepoPath = join(config.gitReposPath, owner, `${repo}.git`);

  // 1. Repo must exist
  if (!(await repoExists(owner, repo))) {
    channel.stderr.write("remote: Repository not found.\n");
    channel.exit(128);
    channel.end();
    return;
  }

  // 2. Load repo metadata for access control
  const repoInfo = await loadRepoInfo(owner, repo);
  if (!repoInfo) {
    channel.stderr.write("remote: Repository not found.\n");
    channel.exit(128);
    channel.end();
    return;
  }

  // 3. Resolve access level
  const access = await resolveRepoAccess({
    repoId: repoInfo.id,
    userId,
    isPublic: !repoInfo.isPrivate,
  });

  if (service === "git-receive-pack") {
    // Push requires write
    if (!satisfiesAccess(access, "write")) {
      const msg = userId
        ? "remote: Permission denied.\n"
        : "remote: Authentication required.\n";
      channel.stderr.write(msg);
      channel.exit(128);
      channel.end();
      return;
    }

    // Ref-name push policies run before the pack lands (name-only checks).
    // Pack-content inspection is wired via a pre-receive hook so it runs
    // inside git's quarantine window — same approach as the HTTP path.
    const refsBefore = await getShowRef(absRepoPath);

    audit({
      userId,
      repositoryId: repoInfo.id,
      action: "git.push.ssh",
      targetType: "repository",
      targetId: repoInfo.id,
    }).catch(() => {});

    let hookEnv: Record<string, string> | undefined;
    let hookCleanup: (() => Promise<void>) | undefined;
    try {
      const hook = await installPackInspectionHookForRepo(repoInfo.id);
      if (hook) {
        hookEnv = hook.env;
        hookCleanup = hook.cleanup;
      }
    } catch {
      // fail-open
    }

    let exitCode: number;
    try {
      exitCode = await pipeGitToChannel(service, absRepoPath, channel, hookEnv);
    } finally {
      hookCleanup?.().catch(() => {});
    }

    if (exitCode === 0) {
      const refsAfter = await getShowRef(absRepoPath);
      const pushedRefs = computePushedRefs(refsBefore, refsAfter);
      invalidateRepoCache(owner, repo);
      if (pushedRefs.length > 0) {
        onPostReceive(owner, repo, pushedRefs).catch((err) =>
          console.error("[ssh-post-receive]", err)
        );
      }
    }
  } else {
    // Clone / fetch requires read
    if (!satisfiesAccess(access, "read")) {
      // Intentionally vague — don't reveal that the repo exists
      channel.stderr.write("remote: Repository not found.\n");
      channel.exit(128);
      channel.end();
      return;
    }
    await pipeGitToChannel(service, absRepoPath, channel);
  }
}

// ---------------------------------------------------------------------------
// Signature verification helper
// ---------------------------------------------------------------------------

/** Extract the hash algorithm hint for RSA keys from the ctx.key.algo string. */
function rsaHashAlgo(algo: string): string | undefined {
  if (/sha2?-?512/i.test(algo)) return "sha512";
  if (/sha2?-?256/i.test(algo)) return "sha256";
  return undefined;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createSshServer(): ReturnType<typeof SshServer> {
  const server = new SshServer(
    { hostKeys: [getHostKey()] },
    (client: Connection) => {
      // Per-connection auth state
      let authUser: { userId: string; username: string; keyId: string } | null =
        null;

      client.on("authentication", async (ctx: AuthContext) => {
        if (ctx.method === "none") {
          return ctx.reject(["publickey"]);
        }
        if (ctx.method !== "publickey") {
          return ctx.reject(["publickey"]);
        }

        // Phase 1 or 2 — always check DB first
        const user = await resolveUserByKeyBlob(ctx.key.data);
        if (!user) {
          return ctx.reject();
        }

        if (!ctx.signature) {
          // Phase 1: key is known — tell git client to proceed with signature
          return ctx.accept();
        }

        // Phase 2: verify the signature
        const pubKeyStr = `${ctx.key.algo} ${ctx.key.data.toString("base64")}`;
        let parsedKey: ReturnType<typeof sshUtils.parseKey>;
        try {
          parsedKey = sshUtils.parseKey(pubKeyStr);
        } catch {
          return ctx.reject();
        }
        if (!parsedKey || parsedKey instanceof Error) {
          return ctx.reject();
        }

        // RSA keys need an explicit hash algorithm hint
        const hashAlgo = rsaHashAlgo(ctx.key.algo);
        const verified = hashAlgo
          ? parsedKey.verify(ctx.blob, ctx.signature, hashAlgo)
          : parsedKey.verify(ctx.blob, ctx.signature);

        if (verified !== true) {
          return ctx.reject();
        }

        // Touch last_used_at for the key — fire and forget
        db.update(sshKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(sshKeys.id, user.keyId))
          .catch(() => {});

        authUser = user;
        ctx.accept();
      });

      client.on("ready", () => {
        client.on("session", (accept: () => ServerChannel) => {
          const session = accept();

          session.on("exec", async (accept: () => ServerChannel, _reject: () => void, info: { command: string }) => {
            const parsed = parseGitCommand(info.command);
            const channel = accept();

            if (!parsed) {
              channel.stderr.write(
                `remote: Unsupported command: ${info.command}\n`
              );
              channel.stderr.write(
                "remote: Only git-upload-pack and git-receive-pack are allowed.\n"
              );
              channel.exit(1);
              channel.end();
              return;
            }

            await handleGitCommand(
              parsed.service,
              parsed.owner,
              parsed.repo,
              authUser?.userId ?? null,
              channel
            );
          });

          // Interactive shell — reject gracefully
          session.on("shell", (accept: () => ServerChannel) => {
            const channel = accept();
            channel.write(
              "Hi there! Gluecron is a git-only service. Shell access is not available.\r\n"
            );
            channel.write(
              "Clone a repo: git clone git@gluecron.com:owner/repo.git\r\n"
            );
            channel.exit(0);
            channel.end();
          });
        });
      });

      client.on("error", (err: Error) => {
        if (process.env.SSH_DEBUG) {
          console.debug("[ssh] client error:", err.message);
        }
      });
    }
  );

  server.on("error", (err: Error) => {
    console.error("[ssh] server error:", err);
  });

  return server;
}

/**
 * Start the SSH server on the configured port.
 * A no-op when SSH_PORT=0.
 */
export function startSshServer(port?: number): void {
  const sshPort = port ?? config.sshPort;
  if (sshPort === 0) {
    console.log("  ssh     disabled (SSH_PORT=0)");
    return;
  }

  try {
    const server = createSshServer();
    server.listen(sshPort, "0.0.0.0", () => {
      console.log(`  ssh://  git@<host>:owner/repo.git  (port ${sshPort})`);
    });
  } catch (err) {
    console.error(
      "[ssh] failed to start:",
      err instanceof Error ? err.message : err
    );
  }
}

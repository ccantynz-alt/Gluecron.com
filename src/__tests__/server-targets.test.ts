/**
 * Driver-level tests for src/lib/server-targets.ts.
 *
 * We never actually shell out — `__setSpawnForTests` lets us inspect the
 * command line the driver builds and feed back canned exit codes. Covers:
 *   - testConnection happy path (returns SHA256 fingerprint)
 *   - deployToTarget happy path (env file is materialised + sourced)
 *   - host-key fingerprint mismatch aborts the deploy
 *   - missing SERVER_TARGETS_KEY collapses to ok:false (no throw)
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import {
  __setSpawnForTests,
  deployToTarget,
  testConnection,
  type SpawnResult,
} from "../lib/server-targets";
import { encryptValue } from "../lib/server-targets-crypto";
import type { ServerTarget } from "../db/schema";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HOST_FP = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const originalKey = process.env.SERVER_TARGETS_KEY;

beforeEach(() => {
  process.env.SERVER_TARGETS_KEY = TEST_KEY;
});

afterEach(() => {
  __setSpawnForTests(null);
  if (originalKey === undefined) delete process.env.SERVER_TARGETS_KEY;
  else process.env.SERVER_TARGETS_KEY = originalKey;
});

function buildTarget(overrides: Partial<ServerTarget> = {}): ServerTarget {
  const enc = encryptValue("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n");
  if (!enc.ok) throw new Error("encrypt failed in test setup: " + enc.error);
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "test-box",
    host: "192.0.2.10",
    port: 22,
    sshUser: "deploy",
    encryptedPrivateKey: enc.ciphertext,
    hostFingerprint: null,
    deployPath: "/var/www/app",
    deployScript: "echo deployed",
    watchedRepositoryId: null,
    watchedBranch: null,
    status: "unverified",
    lastSeenAt: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ServerTarget;
}

describe("testConnection", () => {
  it("returns the fingerprint and ok=true on a clean run", async () => {
    const calls: Array<string[]> = [];
    __setSpawnForTests(async (cmd) => {
      calls.push(cmd);
      const [bin] = cmd;
      if (bin === "ssh-keyscan") {
        return ok("192.0.2.10 ssh-ed25519 AAAA...\n");
      }
      if (bin === "ssh-keygen") {
        return ok(`256 ${HOST_FP} root@box (ED25519)\n`);
      }
      if (bin === "ssh") {
        return ok("gluecron-ok\n");
      }
      return fail("unexpected cmd: " + cmd.join(" "));
    });

    const result = await testConnection(buildTarget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fingerprint).toBe(HOST_FP);
    expect(calls.length).toBe(3);
    expect(calls[0][0]).toBe("ssh-keyscan");
    expect(calls[2][0]).toBe("ssh");
  });

  it("returns ok=false at the scan stage when ssh-keyscan fails", async () => {
    __setSpawnForTests(async (cmd) => {
      if (cmd[0] === "ssh-keyscan") return fail("Connection refused");
      return ok("");
    });
    const result = await testConnection(buildTarget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("scan");
  });

  it("returns ok=false at auth stage when ssh probe fails", async () => {
    __setSpawnForTests(async (cmd) => {
      if (cmd[0] === "ssh-keyscan") return ok("192.0.2.10 ssh-ed25519 AAAA\n");
      if (cmd[0] === "ssh-keygen") return ok(`256 ${HOST_FP} (ED25519)\n`);
      if (cmd[0] === "ssh") return fail("Permission denied (publickey)");
      return fail("?");
    });
    const result = await testConnection(buildTarget());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("auth");
  });
});

describe("deployToTarget", () => {
  it("scp's the env file then ssh-runs the deploy script", async () => {
    const calls: Array<string[]> = [];
    __setSpawnForTests(async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "scp") return ok("");
      if (cmd[0] === "ssh") return ok("done\n");
      return fail("?");
    });
    const result = await deployToTarget(buildTarget(), {
      env: { FOO: "1", BAR: "two" },
      commitSha: "abc1234",
      ref: "refs/heads/main",
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);

    // Two calls: scp, then ssh.
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toBe("scp");
    // scp target ends at deploy_path/.env.gluecron
    const scpDst = calls[0][calls[0].length - 1];
    expect(scpDst).toBe("deploy@192.0.2.10:/var/www/app/.env.gluecron");

    expect(calls[1][0]).toBe("ssh");
    const remoteCmd = calls[1][calls[1].length - 1];
    expect(remoteCmd).toContain("cd '/var/www/app'");
    expect(remoteCmd).toContain(". ./.env.gluecron");
    expect(remoteCmd).toContain("export GLUECRON_COMMIT_SHA='abc1234'");
    expect(remoteCmd).toContain("echo deployed");
  });

  it("aborts deploy when pinned fingerprint doesn't match live", async () => {
    __setSpawnForTests(async (cmd) => {
      if (cmd[0] === "ssh-keyscan") return ok("192.0.2.10 ssh-ed25519 AAAA\n");
      if (cmd[0] === "ssh-keygen") return ok("256 SHA256:DIFFERENT (ED25519)\n");
      return fail("should not get here");
    });
    const result = await deployToTarget(
      buildTarget({ hostFingerprint: HOST_FP }),
      { env: {} }
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("fingerprint mismatch");
  });

  it("collapses to ok=false when SERVER_TARGETS_KEY is missing", async () => {
    const target = buildTarget(); // build while key is present so encrypt works
    delete process.env.SERVER_TARGETS_KEY; // now drop it — decrypt must fail cleanly
    const result = await deployToTarget(target, { env: {} });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function ok(stdout: string): SpawnResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr: string): SpawnResult {
  return { exitCode: 1, stdout: "", stderr };
}

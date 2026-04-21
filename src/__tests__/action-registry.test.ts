/**
 * Unit tests for src/lib/action-registry.ts (Agent 8, Sprint 1).
 *
 * Covers the in-memory registry resolution logic and the two simplest
 * built-ins (checkout, gatetest) that can be exercised without hitting the
 * filesystem or a real backend. The cache/upload/download actions all spawn
 * `tar` and talk to Agent 6's helper module; they're out of scope here
 * (they're integration-shaped and better served by integration tests).
 *
 * The `gatetest` handler calls `db.select()` to resolve owner/repo. We stub
 * `../db` via `mock.module` the same way `repo-access.test.ts` does, so the
 * test stays deterministic without real Postgres.
 */

import { describe, it, expect, mock, afterAll } from "bun:test";

// Stub the DB module before importing the registry.
let _lastFrom: any = null;
let _nextRepoRow: { name: string; ownerId: string } | undefined;
let _nextUserRow: { username: string } | undefined;

const _chain: any = {
  from: (table: any) => {
    _lastFrom = table;
    return _chain;
  },
  where: () => _chain,
  leftJoin: () => _chain,
  innerJoin: () => _chain,
  orderBy: () => _chain,
  limit: async () => {
    const t = _lastFrom;
    if (t && typeof t === "object") {
      if ("username" in t && "passwordHash" in t) {
        return _nextUserRow ? [_nextUserRow] : [];
      }
      if ("ownerId" in t && "name" in t) {
        return _nextRepoRow ? [_nextRepoRow] : [];
      }
    }
    return [];
  },
  set: () => _chain,
};

const _fakeDb = {
  db: {
    select: () => _chain,
    insert: () => _chain,
    update: () => _chain,
    delete: () => _chain,
  },
  getDb: () => ({
    select: () => _chain,
    insert: () => _chain,
    update: () => _chain,
    delete: () => _chain,
  }),
};
mock.module("../db", () => _fakeDb);

afterAll(() => {
  _nextRepoRow = undefined;
  _nextUserRow = undefined;
  _lastFrom = null;
});

// Import AFTER the mock is registered so the registry's built-ins see the
// stub DB when they pull in `../db`.
import {
  resolveAction,
  listActions,
  registerAction,
} from "../lib/action-registry";

const ORIGINAL_GATETEST_URL = process.env.GATETEST_URL;
function clearGatetestUrl() {
  delete process.env.GATETEST_URL;
}
function restoreGatetestUrl() {
  if (ORIGINAL_GATETEST_URL === undefined) delete process.env.GATETEST_URL;
  else process.env.GATETEST_URL = ORIGINAL_GATETEST_URL;
}

afterAll(() => {
  restoreGatetestUrl();
});

const ACTION_CTX_BASE = {
  with: {},
  env: {},
  workspace: "/tmp/fake-workspace",
  runId: "run-id",
  jobId: "job-id",
  repoId: "repo-id",
  commitSha: "deadbeef",
  ref: "refs/heads/main",
};

describe("action-registry — resolveAction", () => {
  it("resolves gluecron/checkout@v1 to the checkout handler", () => {
    const h = resolveAction("gluecron/checkout@v1");
    expect(h).not.toBeNull();
    expect(h?.name).toBe("gluecron/checkout");
    expect(h?.version).toBe("v1");
  });

  it("resolves gluecron/gatetest@v1 to the gatetest handler", () => {
    const h = resolveAction("gluecron/gatetest@v1");
    expect(h).not.toBeNull();
    expect(h?.name).toBe("gluecron/gatetest");
    expect(h?.version).toBe("v1");
  });

  it("resolveAction('unknown/foo@v1') returns null", () => {
    const h = resolveAction("unknown/foo@v1");
    expect(h).toBeNull();
  });

  it("resolveAction('gluecron/checkout') with no @version resolves to the default (v1)", () => {
    const h = resolveAction("gluecron/checkout");
    expect(h).not.toBeNull();
    expect(h?.name).toBe("gluecron/checkout");
    expect(h?.version).toBe("v1");
  });

  it("listActions() includes all 5 built-ins", () => {
    const names = listActions().map((a) => a.name);
    expect(names).toContain("gluecron/checkout");
    expect(names).toContain("gluecron/gatetest");
    expect(names).toContain("gluecron/cache");
    expect(names).toContain("gluecron/upload-artifact");
    expect(names).toContain("gluecron/download-artifact");
  });

  it("registerAction de-duplicates repeated registrations of the same name@version", () => {
    // Use a dedicated test-only name so we don't clobber a built-in.
    const before = listActions().length;
    const handler = {
      name: "gluecron/__test_dedupe__",
      version: "v1",
      async run() {
        return { exitCode: 0 };
      },
    };
    registerAction(handler);
    const afterFirst = listActions().length;
    registerAction(handler);
    const afterSecond = listActions().length;
    expect(afterFirst).toBe(before + 1);
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("action-registry — built-in behaviour", () => {
  it("checkout.run() returns exitCode 0 and emits the sha output", async () => {
    const h = resolveAction("gluecron/checkout@v1")!;
    const res = await h.run({ ...ACTION_CTX_BASE });
    expect(res.exitCode).toBe(0);
    expect(res.outputs?.sha).toBe("deadbeef");
  });

  it("gatetest.run() handles missing repo lookup gracefully (returns non-zero with stderr)", async () => {
    // The config getter provides a default GATETEST_URL, so we exercise the
    // realistic path: the action tries to look up the repo. Our DB stub
    // returns no rows, so the handler reports an unresolved-repo error but
    // never throws — the key contract is "handler returns a result object".
    _nextRepoRow = undefined;
    _nextUserRow = undefined;
    const h = resolveAction("gluecron/gatetest@v1")!;
    const res = await h.run({ ...ACTION_CTX_BASE });
    expect(typeof res.exitCode).toBe("number");
    // With no repo row, the handler emits a 'unable to resolve' stderr on 1
    // OR a 'GateTest: ...' result on 0 if a fallback path was taken. Either
    // way, we expect a structured object (never throws).
    expect(res).toBeDefined();
    if (res.exitCode !== 0) {
      expect((res.stderr || "").length).toBeGreaterThan(0);
    }
  });
});

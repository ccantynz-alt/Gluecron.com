/**
 * Unit tests for src/lib/import-verify.ts.
 *
 * We stub the `../db` module with `mock.module` so we never touch Neon.
 * The fake `db.select(...)` chain returns whatever the per-test closure
 * decides — either undefined (repo not found) or a plausible row whose
 * on-disk path points somewhere that doesn't exist.
 */

import { describe, it, expect, mock } from "bun:test";

// Per-test mutable row — each test assigns its own value before calling
// verifyMigration. The chained Drizzle-style select builder ends in
// `.limit(1)` which we return as an array containing (or omitting) this row.
let _nextRow: { repoName: string; ownerName: string | null } | undefined;

// Minimal Drizzle `db.select(...).from(...).leftJoin(...).where(...).limit(1)`
// chain. Every step returns `this` except `.limit()` which resolves the
// fake row as a 1-element (or 0-element) array.
const _chain: any = {
  from: () => _chain,
  leftJoin: () => _chain,
  where: () => _chain,
  limit: async () => (_nextRow ? [_nextRow] : []),
};

// Mock `../db` at module scope so the dynamic import of ../lib/import-verify
// below picks up the stub instead of the real Neon-backed proxy.
const _fakeDb = {
  db: { select: () => _chain },
  getDb: () => ({ select: () => _chain }),
};
mock.module("../db", () => _fakeDb);

// Point GIT_REPOS_PATH at a directory that definitely doesn't contain
// any of the fake repos we'll reference, so `clonable` checks fail.
process.env.GIT_REPOS_PATH = "/tmp/gluecron-import-verify-does-not-exist";

describe("verifyMigration", () => {
  it("returns clonable:false and issue when repo not found in DB", async () => {
    _nextRow = undefined;
    const { verifyMigration } = await import("../lib/import-verify");
    const r = await verifyMigration(999);
    expect(r.repoId).toBe(999);
    expect(r.clonable).toBe(false);
    expect(r.hasDefaultBranch).toBe(false);
    expect(r.commitCount).toBe(0);
    expect(r.issues).toContain("repo not found");
  });

  it("returns clonable:false with issue when git dir is missing", async () => {
    _nextRow = { repoName: "ghost", ownerName: "nobody" };
    const { verifyMigration } = await import("../lib/import-verify");
    const r = await verifyMigration(42);
    expect(r.repoId).toBe(42);
    expect(r.clonable).toBe(false);
    // At least one of the sentinel-file issues should be present.
    const hasMissing = r.issues.some(
      (s) =>
        s.includes("missing HEAD") ||
        s.includes("missing config") ||
        s.includes("missing objects")
    );
    expect(hasMissing).toBe(true);
    // The git shell-outs against a non-existent path should also fail
    // and contribute to issues, but we don't assert the exact wording
    // (it varies across git versions).
    expect(r.hasDefaultBranch).toBe(false);
    expect(r.commitCount).toBe(0);
  });
});

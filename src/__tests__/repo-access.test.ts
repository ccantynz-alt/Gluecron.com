/**
 * Unit tests for src/middleware/repo-access.ts#resolveRepoAccess.
 *
 * We stub `../db` with `mock.module` (same pattern as import-verify.test.ts)
 * so we never touch Neon. The fake `db.select(...)` chain returns per-test
 * configurable rows — one for the `repositories` lookup (owner check) and
 * one for the `repo_collaborators` lookup. We inspect which table the query
 * is `.from()`-ing to decide which row to return.
 *
 * See import-verify.test.ts for the reasoning behind the defensive defaults
 * (`mock.module` registrations don't unwind across files in a single
 * `bun test` run, so we reset state in `afterAll`).
 */

import { describe, it, expect, mock, afterAll } from "bun:test";

type RepoRow = { id: string; ownerId: string } | undefined;
type CollabRow = { role: "read" | "write" | "admin" } | undefined;

let _nextRepoRow: RepoRow;
let _nextCollabRow: CollabRow;
// The last Drizzle table handle passed to `.from(...)` — we peek at it when
// `.limit(1)` resolves so we can return the correct shape for this query.
let _lastFrom: any = null;

const _chain: any = {
  from: (table: any) => {
    _lastFrom = table;
    return _chain;
  },
  leftJoin: () => _chain,
  innerJoin: () => _chain,
  rightJoin: () => _chain,
  where: () => _chain,
  orderBy: () => _chain,
  groupBy: () => _chain,
  limit: async () => {
    // Heuristic: the schema defines tables as plain objects whose keys
    // include the column definitions. We distinguish repositories from
    // repo_collaborators by the presence of `ownerId` vs `acceptedAt`.
    const t = _lastFrom;
    if (t && typeof t === "object") {
      if ("acceptedAt" in t || "invitedAt" in t) {
        return _nextCollabRow ? [_nextCollabRow] : [];
      }
      if ("ownerId" in t || "diskPath" in t) {
        return _nextRepoRow ? [_nextRepoRow] : [];
      }
    }
    return [];
  },
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
  _nextCollabRow = undefined;
  _lastFrom = null;
});

const REPO_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_USER_ID = "33333333-3333-3333-3333-333333333333";

describe("resolveRepoAccess", () => {
  it('owner returns "owner"', async () => {
    _nextRepoRow = { id: REPO_ID, ownerId: OWNER_ID };
    _nextCollabRow = undefined;
    const { resolveRepoAccess } = await import("../middleware/repo-access");
    const access = await resolveRepoAccess({
      repoId: REPO_ID,
      userId: OWNER_ID,
      isPublic: false,
    });
    expect(access).toBe("owner");
  });

  it("collaborator with accepted invite returns their role", async () => {
    // Viewer is NOT the owner (so the owner check falls through), but they
    // have an accepted "write" collaborator row.
    _nextRepoRow = { id: REPO_ID, ownerId: OWNER_ID };
    _nextCollabRow = { role: "write" };
    const { resolveRepoAccess } = await import("../middleware/repo-access");
    const access = await resolveRepoAccess({
      repoId: REPO_ID,
      userId: OTHER_USER_ID,
      isPublic: false,
    });
    expect(access).toBe("write");
  });

  it("pending invite (acceptedAt=null) does NOT grant access", async () => {
    // The middleware filters `acceptedAt IS NOT NULL` in the WHERE clause,
    // so a pending row would never be returned by the real DB — we simulate
    // that by returning no collaborator row. The user should fall through
    // to the public/private fallback; here the repo is private, so "none".
    _nextRepoRow = { id: REPO_ID, ownerId: OWNER_ID };
    _nextCollabRow = undefined;
    const { resolveRepoAccess } = await import("../middleware/repo-access");
    const access = await resolveRepoAccess({
      repoId: REPO_ID,
      userId: OTHER_USER_ID,
      isPublic: false,
    });
    expect(access).toBe("none");
  });

  it('public repo + no collaborator row returns "read"', async () => {
    _nextRepoRow = { id: REPO_ID, ownerId: OWNER_ID };
    _nextCollabRow = undefined;
    const { resolveRepoAccess } = await import("../middleware/repo-access");
    const access = await resolveRepoAccess({
      repoId: REPO_ID,
      userId: OTHER_USER_ID,
      isPublic: true,
    });
    expect(access).toBe("read");
  });

  it('private repo + no collaborator row returns "none"', async () => {
    _nextRepoRow = { id: REPO_ID, ownerId: OWNER_ID };
    _nextCollabRow = undefined;
    const { resolveRepoAccess } = await import("../middleware/repo-access");
    const access = await resolveRepoAccess({
      repoId: REPO_ID,
      userId: OTHER_USER_ID,
      isPublic: false,
    });
    expect(access).toBe("none");
  });
});

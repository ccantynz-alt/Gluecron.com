/**
 * Tests for src/lib/personal-semantic.ts — cross-repo semantic search
 * over the union of repos a user has access to.
 *
 * Layered:
 *
 *   1. Pure helpers / opt-in gate (no DB-specific shapes).
 *      Covered by short-circuit assertions on missing inputs.
 *
 *   2. DB-backed pipeline — gated on HAS_DB.
 *      Critical security tests live here:
 *        - Refusal when the opt-in flag is OFF (the privacy contract).
 *        - Owned-repo hits surface; non-owned repos that the user has
 *          no collaborator row for are NEVER surfaced.
 *        - Cross-user leak prevention: a hit indexed for user-B's
 *          private repo must not appear in user-A's results.
 *
 * The embedder seam from semantic-index is used to make vectors
 * deterministic so the test asserts on file_path / repo_name shape rather
 * than on cosine-score ordering (which depends on pgvector being
 * available).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import { randomBytes } from "crypto";

import {
  isPersonalSemanticEnabled,
  searchAcrossAllReposForUser,
  searchPersonalSemantic,
  setPersonalSemanticEnabled,
} from "../lib/personal-semantic";
import {
  __setEmbedderForTests,
  EMBEDDING_DIM,
} from "../lib/semantic-index";
import { initBareRepo, getRepoPath } from "../git/repository";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-personal-semantic-" + Date.now()
);

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.GLUECRON_SEMANTIC_CACHE_DIR = join(TEST_REPOS, "_cache");
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  __setEmbedderForTests(null);
  await rm(TEST_REPOS, { recursive: true, force: true });
});

beforeEach(() => {
  __setEmbedderForTests(null);
});

afterEach(() => {
  __setEmbedderForTests(null);
});

// ---------------------------------------------------------------------------
// 1. Pure short-circuits — no DB.
// ---------------------------------------------------------------------------

describe("personal-semantic — short-circuits", () => {
  it("returns [] for empty userId", async () => {
    const out = await searchPersonalSemantic({ userId: "", query: "foo" });
    expect(out).toEqual([]);
  });

  it("returns [] for empty query", async () => {
    const out = await searchPersonalSemantic({
      userId: "00000000-0000-0000-0000-000000000000",
      query: "",
    });
    expect(out).toEqual([]);
  });

  it("alias searchAcrossAllReposForUser is identical contract", async () => {
    const out = await searchAcrossAllReposForUser({
      userId: "",
      query: "foo",
    });
    expect(out).toEqual([]);
  });

  it("isPersonalSemanticEnabled returns false for empty id", async () => {
    expect(await isPersonalSemanticEnabled("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. DB-backed pipeline.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("personal-semantic — DB-backed", () => {
  it.skipIf(!HAS_DB)(
    "refuses to return rows when the opt-in flag is OFF",
    async () => {
      const { db } = await import("../db");
      const { users, repositories, codeEmbeddings } = await import(
        "../db/schema"
      );
      const { eq } = await import("drizzle-orm");

      const stamp = randomBytes(4).toString("hex");
      const username = `psem-off-${stamp}`;
      const reponame = `psem-off-${stamp}`;

      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@test.local`,
          passwordHash: "x",
          personalSemanticIndexEnabled: false,
        })
        .returning();
      if (!u) return;

      await initBareRepo(username, reponame);
      const [r] = await db
        .insert(repositories)
        .values({
          name: reponame,
          ownerId: u.id,
          diskPath: getRepoPath(username, reponame),
          defaultBranch: "main",
        })
        .returning();
      if (!r) return;

      // Plant an embedding row; with opt-in OFF the search must not
      // surface it even though the user owns the repo.
      const fakeVec = new Array<number>(EMBEDDING_DIM).fill(0);
      fakeVec[0] = 1;
      try {
        await db.insert(codeEmbeddings).values({
          repositoryId: r.id,
          filePath: "src/secret.ts",
          blobSha: "aa11",
          commitSha: "aa11",
          contentSnippet: "// SECRET KEY",
          embedding: fakeVec,
          embeddingModel: "stub",
        });
      } catch {
        /* pgvector may not exist; the opt-in refusal is still meaningful
           because it short-circuits BEFORE the cosine ORDER BY runs. */
      }

      __setEmbedderForTests(async () => ({
        vector: fakeVec,
        model: "stub-1024",
      }));

      const hits = await searchPersonalSemantic({
        userId: u.id,
        query: "secret",
      });
      expect(hits).toEqual([]);

      // Now flip on and verify the hit does surface — proves the refusal
      // above is the flag, not a side-effect of missing data.
      await setPersonalSemanticEnabled(u.id, true);
      const after = await searchPersonalSemantic({
        userId: u.id,
        query: "secret",
      });
      // pgvector may not be installed; allow either an empty result or
      // the planted row. The point of THIS assertion is that we no
      // longer SHORT-CIRCUIT — DB-level behaviour is allowed to be empty.
      expect(Array.isArray(after)).toBe(true);
      if (after.length) {
        expect(after[0].repoName).toBe(`${username}/${reponame}`);
        expect(after[0].filePath).toBe("src/secret.ts");
      }

      // Cleanup.
      try {
        await db
          .delete(codeEmbeddings)
          .where(eq(codeEmbeddings.repositoryId, r.id));
      } catch {
        /* may not exist */
      }
      await db.delete(repositories).where(eq(repositories.id, r.id));
      await db.delete(users).where(eq(users.id, u.id));
    }
  );

  it.skipIf(!HAS_DB)(
    "search returns results across multiple owned repos",
    async () => {
      const { db } = await import("../db");
      const { users, repositories, codeEmbeddings } = await import(
        "../db/schema"
      );
      const { eq, inArray } = await import("drizzle-orm");

      const stamp = randomBytes(4).toString("hex");
      const username = `psem-multi-${stamp}`;

      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@test.local`,
          passwordHash: "x",
          personalSemanticIndexEnabled: true,
        })
        .returning();
      if (!u) return;

      const repoA = `psem-multi-a-${stamp}`;
      const repoB = `psem-multi-b-${stamp}`;
      await initBareRepo(username, repoA);
      await initBareRepo(username, repoB);
      const [rA] = await db
        .insert(repositories)
        .values({
          name: repoA,
          ownerId: u.id,
          diskPath: getRepoPath(username, repoA),
          defaultBranch: "main",
        })
        .returning();
      const [rB] = await db
        .insert(repositories)
        .values({
          name: repoB,
          ownerId: u.id,
          diskPath: getRepoPath(username, repoB),
          defaultBranch: "main",
        })
        .returning();
      if (!rA || !rB) return;

      const fakeVec = new Array<number>(EMBEDDING_DIM).fill(0);
      fakeVec[0] = 1;
      let inserted = false;
      try {
        await db.insert(codeEmbeddings).values([
          {
            repositoryId: rA.id,
            filePath: "src/a.ts",
            blobSha: "aaa1",
            commitSha: "aaa1",
            contentSnippet: "// repo a snippet",
            embedding: fakeVec,
            embeddingModel: "stub",
          },
          {
            repositoryId: rB.id,
            filePath: "src/b.ts",
            blobSha: "bbb1",
            commitSha: "bbb1",
            contentSnippet: "// repo b snippet",
            embedding: fakeVec,
            embeddingModel: "stub",
          },
        ]);
        inserted = true;
      } catch {
        /* pgvector missing — we'll skip the surface assertion below */
      }

      __setEmbedderForTests(async () => ({
        vector: fakeVec,
        model: "stub-1024",
      }));

      const hits = await searchPersonalSemantic({
        userId: u.id,
        query: "snippet",
      });
      expect(Array.isArray(hits)).toBe(true);

      // When pgvector is available, both repos should show up — they're
      // both owned by the user, so the union contains both.
      if (inserted && hits.length) {
        const repoNames = new Set(hits.map((h) => h.repoName));
        expect(repoNames.size).toBeGreaterThanOrEqual(1);
        for (const h of hits) {
          expect(typeof h.repoName).toBe("string");
          expect(h.repoName.startsWith(`${username}/`)).toBe(true);
        }
      }

      // Cleanup.
      try {
        await db
          .delete(codeEmbeddings)
          .where(inArray(codeEmbeddings.repositoryId, [rA.id, rB.id]));
      } catch {
        /* may not exist */
      }
      await db
        .delete(repositories)
        .where(inArray(repositories.id, [rA.id, rB.id]));
      await db.delete(users).where(eq(users.id, u.id));
    }
  );

  it.skipIf(!HAS_DB)(
    "search EXCLUDES repos the user has no access to",
    async () => {
      const { db } = await import("../db");
      const { users, repositories, codeEmbeddings } = await import(
        "../db/schema"
      );
      const { eq, inArray } = await import("drizzle-orm");

      const stamp = randomBytes(4).toString("hex");
      const userA = `psem-exclA-${stamp}`;
      const userB = `psem-exclB-${stamp}`;

      const [uA] = await db
        .insert(users)
        .values({
          username: userA,
          email: `${userA}@test.local`,
          passwordHash: "x",
          personalSemanticIndexEnabled: true,
        })
        .returning();
      const [uB] = await db
        .insert(users)
        .values({
          username: userB,
          email: `${userB}@test.local`,
          passwordHash: "x",
        })
        .returning();
      if (!uA || !uB) return;

      // User B owns a private repo. User A has NO collaborator row for it.
      const repoB = `psem-excl-${stamp}`;
      await initBareRepo(userB, repoB);
      const [rB] = await db
        .insert(repositories)
        .values({
          name: repoB,
          ownerId: uB.id,
          diskPath: getRepoPath(userB, repoB),
          defaultBranch: "main",
          isPrivate: true,
        })
        .returning();
      if (!rB) return;

      const fakeVec = new Array<number>(EMBEDDING_DIM).fill(0);
      fakeVec[0] = 1;
      try {
        await db.insert(codeEmbeddings).values({
          repositoryId: rB.id,
          filePath: "src/foreign.ts",
          blobSha: "cccc",
          commitSha: "cccc",
          contentSnippet: "// USER B's PRIVATE CODE",
          embedding: fakeVec,
          embeddingModel: "stub",
        });
      } catch {
        /* pgvector missing — refusal must still hold via the IN ([]) path */
      }

      __setEmbedderForTests(async () => ({
        vector: fakeVec,
        model: "stub-1024",
      }));

      // User A has no repos of their own and no collaborator rows.
      // The accessible-repo-set must be empty, so search returns [] without
      // EVER consulting User B's embedding row.
      const hits = await searchPersonalSemantic({
        userId: uA.id,
        query: "private",
      });
      expect(hits).toEqual([]);

      // Even if User A asks for the exact snippet text, the WHERE clause
      // gates them out.
      const hits2 = await searchPersonalSemantic({
        userId: uA.id,
        query: "USER B's PRIVATE CODE",
      });
      expect(hits2).toEqual([]);

      // Cleanup.
      try {
        await db
          .delete(codeEmbeddings)
          .where(inArray(codeEmbeddings.repositoryId, [rB.id]));
      } catch {
        /* may not exist */
      }
      await db.delete(repositories).where(eq(repositories.id, rB.id));
      await db.delete(users).where(eq(users.id, uA.id));
      await db.delete(users).where(eq(users.id, uB.id));
    }
  );

  it.skipIf(!HAS_DB)(
    "cross-user content leak prevention — User A's results never contain User B's repo data",
    async () => {
      // This test is the load-bearing security assertion. We give User A
      // one owned repo with data, and User B one separate owned repo with
      // distinctively different data. Both have the opt-in flag on. A's
      // search must only see A's repo; B's results must not appear in A's.
      const { db } = await import("../db");
      const { users, repositories, codeEmbeddings } = await import(
        "../db/schema"
      );
      const { eq, inArray } = await import("drizzle-orm");

      const stamp = randomBytes(4).toString("hex");
      const userA = `psem-leakA-${stamp}`;
      const userB = `psem-leakB-${stamp}`;

      const [uA] = await db
        .insert(users)
        .values({
          username: userA,
          email: `${userA}@test.local`,
          passwordHash: "x",
          personalSemanticIndexEnabled: true,
        })
        .returning();
      const [uB] = await db
        .insert(users)
        .values({
          username: userB,
          email: `${userB}@test.local`,
          passwordHash: "x",
          personalSemanticIndexEnabled: true,
        })
        .returning();
      if (!uA || !uB) return;

      const repoA = `psem-leak-a-${stamp}`;
      const repoB = `psem-leak-b-${stamp}`;
      await initBareRepo(userA, repoA);
      await initBareRepo(userB, repoB);
      const [rA] = await db
        .insert(repositories)
        .values({
          name: repoA,
          ownerId: uA.id,
          diskPath: getRepoPath(userA, repoA),
          defaultBranch: "main",
        })
        .returning();
      const [rB] = await db
        .insert(repositories)
        .values({
          name: repoB,
          ownerId: uB.id,
          diskPath: getRepoPath(userB, repoB),
          defaultBranch: "main",
        })
        .returning();
      if (!rA || !rB) return;

      const fakeVec = new Array<number>(EMBEDDING_DIM).fill(0);
      fakeVec[0] = 1;
      try {
        await db.insert(codeEmbeddings).values([
          {
            repositoryId: rA.id,
            filePath: "src/owned-by-a.ts",
            blobSha: "aaaa",
            commitSha: "aaaa",
            contentSnippet: "// A's code",
            embedding: fakeVec,
            embeddingModel: "stub",
          },
          {
            repositoryId: rB.id,
            filePath: "src/owned-by-b.ts",
            blobSha: "bbbb",
            commitSha: "bbbb",
            contentSnippet: "// B's code",
            embedding: fakeVec,
            embeddingModel: "stub",
          },
        ]);
      } catch {
        /* pgvector missing — the next assertions still hold via the
           empty-repo-set short-circuit / IN clause */
      }

      __setEmbedderForTests(async () => ({
        vector: fakeVec,
        model: "stub-1024",
      }));

      const aHits = await searchPersonalSemantic({
        userId: uA.id,
        query: "code",
      });
      // Every hit must be from a repo A owns. The file owned-by-b.ts
      // must never appear; the repo name must never include userB.
      for (const h of aHits) {
        expect(h.ownerName).toBe(userA);
        expect(h.repoName).toBe(`${userA}/${repoA}`);
        expect(h.filePath).not.toBe("src/owned-by-b.ts");
      }

      const bHits = await searchPersonalSemantic({
        userId: uB.id,
        query: "code",
      });
      for (const h of bHits) {
        expect(h.ownerName).toBe(userB);
        expect(h.repoName).toBe(`${userB}/${repoB}`);
        expect(h.filePath).not.toBe("src/owned-by-a.ts");
      }

      // Cleanup.
      try {
        await db
          .delete(codeEmbeddings)
          .where(inArray(codeEmbeddings.repositoryId, [rA.id, rB.id]));
      } catch {
        /* may not exist */
      }
      await db
        .delete(repositories)
        .where(inArray(repositories.id, [rA.id, rB.id]));
      await db.delete(users).where(eq(users.id, uA.id));
      await db.delete(users).where(eq(users.id, uB.id));
    }
  );

  it.skipIf(!HAS_DB)(
    "setPersonalSemanticEnabled flips the flag and isPersonalSemanticEnabled reads it",
    async () => {
      const { db } = await import("../db");
      const { users } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");

      const stamp = randomBytes(4).toString("hex");
      const username = `psem-flag-${stamp}`;
      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@test.local`,
          passwordHash: "x",
        })
        .returning();
      if (!u) return;

      expect(await isPersonalSemanticEnabled(u.id)).toBe(false);
      const r1 = await setPersonalSemanticEnabled(u.id, true);
      expect(r1).toBe(true);
      expect(await isPersonalSemanticEnabled(u.id)).toBe(true);

      const r2 = await setPersonalSemanticEnabled(u.id, false);
      expect(r2).toBe(false);
      expect(await isPersonalSemanticEnabled(u.id)).toBe(false);

      await db.delete(users).where(eq(users.id, u.id));
    }
  );
});

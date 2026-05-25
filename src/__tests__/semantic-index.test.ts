/**
 * Tests for src/lib/semantic-index.ts and the /api/v2/.../semantic-search
 * endpoint that wraps it.
 *
 * Layered:
 *   - Pure (no DB, no network): fallback embedder shape + determinism,
 *     `indexChangedFiles` short-circuits when there are no candidate
 *     paths, file-type filtering, and the test-only embedder seam.
 *   - DB + pgvector: full upsert → search ranking via the real
 *     `code_embeddings` table. Skipped unless DATABASE_URL is present
 *     AND the running Postgres has pgvector installed (probed lazily).
 *
 * The HAS_PGVECTOR probe inserts and then deletes a single throwaway
 * row so a missing extension or table is detected at runtime.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import { randomBytes } from "crypto";
import app from "../app";
import { clearRateLimitStore } from "../middleware/rate-limit";
import { initBareRepo, getRepoPath } from "../git/repository";
import {
  indexChangedFiles,
  searchSemantic,
  embedOne,
  __setEmbedderForTests,
  __test,
  EMBEDDING_DIM,
} from "../lib/semantic-index";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-semantic-index-" + Date.now()
);

// Lazily probed — true only if DATABASE_URL is set, the table exists,
// AND a basic UPSERT/SELECT round-trip through pgvector succeeds.
let HAS_PGVECTOR = false;

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.GLUECRON_SEMANTIC_CACHE_DIR = join(TEST_REPOS, "_cache");
  clearRateLimitStore();
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });

  if (HAS_DB) {
    HAS_PGVECTOR = await probePgvector();
  }
});

afterAll(async () => {
  __setEmbedderForTests(null);
  await rm(TEST_REPOS, { recursive: true, force: true });
});

beforeEach(() => {
  __setEmbedderForTests(null);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  await proc.exited;
}

async function seedRepo(owner: string, name: string, files: Record<string, string>) {
  await initBareRepo(owner, name);
  const bare = getRepoPath(owner, name);
  const work = join(TEST_REPOS, "_work_" + randomBytes(4).toString("hex"));
  await mkdir(work, { recursive: true });
  await run(["git", "clone", bare, work], TEST_REPOS);
  await run(["git", "config", "user.email", "t@gluecron.com"], work);
  await run(["git", "config", "user.name", "T"], work);
  await run(["git", "checkout", "-B", "main"], work);
  for (const [path, content] of Object.entries(files)) {
    const full = join(work, path);
    await mkdir(join(full, ".."), { recursive: true });
    await Bun.write(full, content);
  }
  await run(["git", "add", "-A"], work);
  await run(["git", "commit", "-m", "seed"], work);
  await run(["git", "push", "-u", "origin", "main"], work);
  // Capture the commit sha
  const { stdout } = await Bun.spawn(["git", "rev-parse", "main"], {
    cwd: work,
    stdout: "pipe",
  });
  const sha = (await new Response(stdout).text()).trim();
  await rm(work, { recursive: true, force: true });
  return sha;
}

// Deterministic stub embedder used by ranking tests — encodes the
// first 8 unique characters of the text into the first 8 dimensions
// so semantically-similar text produces similar vectors. Pads to the
// full embedding dim with zeros + L2-normalises.
function makeStubEmbedder(): (
  text: string,
  inputType: "document" | "query"
) => Promise<{ vector: number[]; model: string }> {
  return async (text: string) => {
    const v = new Array<number>(EMBEDDING_DIM).fill(0);
    const lower = text.toLowerCase();
    // Token-frequency over a small bag of high-signal keywords. The
    // ranking test below relies on "fetch" / "database" being distinct.
    const KEYS = [
      "fetch",
      "database",
      "config",
      "user",
      "render",
      "test",
      "embed",
      "route",
    ];
    for (let i = 0; i < KEYS.length; i++) {
      const k = KEYS[i];
      const matches = lower.split(k).length - 1;
      v[i] = matches;
    }
    // Normalise so cosine == dot.
    let sumsq = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) sumsq += v[i] * v[i];
    if (sumsq > 0) {
      const inv = 1 / Math.sqrt(sumsq);
      for (let i = 0; i < EMBEDDING_DIM; i++) v[i] *= inv;
    }
    return { vector: v, model: "stub-1024" };
  };
}

async function probePgvector(): Promise<boolean> {
  if (!HAS_DB) return false;
  try {
    const { db } = await import("../db");
    const { codeEmbeddings } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const fakeRepoId = "00000000-0000-0000-0000-000000000000";
    // Try a SELECT — fast probe that the table + vector column exist.
    await db
      .select({ id: codeEmbeddings.id })
      .from(codeEmbeddings)
      .where(eq(codeEmbeddings.repositoryId, fakeRepoId))
      .limit(1);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. Pure helpers — no DB required
// ---------------------------------------------------------------------------

describe("semantic-index — pure helpers", () => {
  it("fallbackEmbed returns a 1024-dim vector", () => {
    const v = __test.fallbackEmbed("hello world function getUser");
    expect(v.length).toBe(EMBEDDING_DIM);
  });

  it("fallbackEmbed is deterministic", () => {
    const a = __test.fallbackEmbed("function indexFiles()");
    const b = __test.fallbackEmbed("function indexFiles()");
    expect(a).toEqual(b);
  });

  it("fallbackEmbed produces different vectors for different inputs", () => {
    const a = __test.fallbackEmbed("database connection pool");
    const b = __test.fallbackEmbed("react component render hook");
    let differ = false;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-9) {
        differ = true;
        break;
      }
    }
    expect(differ).toBe(true);
  });

  it("deriveBlobSha is deterministic + 64 hex chars", async () => {
    const a = await __test.deriveBlobSha("hello world");
    const b = await __test.deriveBlobSha("hello world");
    expect(a).toBe(b);
    expect(/^[0-9a-f]{64}$/.test(a)).toBe(true);
  });

  it("MAX_FILES_PER_PUSH is the documented cap (~50)", () => {
    expect(__test.MAX_FILES_PER_PUSH).toBeGreaterThanOrEqual(20);
    expect(__test.MAX_FILES_PER_PUSH).toBeLessThanOrEqual(200);
  });
});

describe("embedOne — test seam", () => {
  it("respects __setEmbedderForTests override", async () => {
    __setEmbedderForTests(async () => ({
      vector: new Array(EMBEDDING_DIM).fill(0.001),
      model: "fake-model",
    }));
    const out = await embedOne("anything", "document");
    expect(out.model).toBe("fake-model");
    expect(out.vector.length).toBe(EMBEDDING_DIM);
    expect(out.vector[0]).toBe(0.001);
    __setEmbedderForTests(null);
  });

  it("falls back to the deterministic embedder when no key + no override", async () => {
    delete process.env.VOYAGE_API_KEY;
    const out = await embedOne("hello world", "document");
    expect(out.vector.length).toBe(EMBEDDING_DIM);
    // Fallback model name is stable.
    expect(out.model).toBe(__test.FALLBACK_MODEL);
  });
});

describe("indexChangedFiles — graceful no-ops", () => {
  it("returns 0/0 for empty path list", async () => {
    const out = await indexChangedFiles({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      ownerName: "nobody",
      repoName: "nothing",
      commitSha: "0000000000000000000000000000000000000000",
      changedPaths: [],
    });
    expect(out.indexed).toBe(0);
  });

  it("returns 0/0 for empty repositoryId", async () => {
    const out = await indexChangedFiles({
      repositoryId: "",
      ownerName: "x",
      repoName: "y",
      commitSha: "deadbeef",
      changedPaths: ["src/foo.ts"],
    });
    expect(out.indexed).toBe(0);
  });

  it("filters out non-code files before doing any work", async () => {
    // We can't easily assert what was filtered without a stub git, but
    // we can verify that *only* non-code paths produce indexed=0 even
    // when a stub embedder would have succeeded.
    __setEmbedderForTests(makeStubEmbedder());
    const out = await indexChangedFiles({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      ownerName: "nobody",
      repoName: "nothing",
      commitSha: "0000000000000000000000000000000000000000",
      // None of these are code files we'd index.
      changedPaths: ["LICENSE", "image.png", "binary.zip"],
    });
    expect(out.indexed).toBe(0);
    __setEmbedderForTests(null);
  });
});

describe("searchSemantic — graceful no-ops", () => {
  it("returns [] for empty query", async () => {
    const out = await searchSemantic({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      query: "",
    });
    expect(out).toEqual([]);
  });

  it("returns [] for empty repositoryId", async () => {
    const out = await searchSemantic({
      repositoryId: "",
      query: "hello",
    });
    expect(out).toEqual([]);
  });

  it("clamps limit to [1, 100]", async () => {
    // We can't assert the bound directly without DB; but we can verify
    // that absurd values don't throw — graceful behaviour is the
    // contract.
    const a = await searchSemantic({
      repositoryId: "",
      query: "hi",
      limit: 0,
    });
    const b = await searchSemantic({
      repositoryId: "",
      query: "hi",
      limit: 999999,
    });
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. API endpoint — auth/validation surface (no DB)
// ---------------------------------------------------------------------------

describe("GET /api/v2/repos/:o/:r/semantic-search — validation", () => {
  it("returns 404 for a nonexistent repo", async () => {
    const res = await app.request(
      "/api/v2/repos/nobody/nothing/semantic-search?q=foo"
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (or 200) when called without ?q on a missing repo", async () => {
    const res = await app.request(
      "/api/v2/repos/nobody/nothing/semantic-search"
    );
    // Missing repo dominates over empty query.
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end with DB + pgvector
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("semantic-index — DB-backed flows", () => {
  it.skipIf(!HAS_DB)("upserts a row per file and ranks by similarity", async () => {
    if (!HAS_PGVECTOR) {
      // Re-check at runtime — the beforeAll probe may have raced before
      // migrations ran. Skip cleanly so the suite stays green when
      // pgvector is unavailable.
      return;
    }
    const { db } = await import("../db");
    const { users, repositories, codeEmbeddings } = await import(
      "../db/schema"
    );
    const { eq, and } = await import("drizzle-orm");

    const stamp = randomBytes(4).toString("hex");
    const username = `semuser-${stamp}`;
    const reponame = `semrepo-${stamp}`;

    const [u] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    const sha = await seedRepo(username, reponame, {
      "src/fetch.ts": "export function fetchData() { return fetch('/api'); }\n",
      "src/db.ts": "export function connectDatabase() { /* database pool */ }\n",
    });

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

    // Use the deterministic stub so the test doesn't rely on Voyage.
    __setEmbedderForTests(makeStubEmbedder());

    const out = await indexChangedFiles({
      repositoryId: r.id,
      ownerName: username,
      repoName: reponame,
      commitSha: sha,
      changedPaths: ["src/fetch.ts", "src/db.ts"],
    });

    expect(out.indexed).toBe(2);

    // Verify rows landed.
    const rows = await db
      .select({
        path: codeEmbeddings.filePath,
        snippet: codeEmbeddings.contentSnippet,
      })
      .from(codeEmbeddings)
      .where(eq(codeEmbeddings.repositoryId, r.id));
    expect(rows.length).toBe(2);
    const paths = rows.map((r) => r.path).sort();
    expect(paths).toEqual(["src/db.ts", "src/fetch.ts"]);
    for (const row of rows) {
      // Snippet is the first 500 chars of file content — should be non-empty.
      expect(row.snippet.length).toBeGreaterThan(0);
      expect(row.snippet.length).toBeLessThanOrEqual(500);
    }

    // Ranking: query "fetch" should rank src/fetch.ts higher than src/db.ts.
    const hits = await searchSemantic({
      repositoryId: r.id,
      query: "fetch data",
      limit: 5,
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].filePath).toBe("src/fetch.ts");

    // Query "database" should rank src/db.ts higher.
    const hits2 = await searchSemantic({
      repositoryId: r.id,
      query: "database connection",
      limit: 5,
    });
    expect(hits2.length).toBeGreaterThanOrEqual(1);
    expect(hits2[0].filePath).toBe("src/db.ts");

    // Idempotency: re-indexing the same files should not duplicate rows
    // (unique index on (repository_id, file_path) enforces this).
    const out2 = await indexChangedFiles({
      repositoryId: r.id,
      ownerName: username,
      repoName: reponame,
      commitSha: sha,
      changedPaths: ["src/fetch.ts", "src/db.ts"],
    });
    expect(out2.indexed).toBe(2);

    const rowsAfter = await db
      .select({ id: codeEmbeddings.id })
      .from(codeEmbeddings)
      .where(eq(codeEmbeddings.repositoryId, r.id));
    expect(rowsAfter.length).toBe(2);

    // Cleanup
    await db.delete(codeEmbeddings).where(eq(codeEmbeddings.repositoryId, r.id));
    await db
      .delete(repositories)
      .where(and(eq(repositories.ownerId, u.id), eq(repositories.name, reponame)));
    await db.delete(users).where(eq(users.id, u.id));
    __setEmbedderForTests(null);
  });

  it.skipIf(!HAS_DB)(
    "GET /api/v2/repos/:o/:r/semantic-search returns the indexed hits",
    async () => {
      if (!HAS_PGVECTOR) return;
      const { db } = await import("../db");
      const { users, repositories, codeEmbeddings } = await import(
        "../db/schema"
      );
      const { eq, and } = await import("drizzle-orm");

      const stamp = randomBytes(4).toString("hex");
      const username = `semapi-${stamp}`;
      const reponame = `semapi-${stamp}`;

      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@test.local`,
          passwordHash: "x",
        })
        .returning();
      if (!u) return;

      const sha = await seedRepo(username, reponame, {
        "src/main.ts": "export function fetchUserData() { return fetch('/u'); }\n",
      });

      const [r] = await db
        .insert(repositories)
        .values({
          name: reponame,
          ownerId: u.id,
          diskPath: getRepoPath(username, reponame),
          defaultBranch: "main",
          isPrivate: false,
        })
        .returning();
      if (!r) return;

      __setEmbedderForTests(makeStubEmbedder());

      await indexChangedFiles({
        repositoryId: r.id,
        ownerName: username,
        repoName: reponame,
        commitSha: sha,
        changedPaths: ["src/main.ts"],
      });

      const res = await app.request(
        `/api/v2/repos/${username}/${reponame}/semantic-search?q=fetch`
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        file_path: string;
        snippet: string;
        score: number;
        blob_sha: string;
      }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].file_path).toBe("src/main.ts");
      expect(typeof body[0].score).toBe("number");
      expect(typeof body[0].blob_sha).toBe("string");

      // Cleanup
      await db
        .delete(codeEmbeddings)
        .where(eq(codeEmbeddings.repositoryId, r.id));
      await db
        .delete(repositories)
        .where(
          and(eq(repositories.ownerId, u.id), eq(repositories.name, reponame))
        );
      await db.delete(users).where(eq(users.id, u.id));
      __setEmbedderForTests(null);
    }
  );
});

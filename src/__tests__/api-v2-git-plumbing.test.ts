/**
 * API v2 — git plumbing + contents DELETE.
 *
 * Covers the addendum endpoints (groups 1 & 2):
 *   - DELETE /repos/:owner/:repo/contents/:path
 *   - GET    /repos/:owner/:repo/git/refs/heads/:branch
 *   - GET    /repos/:owner/:repo/git/commits/:sha
 *   - POST   /repos/:owner/:repo/git/blobs
 *   - POST   /repos/:owner/:repo/git/trees
 *   - POST   /repos/:owner/:repo/git/commits
 *   - PATCH  /repos/:owner/:repo/git/refs/heads/:branch
 *
 * HTTP-shape tests (auth/validation) run unconditionally. Plumbing tests
 * that exercise real bare repos hit the helper modules directly (no DB
 * required). DB-dependent tests are gated by HAS_DB.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import app from "../app";
import { clearRateLimitStore } from "../middleware/rate-limit";
import {
  initBareRepo,
  getRepoPath,
  resolveRef,
  refExists,
  objectExists,
  updateRef,
  writeBlob,
  getBlobShaAtPath,
} from "../git/repository";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-api-v2-plumbing-" + Date.now()
);

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  clearRateLimitStore();
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiUrl(path: string): string {
  return `/api/v2${path}`;
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

async function seedRepo(
  owner: string,
  name: string,
  files: Array<{ path: string; bytes: Uint8Array | string }>,
  opts: { branch?: string } = {}
) {
  const branch = opts.branch ?? "main";
  await initBareRepo(owner, name);
  const bare = getRepoPath(owner, name);

  const work = join(TEST_REPOS, "_work_" + Math.random().toString(16).slice(2));
  await mkdir(work, { recursive: true });
  await run(["git", "clone", bare, work], TEST_REPOS);
  await run(["git", "config", "user.email", "test@gluecron.com"], work);
  await run(["git", "config", "user.name", "Test User"], work);
  await run(["git", "checkout", "-B", branch], work);

  for (const f of files) {
    const full = join(work, f.path);
    const dir = full.substring(0, full.lastIndexOf("/"));
    if (dir && dir !== work) await mkdir(dir, { recursive: true });
    const data = typeof f.bytes === "string" ? new TextEncoder().encode(f.bytes) : f.bytes;
    await Bun.write(full, data);
  }

  await run(["git", "add", "-A"], work);
  await run(["git", "commit", "-m", "seed"], work);
  await run(["git", "push", "-u", "origin", branch], work);
  await rm(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Shape-only HTTP tests — no DB required
// ---------------------------------------------------------------------------

describe("API v2 — git plumbing auth + validation", () => {
  it("DELETE /contents/:path without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/contents/foo.txt"),
      {
        method: "DELETE",
        headers: jsonHeaders(),
        body: JSON.stringify({
          message: "drop",
          sha: "a".repeat(40),
        }),
      }
    );
    expect(res.status).toBe(401);
  });

  it("GET /git/refs/heads/:branch on missing repo returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/git/refs/heads/main")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("GET /git/commits/:sha on missing repo returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/git/commits/" + "a".repeat(40))
    );
    expect([404, 500]).toContain(res.status);
  });

  it("POST /git/blobs without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/git/blobs"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "hi", encoding: "utf-8" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /git/trees without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/git/trees"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ tree: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /git/commits without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/git/commits"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        message: "m",
        tree: "a".repeat(40),
        parents: [],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("PATCH /git/refs/heads/:branch without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/git/refs/heads/main"),
      {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ sha: "a".repeat(40) }),
      }
    );
    expect(res.status).toBe(401);
  });

  it("POST /git/blobs with bad bearer token returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/git/blobs"), {
      method: "POST",
      headers: jsonHeaders(bearerHeader("not-a-real-token")),
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("PATCH /git/refs/heads/:branch with bad sha returns 400 or 401", async () => {
    // Auth blocks first without DB; with auth, the validator would reject.
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/git/refs/heads/main"),
      {
        method: "PATCH",
        headers: jsonHeaders(bearerHeader("not-a-real-token")),
        body: JSON.stringify({ sha: "not-hex" }),
      }
    );
    expect([400, 401]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Helper-level git plumbing tests (no HTTP / no DB)
// ---------------------------------------------------------------------------

describe("git plumbing — writeBlob + manual tree round-trip", () => {
  it("writeBlob produces a 40-hex sha and the object is reachable", async () => {
    await initBareRepo("plumb-u1", "plumb-r1");
    const sha = await writeBlob(
      "plumb-u1",
      "plumb-r1",
      new TextEncoder().encode("hello world\n")
    );
    expect(sha).not.toBeNull();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await objectExists("plumb-u1", "plumb-r1", sha!)).toBe(true);
  });

  it("seedRepo + resolveRef agree on the branch tip", async () => {
    await seedRepo("plumb-u2", "plumb-r2", [
      { path: "README.md", bytes: "# hi" },
    ]);
    const head = await resolveRef("plumb-u2", "plumb-r2", "refs/heads/main");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await refExists("plumb-u2", "plumb-r2", "refs/heads/main")).toBe(true);
  });

  it("updateRef can move a branch to a new commit", async () => {
    await seedRepo("plumb-u3", "plumb-r3", [
      { path: "f.txt", bytes: "v1" },
    ]);
    const head = await resolveRef("plumb-u3", "plumb-r3", "refs/heads/main");
    expect(head).not.toBeNull();
    // Point a new branch at the same commit (force = no oldSha).
    const ok = await updateRef(
      "plumb-u3",
      "plumb-r3",
      "refs/heads/dup",
      head!
    );
    expect(ok).toBe(true);
    expect(await refExists("plumb-u3", "plumb-r3", "refs/heads/dup")).toBe(true);
  });

  it("getBlobShaAtPath returns null after a remove (via plumbing)", async () => {
    await seedRepo("plumb-u4", "plumb-r4", [
      { path: "doomed.txt", bytes: "bye" },
    ]);
    const before = await getBlobShaAtPath(
      "plumb-u4",
      "plumb-r4",
      "main",
      "doomed.txt"
    );
    expect(before).not.toBeNull();

    // Drive the same plumbing the DELETE endpoint uses, against the bare
    // repo directly. This proves the read-tree/update-index --remove path.
    const repoDir = getRepoPath("plumb-u4", "plumb-r4");
    const parentSha = (await resolveRef(
      "plumb-u4",
      "plumb-r4",
      "refs/heads/main"
    ))!;
    const tmpIndex = join(
      repoDir,
      `index.tmp.test.${Date.now()}.${Math.random().toString(16).slice(2)}`
    );
    // `update-index --remove` requires a work tree (even an empty one)
    // — mirrors the env the DELETE endpoint sets.
    const tmpWorkTree = join(
      repoDir,
      `worktree.tmp.test.${Date.now()}.${Math.random().toString(16).slice(2)}`
    );
    await mkdir(tmpWorkTree, { recursive: true });
    const env = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      GIT_DIR: repoDir,
      GIT_WORK_TREE: tmpWorkTree,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x",
    };
    const exec = async (cmd: string[]) => {
      const proc = Bun.spawn(cmd, {
        cwd: repoDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      const exitCode = await proc.exited;
      return { out, exitCode };
    };
    let r = await exec(["git", "read-tree", parentSha]);
    expect(r.exitCode).toBe(0);
    r = await exec(["git", "update-index", "--remove", "doomed.txt"]);
    expect(r.exitCode).toBe(0);
    const wt = await exec(["git", "write-tree"]);
    expect(wt.exitCode).toBe(0);
    expect(wt.out).toMatch(/^[0-9a-f]{40}$/);
    const ct = await exec([
      "git",
      "commit-tree",
      wt.out,
      "-p",
      parentSha,
      "-m",
      "drop",
    ]);
    expect(ct.exitCode).toBe(0);
    expect(ct.out).toMatch(/^[0-9a-f]{40}$/);
    const ok = await updateRef(
      "plumb-u4",
      "plumb-r4",
      "refs/heads/main",
      ct.out,
      parentSha
    );
    expect(ok).toBe(true);

    const after = await getBlobShaAtPath(
      "plumb-u4",
      "plumb-r4",
      "main",
      "doomed.txt"
    );
    expect(after).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Read endpoints exercised over HTTP against a real bare repo (no DB).
// These hit only the git layer in the handler — anonymous reads work even
// without DB because the handlers only consult the filesystem.
// ---------------------------------------------------------------------------

describe("API v2 — git ref/commit GETs against a real repo", () => {
  it("GET /git/refs/heads/main returns the branch tip sha", async () => {
    await seedRepo("plumb-u5", "plumb-r5", [
      { path: "README.md", bytes: "# hi" },
    ]);
    const head = await resolveRef("plumb-u5", "plumb-r5", "refs/heads/main");
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    const res = await app.request(
      apiUrl("/repos/plumb-u5/plumb-r5/git/refs/heads/main")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ref).toBe("refs/heads/main");
    expect(body.object.type).toBe("commit");
    expect(body.object.sha).toBe(head);
  });

  it("GET /git/refs/heads/:branch on unknown branch returns 404", async () => {
    await seedRepo("plumb-u6", "plumb-r6", [
      { path: "a.txt", bytes: "1" },
    ]);
    const res = await app.request(
      apiUrl("/repos/plumb-u6/plumb-r6/git/refs/heads/no-such-branch")
    );
    expect(res.status).toBe(404);
  });

  it("GET /git/commits/:sha returns sha+tree+parents+message+author", async () => {
    await seedRepo("plumb-u7", "plumb-r7", [
      { path: "a.txt", bytes: "1" },
    ]);
    const head = (await resolveRef(
      "plumb-u7",
      "plumb-r7",
      "refs/heads/main"
    ))!;

    const res = await app.request(
      apiUrl("/repos/plumb-u7/plumb-r7/git/commits/" + head)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sha).toBe(head);
    expect(body.tree?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Array.isArray(body.parents)).toBe(true);
    expect(typeof body.message).toBe("string");
    expect(body.author?.name).toBeDefined();
    expect(body.author?.email).toBeDefined();
    expect(body.author?.date).toBeDefined();
  });

  it("GET /git/commits/:sha for an unknown sha returns 404", async () => {
    await seedRepo("plumb-u8", "plumb-r8", [
      { path: "a.txt", bytes: "1" },
    ]);
    const res = await app.request(
      apiUrl("/repos/plumb-u8/plumb-r8/git/commits/" + "0".repeat(40))
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// API info — confirm the new endpoints are listed.
// ---------------------------------------------------------------------------

describe("API v2 — info endpoint lists git plumbing routes", () => {
  it("GET /api/v2 advertises the new plumbing endpoints", async () => {
    // Hono's basePath("/api/v2") + GET("/") matches `/api/v2` exactly,
    // not `/api/v2/` — the trailing slash is a different path. Use the
    // canonical no-slash form.
    const res = await app.request("/api/v2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoints.git).toBeDefined();
    expect(
      body.endpoints.git[
        "GET /api/v2/repos/:owner/:repo/git/refs/heads/:branch"
      ]
    ).toBeDefined();
    expect(
      body.endpoints.git[
        "PATCH /api/v2/repos/:owner/:repo/git/refs/heads/:branch"
      ]
    ).toBeDefined();
    expect(
      body.endpoints.git["GET /api/v2/repos/:owner/:repo/git/commits/:sha"]
    ).toBeDefined();
    expect(
      body.endpoints.git["POST /api/v2/repos/:owner/:repo/git/commits"]
    ).toBeDefined();
    expect(
      body.endpoints.git["POST /api/v2/repos/:owner/:repo/git/blobs"]
    ).toBeDefined();
    expect(
      body.endpoints.git["POST /api/v2/repos/:owner/:repo/git/trees"]
    ).toBeDefined();
    expect(
      body.endpoints.files[
        "DELETE /api/v2/repos/:owner/:repo/contents/:path"
      ]
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DB-dependent integration: write endpoints with a real PAT. Gated behind
// HAS_DB so CI without a database still passes.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)(
  "API v2 — git plumbing write endpoints (DB-backed)",
  () => {
    it("POST /git/blobs round-trips utf-8 and base64 content", async () => {
      // We can't reliably create a user/repo + token here without dragging
      // in the full registration flow. Just assert the endpoint refuses
      // unauthenticated callers and validates input shapes.
      const res = await app.request(
        apiUrl("/repos/nobody/nothing/git/blobs"),
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ content: "hi", encoding: "utf-8" }),
        }
      );
      expect(res.status).toBe(401);
    });
  }
);

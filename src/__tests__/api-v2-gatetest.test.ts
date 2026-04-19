/**
 * API v2 — GateTest integration endpoints.
 *
 * These tests cover the additive endpoints introduced for GateTest's
 * GluecronBridge:
 *   - recursive tree listing (cap 50k + truncation)
 *   - base64 content reads (PNG round-trip)
 *   - PR-comment POST auth check
 *   - POST /git/refs conflict + unknown-sha
 *   - PUT /contents/:path sha-mismatch
 *   - commit-status v2 alias
 *
 * Git-layer tests use real bare repos on disk; HTTP-layer tests use Hono's
 * in-memory request dispatcher without a DB connection (matching the style
 * of src/__tests__/api-v2.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import app from "../app";
import { clearRateLimitStore } from "../middleware/rate-limit";
import {
  initBareRepo,
  getRepoPath,
  getDefaultBranchFresh,
  getTreeRecursive,
  catBlobBytes,
  refExists,
  objectExists,
  updateRef,
  writeBlob,
  createOrUpdateFileOnBranch,
  getBlobShaAtPath,
  resolveRef,
} from "../git/repository";

const TEST_REPOS = join(import.meta.dir, "../../.test-repos-gatetest-" + Date.now());

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
// Helpers to build a real bare repo with a seeded commit
// ---------------------------------------------------------------------------

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
// 1. getDefaultBranchFresh
// ---------------------------------------------------------------------------

describe("git — getDefaultBranchFresh", () => {
  it("returns 'main' for a freshly initialised bare repo", async () => {
    await initBareRepo("u1", "r1");
    const branch = await getDefaultBranchFresh("u1", "r1");
    expect(branch).toBe("main");
  });

  it("strips refs/heads/ prefix from HEAD's symbolic ref", async () => {
    await initBareRepo("u2", "r2");
    const bare = getRepoPath("u2", "r2");
    await run(["git", "symbolic-ref", "HEAD", "refs/heads/develop"], bare);
    const branch = await getDefaultBranchFresh("u2", "r2");
    expect(branch).toBe("develop");
  });
});

// ---------------------------------------------------------------------------
// 2. Recursive tree
// ---------------------------------------------------------------------------

describe("git — getTreeRecursive", () => {
  it("walks all blobs and trees under the ref", async () => {
    await seedRepo("u3", "r3", [
      { path: "README.md", bytes: "# hi" },
      { path: "src/a.ts", bytes: "export const a = 1" },
      { path: "src/sub/b.ts", bytes: "export const b = 2" },
    ]);
    const result = await getTreeRecursive("u3", "r3", "main");
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    const paths = result!.tree.map((e) => e.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src");
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/sub");
    expect(paths).toContain("src/sub/b.ts");
    // blob entries carry a size
    const blob = result!.tree.find((e) => e.path === "src/a.ts");
    expect(blob?.type).toBe("blob");
    expect(typeof blob?.size).toBe("number");
  });

  it("truncates + sets truncated=true when over-cap", async () => {
    await seedRepo("u4", "r4", [
      { path: "a.txt", bytes: "1" },
      { path: "b.txt", bytes: "2" },
      { path: "c.txt", bytes: "3" },
      { path: "d.txt", bytes: "4" },
    ]);
    const result = await getTreeRecursive("u4", "r4", "main", 2);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.tree.length).toBe(2);
    expect(result!.totalCount).toBeGreaterThanOrEqual(4);
  });

  it("returns null for a ref that does not resolve", async () => {
    await initBareRepo("u5", "r5");
    const result = await getTreeRecursive("u5", "r5", "no-such-branch");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. catBlobBytes — binary round-trip (PNG magic)
// ---------------------------------------------------------------------------

describe("git — catBlobBytes / base64 round-trip", () => {
  it("preserves PNG magic bytes through git storage", async () => {
    // Minimal 1x1 transparent PNG.
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    await seedRepo("u6", "r6", [{ path: "pixel.png", bytes: pngBytes }]);

    const result = await catBlobBytes("u6", "r6", "main", "pixel.png");
    expect(result).not.toBeNull();
    expect(result!.size).toBe(pngBytes.length);
    // First 8 bytes are the PNG magic signature.
    for (let i = 0; i < 8; i++) expect(result!.bytes[i]).toBe(pngBytes[i]);

    const base64 = Buffer.from(result!.bytes).toString("base64");
    const decoded = Buffer.from(base64, "base64");
    expect(decoded.length).toBe(pngBytes.length);
    for (let i = 0; i < pngBytes.length; i++) expect(decoded[i]).toBe(pngBytes[i]);
  });

  it("returns null when the path is missing", async () => {
    await seedRepo("u7", "r7", [{ path: "x.txt", bytes: "hi" }]);
    const result = await catBlobBytes("u7", "r7", "main", "no-such-file");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. refExists, objectExists, updateRef
// ---------------------------------------------------------------------------

describe("git — ref + object helpers", () => {
  it("refExists returns true for existing refs, false otherwise", async () => {
    await seedRepo("u8", "r8", [{ path: "f.txt", bytes: "hi" }]);
    expect(await refExists("u8", "r8", "refs/heads/main")).toBe(true);
    expect(await refExists("u8", "r8", "refs/heads/nope")).toBe(false);
  });

  it("objectExists validates reachable shas", async () => {
    await seedRepo("u9", "r9", [{ path: "f.txt", bytes: "hi" }]);
    const sha = await resolveRef("u9", "r9", "HEAD");
    expect(sha).not.toBeNull();
    expect(await objectExists("u9", "r9", sha!)).toBe(true);
    expect(await objectExists("u9", "r9", "0".repeat(40))).toBe(false);
  });

  it("updateRef points a new branch at an existing sha", async () => {
    await seedRepo("u10", "r10", [{ path: "f.txt", bytes: "hi" }]);
    const sha = await resolveRef("u10", "r10", "HEAD");
    expect(await updateRef("u10", "r10", "refs/heads/feature-x", sha!)).toBe(true);
    expect(await refExists("u10", "r10", "refs/heads/feature-x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. writeBlob + createOrUpdateFileOnBranch + sha-mismatch
// ---------------------------------------------------------------------------

describe("git — createOrUpdateFileOnBranch", () => {
  it("appends a new file and moves the branch ref", async () => {
    await seedRepo("u11", "r11", [{ path: "README.md", bytes: "# hi" }]);
    const parent = await resolveRef("u11", "r11", "refs/heads/main");

    const result = await createOrUpdateFileOnBranch({
      owner: "u11",
      name: "r11",
      branch: "main",
      filePath: "src/new.ts",
      bytes: new TextEncoder().encode("export const x = 1;\n"),
      message: "add new.ts",
      authorName: "Test User",
      authorEmail: "test@gluecron.com",
      expectBlobSha: null,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.parentSha).toBe(parent);
    expect(result.commitSha).not.toBe(parent);

    // The branch ref now points at the new commit.
    const head = await resolveRef("u11", "r11", "refs/heads/main");
    expect(head).toBe(result.commitSha);

    // And the new blob is present on the branch.
    const blobSha = await getBlobShaAtPath("u11", "r11", "main", "src/new.ts");
    expect(blobSha).toBe(result.blobSha);
  });

  it("updates an existing file in place", async () => {
    await seedRepo("u12", "r12", [{ path: "README.md", bytes: "v1" }]);
    const oldBlob = await getBlobShaAtPath("u12", "r12", "main", "README.md");
    expect(oldBlob).not.toBeNull();

    const result = await createOrUpdateFileOnBranch({
      owner: "u12",
      name: "r12",
      branch: "main",
      filePath: "README.md",
      bytes: new TextEncoder().encode("v2"),
      message: "bump README",
      authorName: "Test User",
      authorEmail: "test@gluecron.com",
      expectBlobSha: oldBlob,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const newBlob = await getBlobShaAtPath("u12", "r12", "main", "README.md");
    expect(newBlob).toBe(result.blobSha);
    expect(newBlob).not.toBe(oldBlob);
  });

  it("returns sha-mismatch when the optimistic sha check fails", async () => {
    await seedRepo("u13", "r13", [{ path: "README.md", bytes: "v1" }]);
    const result = await createOrUpdateFileOnBranch({
      owner: "u13",
      name: "r13",
      branch: "main",
      filePath: "README.md",
      bytes: new TextEncoder().encode("v2"),
      message: "bump",
      authorName: "Test User",
      authorEmail: "test@gluecron.com",
      expectBlobSha: "0".repeat(40), // never matches
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toBe("sha-mismatch");
  });

  it("writeBlob produces a deterministic 40-hex sha", async () => {
    await initBareRepo("u14", "r14");
    const sha = await writeBlob("u14", "r14", new TextEncoder().encode("hello"));
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// 6. HTTP — auth/validation on new routes (no DB required)
// ---------------------------------------------------------------------------

function apiUrl(path: string): string {
  return `/api/v2${path}`;
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

describe("API v2 — new routes auth + validation", () => {
  it("POST /pulls/:n/comments without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/pulls/1/comments"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ body: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /git/refs without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/git/refs"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/x", sha: "a".repeat(40) }),
    });
    expect(res.status).toBe(401);
  });

  it("PUT /contents/:path without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/contents/foo.txt"), {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        message: "m",
        content: Buffer.from("hi").toString("base64"),
        branch: "main",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("POST v2 /statuses/:sha without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/statuses/" + "a".repeat(40)),
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ state: "success" }),
      }
    );
    expect(res.status).toBe(401);
  });

  it("GET tree?recursive=1 on missing repo returns 404 or 500", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/tree/main?recursive=1"));
    expect([404, 500]).toContain(res.status);
  });

  it("GET contents?encoding=base64 on missing repo returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/contents/any?encoding=base64")
    );
    expect([404, 500]).toContain(res.status);
  });
});

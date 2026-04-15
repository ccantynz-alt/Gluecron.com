/**
 * Block D7 — AI changelog route tests.
 *
 * The route depends on a real git repo on disk, so these tests drive the
 * route via the exported Hono app directly. A temporary bare repository is
 * spun up per test run under a unique GIT_REPOS_PATH so we don't collide
 * with other tests or the developer's local `./repos` tree.
 *
 * Tests here are deliberately scoped to the guarantees the Block D7 spec
 * calls out:
 *   - Module imports cleanly.
 *   - GET without query params renders the picker form (HTML).
 *   - GET with nonsense from/to strings renders an error banner, NOT a 500.
 *   - GET for a non-existent repo returns 404.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Pin GIT_REPOS_PATH BEFORE importing the route so `config.gitReposPath`
// (which is a lazy getter) reads our scratch dir on first access.
const SCRATCH = await mkdtemp(join(tmpdir(), "gluecron-ai-changelog-"));
process.env.GIT_REPOS_PATH = SCRATCH;

// eslint-disable-next-line import/first
const { default: aiChangelog } = await import("../routes/ai-changelog");

const OWNER = "alice";
const REPO = "demo";

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function seedRepo(): Promise<void> {
  // Bare repo lives where getRepoPath expects: <root>/<owner>/<repo>.git
  const bareDir = join(SCRATCH, OWNER, `${REPO}.git`);
  await mkdir(bareDir, { recursive: true });
  await run(["git", "init", "--bare", bareDir], SCRATCH);
  await run(
    ["git", "symbolic-ref", "HEAD", "refs/heads/main"],
    bareDir
  );

  // Push one real commit from a scratch working tree so branches/refs exist.
  const workDir = await mkdtemp(join(tmpdir(), "gluecron-ai-changelog-work-"));
  await run(["git", "init", workDir], SCRATCH);
  await run(
    ["git", "-C", workDir, "config", "user.email", "test@example.com"],
    SCRATCH
  );
  await run(
    ["git", "-C", workDir, "config", "user.name", "Test"],
    SCRATCH
  );
  await writeFile(join(workDir, "README.md"), "# hello\n");
  await run(["git", "-C", workDir, "add", "README.md"], SCRATCH);
  await run(
    ["git", "-C", workDir, "commit", "-m", "initial commit"],
    SCRATCH
  );
  // Ensure the local branch is called main regardless of git defaults.
  await run(
    ["git", "-C", workDir, "branch", "-M", "main"],
    SCRATCH
  );
  await run(
    ["git", "-C", workDir, "remote", "add", "origin", bareDir],
    SCRATCH
  );
  await run(
    ["git", "-C", workDir, "push", "origin", "main"],
    SCRATCH
  );

  await rm(workDir, { recursive: true, force: true });
}

describe("routes/ai-changelog — module", () => {
  it("imports cleanly and exports a Hono app", () => {
    expect(aiChangelog).toBeDefined();
    expect(typeof aiChangelog.request).toBe("function");
  });
});

describe("routes/ai-changelog — repo present", () => {
  beforeAll(async () => {
    await seedRepo();
  });

  afterAll(async () => {
    await rm(SCRATCH, { recursive: true, force: true }).catch(() => {});
  });

  it("GET without query params renders the picker form", async () => {
    const res = await aiChangelog.request(
      `/${OWNER}/${REPO}/ai/changelog`
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("AI Changelog");
    // The form exposes from/to inputs and a submit button.
    expect(body).toContain('name="from"');
    expect(body).toContain('name="to"');
    expect(body.toLowerCase()).toContain("generate");
  });

  it("GET with nonsense from/to renders an error banner, not a 500", async () => {
    const res = await aiChangelog.request(
      `/${OWNER}/${REPO}/ai/changelog?from=not-a-real-ref-xyz&to=also-not-real-abc`
    );
    // Must NOT be a 500 — the route should handle unresolvable refs gracefully.
    expect(res.status).toBe(200);
    const body = await res.text();
    // Error banner class used by the Layout for form errors.
    expect(body).toContain("auth-error");
    // And mentions the offending ref(s).
    expect(body).toMatch(/Could not resolve/i);
  });
});

describe("routes/ai-changelog — missing repo", () => {
  it("returns 404 for a non-existent repo", async () => {
    const res = await aiChangelog.request(
      "/nobody-xyz/nothing-xyz/ai/changelog"
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.toLowerCase()).toContain("repository not found");
  });
});

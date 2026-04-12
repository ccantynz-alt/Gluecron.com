import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import app from "../app";
import { initBareRepo, getRepoPath } from "../git/repository";

const TEST_REPOS = join(import.meta.dir, "../../.test-repos-web-" + Date.now());

beforeAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
  process.env.GIT_REPOS_PATH = TEST_REPOS;

  // Create a test repo with content
  await initBareRepo("testuser", "myrepo");
  const cloneDir = join(TEST_REPOS, "_clone");
  await mkdir(cloneDir, { recursive: true });
  const repoPath = getRepoPath("testuser", "myrepo");
  const workDir = join(cloneDir, "work");

  const run = async (cmd: string[], cwd: string) => {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };

  await run(["git", "clone", repoPath, workDir], TEST_REPOS);
  await run(["git", "config", "user.email", "test@test.com"], workDir);
  await run(["git", "config", "user.name", "Test"], workDir);

  await mkdir(join(workDir, "src"), { recursive: true });
  await Bun.write(join(workDir, "README.md"), "# My Repo\nHello");
  await Bun.write(
    join(workDir, "src/index.ts"),
    'const x: number = 42;\nconsole.log(x);'
  );

  await run(["git", "add", "-A"], workDir);
  await run(["git", "commit", "-m", "Initial commit"], workDir);
  await run(["git", "branch", "-M", "main"], workDir);
  await run(["git", "push", "-u", "origin", "main"], workDir);

  // Create a second branch
  await run(["git", "checkout", "-b", "feature"], workDir);
  await Bun.write(join(workDir, "src/feature.ts"), "export const y = 1;");
  await run(["git", "add", "-A"], workDir);
  await run(["git", "commit", "-m", "Add feature"], workDir);
  await run(["git", "push", "-u", "origin", "feature"], workDir);

  await rm(cloneDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

describe("web routes", () => {
  it("GET / returns landing page", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("gluecron");
  });

  it("GET /login returns login form", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in");
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
  });

  it("GET /register returns registration form", async () => {
    const res = await app.request("/register");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Create account");
    expect(html).toContain('name="username"');
    expect(html).toContain('name="email"');
  });

  it("GET /new redirects to login without auth", async () => {
    const res = await app.request("/new", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("GET /settings redirects to login without auth", async () => {
    const res = await app.request("/settings", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("GET /:owner/:repo shows repo page", async () => {
    const res = await app.request("/testuser/myrepo");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("testuser");
    expect(html).toContain("myrepo");
    expect(html).toContain("README.md");
    expect(html).toContain("src");
  });

  it("GET /:owner/:repo returns 404 for missing repo", async () => {
    const res = await app.request("/nobody/nope");
    expect(res.status).toBe(404);
  });

  it("GET /:owner/:repo/tree/:ref shows tree", async () => {
    const res = await app.request("/testuser/myrepo/tree/main/src");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("index.ts");
  });

  it("GET /:owner/:repo/blob/:ref/:path shows file with syntax highlighting", async () => {
    const res = await app.request("/testuser/myrepo/blob/main/src/index.ts");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should contain highlighted code
    expect(html).toContain("hljs-");
    expect(html).toContain("42");
  });

  it("GET /:owner/:repo/commits shows commits", async () => {
    const res = await app.request("/testuser/myrepo/commits");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Initial commit");
  });

  it("supports branch switching — feature branch", async () => {
    const res = await app.request("/testuser/myrepo/tree/feature");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("feature");
  });

  it("feature branch has feature.ts", async () => {
    const res = await app.request("/testuser/myrepo/tree/feature/src");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("feature.ts");
  });

  it("shows branch dropdown when multiple branches", async () => {
    const res = await app.request("/testuser/myrepo");
    const html = await res.text();
    expect(html).toContain("branch-dropdown");
    expect(html).toContain("main");
    expect(html).toContain("feature");
  });
});

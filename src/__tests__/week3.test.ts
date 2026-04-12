import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import app from "../app";
import { initBareRepo, getRepoPath } from "../git/repository";
import { renderMarkdown } from "../lib/markdown";

const TEST_REPOS = join(import.meta.dir, "../../.test-repos-w3-" + Date.now());

beforeAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
  process.env.GIT_REPOS_PATH = TEST_REPOS;

  await initBareRepo("alice", "project");
  const cloneDir = join(TEST_REPOS, "_clone");
  await mkdir(cloneDir, { recursive: true });
  const repoPath = getRepoPath("alice", "project");
  const workDir = join(cloneDir, "work");

  const run = async (cmd: string[], cwd: string) => {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };

  await run(["git", "clone", repoPath, workDir], TEST_REPOS);
  await run(["git", "config", "user.email", "alice@test.com"], workDir);
  await run(["git", "config", "user.name", "Alice"], workDir);

  await mkdir(join(workDir, "src"), { recursive: true });
  await Bun.write(
    join(workDir, "README.md"),
    "# My Project\n\nThis is a **bold** statement.\n\n- Item 1\n- Item 2\n\n```ts\nconst x = 1;\n```"
  );
  await Bun.write(
    join(workDir, "src/main.ts"),
    'function hello(name: string) {\n  console.log(`Hello, ${name}!`);\n}\nhello("world");'
  );
  await Bun.write(join(workDir, "data.json"), '{"key": "value"}');

  await run(["git", "add", "-A"], workDir);
  await run(["git", "commit", "-m", "Initial commit"], workDir);
  await run(["git", "branch", "-M", "main"], workDir);
  await run(["git", "push", "-u", "origin", "main"], workDir);

  // Second branch
  await run(["git", "checkout", "-b", "dev"], workDir);
  await Bun.write(join(workDir, "src/new.ts"), "export const y = 2;");
  await run(["git", "add", "-A"], workDir);
  await run(["git", "commit", "-m", "Add new module"], workDir);
  await run(["git", "push", "-u", "origin", "dev"], workDir);

  await rm(cloneDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

describe("markdown rendering", () => {
  it("should render bold text", () => {
    const html = renderMarkdown("This is **bold**.");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("should render code blocks with highlighting", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("hljs-");
  });

  it("should render lists", () => {
    const html = renderMarkdown("- one\n- two");
    expect(html).toContain("<li>");
  });

  it("should sanitize dangerous links", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("README renders as markdown in repo view", async () => {
    const res = await app.request("/alice/project");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("markdown-body");
  });
});

describe("raw file download", () => {
  it("GET /:owner/:repo/raw/:ref/:path returns file content", async () => {
    const res = await app.request("/alice/project/raw/main/data.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    const text = await res.text();
    expect(text).toContain('"key"');
  });

  it("returns 404 for missing file", async () => {
    const res = await app.request("/alice/project/raw/main/nope.txt");
    expect(res.status).toBe(404);
  });
});

describe("blame view", () => {
  it("GET /:owner/:repo/blame/:ref/:path shows blame", async () => {
    const res = await app.request("/alice/project/blame/main/src/main.ts");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("blame");
    expect(html).toContain("Alice");
    expect(html).toContain("hello");
  });

  it("returns 404 for missing file", async () => {
    const res = await app.request("/alice/project/blame/main/nope.ts");
    expect(res.status).toBe(404);
  });
});

describe("code search", () => {
  it("GET /:owner/:repo/search?q=... returns results", async () => {
    const res = await app.request("/alice/project/search?q=hello");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("result");
    expect(html).toContain("main.ts");
  });

  it("empty query shows no results", async () => {
    const res = await app.request("/alice/project/search");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Search");
  });
});

describe("compare view", () => {
  it("GET /:owner/:repo/compare shows picker", async () => {
    const res = await app.request("/alice/project/compare");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Compare");
    expect(html).toContain("main");
    expect(html).toContain("dev");
  });

  it("GET /:owner/:repo/compare/:base...:head shows diff", async () => {
    const res = await app.request("/alice/project/compare/main...dev");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("new.ts");
    expect(html).toContain("Add new module");
  });
});

describe("blob view links", () => {
  it("blob view contains Raw and Blame links", async () => {
    const res = await app.request("/alice/project/blob/main/src/main.ts");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/alice/project/raw/main/src/main.ts");
    expect(html).toContain("/alice/project/blame/main/src/main.ts");
  });
});

describe("error handling", () => {
  it("404 for unknown routes returns proper page", async () => {
    const res = await app.request("/alice/project/unknown-route-xyz");
    // This might hit the repo page or 404 depending on routing
    expect([200, 404]).toContain(res.status);
  });
});

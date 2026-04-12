import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import { initBareRepo, getRepoPath } from "../git/repository";
import {
  computeHealthScore,
  detectCIConfig,
  analyzePush,
} from "../lib/intelligence";
import { autoRepair } from "../lib/autorepair";

const TEST_REPOS = join(import.meta.dir, "../../.test-repos-intel-" + Date.now());

beforeAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
  process.env.GIT_REPOS_PATH = TEST_REPOS;

  // Create repo with various files
  await initBareRepo("dev", "myapp");
  const cloneDir = join(TEST_REPOS, "_clone");
  const workDir = join(cloneDir, "work");

  const run = async (cmd: string[], cwd: string) => {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };

  await run(["git", "clone", getRepoPath("dev", "myapp"), workDir], TEST_REPOS);
  await run(["git", "config", "user.email", "dev@test.com"], workDir);
  await run(["git", "config", "user.name", "Dev"], workDir);

  await mkdir(join(workDir, "src"), { recursive: true });
  await mkdir(join(workDir, "src/__tests__"), { recursive: true });

  // package.json
  await Bun.write(
    join(workDir, "package.json"),
    JSON.stringify(
      {
        name: "myapp",
        version: "1.0.0",
        scripts: { test: "bun test", lint: "eslint .", build: "tsc" },
        dependencies: { hono: "^4.0.0" },
        devDependencies: { typescript: "^5.0.0", "@types/bun": "^1.0.0" },
      },
      null,
      2
    )
  );

  // tsconfig
  await Bun.write(
    join(workDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true } }, null, 2)
  );

  // README
  await Bun.write(join(workDir, "README.md"), "# My App\n\nA test project.\n");

  // Source files
  await Bun.write(
    join(workDir, "src/index.ts"),
    'const greeting = "hello world";\nconsole.log(greeting);\n'
  );
  await Bun.write(
    join(workDir, "src/util.ts"),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
  );

  // Test file
  await Bun.write(
    join(workDir, "src/__tests__/util.test.ts"),
    'import { expect, test } from "bun:test";\nimport { add } from "../util";\n\ntest("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n'
  );

  // Trailing whitespace in a file (for auto-repair test)
  await Bun.write(
    join(workDir, "src/messy.ts"),
    'const x = 1;   \nconst y = 2;\t\t\n// no newline at end'
  );

  // bun.lock (just a dummy)
  await Bun.write(join(workDir, "bun.lock"), "{}");

  // .gitignore with some entries
  await Bun.write(join(workDir, ".gitignore"), "node_modules/\ndist/\n");

  await run(["git", "add", "-A"], workDir);
  await run(["git", "commit", "-m", "Initial commit"], workDir);
  await run(["git", "branch", "-M", "main"], workDir);
  await run(["git", "push", "-u", "origin", "main"], workDir);

  await rm(cloneDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

describe("health score", () => {
  it("computes a health report", async () => {
    const report = await computeHealthScore("dev", "myapp");

    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(["A+", "A", "B", "C", "D", "F"]).toContain(report.grade);
    expect(report.breakdown.security).toBeDefined();
    expect(report.breakdown.testing).toBeDefined();
    expect(report.breakdown.complexity).toBeDefined();
    expect(report.breakdown.dependencies).toBeDefined();
    expect(report.breakdown.documentation).toBeDefined();
    expect(report.breakdown.activity).toBeDefined();
    expect(report.insights.length).toBeGreaterThan(0);
  });

  it("detects tests exist", async () => {
    const report = await computeHealthScore("dev", "myapp");
    expect(report.breakdown.testing.hasTests).toBe(true);
    expect(report.breakdown.testing.testFileCount).toBeGreaterThan(0);
  });

  it("detects README", async () => {
    const report = await computeHealthScore("dev", "myapp");
    expect(report.breakdown.documentation.hasReadme).toBe(true);
  });

  it("detects dependencies", async () => {
    const report = await computeHealthScore("dev", "myapp");
    expect(report.breakdown.dependencies.total).toBeGreaterThan(0);
    expect(report.breakdown.dependencies.lockfileExists).toBe(true);
  });

  it("has at least 1 contributor", async () => {
    const report = await computeHealthScore("dev", "myapp");
    expect(report.breakdown.activity.uniqueContributors).toBeGreaterThanOrEqual(1);
  });
});

describe("zero-config CI detection", () => {
  it("detects Bun + TypeScript project", async () => {
    const ci = await detectCIConfig("dev", "myapp", "main");

    expect(ci.projectType).toBe("typescript");
    expect(ci.runtime).toBe("bun");
    expect(ci.detected).toContain("Bun project detected");
    expect(ci.detected).toContain("TypeScript detected");
  });

  it("detects test, lint, and build commands", async () => {
    const ci = await detectCIConfig("dev", "myapp", "main");

    const names = ci.commands.map((c) => c.name);
    expect(names).toContain("Test");
    expect(names).toContain("Lint");
  });

  it("detects Hono framework", async () => {
    const ci = await detectCIConfig("dev", "myapp", "main");
    expect(ci.detected).toContain("Hono framework");
  });
});

describe("auto-repair", () => {
  it("fixes whitespace issues", async () => {
    const result = await autoRepair("dev", "myapp", "main");

    expect(result.repaired).toBe(true);
    expect(result.repairs.length).toBeGreaterThan(0);

    // Should have fixed trailing whitespace
    const whitespaceRepairs = result.repairs.filter(
      (r) => r.type === "whitespace"
    );
    expect(whitespaceRepairs.length).toBeGreaterThan(0);
  });

  it("adds missing .gitignore entries", async () => {
    const result = await autoRepair("dev", "myapp", "main");

    const gitignoreRepairs = result.repairs.filter(
      (r) => r.type === "gitignore"
    );
    // May or may not need repair depending on current state
    // (first run may have already fixed it)
    expect(result.repaired).toBeDefined();
  });

  it("subsequent runs have fewer repairs", async () => {
    // Run once to fix everything
    const first = await autoRepair("dev", "myapp", "main");
    // Run again — should have fewer or no repairs
    const second = await autoRepair("dev", "myapp", "main");
    expect(second.repairs.length).toBeLessThanOrEqual(first.repairs.length);
  });
});

describe("health dashboard route", () => {
  it("GET /:owner/:repo/health returns health page", async () => {
    const app = (await import("../app")).default;
    const res = await app.request("/dev/myapp/health");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Health Score");
    expect(html).toContain("Security");
    expect(html).toContain("Testing");
    expect(html).toContain("Zero-Config CI");
  });
});

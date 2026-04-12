import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import {
  initBareRepo,
  repoExists,
  getRepoPath,
  listBranches,
  getDefaultBranch,
  resolveRef,
  getTree,
  getBlob,
  listCommits,
  getCommit,
  getDiff,
  getReadme,
} from "../git/repository";

const TEST_REPOS = join(import.meta.dir, "../../.test-repos-" + Date.now());

beforeAll(async () => {
  // Clean slate
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
  process.env.GIT_REPOS_PATH = TEST_REPOS;
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

describe("git repository management", () => {
  const owner = "testuser";
  const repo = "testrepo";

  it("should initialize a bare repository", async () => {
    const path = await initBareRepo(owner, repo);
    expect(path).toContain(`${owner}/${repo}.git`);
    expect(await repoExists(owner, repo)).toBe(true);
  });

  it("should report non-existent repos", async () => {
    expect(await repoExists("nobody", "nothing")).toBe(false);
  });

  it("should have main as default branch", async () => {
    const branch = await getDefaultBranch(owner, repo);
    expect(branch).toBe("main");
  });

  it("should return empty tree for fresh bare repo", async () => {
    // Fresh bare repo has no commits, so listing "main" returns nothing
    const tree = await getTree(owner, repo, "main");
    expect(tree).toEqual([]);
  });

  it("should return empty commits for fresh bare repo", async () => {
    const commits = await listCommits(owner, repo, "main");
    expect(commits).toEqual([]);
  });

  describe("with commits", () => {
    beforeAll(async () => {
      const cloneDir = join(TEST_REPOS, "_clone_tmp");
      await mkdir(cloneDir, { recursive: true });
      const repoPath = getRepoPath(owner, repo);

      const run = async (cmd: string[], cwd: string) => {
        const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      };

      const workDir = join(cloneDir, "work");
      await run(["git", "clone", repoPath, workDir], TEST_REPOS);
      await run(["git", "config", "user.email", "test@gluecron.com"], workDir);
      await run(["git", "config", "user.name", "Test User"], workDir);

      // Create files
      await mkdir(join(workDir, "src"), { recursive: true });
      await Bun.write(
        join(workDir, "README.md"),
        "# Test Repo\nHello gluecron"
      );
      await Bun.write(join(workDir, "src/index.ts"), "console.log('hello');");

      await run(["git", "add", "-A"], workDir);
      await run(["git", "commit", "-m", "Initial commit"], workDir);
      await run(["git", "branch", "-M", "main"], workDir);
      await run(["git", "push", "-u", "origin", "main"], workDir);

      // Second commit
      await Bun.write(join(workDir, "src/util.ts"), "export const x = 1;");
      await run(["git", "add", "-A"], workDir);
      await run(["git", "commit", "-m", "Add util module"], workDir);
      await run(["git", "push", "origin", "main"], workDir);

      await rm(cloneDir, { recursive: true, force: true });
    });

    it("should list branches", async () => {
      const branches = await listBranches(owner, repo);
      expect(branches).toContain("main");
    });

    it("should resolve HEAD ref", async () => {
      const sha = await resolveRef(owner, repo, "HEAD");
      expect(sha).toBeTruthy();
      expect(sha!.length).toBe(40);
    });

    it("should list root tree", async () => {
      const tree = await getTree(owner, repo, "main");
      expect(tree.length).toBeGreaterThan(0);
      const names = tree.map((e) => e.name);
      expect(names).toContain("README.md");
      expect(names).toContain("src");
    });

    it("should list subtree", async () => {
      const tree = await getTree(owner, repo, "main", "src");
      const names = tree.map((e) => e.name);
      expect(names).toContain("index.ts");
      expect(names).toContain("util.ts");
    });

    it("should read blob content", async () => {
      const blob = await getBlob(owner, repo, "main", "README.md");
      expect(blob).not.toBeNull();
      expect(blob!.content).toContain("Hello gluecron");
      expect(blob!.isBinary).toBe(false);
    });

    it("should list commits", async () => {
      const commits = await listCommits(owner, repo, "main");
      expect(commits.length).toBe(2);
      expect(commits[0].message).toBe("Add util module");
      expect(commits[1].message).toBe("Initial commit");
    });

    it("should get single commit", async () => {
      const commits = await listCommits(owner, repo, "main", 1);
      const commit = await getCommit(owner, repo, commits[0].sha);
      expect(commit).not.toBeNull();
      expect(commit!.author).toBe("Test User");
    });

    it("should get diff for commit", async () => {
      const commits = await listCommits(owner, repo, "main", 1);
      const { files, raw } = await getDiff(owner, repo, commits[0].sha);
      expect(files.length).toBeGreaterThan(0);
      expect(raw).toContain("util.ts");
    });

    it("should find README", async () => {
      const readme = await getReadme(owner, repo, "main");
      expect(readme).toContain("Hello gluecron");
    });
  });
});

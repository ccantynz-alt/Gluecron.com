import { join } from "path";
import { mkdir } from "fs/promises";
import { config } from "../lib/config";
import { gitCache, cached } from "../lib/cache";

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  parentShas: string[];
}

export interface GitTreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  name: string;
  size?: number;
}

export interface GitBlob {
  content: string;
  size: number;
  isBinary: boolean;
}

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

function repoPath(owner: string, name: string): string {
  return join(config.gitReposPath, owner, `${name}.git`);
}

async function exec(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export async function initBareRepo(
  owner: string,
  name: string
): Promise<string> {
  const path = repoPath(owner, name);
  await mkdir(join(config.gitReposPath, owner), { recursive: true });
  await exec(["git", "init", "--bare", path]);
  // Set default branch to main
  await exec(["git", "symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: path,
  });
  return path;
}

export async function repoExists(
  owner: string,
  name: string
): Promise<boolean> {
  const path = repoPath(owner, name);
  const file = Bun.file(join(path, "HEAD"));
  return file.exists();
}

export function getRepoPath(owner: string, name: string): string {
  return repoPath(owner, name);
}

export async function listBranches(
  owner: string,
  name: string
): Promise<string[]> {
  return cached(gitCache as any, `${owner}/${name}:branches`, async () => {
    const path = repoPath(owner, name);
    const { stdout, exitCode } = await exec(
      ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      { cwd: path }
    );
    if (exitCode !== 0) return [];
    return stdout.trim().split("\n").filter(Boolean);
  });
}

export async function getDefaultBranch(
  owner: string,
  name: string
): Promise<string | null> {
  return cached(gitCache as any, `${owner}/${name}:defaultBranch`, async () => {
    const path = repoPath(owner, name);
    const { stdout, exitCode } = await exec(
      ["git", "symbolic-ref", "--short", "HEAD"],
      { cwd: path }
    );
    if (exitCode !== 0) return null;
    return stdout.trim() || null;
  });
}

export async function resolveRef(
  owner: string,
  name: string,
  ref: string
): Promise<string | null> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    ["git", "rev-parse", "--verify", ref],
    { cwd: path }
  );
  if (exitCode !== 0) return null;
  return stdout.trim();
}

/**
 * List all tags (newest first by commit date).
 * Returns array of { name, sha, date }.
 */
export async function listTags(
  owner: string,
  name: string
): Promise<Array<{ name: string; sha: string; date: string }>> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    [
      "git",
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname:short)%00%(objectname)%00%(creatordate:iso-strict)",
      "refs/tags/",
    ],
    { cwd: path }
  );
  if (exitCode !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tname, sha, date] = line.split("\0");
      return { name: tname, sha, date };
    });
}

/**
 * Create a lightweight git tag pointing at a commit.
 */
export async function createTag(
  owner: string,
  name: string,
  tag: string,
  sha: string,
  annotation?: string
): Promise<boolean> {
  const path = repoPath(owner, name);
  const args = annotation
    ? ["git", "tag", "-a", tag, sha, "-m", annotation]
    : ["git", "tag", tag, sha];
  const { exitCode } = await exec(args, { cwd: path });
  return exitCode === 0;
}

/**
 * Delete a tag.
 */
export async function deleteTag(
  owner: string,
  name: string,
  tag: string
): Promise<boolean> {
  const path = repoPath(owner, name);
  const { exitCode } = await exec(["git", "tag", "-d", tag], { cwd: path });
  return exitCode === 0;
}

/**
 * Rename a branch (refs/heads/<from> → refs/heads/<to>). Preserves the
 * commit SHA. Writes the new ref first, then deletes the old one (so a
 * mid-op crash never leaves the branch unreachable). Returns true on
 * success. Caller is responsible for any semantics around the default
 * branch (HEAD symbolic-ref update) + cache invalidation — we flush
 * this repo's branch cache here as a convenience. Block J24.
 */
export async function renameBranch(
  owner: string,
  name: string,
  from: string,
  to: string
): Promise<boolean> {
  const path = repoPath(owner, name);
  const { stdout: shaOut, exitCode: revCode } = await exec(
    ["git", "rev-parse", "--verify", `refs/heads/${from}`],
    { cwd: path }
  );
  if (revCode !== 0) return false;
  const sha = shaOut.trim();
  if (!sha) return false;

  const { exitCode: createCode } = await exec(
    ["git", "update-ref", `refs/heads/${to}`, sha],
    { cwd: path }
  );
  if (createCode !== 0) return false;

  const { exitCode: deleteCode } = await exec(
    ["git", "update-ref", "-d", `refs/heads/${from}`, sha],
    { cwd: path }
  );
  if (deleteCode !== 0) {
    // Best-effort rollback — remove the newly-created ref so we don't
    // leak a duplicate.
    await exec(["git", "update-ref", "-d", `refs/heads/${to}`], {
      cwd: path,
    });
    return false;
  }
  gitCache.invalidatePrefix(`${owner}/${name}:`);
  return true;
}

/**
 * Update `HEAD` to point at a different branch. Used when the default
 * branch is renamed (Block J24).
 */
export async function setHeadBranch(
  owner: string,
  name: string,
  branch: string
): Promise<boolean> {
  const path = repoPath(owner, name);
  const { exitCode } = await exec(
    ["git", "symbolic-ref", "HEAD", `refs/heads/${branch}`],
    { cwd: path }
  );
  if (exitCode !== 0) return false;
  gitCache.invalidatePrefix(`${owner}/${name}:`);
  return true;
}

/**
 * List commits between two refs (excluding `from`, including `to`).
 */
export async function commitsBetween(
  owner: string,
  name: string,
  from: string | null,
  to: string
): Promise<GitCommit[]> {
  const path = repoPath(owner, name);
  const format = "%H%x00%s%x00%an%x00%ae%x00%aI%x00%P";
  const range = from ? `${from}..${to}` : to;
  const { stdout, exitCode } = await exec(
    ["git", "log", `--format=${format}`, "-500", range],
    { cwd: path }
  );
  if (exitCode !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, message, author, authorEmail, date, parents] = line.split("\0");
      return {
        sha,
        message,
        author,
        authorEmail,
        date,
        parentShas: parents ? parents.split(" ").filter(Boolean) : [],
      };
    });
}

export async function getCommit(
  owner: string,
  name: string,
  sha: string
): Promise<GitCommit | null> {
  const path = repoPath(owner, name);
  const format = "%H%n%s%n%an%n%ae%n%aI%n%P";
  const { stdout, exitCode } = await exec(
    ["git", "log", "-1", `--format=${format}`, sha],
    { cwd: path }
  );
  if (exitCode !== 0) return null;
  const lines = stdout.trim().split("\n");
  if (lines.length < 5) return null;
  return {
    sha: lines[0],
    message: lines[1],
    author: lines[2],
    authorEmail: lines[3],
    date: lines[4],
    parentShas: lines[5] ? lines[5].split(" ").filter(Boolean) : [],
  };
}

export async function getCommitFullMessage(
  owner: string,
  name: string,
  sha: string
): Promise<string> {
  const path = repoPath(owner, name);
  const { stdout } = await exec(
    ["git", "log", "-1", "--format=%B", sha],
    { cwd: path }
  );
  return stdout.trim();
}

export async function listCommits(
  owner: string,
  name: string,
  ref: string,
  limit = 30,
  offset = 0
): Promise<GitCommit[]> {
  return cached(gitCache as any, `${owner}/${name}:commits:${ref}:${limit}:${offset}`, async () => {
    const path = repoPath(owner, name);
    const format = "%H%x00%s%x00%an%x00%ae%x00%aI%x00%P";
    const { stdout, exitCode } = await exec(
      [
        "git",
        "log",
        `--format=${format}`,
        `--skip=${offset}`,
        `-${limit}`,
        ref,
      ],
      { cwd: path }
    );
    if (exitCode !== 0) return [];
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, message, author, authorEmail, date, parents] =
          line.split("\0");
        return {
          sha,
          message,
          author,
          authorEmail,
          date,
          parentShas: parents ? parents.split(" ").filter(Boolean) : [],
        };
      });
  });
}

export async function getTree(
  owner: string,
  name: string,
  ref: string,
  treePath = ""
): Promise<GitTreeEntry[]> {
  return cached(gitCache as any, `${owner}/${name}:tree:${ref}:${treePath}`, async () => {
    const path = repoPath(owner, name);
    const treeish = treePath ? `${ref}:${treePath}` : `${ref}`;
    const { stdout, exitCode } = await exec(
      ["git", "ls-tree", "-l", treeish],
      { cwd: path }
    );
    if (exitCode !== 0) return [];
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // format: <mode> <type> <sha>\t<size>\t<name>
        // Actually: <mode> SP <type> SP <sha> SP <size> TAB <name>
        const match = line.match(
          /^(\d+)\s+(blob|tree|commit)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/
        );
        if (!match) return null;
        return {
          mode: match[1],
          type: match[2] as "blob" | "tree" | "commit",
          sha: match[3],
          size: match[4] === "-" ? undefined : parseInt(match[4], 10),
          name: match[5],
        };
      })
      .filter((e): e is GitTreeEntry => e !== null)
      .sort((a, b) => {
        // directories first, then files
        if (a.type === "tree" && b.type !== "tree") return -1;
        if (a.type !== "tree" && b.type === "tree") return 1;
        return a.name.localeCompare(b.name);
      });
  });
}

export async function getBlob(
  owner: string,
  name: string,
  ref: string,
  filePath: string
): Promise<GitBlob | null> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    ["git", "cat-file", "-s", `${ref}:${filePath}`],
    { cwd: path }
  );
  if (exitCode !== 0) return null;
  const size = parseInt(stdout.trim(), 10);

  // Check if binary
  const { stdout: content, exitCode: catCode } = await exec(
    ["git", "show", `${ref}:${filePath}`],
    { cwd: path }
  );
  if (catCode !== 0) return null;

  const isBinary = content.includes("\0");
  return {
    content: isBinary ? "" : content,
    size,
    isBinary,
  };
}

export async function getDiff(
  owner: string,
  name: string,
  sha: string
): Promise<{ files: GitDiffFile[]; raw: string }> {
  const path = repoPath(owner, name);
  // For initial commits (no parent), diff against empty tree
  const commit = await getCommit(owner, name, sha);
  if (!commit) return { files: [], raw: "" };

  let diffCmd: string[];
  if (commit.parentShas.length === 0) {
    const emptyTree = "4b825dc642cb6eb9a060e54bf899d15363da7b23";
    diffCmd = ["git", "diff", emptyTree, sha];
  } else {
    diffCmd = ["git", "diff", `${commit.parentShas[0]}..${sha}`];
  }

  const { stdout: raw } = await exec(diffCmd, { cwd: path });

  // Also get --stat for file-level summary
  const { stdout: stat } = await exec([...diffCmd, "--numstat"], {
    cwd: path,
  });

  const files = stat
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, filePath] = line.split("\t");
      return {
        path: filePath,
        status: "modified",
        additions: add === "-" ? 0 : parseInt(add, 10),
        deletions: del === "-" ? 0 : parseInt(del, 10),
        patch: "",
      };
    });

  return { files, raw };
}

export interface BlameLine {
  sha: string;
  author: string;
  date: string;
  lineNum: number;
  content: string;
}

export async function getBlame(
  owner: string,
  name: string,
  ref: string,
  filePath: string
): Promise<BlameLine[]> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    ["git", "blame", "--porcelain", ref, "--", filePath],
    { cwd: path }
  );
  if (exitCode !== 0) return [];

  const lines: BlameLine[] = [];
  const commits: Record<string, { author: string; date: string }> = {};
  let currentSha = "";
  let currentLineNum = 0;

  for (const line of stdout.split("\n")) {
    // Header line: <sha> <orig-line> <final-line> [<group-lines>]
    const headerMatch = line.match(
      /^([0-9a-f]{40}) \d+ (\d+)/
    );
    if (headerMatch) {
      currentSha = headerMatch[1];
      currentLineNum = parseInt(headerMatch[2], 10);
      continue;
    }

    if (line.startsWith("author ")) {
      if (!commits[currentSha]) commits[currentSha] = { author: "", date: "" };
      commits[currentSha].author = line.slice(7);
    } else if (line.startsWith("author-time ")) {
      if (!commits[currentSha]) commits[currentSha] = { author: "", date: "" };
      commits[currentSha].date = new Date(
        parseInt(line.slice(12), 10) * 1000
      ).toISOString();
    } else if (line.startsWith("\t")) {
      const info = commits[currentSha] || { author: "unknown", date: "" };
      lines.push({
        sha: currentSha,
        author: info.author,
        date: info.date,
        lineNum: currentLineNum,
        content: line.slice(1),
      });
    }
  }

  return lines;
}

export async function getRawBlob(
  owner: string,
  name: string,
  ref: string,
  filePath: string
): Promise<Uint8Array | null> {
  const path = repoPath(owner, name);
  const proc = Bun.spawn(["git", "show", `${ref}:${filePath}`], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  const data = await new Response(proc.stdout).arrayBuffer();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  return new Uint8Array(data);
}

/**
 * Return the raw commit object (`git cat-file commit <sha>`) including any
 * `gpgsig` / `gpgsig-sha256` headers. Used by Block J3 signature verification.
 */
export async function getRawCommitObject(
  owner: string,
  name: string,
  sha: string
): Promise<string | null> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    ["git", "cat-file", "commit", sha],
    { cwd: path }
  );
  if (exitCode !== 0) return null;
  return stdout;
}

export async function searchCode(
  owner: string,
  name: string,
  ref: string,
  query: string,
  maxResults = 50
): Promise<Array<{ file: string; lineNum: number; line: string }>> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    ["git", "grep", "-n", "-I", `--max-count=${maxResults}`, query, ref],
    { cwd: path }
  );
  if (exitCode !== 0) return [];

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, maxResults)
    .map((line) => {
      // Format: <ref>:<file>:<lineNum>:<content>
      const refPrefix = ref + ":";
      const rest = line.startsWith(refPrefix) ? line.slice(refPrefix.length) : line;
      const colonIdx = rest.indexOf(":");
      if (colonIdx === -1) return null;
      const file = rest.slice(0, colonIdx);
      const afterFile = rest.slice(colonIdx + 1);
      const numColonIdx = afterFile.indexOf(":");
      if (numColonIdx === -1) return null;
      const lineNum = parseInt(afterFile.slice(0, numColonIdx), 10);
      const content = afterFile.slice(numColonIdx + 1);
      return { file, lineNum, line: content };
    })
    .filter((r): r is { file: string; lineNum: number; line: string } => r !== null);
}

export async function getReadme(
  owner: string,
  name: string,
  ref: string
): Promise<string | null> {
  return cached(gitCache as any, `${owner}/${name}:readme:${ref}`, async () => {
    const tree = await getTree(owner, name, ref);
    const readme = tree.find((e) =>
      /^readme(\.(md|txt|rst))?$/i.test(e.name)
    );
    if (!readme) return null;
    const blob = await getBlob(owner, name, ref, readme.name);
    return blob?.content || null;
  });
}

/**
 * Recursive flat tree listing at `ref` — returns every blob (file) path +
 * size in bytes. Useful for language breakdowns and large-file audits.
 * Skips symlinks and submodules. Returns `[]` on any git failure.
 */
export async function listTreeRecursive(
  owner: string,
  name: string,
  ref: string
): Promise<Array<{ path: string; size: number }>> {
  return cached(
    gitCache as any,
    `${owner}/${name}:tree-recursive:${ref}`,
    async () => {
      const path = repoPath(owner, name);
      const { stdout, exitCode } = await exec(
        ["git", "ls-tree", "-r", "-l", "-z", ref],
        { cwd: path }
      );
      if (exitCode !== 0) return [];
      const entries: Array<{ path: string; size: number }> = [];
      for (const line of stdout.split("\0")) {
        if (!line) continue;
        // Format: <mode> SP <type> SP <sha> SP <size> TAB <name>
        const match = line.match(
          /^(\d+)\s+(blob|tree|commit)\s+[0-9a-f]+\s+(-|\d+)\t(.+)$/
        );
        if (!match) continue;
        if (match[2] !== "blob") continue; // skip submodules / trees
        // Mode 120000 is a symlink — skip so size doesn't skew stats.
        if (match[1] === "120000") continue;
        const sz = match[3] === "-" ? 0 : Number.parseInt(match[3]!, 10);
        if (!Number.isFinite(sz) || sz < 0) continue;
        entries.push({ path: match[4]!, size: sz });
      }
      return entries;
    }
  );
}

/**
 * Count commits ahead and behind: commits on `head` not on `base` (ahead) and
 * commits on `base` not on `head` (behind). Returns null when either ref is
 * missing or git errors out.
 *
 * Uses `git rev-list --left-right --count <base>...<head>`; git emits
 * `<behind>\t<ahead>` (left is `base`, right is `head`).
 */
export async function aheadBehind(
  owner: string,
  name: string,
  base: string,
  head: string
): Promise<{ ahead: number; behind: number } | null> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    [
      "git",
      "rev-list",
      "--left-right",
      "--count",
      `${base}...${head}`,
    ],
    { cwd: path }
  );
  if (exitCode !== 0) return null;
  const parts = stdout.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const behind = Number.parseInt(parts[0]!, 10);
  const ahead = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

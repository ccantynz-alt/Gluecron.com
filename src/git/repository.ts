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
    .reduce<GitTreeEntry[]>((acc, line) => {
      const match = line.match(
        /^(\d+)\s+(blob|tree|commit)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/
      );
      if (match) {
        acc.push({
          mode: match[1],
          type: match[2] as "blob" | "tree" | "commit",
          sha: match[3],
          size: match[4] === "-" ? undefined : parseInt(match[4], 10),
          name: match[5],
        });
      }
      return acc;
    }, [])
    .sort((a, b) => {
      // directories first, then files
      if (a.type === "tree" && b.type !== "tree") return -1;
      if (a.type !== "tree" && b.type === "tree") return 1;
      return a.name.localeCompare(b.name);
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

/* -------------------------------------------------------------------------- */
/* Extra plumbing used by API v2 write-endpoints for the GateTest integration */
/* -------------------------------------------------------------------------- */

/**
 * Read default branch directly from HEAD on the given repo dir. Used by API
 * v2 where we want a cache-free fresh read. Returns `"main"` when HEAD is
 * missing, detached or unreadable. Safe on bare repos.
 */
export async function getDefaultBranchFresh(
  owner: string,
  name: string
): Promise<string> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    ["git", "symbolic-ref", "HEAD"],
    { cwd: path }
  );
  if (exitCode !== 0) return "main";
  const ref = stdout.trim();
  if (!ref) return "main";
  return ref.replace(/^refs\/heads\//, "") || "main";
}

export interface RecursiveTreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  mode: string;
  size?: number;
}

export interface RecursiveTreeResult {
  tree: RecursiveTreeEntry[];
  truncated: boolean;
  totalCount: number;
}

/**
 * Recursive ls-tree (blobs + trees). Caps at `maxEntries` (default 50_000)
 * to avoid monorepo memory blowups — sets `truncated=true` when exceeded.
 */
export async function getTreeRecursive(
  owner: string,
  name: string,
  ref: string,
  maxEntries = 50_000
): Promise<RecursiveTreeResult | null> {
  const path = repoPath(owner, name);
  // `-t` includes tree entries; `-l` adds size column for blobs.
  const { stdout, exitCode } = await exec(
    ["git", "ls-tree", "-r", "-t", "-l", "--full-tree", ref],
    { cwd: path }
  );
  if (exitCode !== 0) return null;

  const lines = stdout.split("\n").filter(Boolean);
  const totalCount = lines.length;
  const truncated = totalCount > maxEntries;
  const sliced = truncated ? lines.slice(0, maxEntries) : lines;

  const tree: RecursiveTreeEntry[] = [];
  for (const line of sliced) {
    // Format: <mode> SP <type> SP <sha> SP (<size>|-) TAB <path>
    const m = line.match(
      /^(\d+)\s+(blob|tree|commit)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/
    );
    if (!m) continue;
    const type = m[2];
    if (type === "commit") continue; // submodule — skip
    tree.push({
      mode: m[1],
      type: type as "blob" | "tree",
      sha: m[3],
      size: m[4] === "-" ? undefined : parseInt(m[4], 10),
      path: m[5],
    });
  }

  return { tree, truncated, totalCount };
}

/** Raw bytes of a blob by sha (for base64 API responses). */
export async function catBlobBytes(
  owner: string,
  name: string,
  ref: string,
  filePath: string
): Promise<{ bytes: Uint8Array; size: number; sha: string } | null> {
  const path = repoPath(owner, name);
  // Resolve blob sha first.
  const { stdout: shaOut, exitCode: shaCode } = await exec(
    ["git", "rev-parse", `${ref}:${filePath}`],
    { cwd: path }
  );
  if (shaCode !== 0) return null;
  const sha = shaOut.trim();
  if (!sha) return null;

  const { stdout: sizeOut } = await exec(
    ["git", "cat-file", "-s", sha],
    { cwd: path }
  );
  const size = parseInt(sizeOut.trim(), 10) || 0;

  const proc = Bun.spawn(["git", "cat-file", "blob", sha], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  return { bytes, size, sha };
}

/** Returns true iff `git show-ref --verify --quiet <ref>` succeeds. */
export async function refExists(
  owner: string,
  name: string,
  ref: string
): Promise<boolean> {
  const path = repoPath(owner, name);
  const { exitCode } = await exec(
    ["git", "show-ref", "--verify", "--quiet", ref],
    { cwd: path }
  );
  return exitCode === 0;
}

/** Returns true iff the given object is reachable in the repo. */
export async function objectExists(
  owner: string,
  name: string,
  sha: string
): Promise<boolean> {
  const path = repoPath(owner, name);
  const { exitCode } = await exec(
    ["git", "cat-file", "-e", sha],
    { cwd: path }
  );
  return exitCode === 0;
}

/** Point `<ref>` (fully-qualified, e.g. `refs/heads/x`) at `<sha>`. */
export async function updateRef(
  owner: string,
  name: string,
  ref: string,
  sha: string,
  oldSha?: string
): Promise<boolean> {
  const path = repoPath(owner, name);
  const args = oldSha
    ? ["git", "update-ref", ref, sha, oldSha]
    : ["git", "update-ref", ref, sha];
  const { exitCode } = await exec(args, { cwd: path });
  return exitCode === 0;
}

/** Hash + write a blob from bytes; returns the 40-hex blob sha. */
export async function writeBlob(
  owner: string,
  name: string,
  bytes: Uint8Array
): Promise<string | null> {
  const path = repoPath(owner, name);
  const proc = Bun.spawn(["git", "hash-object", "-w", "--stdin"], {
    cwd: path,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.stdin) {
    proc.stdin.write(bytes);
    proc.stdin.end();
  }
  const out = (await new Response(proc.stdout).text()).trim();
  const exitCode = await proc.exited;
  if (exitCode !== 0 || !/^[0-9a-f]{40}$/.test(out)) return null;
  return out;
}

/**
 * Read the blob sha at a given path on a ref, or null if missing.
 * Used for optimistic-concurrency checks on PUT /contents.
 */
export async function getBlobShaAtPath(
  owner: string,
  name: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  const path = repoPath(owner, name);
  const { stdout, exitCode } = await exec(
    ["git", "rev-parse", `${ref}:${filePath}`],
    { cwd: path }
  );
  if (exitCode !== 0) return null;
  const sha = stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Create or update a file at `filePath` on the branch `branch` with the
 * given bytes. Uses a transient index file (`GIT_INDEX_FILE`) to let git
 * handle sub-tree rewriting correctly; `mktree` alone cannot flatten paths
 * containing `/` into nested tree objects.
 *
 *   read-tree HEAD (empty if branch is new)
 *   update-index --add --cacheinfo 100644,<blob>,<path>
 *   write-tree
 *   commit-tree + update-ref
 *
 * Mirrors the plumbing flow used by the web editor (src/routes/editor.tsx)
 * but is safe for arbitrary subpaths. Returns the new commit sha on success.
 */
export async function createOrUpdateFileOnBranch(input: {
  owner: string;
  name: string;
  branch: string;
  filePath: string;
  bytes: Uint8Array;
  message: string;
  authorName: string;
  authorEmail: string;
  expectBlobSha?: string | null;
}): Promise<
  | { commitSha: string; blobSha: string; parentSha: string | null }
  | { error: "sha-mismatch" | "write-failed" }
> {
  const {
    owner,
    name,
    branch,
    filePath,
    bytes,
    message,
    authorName,
    authorEmail,
    expectBlobSha,
  } = input;
  const path = repoPath(owner, name);
  const fullRef = `refs/heads/${branch}`;

  // Resolve current parent + existing blob sha at that path.
  let parentSha: string | null = null;
  let existingBlobSha: string | null = null;
  const { stdout: parentOut, exitCode: parentCode } = await exec(
    ["git", "rev-parse", "--verify", fullRef],
    { cwd: path }
  );
  if (parentCode === 0) {
    parentSha = parentOut.trim();
    const { stdout: blobOut, exitCode: blobCode } = await exec(
      ["git", "rev-parse", `${branch}:${filePath}`],
      { cwd: path }
    );
    if (blobCode === 0) existingBlobSha = blobOut.trim();
  }

  // Optimistic concurrency: if caller supplied a sha, it must match current.
  if (typeof expectBlobSha === "string" && expectBlobSha.length > 0) {
    if (existingBlobSha !== expectBlobSha) return { error: "sha-mismatch" };
  }

  // Write the new blob.
  const blobSha = await writeBlob(owner, name, bytes);
  if (!blobSha) return { error: "write-failed" };

  // Use a temporary index file so we don't disturb whatever index the repo
  // already has (and so parallel writes don't stomp on each other).
  const tmpIndex = join(path, `index.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const envWithIndex = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };

  const cleanup = async () => {
    try {
      const { unlink } = await import("fs/promises");
      await unlink(tmpIndex);
    } catch {
      /* ignore */
    }
  };

  try {
    // Seed the temporary index from the parent tree (if any).
    if (parentSha) {
      const { exitCode: readCode } = await exec(
        ["git", "read-tree", parentSha],
        { cwd: path, env: envWithIndex }
      );
      if (readCode !== 0) {
        await cleanup();
        return { error: "write-failed" };
      }
    }

    // Add / replace our path.
    const { exitCode: updCode } = await exec(
      [
        "git",
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blobSha},${filePath}`,
      ],
      { cwd: path, env: envWithIndex }
    );
    if (updCode !== 0) {
      await cleanup();
      return { error: "write-failed" };
    }

    // Write the tree object.
    const { stdout: treeOut, exitCode: wtCode } = await exec(
      ["git", "write-tree"],
      { cwd: path, env: envWithIndex }
    );
    const newTreeSha = treeOut.trim();
    if (wtCode !== 0 || !/^[0-9a-f]{40}$/.test(newTreeSha)) {
      await cleanup();
      return { error: "write-failed" };
    }

    // Create the commit object.
    const commitArgs = parentSha
      ? ["git", "commit-tree", newTreeSha, "-p", parentSha, "-m", message]
      : ["git", "commit-tree", newTreeSha, "-m", message];
    const commitProc = Bun.spawn(commitArgs, {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
      env: envWithIndex,
    });
    const commitSha = (await new Response(commitProc.stdout).text()).trim();
    const commitExit = await commitProc.exited;
    if (commitExit !== 0 || !/^[0-9a-f]{40}$/.test(commitSha)) {
      await cleanup();
      return { error: "write-failed" };
    }

    // Move the branch.
    const ok = await updateRef(
      owner,
      name,
      fullRef,
      commitSha,
      parentSha || undefined
    );
    if (!ok) {
      await cleanup();
      return { error: "write-failed" };
    }

    await cleanup();
    return { commitSha, blobSha, parentSha };
  } catch {
    await cleanup();
    return { error: "write-failed" };
  }
}

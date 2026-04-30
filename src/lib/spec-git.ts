/**
 * spec-git — apply a batch of AI-proposed file edits to a new branch in a bare
 * git repo using plumbing only (no working tree, no `git add`, no `git commit`).
 *
 * Pattern cribbed from `src/lib/demo-seed.ts` (`writeInitialCommit`): transient
 * GIT_INDEX_FILE, hash-object → update-index → write-tree → commit-tree →
 * update-ref. Extended here to:
 *   - seed the index from a base tree (`read-tree`) so unrelated paths survive,
 *   - support delete edits via `update-index --remove`,
 *   - fail if the target branch already exists,
 *   - validate each edit path as defense in depth (reject `..`, absolute, empty).
 *
 * Never throws. Always cleans up the temp index in a `finally`.
 */
import { unlink } from "fs/promises";

export type FileEdit =
  | { action: "create"; path: string; content: string }
  | { action: "edit"; path: string; content: string }
  | { action: "delete"; path: string };

export type ApplyEditsResult =
  | {
      ok: true;
      branchName: string;
      commitSha: string;
      filesChanged: string[];
    }
  | { ok: false; error: string };

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a git subprocess safely. Never throws — errors surface via exitCode=-1.
 */
async function runGit(
  args: string[],
  cwd: string,
  opts?: { stdin?: string | Uint8Array; env?: Record<string, string> }
): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts?.stdin !== undefined ? "pipe" : undefined,
      env: { ...process.env, ...(opts?.env || {}) },
    });
    if (opts?.stdin !== undefined && proc.stdin) {
      const bytes =
        typeof opts.stdin === "string"
          ? new TextEncoder().encode(opts.stdin)
          : opts.stdin;
      (proc.stdin as any).write(bytes);
      (proc.stdin as any).end();
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr, exitCode };
  } catch (err: any) {
    return { stdout: "", stderr: String(err?.message || err), exitCode: -1 };
  }
}

/**
 * Reject paths that could escape the repo tree. Caller may have already
 * validated — this is defense in depth.
 */
function validatePath(p: string): string | null {
  if (typeof p !== "string") return "path must be a string";
  if (p.length === 0) return "path is empty";
  if (p.startsWith("/")) return `path is absolute: ${p}`;
  // Reject any `..` segment.
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "..") return `path contains '..' segment: ${p}`;
    if (seg === "") return `path has empty segment: ${p}`;
  }
  return null;
}

const SHA_RE = /^[0-9a-f]{40}$/;

export async function applyEditsToNewBranch(args: {
  repoDiskPath: string;
  baseRef: string;
  edits: FileEdit[];
  branchName: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
}): Promise<ApplyEditsResult> {
  const {
    repoDiskPath,
    baseRef,
    edits,
    branchName,
    commitMessage,
    authorName,
    authorEmail,
  } = args;

  // 0. Empty edits → refuse (don't manufacture empty commits).
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "no edits supplied" };
  }

  // 0b. Validate every path up front.
  for (const edit of edits) {
    const bad = validatePath(edit.path);
    if (bad) return { ok: false, error: bad };
  }

  // 0c. Basic branch-name sanity.
  if (!branchName || branchName.includes(" ") || branchName.startsWith("-")) {
    return { ok: false, error: `invalid branch name: ${branchName}` };
  }

  // 0d. Basic commit-message presence.
  if (!commitMessage || !commitMessage.trim()) {
    return { ok: false, error: "commit message is empty" };
  }

  // 1. Confirm repo path exists by probing `git rev-parse --git-dir`.
  const probe = await runGit(["rev-parse", "--git-dir"], repoDiskPath);
  if (probe.exitCode !== 0) {
    return {
      ok: false,
      error: `repo path invalid: ${probe.stderr.trim() || "rev-parse failed"}`,
    };
  }

  // 2. Refuse if target branch already exists.
  const existing = await runGit(
    ["rev-parse", "--verify", `refs/heads/${branchName}`],
    repoDiskPath
  );
  if (existing.exitCode === 0) {
    return { ok: false, error: "branch already exists" };
  }

  // 3. Resolve base commit sha and base tree sha.
  const baseSha = await runGit(["rev-parse", baseRef], repoDiskPath);
  if (baseSha.exitCode !== 0 || !SHA_RE.test(baseSha.stdout)) {
    return {
      ok: false,
      error: `base ref not found: ${baseRef}`,
    };
  }
  const baseTree = await runGit(
    ["rev-parse", `${baseRef}^{tree}`],
    repoDiskPath
  );
  if (baseTree.exitCode !== 0 || !SHA_RE.test(baseTree.stdout)) {
    return {
      ok: false,
      error: `could not resolve base tree for ${baseRef}`,
    };
  }

  // 4. Allocate a transient index file. Keep it inside the repo dir so it
  //    lives on the same filesystem as the object store.
  const tmpIndex = `${repoDiskPath}/index.spec-git.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const baseEnv: Record<string, string> = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };

  try {
    // 5. Seed the transient index from the base tree.
    const readTree = await runGit(
      ["read-tree", baseTree.stdout],
      repoDiskPath,
      { env: baseEnv }
    );
    if (readTree.exitCode !== 0) {
      return {
        ok: false,
        error: `read-tree failed: ${readTree.stderr.trim()}`,
      };
    }

    // 6. Apply each edit to the transient index.
    const filesChanged: string[] = [];
    for (const edit of edits) {
      if (edit.action === "delete") {
        const rm = await runGit(
          ["update-index", "--remove", edit.path],
          repoDiskPath,
          { env: baseEnv }
        );
        if (rm.exitCode !== 0) {
          return {
            ok: false,
            error: `update-index --remove failed for ${edit.path}: ${rm.stderr.trim()}`,
          };
        }
        filesChanged.push(edit.path);
        continue;
      }

      // create or edit — both hash the content and add to the index.
      const hashed = await runGit(
        ["hash-object", "-w", "--stdin"],
        repoDiskPath,
        { stdin: edit.content }
      );
      if (hashed.exitCode !== 0 || !SHA_RE.test(hashed.stdout)) {
        return {
          ok: false,
          error: `hash-object failed for ${edit.path}: ${hashed.stderr.trim()}`,
        };
      }
      const blobSha = hashed.stdout;
      const add = await runGit(
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blobSha},${edit.path}`,
        ],
        repoDiskPath,
        { env: baseEnv }
      );
      if (add.exitCode !== 0) {
        return {
          ok: false,
          error: `update-index --add failed for ${edit.path}: ${add.stderr.trim()}`,
        };
      }
      filesChanged.push(edit.path);
    }

    // 7. write-tree → new tree sha.
    const wt = await runGit(["write-tree"], repoDiskPath, { env: baseEnv });
    if (wt.exitCode !== 0 || !SHA_RE.test(wt.stdout)) {
      return {
        ok: false,
        error: `write-tree failed: ${wt.stderr.trim()}`,
      };
    }
    const newTreeSha = wt.stdout;

    // 8. If the new tree equals the base tree, nothing actually changed —
    //    don't create an empty commit.
    if (newTreeSha === baseTree.stdout) {
      return { ok: false, error: "no changes produced (tree identical)" };
    }

    // 9. commit-tree with the base commit as parent.
    const commit = await runGit(
      [
        "commit-tree",
        newTreeSha,
        "-p",
        baseSha.stdout,
        "-m",
        commitMessage,
      ],
      repoDiskPath,
      { env: baseEnv }
    );
    if (commit.exitCode !== 0 || !SHA_RE.test(commit.stdout)) {
      return {
        ok: false,
        error: `commit-tree failed: ${commit.stderr.trim()}`,
      };
    }
    const commitSha = commit.stdout;

    // 10. update-ref — create the new branch atomically. The `""` old-value
    //     argument tells git to only create if the ref doesn't yet exist.
    const upd = await runGit(
      ["update-ref", `refs/heads/${branchName}`, commitSha, ""],
      repoDiskPath
    );
    if (upd.exitCode !== 0) {
      return {
        ok: false,
        error: `update-ref failed: ${upd.stderr.trim()}`,
      };
    }

    return {
      ok: true,
      branchName,
      commitSha,
      filesChanged,
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    // Always remove the transient index file, success or failure.
    try {
      await unlink(tmpIndex);
    } catch {
      /* ignore — file may never have been created */
    }
  }
}

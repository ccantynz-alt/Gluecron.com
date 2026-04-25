/**
 * Automated merge conflict resolution using Claude.
 *
 * When a merge has conflicts, this module:
 * 1. Detects conflicting files
 * 2. Sends each conflict to Claude for resolution
 * 3. Applies the resolved content and completes the merge
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { getRepoPath } from "../git/repository";
import { MODEL_SONNET } from "./ai-client";

interface ConflictFile {
  path: string;
  content: string;
}

interface ResolvedFile {
  path: string;
  content: string;
}

interface MergeResult {
  success: boolean;
  resolvedFiles: string[];
  error?: string;
  commitSha?: string;
}

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return _client;
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

/**
 * Attempt to merge with automatic conflict resolution via Claude.
 *
 * This works in a temporary worktree to avoid disturbing the bare repo state.
 */
export async function mergeWithAutoResolve(
  owner: string,
  repo: string,
  baseBranch: string,
  headBranch: string,
  mergeMessage: string
): Promise<MergeResult> {
  const repoDir = getRepoPath(owner, repo);
  const worktree = `${repoDir}/_merge_worktree_${Date.now()}`;

  try {
    // Create a temporary worktree on the base branch
    const addWt = await exec(
      ["git", "worktree", "add", worktree, baseBranch],
      { cwd: repoDir }
    );
    if (addWt.exitCode !== 0) {
      return { success: false, resolvedFiles: [], error: `Failed to create worktree: ${addWt.stderr}` };
    }

    // Attempt the merge
    const merge = await exec(
      ["git", "merge", "--no-commit", "--no-ff", `origin/${headBranch}`],
      { cwd: worktree, env: { GIT_AUTHOR_NAME: "GlueCron AI", GIT_AUTHOR_EMAIL: "ai@gluecron.com", GIT_COMMITTER_NAME: "GlueCron AI", GIT_COMMITTER_EMAIL: "ai@gluecron.com" } }
    );

    // If merge succeeded clean (no conflicts), commit it
    if (merge.exitCode === 0) {
      const commit = await exec(
        ["git", "commit", "-m", mergeMessage],
        { cwd: worktree, env: { GIT_AUTHOR_NAME: "GlueCron AI", GIT_AUTHOR_EMAIL: "ai@gluecron.com", GIT_COMMITTER_NAME: "GlueCron AI", GIT_COMMITTER_EMAIL: "ai@gluecron.com" } }
      );

      // Get the merge commit SHA
      const { stdout: sha } = await exec(["git", "rev-parse", "HEAD"], { cwd: worktree });

      // Update the bare repo's base branch ref
      await exec(
        ["git", "update-ref", `refs/heads/${baseBranch}`, sha.trim()],
        { cwd: repoDir }
      );

      return { success: true, resolvedFiles: [], commitSha: sha.trim() };
    }

    // There are conflicts — get the list of conflicting files
    const { stdout: statusOut } = await exec(["git", "diff", "--name-only", "--diff-filter=U"], { cwd: worktree });
    const conflictPaths = statusOut.trim().split("\n").filter(Boolean);

    if (conflictPaths.length === 0) {
      return { success: false, resolvedFiles: [], error: "Merge failed but no conflicts detected" };
    }

    // Read each conflicting file and resolve with Claude
    const resolvedFiles: string[] = [];
    for (const filePath of conflictPaths) {
      const { stdout: conflictContent } = await exec(["cat", filePath], { cwd: worktree });
      const resolved = await resolveConflict(filePath, conflictContent);

      if (resolved) {
        // Write resolved content
        await Bun.write(`${worktree}/${filePath}`, resolved.content);
        await exec(["git", "add", filePath], { cwd: worktree });
        resolvedFiles.push(filePath);
      } else {
        // Could not resolve this file — abort
        await exec(["git", "merge", "--abort"], { cwd: worktree });
        return {
          success: false,
          resolvedFiles: [],
          error: `Could not auto-resolve conflict in ${filePath}`,
        };
      }
    }

    // All conflicts resolved — commit
    const commit = await exec(
      ["git", "commit", "-m", `${mergeMessage}\n\nAuto-resolved conflicts in: ${resolvedFiles.join(", ")}`],
      { cwd: worktree, env: { GIT_AUTHOR_NAME: "GlueCron AI", GIT_AUTHOR_EMAIL: "ai@gluecron.com", GIT_COMMITTER_NAME: "GlueCron AI", GIT_COMMITTER_EMAIL: "ai@gluecron.com" } }
    );

    if (commit.exitCode !== 0) {
      return { success: false, resolvedFiles, error: `Commit failed: ${commit.stderr}` };
    }

    const { stdout: sha } = await exec(["git", "rev-parse", "HEAD"], { cwd: worktree });

    // Update the bare repo ref
    await exec(
      ["git", "update-ref", `refs/heads/${baseBranch}`, sha.trim()],
      { cwd: repoDir }
    );

    return { success: true, resolvedFiles, commitSha: sha.trim() };
  } finally {
    // Clean up the worktree
    await exec(["git", "worktree", "remove", "--force", worktree], { cwd: repoDir }).catch(() => {});
  }
}

/**
 * Use Claude to resolve a single file's merge conflicts.
 */
async function resolveConflict(
  filePath: string,
  conflictContent: string
): Promise<ResolvedFile | null> {
  const client = getClient();

  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: `You are resolving a git merge conflict in the file "${filePath}".

The file contains conflict markers (<<<<<<< HEAD, =======, >>>>>>> branch). Your job is to produce the correctly merged version of the file.

Rules:
- Keep BOTH sides' changes when they don't contradict
- When changes truly conflict, choose the version that preserves correctness and doesn't break functionality
- Remove ALL conflict markers (<<<<<<< HEAD, =======, >>>>>>>)
- The output must be valid, working code
- Output ONLY the resolved file content, no explanation, no code fences

File content with conflicts:
${conflictContent}`,
        },
      ],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";

    // Verify no conflict markers remain
    if (text.includes("<<<<<<<") || text.includes(">>>>>>>")) {
      console.error(`[merge-resolver] Claude left conflict markers in ${filePath}`);
      return null;
    }

    return { path: filePath, content: text };
  } catch (err) {
    console.error(`[merge-resolver] Failed to resolve ${filePath}:`, err);
    return null;
  }
}

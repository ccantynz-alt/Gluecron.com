/**
 * Time-Travel Code Explorer
 *
 * GitHub shows you blame (who changed each line).
 * gluecron shows you the STORY of your code:
 *   - How did this function evolve?
 *   - When was this behavior introduced?
 *   - What was the context of each change?
 *
 * This answers the question developers actually ask:
 * "WHY is this code like this?"
 */

import { getRepoPath, getDefaultBranch } from "../git/repository";

export interface FileTimeline {
  path: string;
  totalRevisions: number;
  firstSeen: { sha: string; date: string; author: string; message: string };
  lastModified: { sha: string; date: string; author: string; message: string };
  revisions: FileRevision[];
}

export interface FileRevision {
  sha: string;
  date: string;
  author: string;
  message: string;
  linesAdded: number;
  linesRemoved: number;
  sizeAfter: number;
}

export interface FunctionTimeline {
  name: string;
  file: string;
  firstSeen: { sha: string; date: string; author: string };
  revisions: FunctionRevision[];
  currentSignature: string;
}

export interface FunctionRevision {
  sha: string;
  date: string;
  author: string;
  message: string;
  changeType: "created" | "modified" | "renamed" | "signature-changed";
  snippet: string;
}

async function exec(
  cmd: string[],
  cwd: string
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

/**
 * Get the complete evolution history of a file.
 * Every commit that touched it, with stats.
 */
export async function getFileTimeline(
  owner: string,
  repo: string,
  ref: string,
  filePath: string
): Promise<FileTimeline | null> {
  const repoDir = getRepoPath(owner, repo);

  // Get all commits that touched this file
  const { stdout, exitCode } = await exec(
    [
      "git",
      "log",
      "--follow",
      "--format=%H%x00%aI%x00%an%x00%s",
      "--numstat",
      ref,
      "--",
      filePath,
    ],
    repoDir
  );

  if (exitCode !== 0 || !stdout) return null;

  const revisions: FileRevision[] = [];
  const lines = stdout.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }

    const parts = line.split("\0");
    if (parts.length < 4) {
      i++;
      continue;
    }

    const [sha, date, author, message] = parts;
    let linesAdded = 0;
    let linesRemoved = 0;
    i++;

    // Read numstat line (may be on next non-empty line)
    while (i < lines.length && lines[i] === "") i++;
    if (i < lines.length) {
      const statLine = lines[i];
      const statMatch = statLine.match(/^(\d+|-)\t(\d+|-)\t/);
      if (statMatch) {
        linesAdded = statMatch[1] === "-" ? 0 : parseInt(statMatch[1], 10);
        linesRemoved = statMatch[2] === "-" ? 0 : parseInt(statMatch[2], 10);
        i++;
      }
    }

    // Get file size at this commit
    const { stdout: sizeStr } = await exec(
      ["git", "cat-file", "-s", `${sha}:${filePath}`],
      repoDir
    );
    const sizeAfter = parseInt(sizeStr, 10) || 0;

    revisions.push({
      sha,
      date,
      author,
      message,
      linesAdded,
      linesRemoved,
      sizeAfter,
    });
  }

  if (revisions.length === 0) return null;

  return {
    path: filePath,
    totalRevisions: revisions.length,
    firstSeen: {
      sha: revisions[revisions.length - 1].sha,
      date: revisions[revisions.length - 1].date,
      author: revisions[revisions.length - 1].author,
      message: revisions[revisions.length - 1].message,
    },
    lastModified: {
      sha: revisions[0].sha,
      date: revisions[0].date,
      author: revisions[0].author,
      message: revisions[0].message,
    },
    revisions,
  };
}

/**
 * Track the evolution of a specific function/symbol in a file.
 * Uses git log -L to trace function history.
 */
export async function getFunctionTimeline(
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
  functionName: string
): Promise<FunctionTimeline | null> {
  const repoDir = getRepoPath(owner, repo);

  // Use git log -L to trace function evolution
  // -L :functionName:filePath traces the function
  const { stdout, exitCode } = await exec(
    [
      "git",
      "log",
      `-L:${functionName}:${filePath}`,
      "--format=%H%x00%aI%x00%an%x00%s",
      "--no-patch",
      ref,
    ],
    repoDir
  );

  if (exitCode !== 0 || !stdout) {
    // Fallback: search for the function name in git log
    return getFunctionTimelineFallback(
      owner,
      repo,
      ref,
      filePath,
      functionName
    );
  }

  const revisions: FunctionRevision[] = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    const parts = line.split("\0");
    if (parts.length < 4) continue;
    const [sha, date, author, message] = parts;

    // Get the function snippet at this commit
    const { stdout: content } = await exec(
      ["git", "show", `${sha}:${filePath}`],
      repoDir
    );
    const snippet = extractFunctionSnippet(content, functionName);

    revisions.push({
      sha,
      date,
      author,
      message,
      changeType:
        revisions.length === 0 ? "created" : "modified",
      snippet: snippet.slice(0, 500),
    });
  }

  if (revisions.length === 0) return null;

  // Get current signature
  const { stdout: currentContent } = await exec(
    ["git", "show", `${ref}:${filePath}`],
    repoDir
  );
  const currentSignature = extractFunctionSignature(
    currentContent,
    functionName
  );

  return {
    name: functionName,
    file: filePath,
    firstSeen: {
      sha: revisions[revisions.length - 1].sha,
      date: revisions[revisions.length - 1].date,
      author: revisions[revisions.length - 1].author,
    },
    revisions,
    currentSignature,
  };
}

async function getFunctionTimelineFallback(
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
  functionName: string
): Promise<FunctionTimeline | null> {
  const repoDir = getRepoPath(owner, repo);

  // Get commits where this function name appears in the diff
  const { stdout } = await exec(
    [
      "git",
      "log",
      "--format=%H%x00%aI%x00%an%x00%s",
      `-S${functionName}`,
      ref,
      "--",
      filePath,
    ],
    repoDir
  );

  if (!stdout) return null;

  const revisions: FunctionRevision[] = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    const parts = line.split("\0");
    if (parts.length < 4) continue;
    const [sha, date, author, message] = parts;

    revisions.push({
      sha,
      date,
      author,
      message,
      changeType: revisions.length === 0 ? "created" : "modified",
      snippet: "",
    });
  }

  if (revisions.length === 0) return null;

  const { stdout: currentContent } = await exec(
    ["git", "show", `${ref}:${filePath}`],
    repoDir
  );

  return {
    name: functionName,
    file: filePath,
    firstSeen: {
      sha: revisions[revisions.length - 1].sha,
      date: revisions[revisions.length - 1].date,
      author: revisions[revisions.length - 1].author,
    },
    revisions,
    currentSignature: extractFunctionSignature(currentContent, functionName),
  };
}

/**
 * Detect hotspots — files that change together frequently.
 * If file A and file B always change in the same commit,
 * they're coupled. This catches architectural issues.
 */
export async function detectCoupledFiles(
  owner: string,
  repo: string,
  ref: string,
  limit = 20
): Promise<Array<{ files: [string, string]; cochanges: number; percentage: number }>> {
  const repoDir = getRepoPath(owner, repo);

  // Get recent commits with their changed files
  const { stdout } = await exec(
    [
      "git",
      "log",
      "--format=%H",
      "--name-only",
      "-100",
      ref,
    ],
    repoDir
  );

  const commits: string[][] = [];
  let current: string[] = [];

  for (const line of stdout.split("\n")) {
    if (line.match(/^[0-9a-f]{40}$/)) {
      if (current.length > 0) commits.push(current);
      current = [];
    } else if (line.trim()) {
      current.push(line.trim());
    }
  }
  if (current.length > 0) commits.push(current);

  // Count co-changes
  const pairCounts: Record<string, number> = {};
  const fileCounts: Record<string, number> = {};

  for (const files of commits) {
    for (const f of files) {
      fileCounts[f] = (fileCounts[f] || 0) + 1;
    }
    // Count pairs
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const pair = [files[i], files[j]].sort().join("|||");
        pairCounts[pair] = (pairCounts[pair] || 0) + 1;
      }
    }
  }

  return Object.entries(pairCounts)
    .filter(([, count]) => count >= 3) // At least 3 co-changes
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([pair, count]) => {
      const [f1, f2] = pair.split("|||");
      const maxChanges = Math.max(fileCounts[f1] || 0, fileCounts[f2] || 0);
      return {
        files: [f1, f2] as [string, string],
        cochanges: count,
        percentage: maxChanges > 0 ? Math.round((count / maxChanges) * 100) : 0,
      };
    });
}

/**
 * Get the "story" of a repository — key milestones,
 * major changes, turning points.
 */
export async function getRepoStory(
  owner: string,
  repo: string,
  ref: string
): Promise<Array<{
  sha: string;
  date: string;
  author: string;
  message: string;
  significance: "milestone" | "major" | "normal";
  stats: { files: number; additions: number; deletions: number };
}>> {
  const repoDir = getRepoPath(owner, repo);

  const { stdout } = await exec(
    [
      "git",
      "log",
      "--format=%H%x00%aI%x00%an%x00%s",
      "--shortstat",
      ref,
    ],
    repoDir
  );

  const entries: Array<{
    sha: string;
    date: string;
    author: string;
    message: string;
    significance: "milestone" | "major" | "normal";
    stats: { files: number; additions: number; deletions: number };
  }> = [];

  const lines = stdout.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }

    const parts = line.split("\0");
    if (parts.length < 4) {
      i++;
      continue;
    }

    const [sha, date, author, message] = parts;
    let files = 0;
    let additions = 0;
    let deletions = 0;
    i++;

    // Read stat line
    while (i < lines.length && lines[i] === "") i++;
    if (i < lines.length) {
      const statMatch = lines[i].match(
        /(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/
      );
      if (statMatch) {
        files = parseInt(statMatch[1], 10) || 0;
        additions = parseInt(statMatch[2], 10) || 0;
        deletions = parseInt(statMatch[3], 10) || 0;
        i++;
      }
    }

    // Determine significance
    let significance: "milestone" | "major" | "normal" = "normal";
    const lowerMsg = message.toLowerCase();

    if (
      lowerMsg.includes("v1") ||
      lowerMsg.includes("v2") ||
      lowerMsg.includes("release") ||
      lowerMsg.includes("launch") ||
      lowerMsg.includes("initial commit") ||
      lowerMsg.match(/v\d+\.\d+/)
    ) {
      significance = "milestone";
    } else if (
      files > 20 ||
      additions + deletions > 1000 ||
      lowerMsg.includes("refactor") ||
      lowerMsg.includes("breaking") ||
      lowerMsg.includes("migration") ||
      lowerMsg.includes("major")
    ) {
      significance = "major";
    }

    entries.push({
      sha,
      date,
      author,
      message,
      significance,
      stats: { files, additions, deletions },
    });
  }

  return entries;
}

// ─── Helpers ─────────────────────────────────────────────────

function extractFunctionSnippet(
  content: string,
  functionName: string
): string {
  const lines = content.split("\n");
  const regex = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?(?:function\\s+${functionName}|const\\s+${functionName}\\s*=|${functionName}\\s*[:(])`,
  );

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      // Get function body (up to 20 lines)
      return lines.slice(i, i + 20).join("\n");
    }
  }
  return "";
}

function extractFunctionSignature(
  content: string,
  functionName: string
): string {
  const lines = content.split("\n");
  const regex = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?(?:function\\s+${functionName}|const\\s+${functionName}\\s*=)`,
  );

  for (const line of lines) {
    if (regex.test(line)) {
      return line.trim();
    }
  }
  return `${functionName}(...)`;
}

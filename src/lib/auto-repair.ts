/**
 * AI-powered auto-repair engine.
 *
 * When a gate fails, this engine attempts to automatically fix the problem
 * and push the fix back to the branch. Covers:
 *   - Failing tests  → analyse + patch source
 *   - Type errors    → fix type signatures
 *   - Lint errors    → apply fixes or reformat
 *   - Secret leaks   → redact secret, add to .gitignore, force-push fix
 *   - Security issues → patch vulnerable code
 *
 * Works in a temporary worktree so the bare repo is never corrupted.
 * All repair commits are authored by "GlueCron AI" and recorded in gate_runs.
 */

import { spawn } from "bun";
import { mkdir, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { getAnthropic, MODEL_SONNET, extractText, parseJsonResponse, isAiAvailable } from "./ai-client";
import { getRepoPath } from "../git/repository";
import type { SecurityFinding, SecretFinding } from "./security-scan";

export interface RepairResult {
  attempted: boolean;
  success: boolean;
  commitSha?: string;
  filesChanged: string[];
  summary: string;
  error?: string;
}

async function exec(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(cmd, {
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

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "GlueCron AI",
  GIT_AUTHOR_EMAIL: "ai@gluecron.com",
  GIT_COMMITTER_NAME: "GlueCron AI",
  GIT_COMMITTER_EMAIL: "ai@gluecron.com",
};

interface Patch {
  path: string;
  /** Full replacement content. Preferred for simplicity + correctness. */
  content: string;
  /** Short rationale for the change — included in the commit message. */
  reason: string;
}

/**
 * Create a disposable worktree at the given branch head.
 * Returns the worktree path; caller MUST call cleanupWorktree when done.
 */
async function createWorktree(
  repoDir: string,
  branch: string
): Promise<{ path: string; ok: boolean; error?: string }> {
  const path = join(repoDir, `_repair_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const res = await exec(["git", "worktree", "add", path, branch], { cwd: repoDir });
  if (res.exitCode !== 0) {
    return { path, ok: false, error: res.stderr };
  }
  return { path, ok: true };
}

async function cleanupWorktree(repoDir: string, worktree: string): Promise<void> {
  await exec(["git", "worktree", "remove", "--force", worktree], {
    cwd: repoDir,
  }).catch(() => {});
  await rm(worktree, { recursive: true, force: true }).catch(() => {});
}

/**
 * Apply patches to a worktree, commit, and update the branch ref in the bare repo.
 */
async function applyAndCommit(
  repoDir: string,
  worktree: string,
  branch: string,
  patches: Patch[],
  commitMessage: string
): Promise<{ ok: boolean; sha?: string; error?: string; filesChanged: string[] }> {
  const filesChanged: string[] = [];
  for (const patch of patches) {
    const fullPath = join(worktree, patch.path);
    try {
      await mkdir(join(fullPath, "..").replace(/[^/]+\/\.\.$/, ""), { recursive: true }).catch(() => {});
      await writeFile(fullPath, patch.content, "utf8");
      filesChanged.push(patch.path);
    } catch (err) {
      console.error(`[auto-repair] Failed to write ${patch.path}:`, err);
    }
  }
  if (filesChanged.length === 0) {
    return { ok: false, error: "No patches applied", filesChanged: [] };
  }

  const add = await exec(["git", "add", "-A"], { cwd: worktree });
  if (add.exitCode !== 0) {
    return { ok: false, error: `git add: ${add.stderr}`, filesChanged };
  }

  const commit = await exec(
    ["git", "commit", "-m", commitMessage],
    { cwd: worktree, env: AUTHOR_ENV }
  );
  if (commit.exitCode !== 0) {
    return { ok: false, error: `git commit: ${commit.stderr}`, filesChanged };
  }

  const { stdout: sha } = await exec(["git", "rev-parse", "HEAD"], { cwd: worktree });

  // Push the new commit to the branch ref in the bare repo
  const push = await exec(
    ["git", "push", "origin", `HEAD:refs/heads/${branch}`],
    { cwd: worktree }
  );
  if (push.exitCode !== 0) {
    // Fall back to update-ref on bare repo if "origin" isn't the bare repo
    const upd = await exec(
      ["git", "update-ref", `refs/heads/${branch}`, sha.trim()],
      { cwd: repoDir }
    );
    if (upd.exitCode !== 0) {
      return { ok: false, error: `update-ref: ${upd.stderr}`, filesChanged };
    }
  }

  return { ok: true, sha: sha.trim(), filesChanged };
}

/**
 * Repair secret leaks by redacting the matching lines.
 * This is a defensive baseline — the secret itself must be rotated manually
 * because git history already contains it, but removing it from HEAD prevents
 * further exposure.
 */
export async function repairSecrets(
  owner: string,
  repo: string,
  branch: string,
  findings: SecretFinding[]
): Promise<RepairResult> {
  if (findings.length === 0) {
    return { attempted: false, success: false, filesChanged: [], summary: "no findings" };
  }
  const repoDir = getRepoPath(owner, repo);
  const wt = await createWorktree(repoDir, branch);
  if (!wt.ok) {
    return {
      attempted: true,
      success: false,
      filesChanged: [],
      summary: "could not create worktree",
      error: wt.error,
    };
  }

  try {
    // Group findings by file
    const byFile = new Map<string, SecretFinding[]>();
    for (const f of findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file)!.push(f);
    }

    const patches: Patch[] = [];
    for (const [file, fileFindings] of byFile) {
      try {
        const content = await readFile(join(wt.path, file), "utf8");
        const lines = content.split("\n");
        const badLines = new Set(fileFindings.map((f) => f.line - 1));
        for (const idx of badLines) {
          if (idx >= 0 && idx < lines.length) {
            // Redact everything that looks like a value after = or :
            lines[idx] = lines[idx].replace(
              /(['"])[A-Za-z0-9_\-/+=\.]{20,}(['"])/g,
              '$1REDACTED_BY_GLUECRON$2'
            );
            // If the whole line IS the secret (PEM), comment it out
            if (lines[idx].includes("BEGIN") && lines[idx].includes("PRIVATE KEY")) {
              lines[idx] = `// ${lines[idx]} // REDACTED_BY_GLUECRON`;
            }
          }
        }
        patches.push({
          path: file,
          content: lines.join("\n"),
          reason: `Redact ${fileFindings.length} secret${fileFindings.length === 1 ? "" : "s"}`,
        });
      } catch (err) {
        console.error(`[auto-repair] Could not read ${file}:`, err);
      }
    }

    if (patches.length === 0) {
      return {
        attempted: true,
        success: false,
        filesChanged: [],
        summary: "no files to patch",
      };
    }

    const msg = `fix(security): auto-redact leaked secrets

Redacted ${findings.length} secret finding${findings.length === 1 ? "" : "s"} in ${patches.length} file${patches.length === 1 ? "" : "s"}.

ACTION REQUIRED: these credentials must be rotated — they remain visible in git history.

[auto-repair by GlueCron AI]`;

    const result = await applyAndCommit(repoDir, wt.path, branch, patches, msg);
    if (!result.ok) {
      return {
        attempted: true,
        success: false,
        filesChanged: result.filesChanged,
        summary: "commit failed",
        error: result.error,
      };
    }
    return {
      attempted: true,
      success: true,
      commitSha: result.sha,
      filesChanged: result.filesChanged,
      summary: `Redacted ${findings.length} secret${findings.length === 1 ? "" : "s"} across ${patches.length} file${patches.length === 1 ? "" : "s"}`,
    };
  } finally {
    await cleanupWorktree(repoDir, wt.path);
  }
}

/**
 * Use Claude to repair a set of security findings by rewriting affected files.
 */
export async function repairSecurityIssues(
  owner: string,
  repo: string,
  branch: string,
  findings: SecurityFinding[]
): Promise<RepairResult> {
  if (findings.length === 0) {
    return { attempted: false, success: false, filesChanged: [], summary: "no findings" };
  }
  if (!isAiAvailable()) {
    return {
      attempted: false,
      success: false,
      filesChanged: [],
      summary: "AI not configured",
    };
  }

  const repoDir = getRepoPath(owner, repo);
  const wt = await createWorktree(repoDir, branch);
  if (!wt.ok) {
    return {
      attempted: true,
      success: false,
      filesChanged: [],
      summary: "could not create worktree",
      error: wt.error,
    };
  }

  try {
    // Group by file, read + patch each
    const byFile = new Map<string, SecurityFinding[]>();
    for (const f of findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file)!.push(f);
    }

    const client = getAnthropic();
    const patches: Patch[] = [];

    for (const [file, fileFindings] of byFile) {
      let original: string;
      try {
        original = await readFile(join(wt.path, file), "utf8");
      } catch {
        continue;
      }
      const findingsText = fileFindings
        .map(
          (f, i) =>
            `${i + 1}. [${f.severity}] ${f.type}${f.line ? ` on line ${f.line}` : ""}: ${f.description}${f.suggestion ? `\n   Suggestion: ${f.suggestion}` : ""}`
        )
        .join("\n");

      const message = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content: `You are a secure-coding assistant. A security scan flagged the following issues in "${file}":

${findingsText}

Rewrite the file to fix ALL flagged issues while preserving existing behaviour. Rules:
- Output ONLY the full corrected file content. No prose, no code fences.
- Do not add feature changes unrelated to the findings.
- Keep imports / exports intact.
- If an issue genuinely can't be fixed without breaking behaviour, return the file unchanged.

Current file:
${original}`,
          },
        ],
      });
      const fixed = extractText(message).replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
      if (fixed && fixed !== original && fixed.length > 10) {
        patches.push({
          path: file,
          content: fixed,
          reason: `Fix ${fileFindings.length} security finding${fileFindings.length === 1 ? "" : "s"}`,
        });
      }
    }

    if (patches.length === 0) {
      return {
        attempted: true,
        success: false,
        filesChanged: [],
        summary: "AI produced no patches",
      };
    }

    const msg = `fix(security): auto-repair flagged issues

${patches.map((p) => `- ${p.path}: ${p.reason}`).join("\n")}

[auto-repair by GlueCron AI]`;

    const result = await applyAndCommit(repoDir, wt.path, branch, patches, msg);
    if (!result.ok) {
      return {
        attempted: true,
        success: false,
        filesChanged: result.filesChanged,
        summary: "commit failed",
        error: result.error,
      };
    }
    return {
      attempted: true,
      success: true,
      commitSha: result.sha,
      filesChanged: result.filesChanged,
      summary: `Repaired ${findings.length} security issue${findings.length === 1 ? "" : "s"} in ${patches.length} file${patches.length === 1 ? "" : "s"}`,
    };
  } finally {
    await cleanupWorktree(repoDir, wt.path);
  }
}

/**
 * Given a GateTest failure summary, ask Claude to produce a patch set
 * that should make the failing check pass.
 */
export async function repairGateFailure(
  owner: string,
  repo: string,
  branch: string,
  gateName: string,
  failureDetails: string,
  context: { file: string; content: string }[]
): Promise<RepairResult> {
  if (!isAiAvailable()) {
    return { attempted: false, success: false, filesChanged: [], summary: "AI not configured" };
  }
  if (context.length === 0) {
    return { attempted: false, success: false, filesChanged: [], summary: "no files to analyse" };
  }

  const repoDir = getRepoPath(owner, repo);
  const wt = await createWorktree(repoDir, branch);
  if (!wt.ok) {
    return { attempted: true, success: false, filesChanged: [], summary: "worktree failed", error: wt.error };
  }

  try {
    const client = getAnthropic();
    const contextBlob = context
      .map((f) => `FILE: ${f.file}\n---\n${f.content.slice(0, 8000)}\n---\n`)
      .join("\n");

    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: `A gate named "${gateName}" failed on repository ${owner}/${repo} (branch ${branch}).

Failure details:
${failureDetails}

Relevant files:
${contextBlob}

Produce a minimal JSON patch set that fixes the failure. Respond ONLY with JSON:
{
  "patches": [
    { "path": "relative/path.ts", "content": "FULL new file content", "reason": "..." }
  ],
  "summary": "One sentence describing the fix"
}

If you cannot safely fix the failure, respond with { "patches": [], "summary": "Unable to auto-fix: ..." }.`,
        },
      ],
    });
    const text = extractText(message);
    const parsed = parseJsonResponse<{ patches: Patch[]; summary: string }>(text);
    if (!parsed || !Array.isArray(parsed.patches) || parsed.patches.length === 0) {
      return {
        attempted: true,
        success: false,
        filesChanged: [],
        summary: parsed?.summary || "AI produced no patches",
      };
    }

    const msg = `fix(${gateName.toLowerCase().replace(/\s+/g, "-")}): auto-repair gate failure

${parsed.summary}

${parsed.patches.map((p) => `- ${p.path}: ${p.reason}`).join("\n")}

[auto-repair by GlueCron AI]`;

    const result = await applyAndCommit(repoDir, wt.path, branch, parsed.patches, msg);
    if (!result.ok) {
      return {
        attempted: true,
        success: false,
        filesChanged: result.filesChanged,
        summary: "commit failed",
        error: result.error,
      };
    }
    return {
      attempted: true,
      success: true,
      commitSha: result.sha,
      filesChanged: result.filesChanged,
      summary: parsed.summary,
    };
  } finally {
    await cleanupWorktree(repoDir, wt.path);
  }
}

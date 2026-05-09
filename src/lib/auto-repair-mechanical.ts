/**
 * Mechanical auto-repair — Tier 1 of the auto-repair stack.
 *
 * Most CI failures are NOT logic bugs. They're mechanical: a lockfile
 * drifted because someone forgot to commit it, formatting got out of
 * sync, imports are ordered wrong. None of these need an AI call to
 * fix — running the right deterministic command produces the patch.
 *
 * This module is consulted FIRST. If a mechanical fix lands, we save
 * the cost + latency of a Claude round-trip. If not, the caller falls
 * through to ai-powered repairGateFailure() in auto-repair.ts.
 *
 * Every function returns {attempted, success, filesChanged, summary,
 * commitSha?} matching auto-repair.ts shape so callers can swap in/out
 * uniformly.
 *
 * Safety: each repair runs in a temporary worktree so the bare repo
 * stays pristine. Commits are signed "GlueCron AI [mechanical]" so
 * the audit trail distinguishes them from Tier-2 AI patches.
 */

import { spawn } from "bun";
import { join } from "path";
import { getRepoPath } from "../git/repository";

export interface MechanicalRepairResult {
  attempted: boolean;
  success: boolean;
  filesChanged: string[];
  summary: string;
  commitSha?: string;
  error?: string;
}

/**
 * What kind of failure are we dealing with? Cheap heuristic match on
 * failure text before deciding which mechanical repair (if any) to try.
 * Returns null if no mechanical pattern matches.
 */
export function classifyFailure(
  failureText: string,
): "lockfile" | "formatting" | "imports" | null {
  const t = failureText.toLowerCase();

  // Lockfile drift signals
  if (
    t.includes("lockfile is out of sync") ||
    t.includes("lockfile mismatch") ||
    t.includes("frozen lockfile failed") ||
    t.includes("frozen-lockfile") ||
    t.includes("package-lock.json is not in sync") ||
    t.includes("bun.lock") &&
      (t.includes("outdated") || t.includes("mismatch"))
  ) {
    return "lockfile";
  }

  // Formatting signals (Prettier / Biome / Bun fmt)
  if (
    t.includes("would be reformatted") ||
    t.includes("style/formatting") ||
    t.includes("prettier") ||
    t.includes("formatting check failed") ||
    /\bbiome\b.*\bformat\b/.test(t) ||
    t.includes("bun fmt")
  ) {
    return "formatting";
  }

  // Import-order signals (eslint-plugin-import, biome organize-imports)
  if (
    t.includes("imports are not sorted") ||
    t.includes("organize-imports") ||
    t.includes("import/order") ||
    t.includes("unused-imports")
  ) {
    return "imports";
  }

  return null;
}

/**
 * Attempt a mechanical repair based on the failure classification.
 * Returns {success: false, attempted: false} if no mechanical handler
 * matches — caller should fall through to AI repair.
 */
export async function tryMechanicalRepair(
  owner: string,
  repo: string,
  branch: string,
  failureText: string,
): Promise<MechanicalRepairResult> {
  const kind = classifyFailure(failureText);
  if (!kind) {
    return {
      attempted: false,
      success: false,
      filesChanged: [],
      summary: "no mechanical pattern matched",
    };
  }

  const repoDir = getRepoPath(owner, repo);
  const wt = await createWorktree(repoDir, branch);
  if (!wt.ok) {
    return {
      attempted: true,
      success: false,
      filesChanged: [],
      summary: `worktree failed: ${wt.error}`,
      error: wt.error,
    };
  }

  try {
    let result: MechanicalRepairResult;
    switch (kind) {
      case "lockfile":
        result = await repairLockfile(wt.path);
        break;
      case "formatting":
        result = await repairFormatting(wt.path);
        break;
      case "imports":
        result = await repairImports(wt.path);
        break;
    }

    if (!result.success || result.filesChanged.length === 0) {
      return result;
    }

    const sha = await commitChanges(
      repoDir,
      wt.path,
      branch,
      result.filesChanged,
      `fix(${kind}): mechanical auto-repair\n\n${result.summary}\n\n[auto-repair by GlueCron AI / mechanical tier]`,
    );

    return { ...result, commitSha: sha ?? undefined };
  } finally {
    await cleanupWorktree(repoDir, wt.path);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Individual repair handlers
// ─────────────────────────────────────────────────────────────────────────

async function repairLockfile(
  worktreePath: string,
): Promise<MechanicalRepairResult> {
  // Try bun first (this is a Bun repo)
  const hasBunLock = await fileExists(join(worktreePath, "bun.lock"));
  const hasPackageLock = await fileExists(join(worktreePath, "package-lock.json"));
  const hasYarnLock = await fileExists(join(worktreePath, "yarn.lock"));
  const hasPnpmLock = await fileExists(join(worktreePath, "pnpm-lock.yaml"));

  if (!hasBunLock && !hasPackageLock && !hasYarnLock && !hasPnpmLock) {
    return {
      attempted: true,
      success: false,
      filesChanged: [],
      summary: "no lockfile detected — nothing to regenerate",
    };
  }

  let cmd: string[];
  let lockfileName: string;
  if (hasBunLock) {
    cmd = ["bun", "install", "--lockfile-only"];
    lockfileName = "bun.lock";
  } else if (hasPackageLock) {
    cmd = ["npm", "install", "--package-lock-only", "--no-audit", "--no-fund"];
    lockfileName = "package-lock.json";
  } else if (hasYarnLock) {
    cmd = ["yarn", "install", "--mode", "update-lockfile"];
    lockfileName = "yarn.lock";
  } else {
    cmd = ["pnpm", "install", "--lockfile-only"];
    lockfileName = "pnpm-lock.yaml";
  }

  const { code, stderr } = await runCmd(cmd, worktreePath, 120_000);
  if (code !== 0) {
    return {
      attempted: true,
      success: false,
      filesChanged: [],
      summary: `lockfile regeneration failed (exit ${code})`,
      error: stderr.slice(0, 400),
    };
  }

  const changed = await dirtyFiles(worktreePath);
  return {
    attempted: true,
    success: changed.length > 0,
    filesChanged: changed,
    summary:
      changed.length > 0
        ? `regenerated ${lockfileName}`
        : `lockfile already in sync`,
  };
}

async function repairFormatting(
  worktreePath: string,
): Promise<MechanicalRepairResult> {
  // Try formatters in priority order: biome (fastest, growing adoption),
  // prettier (industry standard), bun fmt (built-in fallback).
  const tools: Array<{ check: string[]; cmd: string[]; name: string }> = [
    {
      check: ["bunx", "--bun", "biome", "--version"],
      cmd: ["bunx", "--bun", "biome", "format", "--write", "."],
      name: "biome",
    },
    {
      check: ["bunx", "prettier", "--version"],
      cmd: ["bunx", "prettier", "--write", "."],
      name: "prettier",
    },
  ];

  for (const tool of tools) {
    const probe = await runCmd(tool.check, worktreePath, 15_000);
    if (probe.code !== 0) continue;
    const apply = await runCmd(tool.cmd, worktreePath, 90_000);
    if (apply.code !== 0) {
      return {
        attempted: true,
        success: false,
        filesChanged: [],
        summary: `${tool.name} returned non-zero (${apply.code})`,
        error: apply.stderr.slice(0, 400),
      };
    }
    const changed = await dirtyFiles(worktreePath);
    return {
      attempted: true,
      success: changed.length > 0,
      filesChanged: changed,
      summary:
        changed.length > 0
          ? `reformatted ${changed.length} file(s) with ${tool.name}`
          : `code already formatted (${tool.name} clean)`,
    };
  }

  return {
    attempted: true,
    success: false,
    filesChanged: [],
    summary: "no formatter available (biome / prettier not installed)",
  };
}

async function repairImports(
  worktreePath: string,
): Promise<MechanicalRepairResult> {
  // Prefer biome's organize-imports — single command, fast.
  const probe = await runCmd(
    ["bunx", "--bun", "biome", "--version"],
    worktreePath,
    15_000,
  );
  if (probe.code !== 0) {
    return {
      attempted: true,
      success: false,
      filesChanged: [],
      summary: "no import organiser available (biome not installed)",
    };
  }

  const apply = await runCmd(
    [
      "bunx",
      "--bun",
      "biome",
      "check",
      "--write",
      "--unsafe",
      ".",
    ],
    worktreePath,
    90_000,
  );
  if (apply.code !== 0) {
    return {
      attempted: true,
      success: false,
      filesChanged: [],
      summary: `biome check exit ${apply.code}`,
      error: apply.stderr.slice(0, 400),
    };
  }

  const changed = await dirtyFiles(worktreePath);
  return {
    attempted: true,
    success: changed.length > 0,
    filesChanged: changed,
    summary:
      changed.length > 0
        ? `organised imports in ${changed.length} file(s)`
        : `imports already organised`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// helpers — worktree, git, fs
// ─────────────────────────────────────────────────────────────────────────

async function createWorktree(
  bareRepoDir: string,
  branch: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const wtPath = `/tmp/gluecron-mechrepair-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const { code, stderr } = await runCmd(
    ["git", "worktree", "add", "-f", wtPath, branch],
    bareRepoDir,
    30_000,
  );
  if (code !== 0) return { ok: false, error: stderr.slice(0, 400) };
  return { ok: true, path: wtPath };
}

async function cleanupWorktree(bareRepoDir: string, wtPath: string) {
  await runCmd(["git", "worktree", "remove", "-f", wtPath], bareRepoDir, 30_000);
}

async function dirtyFiles(worktreePath: string): Promise<string[]> {
  const { stdout, code } = await runCmd(
    ["git", "status", "--porcelain"],
    worktreePath,
    15_000,
  );
  if (code !== 0) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^.{2,3}\s+/, ""));
}

async function commitChanges(
  bareRepoDir: string,
  worktreePath: string,
  branch: string,
  files: string[],
  message: string,
): Promise<string | null> {
  if (files.length === 0) return null;

  const addRes = await runCmd(
    ["git", "add", "--", ...files],
    worktreePath,
    30_000,
  );
  if (addRes.code !== 0) return null;

  const commitRes = await runCmd(
    [
      "git",
      "-c",
      "user.name=GlueCron AI",
      "-c",
      "user.email=ai-bot@gluecron.com",
      "commit",
      "-m",
      message,
    ],
    worktreePath,
    30_000,
  );
  if (commitRes.code !== 0) return null;

  const shaRes = await runCmd(["git", "rev-parse", "HEAD"], worktreePath, 15_000);
  if (shaRes.code !== 0) return null;

  // Push from the worktree back to the bare via direct branch update.
  // The worktree shares object storage with the bare, so we just update
  // the bare's branch ref.
  const push = await runCmd(
    ["git", "push", bareRepoDir, `HEAD:${branch}`],
    worktreePath,
    30_000,
  );
  if (push.code !== 0) return null;

  return shaRes.stdout.trim();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const f = Bun.file(path);
    return await f.exists();
  } catch {
    return false;
  }
}

async function runCmd(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = spawn({
      cmd,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Don't write to the user's HOME during install / format
        HOME: "/tmp",
        // Stop interactive prompts dead
        CI: "true",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code: code ?? 1, stdout, stderr };
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

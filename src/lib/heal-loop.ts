/**
 * Self-healing loop — GateTest integration.
 *
 * Continuously runs tests on a branch, interprets failures, auto-repairs,
 * resubmits, and repeats until green or max attempts reached. This is the
 * "nothing broken ships" guarantee taken to its logical conclusion.
 *
 * Flow:
 *   1. Run GateTest scan (or local test suite)
 *   2. If green → done
 *   3. If red → parse failure output
 *   4. Send failure context to Claude for repair
 *   5. Apply patches, commit, update ref
 *   6. Repeat from step 1 (max 3 attempts)
 *
 * The loop runs asynchronously and broadcasts SSE events at each step
 * so the UI can show live progress.
 */

import { spawn } from "bun";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getRepoPath } from "../git/repository";
import { broadcast } from "./sse";
import { config } from "./config";
import { db } from "../db";
import { gateRuns, repositories, users } from "../db/schema";
import { eq, and } from "drizzle-orm";

const MAX_HEAL_ATTEMPTS = 3;

interface HealResult {
  success: boolean;
  attempts: number;
  repairs: Array<{
    attempt: number;
    failureType: string;
    filesChanged: string[];
    commitSha?: string;
  }>;
  finalStatus: "green" | "red" | "max_attempts" | "error";
  error?: string;
}

interface TestFailure {
  type: "test" | "lint" | "typecheck" | "build" | "security" | "unknown";
  message: string;
  file?: string;
  line?: number;
  details: string;
}

async function exec(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(cmd, {
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  if (opts?.timeout) {
    timeoutId = setTimeout(() => proc.kill(), opts.timeout);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (timeoutId) clearTimeout(timeoutId);
  return { stdout, stderr, exitCode };
}

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "GlueCron AI",
  GIT_AUTHOR_EMAIL: "ai@gluecron.com",
  GIT_COMMITTER_NAME: "GlueCron AI",
  GIT_COMMITTER_EMAIL: "ai@gluecron.com",
};

/**
 * Parse test/build output to identify specific failures.
 */
function parseFailures(stdout: string, stderr: string): TestFailure[] {
  const combined = stdout + "\n" + stderr;
  const failures: TestFailure[] = [];

  // TypeScript errors: src/file.ts(10,5): error TS1234: message
  const tsErrors = combined.matchAll(/^(.+?)\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)$/gm);
  for (const m of tsErrors) {
    failures.push({
      type: "typecheck",
      message: m[3],
      file: m[1],
      line: parseInt(m[2]),
      details: m[0],
    });
  }

  // Test failures: ✗ test name ... expected X received Y
  const testFails = combined.matchAll(/(?:FAIL|✗|×)\s+(.+?)(?:\n[\s\S]*?(?:expected|Error|assert)[\s\S]*?)(?=\n(?:FAIL|✗|×|PASS|✓|\d+ pass)|\n\n)/gm);
  for (const m of testFails) {
    failures.push({
      type: "test",
      message: m[1].trim(),
      details: m[0].slice(0, 500),
    });
  }

  // ESLint errors
  const lintErrors = combined.matchAll(/^(.+?):(\d+):\d+\s+error\s+(.+?)\s+/gm);
  for (const m of lintErrors) {
    failures.push({
      type: "lint",
      message: m[3],
      file: m[1],
      line: parseInt(m[2]),
      details: m[0],
    });
  }

  // Build errors
  if (combined.includes("Build failed") || combined.includes("Cannot find module")) {
    const buildMatch = combined.match(/(?:Build failed|Cannot find module[^\n]+)/);
    failures.push({
      type: "build",
      message: buildMatch?.[0] || "Build error",
      details: combined.slice(0, 500),
    });
  }

  if (failures.length === 0 && (stdout.includes("fail") || stderr.includes("error"))) {
    failures.push({
      type: "unknown",
      message: "Unrecognized failure pattern",
      details: combined.slice(0, 500),
    });
  }

  return failures;
}

/**
 * Ask Claude to generate repair patches for identified failures.
 */
async function generateRepairPatches(
  worktreePath: string,
  failures: TestFailure[]
): Promise<Array<{ path: string; content: string; reason: string }>> {
  if (!config.anthropicApiKey) return [];

  const { getAnthropic, MODEL_SONNET, extractText } = await import("./ai-client");
  const client = getAnthropic();

  // Group failures by file
  const byFile = new Map<string, TestFailure[]>();
  for (const f of failures) {
    const file = f.file || "unknown";
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(f);
  }

  const patches: Array<{ path: string; content: string; reason: string }> = [];

  for (const [file, fileFailures] of byFile) {
    if (file === "unknown") continue;

    let original: string;
    try {
      original = await readFile(join(worktreePath, file), "utf8");
    } catch {
      continue;
    }

    const failureText = fileFailures
      .map((f, i) => `${i + 1}. [${f.type}] ${f.message}${f.line ? ` (line ${f.line})` : ""}\n   ${f.details}`)
      .join("\n\n");

    try {
      const message = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content: `Fix the following failures in "${file}". Output ONLY the corrected file content — no prose, no code fences, no explanation.

Failures:
${failureText}

Current file content:
${original.slice(0, 50000)}`,
          },
        ],
      });

      const fixed = extractText(message).replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
      if (fixed && fixed !== original && fixed.length > 10) {
        patches.push({
          path: file,
          content: fixed,
          reason: `Fix ${fileFailures.length} ${fileFailures[0].type} failure${fileFailures.length > 1 ? "s" : ""}`,
        });
      }
    } catch (err) {
      console.error(`[heal-loop] Claude repair failed for ${file}:`, err);
    }
  }

  return patches;
}

/**
 * Run the test suite in a worktree.
 */
async function runTests(
  worktreePath: string
): Promise<{ passed: boolean; stdout: string; stderr: string }> {
  // Check if there's a package.json with test script
  try {
    const pkg = JSON.parse(await readFile(join(worktreePath, "package.json"), "utf8"));
    const testCmd = pkg.scripts?.test;
    if (testCmd) {
      const result = await exec(["bun", "test"], { cwd: worktreePath, timeout: 120_000 });
      return { passed: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
    }
  } catch {}

  // Fallback: try bun test directly
  const result = await exec(["bun", "test"], { cwd: worktreePath, timeout: 120_000 });
  return { passed: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run the self-healing loop on a branch.
 *
 * Called after a push or PR merge attempt that failed gate checks.
 * The loop attempts to fix failures and push repairs back to the branch.
 */
export async function runHealLoop(
  owner: string,
  repo: string,
  branch: string,
  opts: {
    repositoryId?: string;
    pullRequestId?: string;
    triggerSource?: string;
  } = {}
): Promise<HealResult> {
  const repoDir = getRepoPath(owner, repo);
  const sseChannel = opts.repositoryId ? `gate:${opts.repositoryId}` : null;

  const result: HealResult = {
    success: false,
    attempts: 0,
    repairs: [],
    finalStatus: "error",
  };

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    result.attempts = attempt;

    // Broadcast SSE: healing attempt starting
    if (sseChannel) {
      broadcast(sseChannel, "heal:attempt", {
        attempt,
        maxAttempts: MAX_HEAL_ATTEMPTS,
        branch,
        status: "running",
      });
    }

    // Create worktree
    const wtPath = join(repoDir, `_heal_${Date.now()}_${attempt}`);
    const wt = await exec(["git", "worktree", "add", wtPath, branch], { cwd: repoDir });
    if (wt.exitCode !== 0) {
      result.error = `Worktree creation failed: ${wt.stderr}`;
      result.finalStatus = "error";
      break;
    }

    try {
      // Install deps if needed
      const pkgExists = await readFile(join(wtPath, "package.json"), "utf8").catch(() => null);
      if (pkgExists) {
        await exec(["bun", "install", "--frozen-lockfile"], { cwd: wtPath, timeout: 60_000 });
      }

      // Run tests
      const testResult = await runTests(wtPath);

      if (testResult.passed) {
        result.success = true;
        result.finalStatus = "green";

        if (sseChannel) {
          broadcast(sseChannel, "heal:green", {
            attempt,
            branch,
            totalRepairs: result.repairs.length,
          });
        }
        break;
      }

      // Tests failed — parse failures
      const failures = parseFailures(testResult.stdout, testResult.stderr);
      console.log(`[heal-loop] Attempt ${attempt}: ${failures.length} failures detected`);

      if (failures.length === 0) {
        result.finalStatus = "red";
        result.error = "Tests failed but no parseable failures found";

        if (sseChannel) {
          broadcast(sseChannel, "heal:unparseable", { attempt, branch });
        }
        break;
      }

      // Generate repair patches
      const patches = await generateRepairPatches(wtPath, failures);
      if (patches.length === 0) {
        result.finalStatus = "red";
        result.error = "Could not generate repair patches";

        if (sseChannel) {
          broadcast(sseChannel, "heal:no_patches", { attempt, branch, failures: failures.length });
        }
        break;
      }

      // Apply patches
      for (const patch of patches) {
        const fullPath = join(wtPath, patch.path);
        await mkdir(join(fullPath, ".."), { recursive: true }).catch(() => {});
        await writeFile(fullPath, patch.content, "utf8");
      }

      // Commit repair
      await exec(["git", "add", "-A"], { cwd: wtPath });
      const commitMsg = `fix(heal): auto-repair attempt ${attempt}/${MAX_HEAL_ATTEMPTS}\n\n${patches.map((p) => `- ${p.path}: ${p.reason}`).join("\n")}\n\n[GlueCron self-healing loop]`;
      const commit = await exec(["git", "commit", "-m", commitMsg], { cwd: wtPath, env: AUTHOR_ENV });

      if (commit.exitCode !== 0) {
        result.error = `Commit failed: ${commit.stderr}`;
        continue;
      }

      const { stdout: sha } = await exec(["git", "rev-parse", "HEAD"], { cwd: wtPath });
      await exec(["git", "update-ref", `refs/heads/${branch}`, sha.trim()], { cwd: repoDir });

      result.repairs.push({
        attempt,
        failureType: failures[0].type,
        filesChanged: patches.map((p) => p.path),
        commitSha: sha.trim(),
      });

      if (sseChannel) {
        broadcast(sseChannel, "heal:repaired", {
          attempt,
          branch,
          sha: sha.trim(),
          filesChanged: patches.map((p) => p.path),
        });
      }
    } finally {
      // Cleanup worktree
      await exec(["git", "worktree", "remove", "--force", wtPath], { cwd: repoDir }).catch(() => {});
    }
  }

  if (!result.success && result.attempts >= MAX_HEAL_ATTEMPTS) {
    result.finalStatus = "max_attempts";
    if (sseChannel) {
      broadcast(sseChannel, "heal:exhausted", {
        attempts: result.attempts,
        branch,
        repairs: result.repairs.length,
      });
    }
  }

  // Record the heal loop result in gate_runs
  if (opts.repositoryId) {
    try {
      await db.insert(gateRuns).values({
        repositoryId: opts.repositoryId,
        pullRequestId: opts.pullRequestId,
        commitSha: "heal-loop",
        ref: `refs/heads/${branch}`,
        gateName: "Self-heal loop",
        status: result.success ? "passed" : "failed",
        summary: `${result.attempts} attempt${result.attempts === 1 ? "" : "s"}, ${result.repairs.length} repair${result.repairs.length === 1 ? "" : "s"} — ${result.finalStatus}`,
        details: JSON.stringify(result),
        repairAttempted: result.repairs.length > 0,
        repairSucceeded: result.success,
        repairCommitSha: result.repairs[result.repairs.length - 1]?.commitSha,
        completedAt: new Date(),
      });
    } catch (err) {
      console.error("[heal-loop] Failed to record gate run:", err);
    }
  }

  console.log(`[heal-loop] Complete: ${result.finalStatus} after ${result.attempts} attempts, ${result.repairs.length} repairs`);
  return result;
}

/**
 * Quick check: is the heal loop available? (needs AI for repair generation)
 */
export function isHealLoopEnabled(): boolean {
  return !!config.anthropicApiKey;
}

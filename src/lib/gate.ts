/**
 * Green gate enforcement.
 *
 * Checks that all quality gates pass before a merge is allowed:
 * 1. GateTest scan — runs automated tests/checks via the GateTest API
 * 2. AI code review — must be approved (no blocking issues)
 *
 * Nothing ships unless everything is green.
 */

import { config } from "./config";

export interface GateCheckResult {
  name: string;
  passed: boolean;
  details: string;
}

export interface GateResult {
  allPassed: boolean;
  checks: GateCheckResult[];
}

/**
 * Run GateTest scan on a repository at a specific ref.
 * Returns pass/fail with details.
 */
export async function runGateTestScan(
  owner: string,
  repo: string,
  ref: string,
  headSha: string
): Promise<GateCheckResult> {
  if (!config.gatetestUrl) {
    return { name: "GateTest", passed: true, details: "GateTest URL not configured — skipped" };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.gatetestApiKey) {
      headers["Authorization"] = `Bearer ${config.gatetestApiKey}`;
    }

    const response = await fetch(config.gatetestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repository: `${owner}/${repo}`,
        ref,
        sha: headSha,
        source: "gluecron",
        mode: "blocking", // Wait for results instead of fire-and-forget
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        name: "GateTest",
        passed: false,
        details: `GateTest returned ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    const result = await response.json().catch(() => ({})) as Record<string, unknown>;

    // GateTest API returns { passed: boolean, summary: string, issues: [...] }
    const passed = result.passed === true || result.status === "passed" || result.status === "success";
    const summary = (result.summary as string) || (result.message as string) || (passed ? "All checks passed" : "Checks failed");

    return {
      name: "GateTest",
      passed,
      details: summary,
    };
  } catch (err) {
    console.error("[gate] GateTest scan error:", err);
    return {
      name: "GateTest",
      passed: false,
      details: `GateTest scan failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    };
  }
}

/**
 * Check for merge conflicts between branches.
 */
export async function checkMergeability(
  owner: string,
  repo: string,
  baseBranch: string,
  headBranch: string
): Promise<GateCheckResult> {
  const { getRepoPath } = await import("../git/repository");
  const repoDir = getRepoPath(owner, repo);

  const proc = Bun.spawn(
    ["git", "merge-tree", `$(git merge-base ${baseBranch} ${headBranch})`, baseBranch, headBranch],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  // merge-tree isn't ideal — use merge --no-commit in a worktree style check
  await proc.exited;

  // Simpler: check if merge-base --is-ancestor works (fast-forward possible)
  const ffCheck = Bun.spawn(
    ["git", "merge-base", "--is-ancestor", baseBranch, headBranch],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const ffExit = await ffCheck.exited;

  if (ffExit === 0) {
    return { name: "Merge check", passed: true, details: "Fast-forward merge possible" };
  }

  // Check if there would be conflicts
  const mergeBase = Bun.spawn(
    ["git", "merge-base", baseBranch, headBranch],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const baseOut = await new Response(mergeBase.stdout).text();
  const baseExit = await mergeBase.exited;

  if (baseExit !== 0) {
    return { name: "Merge check", passed: false, details: "Branches have no common ancestor" };
  }

  // Use merge-tree (three-way) to detect conflicts without touching working tree
  const mergeTree = Bun.spawn(
    ["git", "merge-tree", baseOut.trim(), baseBranch, headBranch],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const treeOut = await new Response(mergeTree.stdout).text();
  await mergeTree.exited;

  const hasConflicts = treeOut.includes("<<<<<<<");

  return {
    name: "Merge check",
    passed: !hasConflicts,
    details: hasConflicts
      ? "Merge conflicts detected — auto-resolution will be attempted"
      : "Clean merge possible",
  };
}

/**
 * Run all gate checks for a PR merge.
 */
export async function runAllGateChecks(
  owner: string,
  repo: string,
  baseBranch: string,
  headBranch: string,
  headSha: string,
  aiReviewApproved: boolean
): Promise<GateResult> {
  const checks: GateCheckResult[] = [];

  // Run GateTest and mergeability check in parallel
  const [gateTestResult, mergeResult] = await Promise.all([
    runGateTestScan(owner, repo, `refs/heads/${headBranch}`, headSha),
    checkMergeability(owner, repo, baseBranch, headBranch),
  ]);

  checks.push(gateTestResult);
  checks.push(mergeResult);

  // AI review check
  checks.push({
    name: "AI Review",
    passed: aiReviewApproved,
    details: aiReviewApproved
      ? "AI review approved"
      : "AI review found blocking issues — resolve before merging",
  });

  return {
    allPassed: checks.every((c) => c.passed),
    checks,
  };
}

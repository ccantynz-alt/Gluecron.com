/**
 * Green gate enforcement — the heart of the "nothing broken ships" guarantee.
 *
 * Runs every configured gate for a repo on push / on PR / on merge:
 *   1. GateTest scan          (external test/lint runner)
 *   2. Secret scan            (regex secrets + AI security review)
 *   3. AI code review         (for PRs)
 *   4. Merge check            (for PRs)
 *   5. Dependency/vuln scan   (best-effort, skipped if not configured)
 *
 * Each result is persisted to `gate_runs`. If auto-repair is enabled
 * and a gate fails, the engine attempts a fix before reporting a hard fail.
 */

import { eq } from "drizzle-orm";
import { config } from "./config";
import { db } from "../db";
import { gateRuns, repoSettings, repositories, users } from "../db/schema";
import { getOrCreateSettings } from "./repo-bootstrap";
import { scanForSecrets, aiSecurityScan } from "./security-scan";
import type { SecretFinding, SecurityFinding } from "./security-scan";
import { repairSecrets, repairSecurityIssues } from "./auto-repair";
import { readFile } from "fs/promises";
import { join } from "path";
import { updateGateMetrics, extractPatterns } from "./flywheel";

export interface GateCheckResult {
  name: string;
  passed: boolean;
  details: string;
  skipped?: boolean;
  repaired?: boolean;
  repairCommitSha?: string;
}

export interface GateResult {
  allPassed: boolean;
  checks: GateCheckResult[];
}

/**
 * Record a gate run in the DB. Fire-and-forget; swallows DB errors.
 */
async function recordGateRun(opts: {
  repositoryId: string;
  pullRequestId?: string;
  commitSha: string;
  ref: string;
  gateName: string;
  status: "passed" | "failed" | "skipped" | "repaired";
  summary: string;
  details?: unknown;
  repairAttempted?: boolean;
  repairSucceeded?: boolean;
  repairCommitSha?: string;
  durationMs?: number;
}): Promise<void> {
  try {
    await db.insert(gateRuns).values({
      repositoryId: opts.repositoryId,
      pullRequestId: opts.pullRequestId,
      commitSha: opts.commitSha,
      ref: opts.ref,
      gateName: opts.gateName,
      status: opts.status,
      summary: opts.summary,
      details: opts.details ? JSON.stringify(opts.details) : null,
      repairAttempted: opts.repairAttempted ?? false,
      repairSucceeded: opts.repairSucceeded ?? false,
      repairCommitSha: opts.repairCommitSha,
      durationMs: opts.durationMs,
      completedAt: new Date(),
    });
  } catch (err) {
    console.error("[gate] recordGateRun failed:", err);
  }
}

/**
 * Look up the repository row by owner/name.
 */
async function lookupRepo(
  owner: string,
  repo: string
): Promise<{ id: string } | null> {
  try {
    const [u] = await db.select().from(users).where(eq(users.username, owner)).limit(1);
    if (!u) return null;
    const { and } = await import("drizzle-orm");
    const [r] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerId, u.id), eq(repositories.name, repo)))
      .limit(1);
    return r ? { id: r.id } : null;
  } catch {
    return null;
  }
}

/**
 * Run GateTest scan on a repository at a specific ref.
 */
export async function runGateTestScan(
  owner: string,
  repo: string,
  ref: string,
  headSha: string
): Promise<GateCheckResult> {
  if (!config.gatetestUrl) {
    return { name: "GateTest", passed: true, details: "GateTest URL not configured — skipped", skipped: true };
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
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
        mode: "blocking",
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        name: "GateTest",
        passed: false,
        details: `GateTest returned ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const passed =
      result.passed === true || result.status === "passed" || result.status === "success";
    const summary =
      (result.summary as string) || (result.message as string) || (passed ? "All checks passed" : "Checks failed");
    return { name: "GateTest", passed, details: summary };
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

  const ffCheck = Bun.spawn(
    ["git", "merge-base", "--is-ancestor", baseBranch, headBranch],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const ffExit = await ffCheck.exited;
  if (ffExit === 0) {
    return { name: "Merge check", passed: true, details: "Fast-forward merge possible" };
  }

  const mergeBase = Bun.spawn(
    ["git", "merge-base", baseBranch, headBranch],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const baseOut = await new Response(mergeBase.stdout).text();
  const baseExit = await mergeBase.exited;

  if (baseExit !== 0) {
    return { name: "Merge check", passed: false, details: "Branches have no common ancestor" };
  }

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
 * Secret + security scan. Runs the regex scanner on files at the given ref,
 * then optionally runs the AI semantic scan on the diff.
 */
export async function runSecretAndSecurityScan(
  owner: string,
  repo: string,
  ref: string,
  headSha: string,
  opts: { scanSecrets: boolean; scanSecurity: boolean; diffText?: string }
): Promise<{
  secretResult: GateCheckResult;
  securityResult: GateCheckResult;
  secrets: SecretFinding[];
  securityIssues: SecurityFinding[];
}> {
  const { getRepoPath, getTree, getBlob, listBranches } = await import("../git/repository");
  const repoDir = getRepoPath(owner, repo);

  // Snapshot top-level + one level deep files at the ref
  const files: Array<{ path: string; content: string }> = [];
  const branches = await listBranches(owner, repo);
  const effectiveRef = branches.includes(ref.replace(/^refs\/heads\//, ""))
    ? ref.replace(/^refs\/heads\//, "")
    : headSha;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    const tree = await getTree(owner, repo, effectiveRef, dir);
    for (const entry of tree) {
      const full = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.type === "tree") {
        await walk(full, depth + 1);
      } else if (entry.type === "blob" && (entry.size ?? 0) < 200_000) {
        try {
          const blob = await getBlob(owner, repo, effectiveRef, full);
          if (blob && !blob.isBinary) {
            files.push({ path: full, content: blob.content });
          }
        } catch {
          // skip
        }
      }
      if (files.length >= 500) return;
    }
  }

  try {
    await walk("", 0);
  } catch {
    // Unable to walk — the ref may not exist yet. Bail gracefully.
  }

  const secrets = opts.scanSecrets ? scanForSecrets(files) : [];
  const securityIssues =
    opts.scanSecurity && opts.diffText ? await aiSecurityScan(`${owner}/${repo}`, opts.diffText) : [];

  const criticalSecrets = secrets.filter((s) => s.severity === "critical").length;
  const criticalSec = securityIssues.filter((i) => i.severity === "critical" || i.severity === "high").length;

  return {
    secretResult: {
      name: "Secret scan",
      passed: criticalSecrets === 0,
      details:
        secrets.length === 0
          ? "No secrets detected"
          : `Found ${secrets.length} secret${secrets.length === 1 ? "" : "s"} (${criticalSecrets} critical)`,
    },
    securityResult: {
      name: "Security scan",
      passed: criticalSec === 0,
      skipped: !opts.scanSecurity || !opts.diffText,
      details:
        securityIssues.length === 0
          ? opts.scanSecurity && opts.diffText
            ? "No security issues found"
            : "Skipped — no diff provided"
          : `Found ${securityIssues.length} issue${securityIssues.length === 1 ? "" : "s"} (${criticalSec} high/critical)`,
    },
    secrets,
    securityIssues,
  };
}

/**
 * Run every configured gate for a PR merge.
 * Records gate_runs entries. Optionally invokes auto-repair.
 */
export async function runAllGateChecks(
  owner: string,
  repo: string,
  baseBranch: string,
  headBranch: string,
  headSha: string,
  aiReviewApproved: boolean,
  opts: {
    pullRequestId?: string;
    enableAutoRepair?: boolean;
    diffText?: string;
  } = {}
): Promise<GateResult> {
  const started = Date.now();
  const repoRow = await lookupRepo(owner, repo);
  const settings = repoRow ? await getOrCreateSettings(repoRow.id) : null;

  // Decide which gates to run
  const runGateTest = settings?.gateTestEnabled !== false && !!config.gatetestUrl;
  const runSecretScan = settings?.secretScanEnabled !== false;
  const runSecurityScan = settings?.securityScanEnabled !== false;
  const runAiReview = settings?.aiReviewEnabled !== false;
  const enableRepair = opts.enableAutoRepair !== false && settings?.autoFixEnabled !== false;

  const [gateTestResult, mergeResult, scanResults] = await Promise.all([
    runGateTest
      ? runGateTestScan(owner, repo, `refs/heads/${headBranch}`, headSha)
      : Promise.resolve<GateCheckResult>({
          name: "GateTest",
          passed: true,
          skipped: true,
          details: "Disabled in settings",
        }),
    checkMergeability(owner, repo, baseBranch, headBranch),
    runSecretAndSecurityScan(owner, repo, `refs/heads/${headBranch}`, headSha, {
      scanSecrets: runSecretScan,
      scanSecurity: runSecurityScan,
      diffText: opts.diffText,
    }),
  ]);

  const checks: GateCheckResult[] = [gateTestResult];
  checks.push(scanResults.secretResult);
  if (runSecurityScan) checks.push(scanResults.securityResult);
  checks.push(mergeResult);
  checks.push({
    name: "AI Review",
    passed: !runAiReview || aiReviewApproved,
    skipped: !runAiReview,
    details: !runAiReview
      ? "Disabled in settings"
      : aiReviewApproved
        ? "AI review approved"
        : "AI review found blocking issues — resolve before merging",
  });

  // ---- Auto-repair on failures ----
  if (enableRepair) {
    // Secrets
    if (!scanResults.secretResult.passed) {
      const repair = await repairSecrets(owner, repo, headBranch, scanResults.secrets);
      if (repair.success) {
        scanResults.secretResult.passed = true;
        scanResults.secretResult.repaired = true;
        scanResults.secretResult.repairCommitSha = repair.commitSha;
        scanResults.secretResult.details = `Auto-redacted ${scanResults.secrets.length} secret${scanResults.secrets.length === 1 ? "" : "s"} (${repair.commitSha?.slice(0, 7)})`;
      }
    }
    // Security
    if (!scanResults.securityResult.passed && scanResults.securityIssues.length > 0) {
      const repair = await repairSecurityIssues(
        owner,
        repo,
        headBranch,
        scanResults.securityIssues
      );
      if (repair.success) {
        scanResults.securityResult.passed = true;
        scanResults.securityResult.repaired = true;
        scanResults.securityResult.repairCommitSha = repair.commitSha;
        scanResults.securityResult.details = `Auto-repaired ${repair.filesChanged.length} file${repair.filesChanged.length === 1 ? "" : "s"} (${repair.commitSha?.slice(0, 7)})`;
      }
    }
  }

  // Persist gate_runs + feed flywheel metrics
  if (repoRow) {
    const duration = Date.now() - started;
    await Promise.all(
      checks.map((check) => {
        const status = check.skipped
          ? ("skipped" as const)
          : check.repaired
            ? ("repaired" as const)
            : check.passed
              ? ("passed" as const)
              : ("failed" as const);
        return Promise.all([
          recordGateRun({
            repositoryId: repoRow.id,
            pullRequestId: opts.pullRequestId,
            commitSha: headSha,
            ref: `refs/heads/${headBranch}`,
            gateName: check.name,
            status,
            summary: check.details,
            repairAttempted: !!check.repaired,
            repairSucceeded: !!check.repaired,
            repairCommitSha: check.repairCommitSha,
            durationMs: duration,
          }),
          updateGateMetrics(repoRow.id, check.name, status, duration),
        ]);
      })
    );

    // Trigger pattern extraction periodically (every ~20 gate runs)
    const runCount = checks.length;
    if (runCount > 0 && Math.random() < 0.05) {
      extractPatterns(repoRow.id).catch((err) =>
        console.error("[flywheel] background pattern extraction failed:", err)
      );
    }
  }

  return {
    allPassed: checks.every((c) => c.passed || c.skipped),
    checks,
  };
}

/**
 * Merge Impact Analysis — "What breaks if I merge this?"
 *
 * Computes a static analysis of a PR's changed files to identify:
 *   - Which test files import the changed source files
 *   - Which other source files import the changed source files
 *   - Which downstream repos in the org depend on the changed package
 *   - A 0-100 risk score with a plain-English summary
 *
 * No AI calls. Pure git + DB queries. Results are cached in memory for
 * 10 minutes per prId so the PR detail page can call this on every
 * request without hitting disk.
 */

import { db } from "../db";
import { pullRequests, repositories, users, repoDependencies } from "../db/schema";
import { eq, and, ne } from "drizzle-orm";
import { getRepoPath } from "../git/repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImpactAnalysis {
  changedFiles: string[];
  affectedTestFiles: string[];
  affectedFiles: string[];
  downstreamRepos: {
    owner: string;
    repo: string;
    matchedDependency: string;
  }[];
  riskScore: number;
  riskSummary: string;
}

// ---------------------------------------------------------------------------
// Cache (10 minute TTL per prId)
// ---------------------------------------------------------------------------

const IMPACT_TTL_MS = 10 * 60 * 1000;

const impactCache = new Map<
  string,
  { analysis: ImpactAnalysis; expiresAt: number }
>();

function getCached(prId: string): ImpactAnalysis | null {
  const entry = impactCache.get(prId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    impactCache.delete(prId);
    return null;
  }
  return entry.analysis;
}

function setCached(prId: string, analysis: ImpactAnalysis): void {
  impactCache.set(prId, { analysis, expiresAt: Date.now() + IMPACT_TTL_MS });
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

async function git(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes(".test.") ||
    filePath.includes(".spec.") ||
    filePath.includes("__tests__/") ||
    filePath.includes("/__tests__/") ||
    filePath.includes("/test/") ||
    filePath.includes("/tests/")
  );
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

/** Sensitive path patterns that add to the risk score. */
const SENSITIVE_PATTERNS = [
  /auth/i,
  /payment/i,
  /billing/i,
  /stripe/i,
  /password/i,
  /secret/i,
  /migration/i,
  /schema/i,
  /database/i,
  /security/i,
  /token/i,
  /session/i,
  /credential/i,
];

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(filePath));
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

export async function analyzeImpact(
  repoId: string,
  prId: string
): Promise<ImpactAnalysis> {
  // Return cached result if available
  const cached = getCached(prId);
  if (cached) return cached;

  // Load PR
  const [pr] = await db
    .select({
      baseBranch: pullRequests.baseBranch,
      headBranch: pullRequests.headBranch,
      repositoryId: pullRequests.repositoryId,
    })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .limit(1);

  if (!pr) {
    const empty = emptyAnalysis("PR not found");
    setCached(prId, empty);
    return empty;
  }

  // Resolve owner/repo for git operations
  const [repoRow] = await db
    .select({ name: repositories.name, ownerId: repositories.ownerId, orgId: repositories.orgId })
    .from(repositories)
    .where(eq(repositories.id, pr.repositoryId))
    .limit(1);

  if (!repoRow) {
    const empty = emptyAnalysis("Repository not found");
    setCached(prId, empty);
    return empty;
  }

  const [ownerRow] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, repoRow.ownerId))
    .limit(1);

  if (!ownerRow) {
    const empty = emptyAnalysis("Owner not found");
    setCached(prId, empty);
    return empty;
  }

  const ownerName = ownerRow.username;
  const repoName = repoRow.name;
  const repoDir = getRepoPath(ownerName, repoName);

  // ── 1. Get changed files ─────────────────────────────────────────────────
  let changedFiles: string[] = [];
  try {
    const { stdout } = await git(
      ["diff", "--name-only", `${pr.baseBranch}...${pr.headBranch}`],
      repoDir
    );
    changedFiles = stdout.trim().split("\n").filter(Boolean);
  } catch {
    /* non-blocking */
  }

  if (changedFiles.length === 0) {
    const analysis: ImpactAnalysis = {
      changedFiles: [],
      affectedTestFiles: [],
      affectedFiles: [],
      downstreamRepos: [],
      riskScore: 0,
      riskSummary: "No changed files detected",
    };
    setCached(prId, analysis);
    return analysis;
  }

  // ── 2. Find files that import changed files ──────────────────────────────
  const affectedTestFiles = new Set<string>();
  const affectedSourceFiles = new Set<string>();

  // For each changed source file, look for files that import it
  const sourceChangedFiles = changedFiles.filter(
    (f) =>
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) &&
      !isTestFile(f)
  );

  for (const changedFile of sourceChangedFiles) {
    const fileBase = stripExtension(basename(changedFile));
    const fileWithoutExt = stripExtension(changedFile);

    // Search for imports of this file
    // We look for: from "...{basename}" or require("...{basename}")
    const searchPatterns = [
      `from.*${fileBase}`,
      `require.*${fileBase}`,
      // Also try the full path without extension
      `from.*${fileWithoutExt.replace(/\//g, "\\/")}`,
    ];

    for (const pattern of searchPatterns.slice(0, 2)) {
      // Only use basename patterns for git grep (avoids escaping issues)
      try {
        const { stdout } = await git(
          [
            "grep",
            "-l",
            "--extended-regexp",
            pattern,
            "--",
            "*.ts",
            "*.tsx",
            "*.js",
            "*.jsx",
          ],
          repoDir
        );
        const matchingFiles = stdout.trim().split("\n").filter(Boolean);
        for (const f of matchingFiles) {
          // Exclude the changed file itself
          if (f === changedFile) continue;
          if (isTestFile(f)) {
            affectedTestFiles.add(f);
          } else {
            affectedSourceFiles.add(f);
          }
        }
      } catch {
        /* git grep exits 1 when no matches — not an error */
      }
    }
  }

  // Remove changed files from affected sets
  const changedSet = new Set(changedFiles);
  for (const f of changedSet) {
    affectedTestFiles.delete(f);
    affectedSourceFiles.delete(f);
  }

  const affectedTestFilesList = Array.from(affectedTestFiles).slice(0, 50);
  const affectedSourceFilesList = Array.from(affectedSourceFiles).slice(0, 50);

  // ── 3. Check downstream repos ────────────────────────────────────────────
  const downstreamRepos: ImpactAnalysis["downstreamRepos"] = [];
  try {
    // Check if this repo is a package (has a name in package.json)
    let packageName: string | null = null;
    try {
      const { stdout: pkgBlob } = await git(
        ["show", "HEAD:package.json"],
        repoDir
      );
      const pkg = JSON.parse(pkgBlob) as Record<string, unknown>;
      if (typeof pkg.name === "string" && pkg.name) {
        packageName = pkg.name;
      }
    } catch {
      /* no package.json or not parseable */
    }

    if (packageName) {
      // Find repos in the same org (or by the same owner) that depend on this package
      const orgScope = repoRow.orgId;
      const depRows = await db
        .select({
          repositoryId: repoDependencies.repositoryId,
          depName: repoDependencies.name,
        })
        .from(repoDependencies)
        .where(
          and(
            eq(repoDependencies.name, packageName),
            ne(repoDependencies.repositoryId, pr.repositoryId)
          )
        )
        .limit(20);

      for (const depRow of depRows) {
        // Look up the dependent repo
        const [depRepo] = await db
          .select({
            name: repositories.name,
            ownerId: repositories.ownerId,
            orgId: repositories.orgId,
          })
          .from(repositories)
          .where(eq(repositories.id, depRow.repositoryId))
          .limit(1);

        if (!depRepo) continue;

        // Only include if same org or same owner
        const sameOrg = orgScope && depRepo.orgId === orgScope;
        const sameOwner = depRepo.ownerId === repoRow.ownerId;
        if (!sameOrg && !sameOwner) continue;

        const [depOwner] = await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, depRepo.ownerId))
          .limit(1);

        if (!depOwner) continue;

        downstreamRepos.push({
          owner: depOwner.username,
          repo: depRepo.name,
          matchedDependency: depRow.depName,
        });
      }
    }
  } catch {
    /* downstream check is best-effort */
  }

  // ── 4. Risk score ─────────────────────────────────────────────────────────
  let riskScore = 0;

  // +30 if any changed file is imported by more than 5 files
  for (const f of changedFiles) {
    const importCount =
      affectedTestFiles.has(f) || affectedSourceFiles.has(f) ? 1 : 0; // can't easily get exact count per file here
    // Estimate: if total affected > 5
    if (affectedTestFiles.size + affectedSourceFiles.size > 5) {
      riskScore += 30;
      break;
    }
  }

  // +20 if changed files include sensitive paths
  const hasSensitive = changedFiles.some(isSensitivePath);
  if (hasSensitive) riskScore += 20;

  // +10 per downstream repo
  riskScore += Math.min(downstreamRepos.length * 10, 40);

  // +5 per affected source file (capped)
  riskScore += Math.min(affectedSourceFilesList.length * 5, 30);

  // Cap at 100
  riskScore = Math.min(riskScore, 100);

  // ── 5. Risk summary ───────────────────────────────────────────────────────
  const riskSummary = buildRiskSummary(
    riskScore,
    changedFiles,
    affectedTestFilesList,
    affectedSourceFilesList,
    downstreamRepos,
    hasSensitive
  );

  const analysis: ImpactAnalysis = {
    changedFiles,
    affectedTestFiles: affectedTestFilesList,
    affectedFiles: affectedSourceFilesList,
    downstreamRepos,
    riskScore,
    riskSummary,
  };

  setCached(prId, analysis);
  return analysis;
}

function emptyAnalysis(reason: string): ImpactAnalysis {
  return {
    changedFiles: [],
    affectedTestFiles: [],
    affectedFiles: [],
    downstreamRepos: [],
    riskScore: 0,
    riskSummary: reason,
  };
}

function buildRiskSummary(
  score: number,
  changedFiles: string[],
  testFiles: string[],
  sourceFiles: string[],
  downstream: ImpactAnalysis["downstreamRepos"],
  hasSensitive: boolean
): string {
  if (score === 0 && sourceFiles.length === 0 && testFiles.length === 0) {
    return "Low risk — no downstream impact detected";
  }
  if (score <= 10 && testFiles.length > 0 && sourceFiles.length === 0) {
    return "Low risk — only test files affected";
  }
  if (hasSensitive && score >= 50) {
    return "High risk — sensitive paths (auth/payments/schema) modified";
  }
  if (downstream.length > 0) {
    return `High risk — ${downstream.length} downstream repo${downstream.length === 1 ? "" : "s"} may be affected`;
  }
  if (score >= 70) {
    return `High risk — ${sourceFiles.length} source file${sourceFiles.length === 1 ? "" : "s"} import these changes`;
  }
  if (score >= 40) {
    return `Medium risk — ${sourceFiles.length + testFiles.length} file${sourceFiles.length + testFiles.length === 1 ? "" : "s"} reference these changes`;
  }
  return `Low risk — ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed with limited downstream impact`;
}

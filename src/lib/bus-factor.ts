/**
 * Bus Factor Analysis — detect files that only one person understands.
 *
 * Uses git log parsing to build a commit-author map per file, then flags
 * files where one author has >75% of commits and total commits >= 3.
 *
 * Risk levels:
 *   critical — >90% single author, >=5 commits, modified in last 30 days
 *   high     — >80% single author, >=4 commits
 *   medium   — >75% single author, >=3 commits
 *
 * Results are cached in the `bus_factor_cache` table (7-day TTL).
 * No AI calls — pure git log parsing.
 */

import { join } from "path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { busFactorCache } from "../db/schema";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BusFactorFile {
  path: string;
  primaryAuthor: string;        // username / display name of dominant author
  primaryAuthorPct: number;     // e.g. 87 (integer percent)
  totalCommits: number;
  lastModified: string;         // ISO date string
  risk: "critical" | "high" | "medium";
}

export interface BusFactorReport {
  repoId: string;
  analyzedAt: string;
  atRiskFiles: BusFactorFile[];  // files with bus factor = 1
  totalFilesAnalyzed: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".swift", ".kt", ".scala",
  ".vue", ".svelte",
  ".sh", ".bash", ".zsh",
  ".sql",
]);

const SKIP_DIRS = ["node_modules", "dist", ".next", "build", "vendor", ".git", "coverage"];

function isCodeFile(filePath: string): boolean {
  // Skip generated / dependency directories
  const parts = filePath.split("/");
  if (parts.some((p) => SKIP_DIRS.includes(p))) return false;

  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return false;
  const ext = filePath.slice(dotIdx).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function getRepoDir(owner: string, repo: string): string {
  return join(config.gitReposPath, `${owner}/${repo}.git`);
}

async function spawnGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "--git-dir", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Parse `git log --name-only --format="%ae %an"` output into a map:
 *   Map<filePath, Map<authorIdentifier, commitCount>>
 *
 * Also returns a map of file → last modified date.
 */
function parseGitLog(raw: string): {
  fileAuthorMap: Map<string, Map<string, number>>;
  fileLastModified: Map<string, string>;
} {
  const fileAuthorMap = new Map<string, Map<string, number>>();
  const fileLastModified = new Map<string, string>();

  const lines = raw.split("\n");
  let currentAuthor: string | null = null;
  let currentDate: string | null = null;
  let inFileList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // blank line separator between commits
      inFileList = false;
      currentDate = null;
      continue;
    }

    // Header line — format: "<email> <name> <date>"
    // We use "%ae %an %ad" with --date=short
    const headerMatch = trimmed.match(/^(\S+)\s+(.+?)\s+(\d{4}-\d{2}-\d{2})$/);
    if (headerMatch) {
      currentAuthor = headerMatch[2].trim(); // prefer display name
      currentDate = headerMatch[3];
      inFileList = true;
      continue;
    }

    if (inFileList && currentAuthor) {
      // This line is a file path
      const filePath = trimmed;
      if (!filePath || filePath.startsWith("diff") || filePath.startsWith("---")) continue;

      if (!fileAuthorMap.has(filePath)) {
        fileAuthorMap.set(filePath, new Map());
      }
      const authorMap = fileAuthorMap.get(filePath)!;
      authorMap.set(currentAuthor, (authorMap.get(currentAuthor) ?? 0) + 1);

      // Track most recent modification (git log is newest-first)
      if (!fileLastModified.has(filePath) && currentDate) {
        fileLastModified.set(filePath, currentDate);
      }
    }
  }

  return { fileAuthorMap, fileLastModified };
}

function computeRisk(
  primaryPct: number,
  totalCommits: number,
  lastModified: string
): "critical" | "high" | "medium" | null {
  if (primaryPct <= 75 || totalCommits < 3) return null;

  const daysSinceModified =
    (Date.now() - new Date(lastModified).getTime()) / (1000 * 60 * 60 * 24);

  if (primaryPct > 90 && totalCommits >= 5 && daysSinceModified <= 30) {
    return "critical";
  }
  if (primaryPct > 80 && totalCommits >= 4) {
    return "high";
  }
  return "medium";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function analyzeBusFactor(
  repoId: string,
  owner: string,
  repo: string
): Promise<BusFactorReport> {
  const repoDir = getRepoDir(owner, repo);
  const analyzedAt = new Date().toISOString();

  // Fetch git log with file names in one pass — format: "email name date\nfile1\nfile2\n\n"
  const raw = await spawnGit(
    [
      "log",
      "--name-only",
      "--format=%ae %an %ad",
      "--date=short",
      "--diff-filter=ACMR",
      "-n",
      "5000",
    ],
    repoDir
  );

  const { fileAuthorMap, fileLastModified } = parseGitLog(raw);

  const atRiskFiles: BusFactorFile[] = [];
  let totalFilesAnalyzed = 0;

  for (const [filePath, authorMap] of fileAuthorMap) {
    if (!isCodeFile(filePath)) continue;
    totalFilesAnalyzed++;

    const totalCommits = Array.from(authorMap.values()).reduce((a, b) => a + b, 0);
    if (totalCommits < 3) continue;

    // Find dominant author
    let primaryAuthor = "";
    let primaryCount = 0;
    for (const [author, count] of authorMap) {
      if (count > primaryCount) {
        primaryCount = count;
        primaryAuthor = author;
      }
    }

    const primaryAuthorPct = Math.round((primaryCount / totalCommits) * 100);
    const lastModified = fileLastModified.get(filePath) ?? new Date().toISOString().slice(0, 10);
    const risk = computeRisk(primaryAuthorPct, totalCommits, lastModified);

    if (risk) {
      atRiskFiles.push({
        path: filePath,
        primaryAuthor,
        primaryAuthorPct,
        totalCommits,
        lastModified,
        risk,
      });
    }

    if (atRiskFiles.length >= 50) break;
  }

  // Sort: critical first, then high, then medium
  const riskOrder = { critical: 0, high: 1, medium: 2 };
  atRiskFiles.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk]);

  const report: BusFactorReport = {
    repoId,
    analyzedAt,
    atRiskFiles,
    totalFilesAnalyzed,
  };

  // Upsert into cache
  try {
    await db
      .insert(busFactorCache)
      .values({
        repositoryId: repoId,
        analyzedAt: new Date(analyzedAt),
        atRiskFiles: atRiskFiles as unknown as object,
        totalFilesAnalyzed,
      })
      .onConflictDoUpdate({
        target: busFactorCache.repositoryId,
        set: {
          analyzedAt: new Date(analyzedAt),
          atRiskFiles: atRiskFiles as unknown as object,
          totalFilesAnalyzed,
        },
      });
  } catch {
    // Cache write failure is non-blocking
  }

  return report;
}

/**
 * Return cached at-risk files that overlap with `changedFiles`.
 * If the cache is older than 7 days, trigger a background re-analysis.
 */
export async function getBusFactorWarning(
  repoId: string,
  owner: string,
  repo: string,
  changedFiles: string[]
): Promise<BusFactorFile[]> {
  if (changedFiles.length === 0) return [];

  try {
    const rows = await db
      .select()
      .from(busFactorCache)
      .where(eq(busFactorCache.repositoryId, repoId))
      .limit(1);

    if (rows.length === 0) {
      // No cache yet — trigger background analysis and return empty
      analyzeBusFactor(repoId, owner, repo).catch(() => {});
      return [];
    }

    const cached = rows[0];
    const ageMs = Date.now() - cached.analyzedAt.getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    if (ageMs > sevenDaysMs) {
      // Stale — refresh in background
      analyzeBusFactor(repoId, owner, repo).catch(() => {});
    }

    const atRiskFiles = cached.atRiskFiles as BusFactorFile[];
    const changedSet = new Set(changedFiles);
    return atRiskFiles.filter((f) => changedSet.has(f.path));
  } catch {
    return [];
  }
}

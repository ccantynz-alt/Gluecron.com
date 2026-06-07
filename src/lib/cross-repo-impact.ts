/**
 * Cross-Repo Dependency Impact Detection
 *
 * When a PR changes a package's public API (renamed exports, changed type
 * signatures, bumped version), downstream repos that depend on THIS repo
 * get silently broken. This module surfaces those risks before merge.
 *
 * Steps:
 *   1. Get PR diff (changed files via git diff base...head --name-only)
 *   2. Find changed exported symbols (regex on +export / -export lines)
 *   3. Look up repo_dependencies for repos that depend on this package
 *   4. For each downstream repo, grep for usage of the changed symbols
 *   5. Score risk: high/medium/low based on symbol usage + test coverage
 *   6. Cache results in memory for 15 minutes (keyed by prId)
 *   7. Use Claude to generate one-sentence migration notes per changed export
 *   8. Cap at 20 downstream repos
 */

import { db } from "../db";
import {
  pullRequests,
  repositories,
  users,
  repoDependencies,
  crossRepoImpactCache,
} from "../db/schema";
import { eq, and, ne } from "drizzle-orm";
import { getRepoPath } from "../git/repository";
import { isAiAvailable, getAnthropic, MODEL_SONNET, extractText } from "./ai-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DownstreamImpact {
  repoId: string;
  repoName: string;
  ownerName: string;
  dependencyName: string;   // e.g. "@myorg/auth-lib"
  currentVersion: string;
  riskLevel: "high" | "medium" | "low";
  changedExports: string[]; // function/type names that changed in the PR diff
  suggestedFixPrUrl?: string; // if we opened a fix PR
}

export interface CrossRepoReport {
  prId: string;
  affectedRepos: DownstreamImpact[];
  totalRisk: number;   // 0-100
  analyzedAt: Date;
  cachedUntil: Date;
}

// ---------------------------------------------------------------------------
// In-memory cache (15 min TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  report: CrossRepoReport;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

function getCached(prId: string): CrossRepoReport | null {
  const entry = memoryCache.get(prId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(prId);
    return null;
  }
  return entry.report;
}

function setMemoryCache(prId: string, report: CrossRepoReport): void {
  memoryCache.set(prId, { report, expiresAt: Date.now() + CACHE_TTL_MS });
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
// Symbol extraction helpers
// ---------------------------------------------------------------------------

/**
 * Parse lines from a diff for changed export declarations.
 * Looks for lines beginning with + or - that contain an export keyword.
 * Returns deduplicated symbol names extracted from those lines.
 */
function extractChangedExports(diffText: string): string[] {
  const exportLineRe = /^[+-]export\s+(?:default\s+)?(?:async\s+)?(?:function|class|type|interface|const|let|var|enum|abstract\s+class)\s+(\w+)/m;
  const lines = diffText.split("\n");
  const changed = new Set<string>();

  for (const line of lines) {
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    // Skip diff header lines like +++ or ---
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    const trimmed = line.slice(1).trim();
    // Match: export [default] [async] function/class/type/interface/const/let/var/enum Name
    const m = trimmed.match(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|type|interface|const|let|var|enum|abstract\s+class)\s+(\w+)/
    );
    if (m && m[1]) {
      changed.add(m[1]);
    }
    // Also catch: export { Name, Name2 }
    const namedExport = trimmed.match(/^export\s+\{([^}]+)\}/);
    if (namedExport && namedExport[1]) {
      for (const name of namedExport[1].split(",")) {
        const clean = name.trim().replace(/\s+as\s+\w+/, "").trim();
        if (clean && /^\w+$/.test(clean)) changed.add(clean);
      }
    }
  }

  return Array.from(changed);
}

// ---------------------------------------------------------------------------
// Determine if a downstream repo imports any of the changed symbols
// ---------------------------------------------------------------------------

async function repoUsesSymbols(
  repoDir: string,
  symbols: string[]
): Promise<string[]> {
  if (symbols.length === 0) return [];

  const used: string[] = [];
  for (const sym of symbols) {
    try {
      // git grep -l <sym> -- *.ts *.tsx *.js *.jsx
      const { stdout, exitCode } = await git(
        ["grep", "-l", "--extended-regexp", `\\b${sym}\\b`, "--", "*.ts", "*.tsx", "*.js", "*.jsx"],
        repoDir
      );
      // exit 1 = no matches (not an error)
      if (exitCode === 0 && stdout.trim()) {
        used.push(sym);
      }
    } catch {
      // git grep may fail if git not available or repo empty
    }
  }
  return used;
}

/**
 * Check if a repo has any test files (rough proxy for test coverage).
 */
async function repoHasTests(repoDir: string): Promise<boolean> {
  try {
    const { stdout } = await git(
      ["ls-files", "--", "*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx", "*.test.js", "*.spec.js"],
      repoDir
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AI migration note generation
// ---------------------------------------------------------------------------

async function generateMigrationNotes(
  changedExports: string[],
  packageName: string,
  diffExcerpt: string
): Promise<Record<string, string>> {
  if (!isAiAvailable() || changedExports.length === 0) return {};

  try {
    const client = getAnthropic();
    const prompt = `You are a migration assistant. The package "${packageName}" changed the following exports in a PR:
${changedExports.map((e) => `- ${e}`).join("\n")}

Here is a brief diff excerpt:
\`\`\`
${diffExcerpt.slice(0, 2000)}
\`\`\`

For each changed export, write exactly ONE sentence describing what callers need to update. Be concrete and brief.
Respond with a JSON object mapping export name to migration note string. Example:
{"myFunction": "Rename the first parameter from 'id' to 'userId'.", "MyType": "Add the required 'createdAt: Date' field."}`;

    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractText(message);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as Record<string, string>;
      } catch {
        return {};
      }
    }
  } catch {
    // AI unavailable — degrade gracefully
  }
  return {};
}

// ---------------------------------------------------------------------------
// DB cache helpers
// ---------------------------------------------------------------------------

async function loadDbCache(prId: string): Promise<CrossRepoReport | null> {
  try {
    const rows = await db
      .select()
      .from(crossRepoImpactCache)
      .where(eq(crossRepoImpactCache.prId, prId))
      .limit(1);

    if (!rows.length) return null;

    const row = rows[0];
    if (row.cachedUntil < new Date()) {
      // Expired — delete stale row
      await db.delete(crossRepoImpactCache).where(eq(crossRepoImpactCache.prId, prId)).catch(() => {});
      return null;
    }

    return row.report as CrossRepoReport;
  } catch {
    return null;
  }
}

async function saveDbCache(report: CrossRepoReport): Promise<void> {
  try {
    // Upsert: delete then insert
    await db.delete(crossRepoImpactCache).where(eq(crossRepoImpactCache.prId, report.prId)).catch(() => {});
    await db.insert(crossRepoImpactCache).values({
      prId: report.prId,
      report: report as unknown as Record<string, unknown>,
      analyzedAt: report.analyzedAt,
      cachedUntil: report.cachedUntil,
    });
  } catch {
    // Best-effort — memory cache still works
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function analyzeCrossRepoImpact(
  repoId: string,
  prId: string,
  ownerName: string,
  repoName: string
): Promise<CrossRepoReport> {
  // 1. Check memory cache
  const memHit = getCached(prId);
  if (memHit) return memHit;

  // 2. Check DB cache
  const dbHit = await loadDbCache(prId);
  if (dbHit) {
    setMemoryCache(prId, dbHit);
    return dbHit;
  }

  // 3. Load PR info
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
    return emptyReport(prId, "PR not found");
  }

  const repoDir = getRepoPath(ownerName, repoName);

  // 4. Get changed file names
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

  // 5. Get full diff text for export extraction + AI notes
  let diffText = "";
  try {
    const { stdout } = await git(
      ["diff", `${pr.baseBranch}...${pr.headBranch}`, "--unified=2"],
      repoDir
    );
    // Cap at 100KB to avoid huge diffs
    diffText = stdout.slice(0, 100_000);
  } catch {
    /* non-blocking */
  }

  // 6. Extract changed exports from diff
  const changedExports = extractChangedExports(diffText);

  // 7. Get this repo's package name from package.json on default branch
  let packageName: string | null = null;
  try {
    const { stdout: pkgBlob } = await git(["show", "HEAD:package.json"], repoDir);
    const pkg = JSON.parse(pkgBlob) as Record<string, unknown>;
    if (typeof pkg.name === "string" && pkg.name) {
      packageName = pkg.name;
    }
  } catch {
    /* no package.json or not parseable */
  }

  // 8. Find downstream repos in repo_dependencies
  const affectedRepos: DownstreamImpact[] = [];

  if (packageName && packageName.trim()) {
    const depRows = await db
      .select({
        repositoryId: repoDependencies.repositoryId,
        name: repoDependencies.name,
        versionSpec: repoDependencies.versionSpec,
      })
      .from(repoDependencies)
      .where(
        and(
          eq(repoDependencies.name, packageName),
          ne(repoDependencies.repositoryId, repoId)
        )
      )
      .limit(20)
      .catch(() => []);

    // Process each downstream repo (cap at 20)
    for (const depRow of depRows.slice(0, 20)) {
      // Load downstream repo info
      const [depRepo] = await db
        .select({
          id: repositories.id,
          name: repositories.name,
          ownerId: repositories.ownerId,
          defaultBranch: repositories.defaultBranch,
        })
        .from(repositories)
        .where(eq(repositories.id, depRow.repositoryId))
        .limit(1)
        .catch(() => []);

      if (!depRepo) continue;

      const [depOwner] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, depRepo.ownerId))
        .limit(1)
        .catch(() => []);

      if (!depOwner) continue;

      const downstreamRepoDir = getRepoPath(depOwner.username, depRepo.name);

      // Check which changed symbols are used in the downstream repo
      let usedSymbols: string[] = [];
      let hasTests = false;
      try {
        [usedSymbols, hasTests] = await Promise.all([
          repoUsesSymbols(downstreamRepoDir, changedExports),
          repoHasTests(downstreamRepoDir),
        ]);
      } catch {
        /* git may not be available for this repo */
      }

      // Determine risk level
      let riskLevel: "high" | "medium" | "low";
      if (usedSymbols.length > 0 && !hasTests) {
        riskLevel = "high";
      } else if (usedSymbols.length > 0 && hasTests) {
        riskLevel = "medium";
      } else {
        riskLevel = "low";
      }

      affectedRepos.push({
        repoId: depRepo.id,
        repoName: depRepo.name,
        ownerName: depOwner.username,
        dependencyName: depRow.name,
        currentVersion: depRow.versionSpec ?? "unknown",
        riskLevel,
        changedExports: usedSymbols.length > 0 ? usedSymbols : changedExports,
      });
    }
  }

  // 9. Generate AI migration notes (best-effort, non-blocking)
  if (changedExports.length > 0 && affectedRepos.some((r) => r.riskLevel !== "low")) {
    try {
      await generateMigrationNotes(changedExports, packageName ?? repoName, diffText);
    } catch {
      /* non-blocking */
    }
  }

  // 10. Compute total risk score (0-100)
  const highCount = affectedRepos.filter((r) => r.riskLevel === "high").length;
  const mediumCount = affectedRepos.filter((r) => r.riskLevel === "medium").length;
  const lowCount = affectedRepos.filter((r) => r.riskLevel === "low").length;

  let totalRisk = 0;
  totalRisk += Math.min(highCount * 30, 60);
  totalRisk += Math.min(mediumCount * 15, 30);
  totalRisk += Math.min(lowCount * 5, 10);
  totalRisk += Math.min(changedExports.length * 5, 20);
  totalRisk = Math.min(totalRisk, 100);

  const now = new Date();
  const cachedUntil = new Date(now.getTime() + CACHE_TTL_MS);

  const report: CrossRepoReport = {
    prId,
    affectedRepos,
    totalRisk,
    analyzedAt: now,
    cachedUntil,
  };

  // 11. Persist to memory + DB cache
  setMemoryCache(prId, report);
  await saveDbCache(report);

  return report;
}

export function invalidateCrossRepoCache(prId: string): void {
  memoryCache.delete(prId);
}

function emptyReport(prId: string, _reason: string): CrossRepoReport {
  const now = new Date();
  return {
    prId,
    affectedRepos: [],
    totalRisk: 0,
    analyzedAt: now,
    cachedUntil: new Date(now.getTime() + CACHE_TTL_MS),
  };
}

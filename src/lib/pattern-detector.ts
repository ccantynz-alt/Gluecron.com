/**
 * Proactive Pattern Recognition — detects when the same bug has been fixed
 * multiple times and surfaces a warning on PR pages.
 *
 * Public surface:
 *   detectRecurringPatterns(repoId) — analyse last 90 days of fix commits
 *     and upsert findings into `recurring_patterns` with a 24h TTL.
 *   getPatternWarning(repoId, changedFiles) — return the highest-severity
 *     pattern whose suggestedFile overlaps with changedFiles, or null.
 *
 * Both functions are fire-and-forget safe and never throw.
 */

import { and, eq, gt, desc } from "drizzle-orm";
import { db } from "../db";
import { repositories, recurringPatterns, users } from "../db/schema";
import { getRepoPath } from "../git/repository";
import {
  getAnthropic,
  isAiAvailable,
  MODEL_SONNET,
  extractText,
  parseJsonResponse,
} from "./ai-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Pattern {
  id?: string;
  title: string;
  occurrences: number;
  commits: string[];
  rootCauseHypothesis: string | null;
  suggestedFile: string | null;
  severity: "high" | "medium" | "low";
}

interface ClaudePatternResponse {
  title: string;
  occurrences: number;
  commits: string[];
  rootCauseHypothesis: string;
  suggestedFile: string;
  severity: "high" | "medium" | "low";
}

// ---------------------------------------------------------------------------
// In-memory cache (per-repo, 24h TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  patterns: Pattern[];
  expiresAt: number; // epoch ms
}

const _cache = new Map<string, CacheEntry>();

function getCached(repoId: string): Pattern[] | null {
  const entry = _cache.get(repoId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(repoId);
    return null;
  }
  return entry.patterns;
}

function setCached(repoId: string, patterns: Pattern[]): void {
  _cache.set(repoId, {
    patterns,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function spawnGit(
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

function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.slice(0, maxBytes).toString("utf8") + "\n[truncated]";
}

const FIX_KEYWORDS = /\b(fix|bug|patch|revert|hotfix|fixes|fixed|bugfix)\b/i;
const MAX_FIX_COMMITS = 30;
const MAX_DIFF_BYTES_PER_COMMIT = 2 * 1024;

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Analyse the last 90 days of commits in a repo. Finds commits whose messages
 * suggest a bug fix, gets their diffs, and asks Claude to identify recurring
 * patterns. Results are cached in-memory for 24h AND persisted to the
 * `recurring_patterns` table.
 */
export async function detectRecurringPatterns(
  repoId: string
): Promise<Pattern[]> {
  if (!isAiAvailable()) return [];

  // Check in-memory cache first
  const cached = getCached(repoId);
  if (cached) return cached;

  // Check DB cache (another instance may have already run this recently)
  const now = new Date();
  const dbCached = await db
    .select()
    .from(recurringPatterns)
    .where(
      and(
        eq(recurringPatterns.repositoryId, repoId),
        gt(recurringPatterns.expiresAt, now)
      )
    )
    .orderBy(desc(recurringPatterns.detectedAt))
    .limit(5);

  if (dbCached.length > 0) {
    const patterns: Pattern[] = dbCached.map((row) => ({
      id: row.id,
      title: row.title,
      occurrences: row.occurrences,
      commits: (row.commitShas as string[]) ?? [],
      rootCauseHypothesis: row.rootCauseHypothesis,
      suggestedFile: row.suggestedFile,
      severity: row.severity as "high" | "medium" | "low",
    }));
    setCached(repoId, patterns);
    return patterns;
  }

  try {
    return await _runDetection(repoId);
  } catch (err) {
    console.error(
      "[pattern-detector] crashed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

async function _runDetection(repoId: string): Promise<Pattern[]> {
  // Resolve repo owner/name for getRepoPath
  const [repoRow] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerUsername: users.username,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(eq(repositories.id, repoId))
    .limit(1);

  if (!repoRow) return [];

  const repoDir = getRepoPath(repoRow.ownerUsername, repoRow.name);

  // 1. Query last 90 days of commits (SHA + message, one line each)
  const logResult = await spawnGit(
    ["log", "--oneline", '--since=90 days ago', "--format=%H %s"],
    repoDir
  );

  if (logResult.exitCode !== 0 || !logResult.stdout.trim()) return [];

  const allCommits = logResult.stdout.trim().split("\n");

  // 2. Filter to fix-related commits
  const fixCommits = allCommits
    .filter((line) => {
      const [, ...msgParts] = line.split(" ");
      return FIX_KEYWORDS.test(msgParts.join(" "));
    })
    .slice(0, MAX_FIX_COMMITS);

  if (fixCommits.length < 2) return []; // Not enough data to detect patterns

  // 3. Get diffs for fix commits
  const commitBlocks: string[] = [];
  for (const line of fixCommits) {
    const [sha, ...msgParts] = line.split(" ");
    const msg = msgParts.join(" ");
    const diffResult = await spawnGit(
      ["show", "--stat", "--format=", sha],
      repoDir
    );
    const diff = truncate(diffResult.stdout, MAX_DIFF_BYTES_PER_COMMIT);
    commitBlocks.push(`Commit ${sha.slice(0, 7)}: ${msg}\n${diff}`);
  }

  const commitsText = commitBlocks.join("\n\n---\n\n");

  // 4. Call Claude Sonnet 4.6
  const client = getAnthropic();
  const prompt = `Analyze these bug-fix commits from a codebase. Identify recurring patterns — bugs that have been fixed multiple times, suggesting a deeper root cause.

Commits:
${commitsText}

Return JSON array (max 5 patterns):
[{
  "title": "Session token not refreshed after password change",
  "occurrences": 3,
  "commits": ["abc123", "def456"],
  "rootCauseHypothesis": "The auth middleware caches tokens without invalidation",
  "suggestedFile": "src/lib/auth.ts",
  "severity": "high|medium|low"
}]

If you cannot identify any recurring patterns, return an empty array [].`;

  const message = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = extractText(message);
  const parsed = parseJsonResponse<ClaudePatternResponse[]>(rawText);

  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) return [];

  // 5. Persist to DB with 24h TTL
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Delete stale entries for this repo first
  await db
    .delete(recurringPatterns)
    .where(eq(recurringPatterns.repositoryId, repoId));

  const inserted: Pattern[] = [];
  for (const p of parsed.slice(0, 5)) {
    if (!p.title || typeof p.occurrences !== "number") continue;
    const [row] = await db
      .insert(recurringPatterns)
      .values({
        repositoryId: repoId,
        title: p.title,
        occurrences: p.occurrences,
        commitShas: p.commits ?? [],
        rootCauseHypothesis: p.rootCauseHypothesis || null,
        suggestedFile: p.suggestedFile || null,
        severity: p.severity ?? "medium",
        expiresAt,
      })
      .returning();

    if (row) {
      inserted.push({
        id: row.id,
        title: row.title,
        occurrences: row.occurrences,
        commits: (row.commitShas as string[]) ?? [],
        rootCauseHypothesis: row.rootCauseHypothesis,
        suggestedFile: row.suggestedFile,
        severity: row.severity as "high" | "medium" | "low",
      });
    }
  }

  setCached(repoId, inserted);
  return inserted;
}

// ---------------------------------------------------------------------------
// Pattern warning for PR pages
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Returns the highest-severity pattern whose suggestedFile overlaps with
 * the list of changed files in a PR. Returns null if no overlap is found.
 *
 * This is designed to be called during PR page load — it hits the in-memory
 * cache first, then the DB cache, and only triggers a full AI run if the
 * cache is cold (which is rare for active repos).
 */
export async function getPatternWarning(
  repoId: string,
  changedFiles: string[]
): Promise<Pattern | null> {
  if (!isAiAvailable()) return null;
  if (changedFiles.length === 0) return null;

  let patterns = getCached(repoId);

  if (!patterns) {
    // Try DB cache (non-blocking best-effort)
    try {
      const now = new Date();
      const rows = await db
        .select()
        .from(recurringPatterns)
        .where(
          and(
            eq(recurringPatterns.repositoryId, repoId),
            gt(recurringPatterns.expiresAt, now)
          )
        )
        .limit(5);

      if (rows.length > 0) {
        patterns = rows.map((row) => ({
          id: row.id,
          title: row.title,
          occurrences: row.occurrences,
          commits: (row.commitShas as string[]) ?? [],
          rootCauseHypothesis: row.rootCauseHypothesis,
          suggestedFile: row.suggestedFile,
          severity: row.severity as "high" | "medium" | "low",
        }));
        setCached(repoId, patterns);
      } else {
        // Cache is cold — trigger background detection, return null now
        detectRecurringPatterns(repoId).catch(() => {});
        return null;
      }
    } catch {
      return null;
    }
  }

  // Find the highest-severity pattern that overlaps with changed files
  const matched = patterns
    .filter((p) => {
      if (!p.suggestedFile) return false;
      return changedFiles.some(
        (f) =>
          f === p.suggestedFile ||
          f.endsWith(p.suggestedFile!) ||
          p.suggestedFile!.endsWith(f)
      );
    })
    .sort(
      (a, b) =>
        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
    );

  return matched[0] ?? null;
}

/**
 * Claude-API-based semantic code search.
 *
 * Unlike the embedding-based search in semantic-search.ts (which requires
 * Voyage AI + a pre-built index), this approach uses Claude to understand
 * the query and rank files in natural language — no vector DB, no prior
 * indexing. Works immediately on any repo.
 *
 * Algorithm:
 *  1. List all files via `git ls-tree -r --name-only HEAD` (up to 1000 files).
 *  2. For large repos (>200 files): pre-filter with `git grep -l keyword`.
 *  3. Build a compact index: for each candidate file, read its first 50 lines.
 *  4. Send index + query to Claude (haiku — fast + cheap) and ask for a
 *     JSON-ranked result: [{file, reason, confidence}].
 *  5. For the top 5 results, read the actual file and extract the most
 *     relevant 20-line snippet (heuristic: find the block that contains the
 *     most query-adjacent tokens).
 *  6. Cache results in-memory for 5 minutes (Map<`${repoId}:${query}`, ...>).
 *
 * Rate limit: 20 semantic searches per user (by userId or IP) per hour.
 * After the limit is hit, falls back to `git grep` keyword search.
 *
 * Fallback: if ANTHROPIC_API_KEY is not set, falls back to `git grep`.
 */

import { getAnthropic, MODEL_HAIKU, parseJsonResponse } from "./ai-client";
import { config } from "./config";
import { getRepoPath } from "../git/repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticSearchResult {
  file: string;
  reason: string;      // AI's explanation of why this file is relevant
  confidence: number;  // 0–1
  snippet: string;     // up to 20 lines of the most relevant content
  lineNumber?: number; // best-guess start line for the snippet
}

// ---------------------------------------------------------------------------
// In-memory cache (5-minute TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  results: SemanticSearchResult[];
  expiresAt: number;
}

const resultCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheGet(key: string): SemanticSearchResult[] | null {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(key);
    return null;
  }
  return entry.results;
}

function cacheSet(key: string, results: SemanticSearchResult[]): void {
  // Evict old entries to keep memory bounded.
  if (resultCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of resultCache) {
      if (v.expiresAt < now) resultCache.delete(k);
    }
  }
  resultCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Per-user/IP rate limiting (20 semantic searches per hour)
// ---------------------------------------------------------------------------

interface BucketEntry {
  count: number;
  resetAt: number;
}

const semanticSearchBuckets = new Map<string, BucketEntry>();
const SEMANTIC_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SEMANTIC_RATE_MAX = 20;

/** Returns true if the caller is within quota, false if exceeded. */
export function checkSemanticRateLimit(key: string): boolean {
  const now = Date.now();
  let bucket = semanticSearchBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + SEMANTIC_RATE_WINDOW_MS };
    semanticSearchBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= SEMANTIC_RATE_MAX;
}

/** Returns remaining semantic searches in the current window (never negative). */
export function semanticRateLimitRemaining(key: string): number {
  const now = Date.now();
  const bucket = semanticSearchBuckets.get(key);
  if (!bucket || bucket.resetAt < now) return SEMANTIC_RATE_MAX;
  return Math.max(0, SEMANTIC_RATE_MAX - bucket.count);
}

// ---------------------------------------------------------------------------
// Skip-list: directories we never look inside
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".next",
  ".turbo",
  "target",
  "__pycache__",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
]);

function shouldSkipPath(path: string): boolean {
  const parts = path.split("/");
  // Skip if any directory segment is in the skip list.
  for (const part of parts.slice(0, -1)) {
    if (SKIP_DIRS.has(part.toLowerCase())) return true;
  }
  const basename = parts[parts.length - 1].toLowerCase();
  if (SKIP_FILES.has(basename)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function gitExec(
  cmd: string[],
  cwd: string
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

async function lsFiles(owner: string, repo: string, branch: string): Promise<string[]> {
  const repoDir = getRepoPath(owner, repo);
  const { stdout, exitCode } = await gitExec(
    ["git", "ls-tree", "-r", "--name-only", branch],
    repoDir
  );
  if (exitCode !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((p) => !shouldSkipPath(p));
}

async function grepFiles(
  owner: string,
  repo: string,
  branch: string,
  keyword: string
): Promise<string[]> {
  const repoDir = getRepoPath(owner, repo);
  const { stdout } = await gitExec(
    ["git", "grep", "-l", "-i", keyword, branch, "--"],
    repoDir
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // git grep -l output: "<ref>:<path>"
      const idx = line.indexOf(":");
      return idx >= 0 ? line.slice(idx + 1) : line;
    })
    .filter((p) => !shouldSkipPath(p));
}

async function readFileHead(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  maxLines = 50
): Promise<string> {
  const repoDir = getRepoPath(owner, repo);
  const { stdout, exitCode } = await gitExec(
    ["git", "show", `${branch}:${filePath}`],
    repoDir
  );
  if (exitCode !== 0) return "";
  return stdout.split("\n").slice(0, maxLines).join("\n");
}

async function readFileFull(
  owner: string,
  repo: string,
  branch: string,
  filePath: string
): Promise<string> {
  const repoDir = getRepoPath(owner, repo);
  const { stdout, exitCode } = await gitExec(
    ["git", "show", `${branch}:${filePath}`],
    repoDir
  );
  if (exitCode !== 0) return "";
  return stdout;
}

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

/**
 * Extract the most relevant 20-line window from a file for a given query.
 * Strategy: split query into lowercase tokens, score each line by how many
 * tokens it contains, then find the 20-line window with the highest total
 * score. Falls back to the first 20 lines when no tokens match anything.
 */
function extractSnippet(
  content: string,
  query: string,
  windowSize = 20
): { snippet: string; lineNumber: number } {
  const lines = content.split("\n");
  if (lines.length <= windowSize) {
    return { snippet: content, lineNumber: 1 };
  }

  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  if (tokens.length === 0) {
    return { snippet: lines.slice(0, windowSize).join("\n"), lineNumber: 1 };
  }

  const lineScores = lines.map((line) => {
    const lower = line.toLowerCase();
    return tokens.reduce((acc, tok) => acc + (lower.includes(tok) ? 1 : 0), 0);
  });

  // Sliding window: find the windowSize-line slice with the highest score sum.
  let windowScore = lineScores.slice(0, windowSize).reduce((a, b) => a + b, 0);
  let bestStart = 0;
  let bestScore = windowScore;

  for (let i = 1; i + windowSize <= lines.length; i++) {
    windowScore = windowScore - lineScores[i - 1] + lineScores[i + windowSize - 1];
    if (windowScore > bestScore) {
      bestScore = windowScore;
      bestStart = i;
    }
  }

  const snippet = lines.slice(bestStart, bestStart + windowSize).join("\n");
  return { snippet, lineNumber: bestStart + 1 };
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

interface ClaudeRankedFile {
  file: string;
  reason: string;
  confidence: number;
}

const MAX_INDEX_CHARS = 80_000; // cap total index size sent to Claude

async function rankFilesWithClaude(
  query: string,
  fileIndex: Array<{ path: string; head: string }>
): Promise<ClaudeRankedFile[]> {
  const client = getAnthropic();

  // Build a compact text index, respecting the char cap.
  let indexText = "";
  for (const { path, head } of fileIndex) {
    const entry = `\n--- ${path} ---\n${head.slice(0, 600)}\n`;
    if (indexText.length + entry.length > MAX_INDEX_CHARS) break;
    indexText += entry;
  }

  const prompt = `You are a code navigation assistant. Given a codebase file index and a search query, identify the most relevant files.

QUERY: "${query}"

CODEBASE INDEX (filename + first 50 lines per file):
${indexText}

Return ONLY a JSON array (no prose, no markdown) of up to 8 objects, ranked by relevance, with this shape:
[{"file": "<path>", "reason": "<1-sentence explanation>", "confidence": <0.0–1.0>}]

Only include files with confidence > 0.2. Return [] if nothing is relevant.`;

  try {
    const message = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      message.content.find((b) => b.type === "text")?.text ?? "";
    const parsed = parseJsonResponse<ClaudeRankedFile[]>(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is ClaudeRankedFile =>
        typeof r.file === "string" &&
        typeof r.reason === "string" &&
        typeof r.confidence === "number"
    );
  } catch (err) {
    console.error("[claude-semantic-search] Claude API error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Keyword fallback (git grep)
// ---------------------------------------------------------------------------

async function keywordFallback(
  owner: string,
  repo: string,
  branch: string,
  query: string
): Promise<SemanticSearchResult[]> {
  const repoDir = getRepoPath(owner, repo);
  const keyword = query.split(/\s+/)[0] || query;
  const { stdout, exitCode } = await gitExec(
    ["git", "grep", "-n", "-i", "-m", "5", keyword, branch, "--"],
    repoDir
  );
  if (exitCode !== 0) return [];

  // Group by file, take top 5 files.
  const byFile = new Map<string, { lineNum: number; line: string }[]>();
  for (const raw of stdout.trim().split("\n").filter(Boolean)) {
    // Format: <ref>:<file>:<lineNum>:<content>
    const refPrefix = branch + ":";
    const stripped = raw.startsWith(refPrefix) ? raw.slice(refPrefix.length) : raw;
    const firstColon = stripped.indexOf(":");
    if (firstColon < 0) continue;
    const file = stripped.slice(0, firstColon);
    const rest = stripped.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    if (secondColon < 0) continue;
    const lineNum = parseInt(rest.slice(0, secondColon), 10);
    const line = rest.slice(secondColon + 1);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ lineNum, line });
  }

  const results: SemanticSearchResult[] = [];
  let count = 0;
  for (const [file, matches] of byFile) {
    if (count++ >= 5) break;
    const snippet = matches
      .slice(0, 5)
      .map((m) => `${m.lineNum}: ${m.line}`)
      .join("\n");
    results.push({
      file,
      reason: `Keyword match for "${keyword}"`,
      confidence: 0.5,
      snippet,
      lineNumber: matches[0]?.lineNum,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface SemanticSearchOptions {
  maxFiles?: number;   // max candidate files to index (default 200)
  branch?: string;     // branch/ref to search (default "HEAD")
  rateLimitKey?: string; // userId or IP for rate limiting
}

/**
 * Semantic code search powered by Claude.
 *
 * @param owner - repo owner username
 * @param repo  - repo name
 * @param repoId - DB repository id (used as cache key)
 * @param query - natural-language search query
 * @param opts  - optional config
 * @returns ranked list of matching files with AI reasoning
 */
export async function claudeSemanticSearch(
  owner: string,
  repo: string,
  repoId: string,
  query: string,
  opts: SemanticSearchOptions = {}
): Promise<{ results: SemanticSearchResult[]; mode: "semantic" | "keyword"; quotaExceeded: boolean }> {
  const q = query.trim();
  if (!q) return { results: [], mode: "keyword", quotaExceeded: false };

  const branch = opts.branch || "HEAD";
  const maxFiles = opts.maxFiles ?? 200;
  const cacheKey = `${repoId}:${branch}:${q}`;

  // Cache hit
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { results: cached, mode: "semantic", quotaExceeded: false };
  }

  // Rate limit check (per-user or per-IP)
  let quotaExceeded = false;
  if (opts.rateLimitKey) {
    const within = checkSemanticRateLimit(opts.rateLimitKey);
    if (!within) {
      quotaExceeded = true;
    }
  }

  // No Claude API key or quota exceeded → keyword fallback
  if (!config.anthropicApiKey || quotaExceeded) {
    const results = await keywordFallback(owner, repo, branch, q);
    return { results, mode: "keyword", quotaExceeded };
  }

  // Step 1: list all files
  let allFiles: string[];
  try {
    allFiles = await lsFiles(owner, repo, branch);
  } catch {
    return { results: await keywordFallback(owner, repo, branch, q), mode: "keyword", quotaExceeded: false };
  }

  // Step 2: pre-filter if repo is large
  let candidates: string[];
  if (allFiles.length > maxFiles) {
    const keyword = q.split(/\s+/)[0] || q;
    try {
      const grepHits = new Set(await grepFiles(owner, repo, branch, keyword));
      candidates = allFiles.filter((f) => grepHits.has(f));
      // If grep found nothing, fall back to first maxFiles files.
      if (candidates.length === 0) {
        candidates = allFiles.slice(0, maxFiles);
      } else if (candidates.length > maxFiles) {
        candidates = candidates.slice(0, maxFiles);
      }
    } catch {
      candidates = allFiles.slice(0, maxFiles);
    }
  } else {
    candidates = allFiles;
  }

  // Step 3: build file index (filename + first 50 lines)
  const fileIndex: Array<{ path: string; head: string }> = [];
  const HEAD_CONCURRENCY = 20;
  for (let i = 0; i < candidates.length; i += HEAD_CONCURRENCY) {
    const batch = candidates.slice(i, i + HEAD_CONCURRENCY);
    const heads = await Promise.all(
      batch.map((p) => readFileHead(owner, repo, branch, p, 50))
    );
    for (let j = 0; j < batch.length; j++) {
      if (heads[j]) fileIndex.push({ path: batch[j], head: heads[j] });
    }
  }

  if (fileIndex.length === 0) {
    return { results: await keywordFallback(owner, repo, branch, q), mode: "keyword", quotaExceeded: false };
  }

  // Step 4: ask Claude to rank files
  const ranked = await rankFilesWithClaude(q, fileIndex);

  if (ranked.length === 0) {
    // Claude found nothing — try keyword fallback
    const kwResults = await keywordFallback(owner, repo, branch, q);
    return { results: kwResults, mode: "keyword", quotaExceeded: false };
  }

  // Step 5: for each top result, read full file and extract relevant snippet
  const TOP_N = 5;
  const top = ranked.slice(0, TOP_N);
  const results: SemanticSearchResult[] = [];

  await Promise.all(
    top.map(async (r) => {
      const content = await readFileFull(owner, repo, branch, r.file).catch(() => "");
      if (!content) {
        results.push({ ...r, snippet: "", lineNumber: 1 });
        return;
      }
      const { snippet, lineNumber } = extractSnippet(content, q, 20);
      results.push({
        file: r.file,
        reason: r.reason,
        confidence: Math.min(1, Math.max(0, r.confidence)),
        snippet,
        lineNumber,
      });
    })
  );

  // Sort by confidence desc (Promise.all doesn't preserve order after push).
  results.sort((a, b) => b.confidence - a.confidence);

  cacheSet(cacheKey, results);
  return { results, mode: "semantic", quotaExceeded: false };
}

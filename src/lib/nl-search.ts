/**
 * Natural Language Code Search — Claude-powered intent search.
 *
 * Unlike embedding-based semantic search (which requires a pre-built vector
 * index), NL search uses Claude as the reasoner over actual file content.
 * A developer types a natural language question like:
 *   "find all places where we validate user email but don't check MX records"
 *   "where do we write to the database without a transaction?"
 * and Claude finds the matching code.
 *
 * Algorithm:
 *  1. Quick Claude call to extract grep-friendly keywords from the query.
 *  2. Run `git grep -l <keyword>` for each keyword; union matching files.
 *     Cap at 40 files. Fall back to code_chunks table if grep returns 0.
 *  3. Read each candidate file via git show (HEAD:<path>), capped at 6KB each.
 *     Build combined context, capped at 80KB total.
 *  4. Single Claude reasoning pass: find all places matching the query,
 *     return JSON with filePath, lineStart, lineEnd, snippet, explanation,
 *     confidence.
 *  5. Cache results in-memory per `${repoId}:${query}` for 15 minutes.
 */

import { getAnthropic, MODEL_SONNET, isAiAvailable, parseJsonResponse } from "./ai-client";
import { getRepoPath } from "../git/repository";
import { db } from "../db";
import { codeChunks } from "../db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NlSearchResult {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;         // the relevant lines
  explanation: string;     // why this matches the query
  confidence: "high" | "medium" | "low";
}

export interface NlSearchResponse {
  query: string;
  results: NlSearchResult[];
  totalFilesScanned: number;
  searchedAt: Date;
  cached: boolean;
}

// ---------------------------------------------------------------------------
// In-memory cache (15-minute TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  response: NlSearchResponse;
  expiresAt: number;
}

const nlCache = new Map<string, CacheEntry>();
const NL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function cacheGet(key: string): NlSearchResponse | null {
  const entry = nlCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    nlCache.delete(key);
    return null;
  }
  return entry.response;
}

function cacheSet(key: string, response: NlSearchResponse): void {
  // Evict expired entries to keep memory bounded.
  if (nlCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of nlCache) {
      if (v.expiresAt < now) nlCache.delete(k);
    }
  }
  nlCache.set(key, { response, expiresAt: Date.now() + NL_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Skip-list: skip binary/build/lock files
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

const SKIP_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".gz", ".tar",
  ".lockb", ".lock",
  ".min.js", ".min.css",
]);

function shouldSkipPath(filePath: string): boolean {
  const parts = filePath.split("/");
  for (const part of parts.slice(0, -1)) {
    if (SKIP_DIRS.has(part.toLowerCase())) return true;
  }
  const basename = parts[parts.length - 1].toLowerCase();
  for (const ext of SKIP_EXTS) {
    if (basename.endsWith(ext)) return true;
  }
  // Lock files by exact name
  const lockFiles = new Set([
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "bun.lockb", "bun.lock", "poetry.lock", "cargo.lock",
    "composer.lock", "gemfile.lock",
  ]);
  if (lockFiles.has(basename)) return true;
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

/**
 * Run `git grep -l <keyword> HEAD --` and return matching file paths.
 */
async function grepForKeyword(
  ownerName: string,
  repoName: string,
  keyword: string
): Promise<string[]> {
  const repoDir = getRepoPath(ownerName, repoName);
  try {
    const { stdout, exitCode } = await gitExec(
      ["git", "grep", "-l", "-i", keyword, "HEAD", "--"],
      repoDir
    );
    // exit code 1 = no matches (not an error)
    if (exitCode !== 0 && exitCode !== 1) return [];
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // git grep -l with a ref outputs "<ref>:<path>" or just "<path>"
        const idx = line.indexOf(":");
        return idx >= 0 ? line.slice(idx + 1) : line;
      })
      .filter((p) => !shouldSkipPath(p));
  } catch {
    return [];
  }
}

/**
 * Read a file from the repo at HEAD, capped to maxBytes.
 * Returns empty string on error.
 */
async function readFileFromGit(
  ownerName: string,
  repoName: string,
  filePath: string,
  maxBytes = 6 * 1024
): Promise<string> {
  const repoDir = getRepoPath(ownerName, repoName);
  try {
    const { stdout, exitCode } = await gitExec(
      ["git", "show", `HEAD:${filePath}`],
      repoDir
    );
    if (exitCode !== 0) return "";
    return stdout.slice(0, maxBytes);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Extract keywords from the query via Claude
// ---------------------------------------------------------------------------

interface KeywordExtraction {
  keywords: string[];
  fileTypes: string[];
}

async function extractKeywords(query: string): Promise<KeywordExtraction> {
  const client = getAnthropic();
  try {
    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content:
            `Extract 3-5 grep-friendly keywords from this natural language search query. ` +
            `Return JSON only, no prose: {"keywords": string[], "fileTypes": string[]}\n` +
            `Keywords should be short, concrete identifiers/patterns likely to appear in code. ` +
            `fileTypes is an optional list of file extensions (e.g. [".ts", ".tsx"]) to narrow the search. ` +
            `Return [] for fileTypes if the query is language-agnostic.\n\n` +
            `Query: ${query}`,
        },
      ],
    });
    const text = msg.content.find((b) => b.type === "text")?.text ?? "";
    const parsed = parseJsonResponse<KeywordExtraction>(text);
    if (parsed && Array.isArray(parsed.keywords)) {
      return {
        keywords: parsed.keywords.slice(0, 5).filter((k) => typeof k === "string" && k.length > 0),
        fileTypes: Array.isArray(parsed.fileTypes) ? parsed.fileTypes : [],
      };
    }
  } catch (err) {
    console.error("[nl-search] keyword extraction error:", err);
  }
  // Fallback: split query into words
  const words = query
    .split(/[^a-zA-Z0-9_]+/)
    .filter((w) => w.length >= 3)
    .slice(0, 5);
  return { keywords: words, fileTypes: [] };
}

// ---------------------------------------------------------------------------
// Step 2 — Gather candidate files via git grep
// ---------------------------------------------------------------------------

async function gatherCandidates(
  ownerName: string,
  repoName: string,
  repoId: string,
  extraction: KeywordExtraction,
  maxFiles = 40
): Promise<string[]> {
  const seen = new Set<string>();

  // Run git grep for each keyword (in parallel)
  const results = await Promise.allSettled(
    extraction.keywords.map((kw) => grepForKeyword(ownerName, repoName, kw))
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const p of r.value) {
        seen.add(p);
        if (seen.size >= maxFiles * 2) break;
      }
    }
  }

  // Apply file-type filter if provided
  let candidates = Array.from(seen);
  if (extraction.fileTypes.length > 0) {
    const filtered = candidates.filter((p) =>
      extraction.fileTypes.some((ext) => p.endsWith(ext))
    );
    // Only narrow if we still have results
    if (filtered.length > 0) candidates = filtered;
  }

  candidates = candidates.slice(0, maxFiles);

  // Fallback: if git grep returned nothing, read from code_chunks table
  if (candidates.length === 0) {
    try {
      const rows = await db
        .select({ path: codeChunks.path })
        .from(codeChunks)
        .where(eq(codeChunks.repositoryId, repoId))
        .groupBy(codeChunks.path)
        .limit(maxFiles);
      candidates = rows.map((r) => r.path).filter((p) => !shouldSkipPath(p));
    } catch {
      // DB unavailable — return empty
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Step 3 — Read file contents and build context
// ---------------------------------------------------------------------------

/**
 * For each candidate file, read content (capped at 6KB).
 * Build a combined context string where each file is prefixed with a header
 * showing the filename and line numbers, capped at 80KB total.
 */
async function buildContext(
  ownerName: string,
  repoName: string,
  candidates: string[],
  maxTotalBytes = 80 * 1024
): Promise<{ contextStr: string; filesRead: string[] }> {
  const BATCH = 10;
  const fileContents: Array<{ path: string; content: string }> = [];

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const contents = await Promise.all(
      batch.map((p) => readFileFromGit(ownerName, repoName, p, 6144))
    );
    for (let j = 0; j < batch.length; j++) {
      if (contents[j]) {
        fileContents.push({ path: batch[j], content: contents[j] });
      }
    }
  }

  // Build numbered context string
  let contextStr = "";
  const filesRead: string[] = [];

  for (const { path, content } of fileContents) {
    if (contextStr.length >= maxTotalBytes) break;
    const lines = content.split("\n");
    // Number lines starting at 1
    const numbered = lines
      .map((line, idx) => `${idx + 1}: ${line}`)
      .join("\n");
    const header = `\n\n=== FILE: ${path} ===\n`;
    const block = header + numbered;
    if (contextStr.length + block.length > maxTotalBytes) {
      // Trim block to fit
      const remaining = maxTotalBytes - contextStr.length;
      if (remaining > header.length + 100) {
        contextStr += block.slice(0, remaining);
        filesRead.push(path);
      }
    } else {
      contextStr += block;
      filesRead.push(path);
    }
  }

  return { contextStr, filesRead };
}

// ---------------------------------------------------------------------------
// Step 4 — Claude reasoning pass
// ---------------------------------------------------------------------------

interface RawResult {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  explanation: string;
  confidence: "high" | "medium" | "low";
}

async function reasonWithClaude(
  query: string,
  contextStr: string
): Promise<NlSearchResult[]> {
  const client = getAnthropic();

  const systemPrompt =
    `You are a code analysis expert. Find all places in the provided code that match the user's query. ` +
    `Be precise about file paths and line numbers. Only return matches that genuinely satisfy the query — ` +
    `do not include tangentially related code.`;

  const userPrompt =
    `Query: ${query}\n\n` +
    `Code files:\n${contextStr}\n\n` +
    `Return JSON only, no prose:\n` +
    `{\n` +
    `  "results": Array<{\n` +
    `    "filePath": string,\n` +
    `    "lineStart": number,\n` +
    `    "lineEnd": number,\n` +
    `    "snippet": string,\n` +
    `    "explanation": string,\n` +
    `    "confidence": "high" | "medium" | "low"\n` +
    `  }>\n` +
    `}\n\n` +
    `Return {"results": []} if nothing matches. Sort by confidence descending. Max 10 results.`;

  try {
    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = msg.content.find((b) => b.type === "text")?.text ?? "";
    const parsed = parseJsonResponse<{ results: RawResult[] }>(text);

    if (!parsed || !Array.isArray(parsed.results)) return [];

    return parsed.results
      .filter(
        (r): r is RawResult =>
          typeof r.filePath === "string" &&
          typeof r.lineStart === "number" &&
          typeof r.lineEnd === "number" &&
          typeof r.snippet === "string" &&
          typeof r.explanation === "string" &&
          (r.confidence === "high" || r.confidence === "medium" || r.confidence === "low")
      )
      .slice(0, 10);
  } catch (err) {
    console.error("[nl-search] Claude reasoning error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Natural language code search powered by Claude.
 *
 * @param ownerName  - repo owner username
 * @param repoName   - repo name
 * @param repoId     - DB repository id (used as cache key + fallback)
 * @param query      - natural-language search query
 * @returns NlSearchResponse (never throws)
 */
export async function nlSearch(
  ownerName: string,
  repoName: string,
  repoId: string,
  query: string
): Promise<NlSearchResponse> {
  const q = query.trim();
  const empty: NlSearchResponse = {
    query: q,
    results: [],
    totalFilesScanned: 0,
    searchedAt: new Date(),
    cached: false,
  };

  if (!q) return empty;

  // Guard: AI must be available
  if (!isAiAvailable()) {
    return { ...empty, results: [] };
  }

  // Cache check
  const cacheKey = `${repoId}:${q}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  try {
    // Step 1 — Extract keywords
    const extraction = await extractKeywords(q);

    // Step 2 — Gather candidate files
    const candidates = await gatherCandidates(
      ownerName, repoName, repoId, extraction, 40
    );

    if (candidates.length === 0) {
      cacheSet(cacheKey, empty);
      return empty;
    }

    // Step 3 — Read file contents
    const { contextStr, filesRead } = await buildContext(
      ownerName, repoName, candidates, 80 * 1024
    );

    if (!contextStr || filesRead.length === 0) {
      cacheSet(cacheKey, empty);
      return empty;
    }

    // Step 4 — Claude reasoning pass
    const results = await reasonWithClaude(q, contextStr);

    const response: NlSearchResponse = {
      query: q,
      results,
      totalFilesScanned: filesRead.length,
      searchedAt: new Date(),
      cached: false,
    };

    // Step 5 — Cache and return
    cacheSet(cacheKey, response);
    return response;
  } catch (err) {
    console.error("[nl-search] unexpected error:", err);
    return empty;
  }
}

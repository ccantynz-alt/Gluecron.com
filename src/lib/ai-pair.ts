/**
 * Proactive AI pair programmer — assembles rich editor context and generates
 * suggestions that go beyond simple autocomplete.
 *
 * Two public entry points:
 *
 *   assemblePairContext(repoId, filePath, userId)
 *     Queries the DB for open PRs touching this file, recent gate failures,
 *     related issues, and extracts top-level symbols from the file. Result is
 *     cached in-memory for 3 minutes per (repoId, filePath, userId) triple.
 *
 *   generatePairSuggestion(prefix, suffix, filePath, context)
 *     Sends the assembled context to Claude (MODEL_SONNET) and returns a
 *     structured PairSuggestion. Falls back to a plain prefix completion on
 *     any error. Never throws.
 *
 * Design notes:
 *   - All DB queries are read-only and best-effort; individual failures are
 *     swallowed so the editor never blocks on a DB hiccup.
 *   - Git operations (diff --name-only, diff excerpt) run as Bun subprocesses
 *     against the bare repo on disk. Results are cached per PR for 5 minutes.
 *   - We intentionally avoid importing anything from src/routes/* to keep
 *     this file usable in background workers without spinning up HTTP handlers.
 */

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import { db } from "../db";
import {
  gateRuns,
  issues,
  pullRequests,
  repositories,
} from "../db/schema";
import { getAnthropic, MODEL_SONNET, extractText, parseJsonResponse, isAiAvailable } from "./ai-client";
import { extractSymbols, detectLanguage } from "./symbols";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Contextual signals assembled for a specific file + user combination. */
export interface PairContext {
  openPrForFile?: {
    prNumber: number;
    title: string;
    branch: string;
    /** Unified diff excerpt for this file, max 2 KB. */
    changedLines: string;
  };
  recentGateFailure?: {
    runType: string;
    /** First 500 chars of error log (summary or details field). */
    errorSummary: string;
    failedAt: Date;
  };
  /** Top-level export names detected in this file via regex. */
  fileSymbols?: string[];
  relatedIssue?: {
    issueNumber: number;
    title: string;
  };
}

/** A structured suggestion returned to the editor. */
export interface PairSuggestion {
  type: "completion" | "warning" | "context_note" | "fix_available";
  /** One line, shown inline in editor. */
  headline: string;
  /** Shown on hover/expand. */
  detail?: string;
  /** e.g. "Apply fix" */
  actionLabel?: string;
  /** Diff to apply or URL to navigate to. */
  actionPayload?: string;
}

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Per-(repoId:filePath:userId) context cache — 3 min TTL. */
const contextCache = new Map<string, CacheEntry<PairContext>>();
const CONTEXT_TTL_MS = 3 * 60 * 1000;

/** Per-(prId) file-list cache — 5 min TTL. */
const prFilesCache = new Map<string, CacheEntry<string[]>>();
const PR_FILES_TTL_MS = 5 * 60 * 1000;

/** Per-(repoId:filePath:userId:prefixSlice) suggestion cache — 30 s TTL. */
const suggestCache = new Map<string, CacheEntry<PairSuggestion>>();
const SUGGEST_TTL_MS = 30 * 1000;

function cacheGet<T>(store: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet<T>(store: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * List files touched by a PR's branch relative to its base branch.
 * Returns an empty array on any error.
 */
async function prChangedFiles(
  prId: string,
  repoPath: string,
  baseBranch: string,
  headBranch: string
): Promise<string[]> {
  const cached = cacheGet(prFilesCache, prId);
  if (cached !== undefined) return cached;

  try {
    const proc = Bun.spawn(
      ["git", "diff", "--name-only", `${baseBranch}...${headBranch}`],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const files = text
      .trim()
      .split("\n")
      .filter(Boolean);
    cacheSet(prFilesCache, prId, files, PR_FILES_TTL_MS);
    return files;
  } catch {
    return [];
  }
}

/**
 * Extract the diff excerpt for a specific file from a PR's branch comparison.
 * Returns at most 2 KB of unified diff text.
 */
async function fileDiffExcerpt(
  repoPath: string,
  baseBranch: string,
  headBranch: string,
  filePath: string
): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["git", "diff", `${baseBranch}...${headBranch}`, "--", filePath],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    // Cap at 2 KB.
    return text.slice(0, 2048);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Symbol extraction from file content in the repo
// ---------------------------------------------------------------------------

/**
 * Read a file from the HEAD of the repo's default branch and extract top-level
 * symbol names. Returns an empty array on any error.
 */
async function extractFileSymbols(
  repoPath: string,
  filePath: string,
  defaultBranch: string
): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      ["git", "show", `${defaultBranch}:${filePath}`],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    const content = await new Response(proc.stdout).text();
    await proc.exited;
    if (!content) return [];
    const lang = detectLanguage(filePath);
    if (!lang) return [];
    const symbols = extractSymbols(content, lang);
    // Return unique names, up to 30.
    const seen = new Set<string>();
    const names: string[] = [];
    for (const s of symbols) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        names.push(s.name);
        if (names.length >= 30) break;
      }
    }
    return names;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Find the most recent open PR authored by this user in this repo that
 * touches the given file path. Returns null if none found.
 */
async function findOpenPrForFile(
  repoId: string,
  filePath: string,
  userId: string,
  repoPath: string
): Promise<PairContext["openPrForFile"] | undefined> {
  try {
    // Load up to 10 recent open PRs by this user in this repo.
    const prs = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repoId),
          eq(pullRequests.authorId, userId),
          eq(pullRequests.state, "open")
        )
      )
      .orderBy(desc(pullRequests.updatedAt))
      .limit(10);

    if (prs.length === 0) return undefined;

    for (const pr of prs) {
      const files = await prChangedFiles(
        pr.id,
        repoPath,
        pr.baseBranch,
        pr.headBranch
      );
      // Check if the target file is in this PR's changeset.
      const touches = files.some(
        (f) => f === filePath || filePath.endsWith(f) || f.endsWith(filePath)
      );
      if (!touches) continue;

      const changedLines = await fileDiffExcerpt(
        repoPath,
        pr.baseBranch,
        pr.headBranch,
        filePath
      );

      return {
        prNumber: pr.number,
        title: pr.title,
        branch: pr.headBranch,
        changedLines,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the most recent failed gate run for any open PR by this user in this
 * repo within the last 30 minutes.
 */
async function findRecentGateFailure(
  repoId: string,
  userId: string
): Promise<PairContext["recentGateFailure"] | undefined> {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);

    // Get open PRs for this user.
    const openPrs = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repoId),
          eq(pullRequests.authorId, userId),
          eq(pullRequests.state, "open")
        )
      )
      .limit(20);

    if (openPrs.length === 0) return undefined;

    const prIds = openPrs.map((p) => p.id);

    const [failed] = await db
      .select()
      .from(gateRuns)
      .where(
        and(
          inArray(gateRuns.pullRequestId, prIds),
          eq(gateRuns.status, "failed"),
          gte(gateRuns.createdAt, cutoff)
        )
      )
      .orderBy(desc(gateRuns.createdAt))
      .limit(1);

    if (!failed) return undefined;

    const rawLog = failed.summary || failed.details || "";
    const errorSummary = rawLog.slice(0, 500);

    return {
      runType: failed.gateName,
      errorSummary,
      failedAt: new Date(failed.createdAt),
    };
  } catch {
    return undefined;
  }
}

/**
 * Find the first open issue whose title or body mentions the file name.
 */
async function findRelatedIssue(
  repoId: string,
  filePath: string
): Promise<PairContext["relatedIssue"] | undefined> {
  try {
    // Extract just the file name (last segment) for a broader match.
    const fileName = filePath.split("/").pop() || filePath;

    const allOpen = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, repoId),
          eq(issues.state, "open")
        )
      )
      .orderBy(desc(issues.updatedAt))
      .limit(50);

    for (const issue of allOpen) {
      const haystack = `${issue.title} ${issue.body ?? ""}`.toLowerCase();
      if (
        haystack.includes(filePath.toLowerCase()) ||
        haystack.includes(fileName.toLowerCase())
      ) {
        return {
          issueNumber: issue.number,
          title: issue.title,
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

/**
 * Assemble rich context for the pair programmer for a given file + user.
 *
 * Results are cached in-memory for 3 minutes. The function never throws;
 * on any DB or git error it returns an empty (but valid) PairContext.
 */
export async function assemblePairContext(
  repoId: string,
  filePath: string,
  userId: string
): Promise<PairContext> {
  const cacheKey = `${repoId}:${filePath}:${userId}`;
  const cached = cacheGet(contextCache, cacheKey);
  if (cached !== undefined) return cached;

  // Resolve the bare repo path on disk.
  let repoPath = "";
  let defaultBranch = "main";
  try {
    const [repo] = await db
      .select({ diskPath: repositories.diskPath, defaultBranch: repositories.defaultBranch })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (repo) {
      // diskPath is the absolute path returned by initBareRepo (the full .git dir path).
      repoPath = repo.diskPath;
      defaultBranch = repo.defaultBranch || "main";
    }
  } catch {
    // Fall through with empty repoPath — git operations will no-op.
  }

  // Fan out all context queries in parallel.
  const [openPrForFile, recentGateFailure, fileSymbols, relatedIssue] =
    await Promise.all([
      repoPath
        ? findOpenPrForFile(repoId, filePath, userId, repoPath)
        : Promise.resolve(undefined),
      findRecentGateFailure(repoId, userId),
      repoPath
        ? extractFileSymbols(repoPath, filePath, defaultBranch)
        : Promise.resolve([] as string[]),
      findRelatedIssue(repoId, filePath),
    ]);

  const context: PairContext = {};
  if (openPrForFile) context.openPrForFile = openPrForFile;
  if (recentGateFailure) context.recentGateFailure = recentGateFailure;
  if (fileSymbols && fileSymbols.length > 0) context.fileSymbols = fileSymbols;
  if (relatedIssue) context.relatedIssue = relatedIssue;

  cacheSet(contextCache, cacheKey, context, CONTEXT_TTL_MS);
  return context;
}

// ---------------------------------------------------------------------------
// Suggestion generation
// ---------------------------------------------------------------------------

/**
 * Check whether the assembled context has anything interesting to surface.
 * "Interesting" = open PR touching this file, a gate failure, or a related
 * issue. Pure completion is fine even with symbols alone.
 */
function hasInterestingContext(ctx: PairContext): boolean {
  return !!(ctx.openPrForFile || ctx.recentGateFailure || ctx.relatedIssue);
}

/**
 * Build a text summary of the PairContext for inclusion in the AI prompt.
 */
function formatContext(ctx: PairContext): string {
  const parts: string[] = [];

  if (ctx.openPrForFile) {
    parts.push(
      `OPEN PR #${ctx.openPrForFile.prNumber}: "${ctx.openPrForFile.title}" (branch: ${ctx.openPrForFile.branch})`
    );
    if (ctx.openPrForFile.changedLines) {
      parts.push(`Diff for this file:\n${ctx.openPrForFile.changedLines}`);
    }
  }

  if (ctx.recentGateFailure) {
    parts.push(
      `RECENT CI FAILURE (${ctx.recentGateFailure.runType}):\n${ctx.recentGateFailure.errorSummary}`
    );
  }

  if (ctx.relatedIssue) {
    parts.push(
      `RELATED ISSUE #${ctx.relatedIssue.issueNumber}: "${ctx.relatedIssue.title}"`
    );
  }

  if (ctx.fileSymbols && ctx.fileSymbols.length > 0) {
    parts.push(`File symbols: ${ctx.fileSymbols.join(", ")}`);
  }

  return parts.join("\n\n");
}

/**
 * Generate a proactive pair suggestion using Claude.
 *
 * When the context has interesting signals (open PR, gate failure, related
 * issue), Claude is asked to produce a structured JSON PairSuggestion.
 * When there is no interesting context, we fall back to a plain code
 * completion using the prefix/suffix — same quality as the existing copilot
 * endpoint but with MODEL_SONNET and a slightly different prompt.
 *
 * Never throws — returns a safe fallback on any error.
 */
export async function generatePairSuggestion(
  prefix: string,
  suffix: string,
  filePath: string,
  context: PairContext
): Promise<PairSuggestion> {
  // --- Fallback used on errors or when AI is unavailable ---
  const fallback: PairSuggestion = {
    type: "completion",
    headline: "Continue editing",
    detail: undefined,
  };

  if (!isAiAvailable()) return fallback;

  try {
    // Clip inputs to sane sizes.
    const clippedPrefix = prefix.slice(-4000);
    const clippedSuffix = (suffix || "").slice(0, 1000);

    if (!hasInterestingContext(context)) {
      // Pure completion path.
      const client = getAnthropic();
      const response = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 256,
        system:
          "You are an expert pair programmer embedded in a code editor. " +
          `The developer is editing ${filePath}. ` +
          "Output ONLY the characters that should be inserted at the cursor. " +
          "No explanations. No markdown fences.",
        messages: [
          {
            role: "user",
            content:
              `PREFIX:\n${clippedPrefix}\n\nSUFFIX:\n${clippedSuffix}`,
          },
        ],
      });
      const completion = extractText(response).replace(/^\s*```[A-Za-z0-9_+-]*\s*\n?/, "").replace(/\n?\s*```\s*$/, "");
      return {
        type: "completion",
        headline: completion.split("\n")[0].slice(0, 120) || "Inline suggestion",
        detail: completion,
      };
    }

    // Context-aware path — ask Claude for a structured suggestion.
    const contextText = formatContext(context);

    const client = getAnthropic();
    const response = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 800,
      system:
        "You are an expert pair programmer embedded in a code editor. " +
        `The developer is editing ${filePath}. ` +
        "Analyse the context provided (open PRs, CI failures, related issues, file symbols) " +
        "and return a single JSON object with the shape: " +
        '{ "type": "completion"|"warning"|"context_note"|"fix_available", ' +
        '"headline": "<one line, max 120 chars>", ' +
        '"detail": "<optional expanded explanation>", ' +
        '"actionLabel": "<optional button label>", ' +
        '"actionPayload": "<optional diff or URL>" }. ' +
        "Respond with ONLY the JSON object — no prose, no markdown fences.",
      messages: [
        {
          role: "user",
          content:
            `CONTEXT:\n${contextText}\n\n` +
            `PREFIX (last 4000 chars):\n${clippedPrefix}\n\n` +
            `SUFFIX (first 1000 chars):\n${clippedSuffix}`,
        },
      ],
    });

    const raw = extractText(response);
    const parsed = parseJsonResponse<{
      type?: string;
      headline?: string;
      detail?: string;
      actionLabel?: string;
      actionPayload?: string;
    }>(raw);

    if (!parsed || typeof parsed.headline !== "string") {
      // Response didn't parse — treat it as a context note.
      return {
        type: "context_note",
        headline: raw.split("\n")[0].slice(0, 120) || "Pair programmer note",
        detail: raw.slice(0, 500),
      };
    }

    const validTypes = new Set(["completion", "warning", "context_note", "fix_available"]);
    const type = validTypes.has(parsed.type ?? "") ? (parsed.type as PairSuggestion["type"]) : "context_note";

    return {
      type,
      headline: (parsed.headline || "").slice(0, 120),
      detail: parsed.detail,
      actionLabel: parsed.actionLabel,
      actionPayload: parsed.actionPayload,
    };
  } catch (err) {
    console.error(
      "[ai-pair] generatePairSuggestion error:",
      (err as Error)?.message || err
    );
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Cache key helper used by the route for the 30-s suggestion cache
// ---------------------------------------------------------------------------

/**
 * Derive a stable cache key for a suggest request.
 * The prefix is hashed (last 50 chars) so we never store raw source.
 */
export function suggestCacheKey(
  userId: string,
  repoId: string,
  filePath: string,
  prefix: string
): string {
  const prefixSlice = prefix.slice(-50);
  return createHash("sha256")
    .update(userId)
    .update("\0")
    .update(repoId)
    .update("\0")
    .update(filePath)
    .update("\0")
    .update(prefixSlice)
    .digest("hex");
}

/** Exported for use by the route layer. */
export { suggestCache, cacheGet, cacheSet, SUGGEST_TTL_MS };

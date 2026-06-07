/**
 * Context Restore for Stale Reviews.
 *
 * When a user opens a PR they previously reviewed (or started reviewing),
 * this module provides an AI-generated summary of what changed since their
 * last visit and where they left off. Shown as a dismissible banner on the
 * PR detail page.
 *
 * Tracks visits via the `pr_visits` table (migration 0088). On each PR page
 * load we upsert the visit timestamp so the next visit can compute the delta.
 *
 * The AI summary is only generated when:
 *   - The user has visited this PR before (non-first-visit)
 *   - The last visit was >4 hours ago
 *   - There are commits or new comments since the last visit
 *
 * Never throws — all paths are wrapped in try/catch.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { prComments, prVisits } from "../db/schema";
import {
  getAnthropic,
  isAiAvailable,
  MODEL_SONNET,
  extractText,
} from "./ai-client";
import { commitsBetween } from "../git/repository";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReviewContext {
  /** ISO string of the user's last visit */
  lastVisitedAt: string;
  /** Number of commits pushed since last visit */
  commitsSince: number;
  /** Number of new comments since last visit */
  newComments: number;
  /** Number of comments with unresolved threads */
  unresolvedThreads: number;
  /** AI-written 2-3 sentence summary of what changed */
  summary: string;
  /** Optional file:line hint for where to start reviewing */
  suggestedStartLine?: string;
}

/** Minimum hours since last visit before we show the context banner. */
const MIN_STALENESS_HOURS = 4;

// ---------------------------------------------------------------------------
// Visit tracking
// ---------------------------------------------------------------------------

/**
 * Record (or refresh) the user's visit to this PR. Call on every PR page load
 * for authenticated users. Uses an upsert so the row always reflects the
 * most recent visit.
 *
 * Never throws.
 */
export async function recordPrVisit(
  prId: string,
  userId: string
): Promise<void> {
  try {
    await db
      .insert(prVisits)
      .values({ prId, userId, visitedAt: new Date() })
      .onConflictDoUpdate({
        target: [prVisits.prId, prVisits.userId],
        set: { visitedAt: new Date() },
      });
  } catch (err) {
    console.error("[review-context] recordPrVisit error:", err);
  }
}

// ---------------------------------------------------------------------------
// Context computation
// ---------------------------------------------------------------------------

/**
 * Compute context for a returning visitor. Returns null when:
 *   - No previous visit exists (first-time visit)
 *   - Visit was too recent (<4h ago)
 *   - No changes since last visit
 *   - AI unavailable AND no new comments (nothing to say)
 *
 * NOTE: Call `recordPrVisit` AFTER this function so the previous timestamp
 * is still available when computing the delta.
 */
export async function getReviewContext(
  prId: string,
  userId: string,
  opts?: {
    ownerName?: string;
    repoName?: string;
    baseBranch?: string;
    headBranch?: string;
  }
): Promise<ReviewContext | null> {
  try {
    // --- Look up previous visit ---
    const [visit] = await db
      .select()
      .from(prVisits)
      .where(and(eq(prVisits.prId, prId), eq(prVisits.userId, userId)))
      .limit(1);

    if (!visit) return null; // First visit

    const lastVisitedAt = new Date(visit.visitedAt);
    const hoursSince =
      (Date.now() - lastVisitedAt.getTime()) / 3_600_000;

    if (hoursSince < MIN_STALENESS_HOURS) return null; // Too recent

    // --- Count new comments since last visit ---
    let newComments = 0;
    try {
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(prComments)
        .where(
          and(
            eq(prComments.pullRequestId, prId),
            gt(prComments.createdAt, lastVisitedAt)
          )
        );
      newComments = countRow?.count || 0;
    } catch {
      /* non-fatal */
    }

    // --- Count commits since last visit (via git log) ---
    let commitsSince = 0;
    let changedFiles: string[] = [];
    if (opts?.ownerName && opts?.repoName && opts?.baseBranch && opts?.headBranch) {
      try {
        const allCommits = await commitsBetween(
          opts.ownerName,
          opts.repoName,
          opts.baseBranch,
          opts.headBranch
        );
        const newCommits = allCommits.filter(
          (c) => new Date(c.date) > lastVisitedAt
        );
        commitsSince = newCommits.length;
        // Rough file list from commit messages (best-effort)
        changedFiles = newCommits
          .flatMap((c) => (c.message || "").split("\n"))
          .filter((l) => l.startsWith("M\t") || l.startsWith("A\t") || l.startsWith("D\t"))
          .map((l) => l.slice(2))
          .filter(Boolean)
          .slice(0, 5);
      } catch {
        /* swallow — git ops can fail */
      }
    }

    // Nothing changed — skip the banner
    if (commitsSince === 0 && newComments === 0) return null;

    // --- AI summary (optional) ---
    let summary = buildFallbackSummary(commitsSince, newComments, hoursSince);
    let suggestedStartLine: string | undefined;

    if (isAiAvailable() && (commitsSince > 0 || newComments > 0)) {
      try {
        const aiResult = await callClaudeForContext({
          commitsSince,
          newComments,
          changedFiles,
          hoursSince,
          lastVisitedAt: lastVisitedAt.toISOString(),
        });
        if (aiResult) {
          summary = aiResult.summary;
          suggestedStartLine = aiResult.suggestedStartLine;
        }
      } catch (err) {
        console.error("[review-context] Claude call failed:", err);
        // Keep fallback summary
      }
    }

    // Unresolved threads — comments without a resolution marker (heuristic)
    const unresolvedThreads = newComments; // simple proxy for now

    return {
      lastVisitedAt: lastVisitedAt.toISOString(),
      commitsSince,
      newComments,
      unresolvedThreads,
      summary,
      suggestedStartLine,
    };
  } catch (err) {
    console.error("[review-context] getReviewContext error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFallbackSummary(
  commitsSince: number,
  newComments: number,
  hoursSince: number
): string {
  const parts: string[] = [];
  const hoursLabel =
    hoursSince >= 24
      ? `${Math.floor(hoursSince / 24)} day${Math.floor(hoursSince / 24) === 1 ? "" : "s"}`
      : `${Math.round(hoursSince)} hour${Math.round(hoursSince) === 1 ? "" : "s"}`;

  if (commitsSince > 0) {
    parts.push(
      `${commitsSince} new commit${commitsSince === 1 ? " was" : "s were"} pushed since your last visit ${hoursLabel} ago`
    );
  }
  if (newComments > 0) {
    parts.push(
      `${newComments} new comment${newComments === 1 ? " was" : "s were"} added`
    );
  }
  return parts.join(". ") + ".";
}

interface ClaudeContextResponse {
  summary: string;
  suggestedStartLine?: string;
}

async function callClaudeForContext(input: {
  commitsSince: number;
  newComments: number;
  changedFiles: string[];
  hoursSince: number;
  lastVisitedAt: string;
}): Promise<ClaudeContextResponse | null> {
  const client = getAnthropic();
  const hoursLabel =
    input.hoursSince >= 24
      ? `${Math.floor(input.hoursSince / 24)} day${Math.floor(input.hoursSince / 24) === 1 ? "" : "s"}`
      : `${Math.round(input.hoursSince)} hours`;

  const prompt = `A developer is returning to a pull request they last reviewed ${hoursLabel} ago.

Changes since their last visit:
- New commits pushed: ${input.commitsSince}
- New comments added: ${input.newComments}
${input.changedFiles.length > 0 ? `- Files changed: ${input.changedFiles.join(", ")}` : ""}

Write a brief 2-3 sentence "welcome back" summary telling the reviewer what happened.
If there are changed files, suggest one as the best starting point.

Respond with JSON:
{"summary": "...", "suggestedStartLine": "src/foo.ts:42 — reason (optional, omit if no files)"}

Rules:
- summary must be specific and human, not generic
- No more than 3 sentences
- If no changed files, omit suggestedStartLine
- Return only valid JSON, no prose`;

  const msg = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = extractText(msg);

  // Extract JSON from response
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ClaudeContextResponse;
      if (typeof parsed.summary === "string") return parsed;
    }
  } catch {
    /* fall through */
  }

  return null;
}

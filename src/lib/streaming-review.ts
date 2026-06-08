/**
 * Streaming PR review — real-time Claude review via SSE.
 *
 * Additive to the existing batch ai-review.ts. This module streams tokens
 * from Claude as they arrive, allowing the browser to display the review
 * in real time rather than waiting 10–30 seconds for a batch result.
 *
 * Usage:
 *   for await (const token of streamPrReview(...)) {
 *     // send token as SSE event
 *   }
 */

import { eq, and, like } from "drizzle-orm";
import { db } from "../db";
import { pullRequests, prComments } from "../db/schema";
import { getRepoPath } from "../git/repository";
import { getAnthropic, isAiAvailable, MODEL_SONNET } from "./ai-client";
import { getBotUserIdOrFallback } from "./bot-user";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StreamingReviewToken {
  type: "token" | "section_start" | "section_end" | "done" | "error";
  content?: string;  // for type="token"
  section?: string;  // for section_start/end: "summary" | "finding" | "verdict"
  error?: string;    // for type="error"
}

// ---------------------------------------------------------------------------
// In-memory streaming state
// ---------------------------------------------------------------------------

/** PR IDs currently being streamed. Prevents duplicate concurrent streams. */
const _streamingPrs = new Set<string>();

/**
 * Returns true when a streaming review is already in progress for the given
 * PR id.
 */
export function isReviewStreaming(prId: string): boolean {
  return _streamingPrs.has(prId);
}

// ---------------------------------------------------------------------------
// Marker embedded in the saved comment body so we can detect duplicates
// ---------------------------------------------------------------------------

export const STREAM_REVIEW_MARKER = "<!-- gluecron:stream-review:v1 -->";

/** Max bytes of diff sent to Claude. Matches the batch reviewer's cap. */
const DIFF_BYTE_CAP = 100_000;

// ---------------------------------------------------------------------------
// Section detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect section transitions by examining accumulated lines.
 *
 * Sections (in order):
 *   1. "summary"  — opening paragraph
 *   2. "finding"  — numbered list items (lines starting with a digit + ".")
 *   3. "verdict"  — line starting with "Verdict:"
 *
 * Returns the section name when a transition is detected, or null otherwise.
 */
function detectSectionTransition(
  accumulated: string,
  prevSection: string | null
): string | null {
  // Split into lines so we can inspect the latest complete line.
  const lines = accumulated.split("\n");
  // Look at lines from the end (most recent first)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    // Verdict line — always wins
    if (line.toLowerCase().startsWith("verdict:") && prevSection !== "verdict") {
      return "verdict";
    }
    // Finding: numbered list item (e.g. "1. ", "2. ", "12. ")
    if (/^\d+\.\s/.test(line) && prevSection === "summary") {
      return "finding";
    }
    break; // Only inspect the last non-empty line
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core streaming generator
// ---------------------------------------------------------------------------

/**
 * Start a streaming review for a PR.
 *
 * Yields `StreamingReviewToken` objects as Claude produces them.
 * On completion, saves the full review text as a PR comment
 * (idempotent — skipped when the marker already exists in comments).
 */
export async function* streamPrReview(
  prId: string,
  ownerName: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): AsyncGenerator<StreamingReviewToken> {
  // Guard: AI must be configured
  if (!isAiAvailable()) {
    yield { type: "error", error: "AI not available — ANTHROPIC_API_KEY is not set" };
    return;
  }

  // Guard: prevent duplicate concurrent streams
  if (_streamingPrs.has(prId)) {
    yield { type: "error", error: "A streaming review is already in progress for this PR" };
    return;
  }

  // Idempotency: skip if a stream-review comment already exists
  try {
    const [existing] = await db
      .select({ id: prComments.id })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, prId),
          eq(prComments.isAiReview, true),
          like(prComments.body, `%${STREAM_REVIEW_MARKER}%`)
        )
      )
      .limit(1);
    if (existing) {
      yield { type: "error", error: "Streaming review already completed for this PR" };
      return;
    }
  } catch {
    // DB check failed — proceed optimistically
  }

  // Mark PR as streaming
  _streamingPrs.add(prId);

  // Accumulate full text for DB persistence
  let accumulated = "";
  let currentSection: string | null = null;

  try {
    // Compute diff via git
    let diffText = "";
    try {
      const cwd = getRepoPath(ownerName, repoName);
      const proc = Bun.spawn(
        ["git", "diff", `${baseBranch}...${headBranch}`, "--"],
        { cwd, stdout: "pipe", stderr: "pipe" }
      );
      const raw = await new Response(proc.stdout).text();
      await proc.exited;
      diffText = raw;
    } catch {
      diffText = "";
    }

    if (!diffText.trim()) {
      yield { type: "error", error: "No diff found between branches — nothing to review" };
      return;
    }

    // Cap diff size
    if (diffText.length > DIFF_BYTE_CAP) {
      diffText = diffText.slice(0, DIFF_BYTE_CAP);
    }

    // Build messages
    const systemPrompt =
      "You are a senior code reviewer. Review this PR diff section by section. " +
      "Start with a one-paragraph summary of the overall change, then list specific findings " +
      "(each as: file:line — issue description), then give a verdict " +
      "(Approve / Request Changes / Comment). Be direct and specific. " +
      "Format findings as a numbered list. Start the verdict line with 'Verdict:'.";

    const userMessage = `PR diff:\n${diffText}`;

    // Open the streaming request
    const anthropic = getAnthropic();

    // Emit the summary section start before streaming begins
    yield { type: "section_start", section: "summary" };
    currentSection = "summary";

    const stream = anthropic.messages.stream({
      model: MODEL_SONNET,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    // Stream tokens
    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        const text = chunk.delta.text;
        if (!text) continue;

        accumulated += text;

        // Check for section transitions
        const newSection = detectSectionTransition(accumulated, currentSection);
        if (newSection && newSection !== currentSection) {
          // Close the old section
          yield { type: "section_end", section: currentSection ?? "summary" };
          // Open the new section
          yield { type: "section_start", section: newSection };
          currentSection = newSection;
        }

        // Yield the token
        yield { type: "token", content: text };
      }
    }

    // Close the final section
    if (currentSection) {
      yield { type: "section_end", section: currentSection };
    }

    // Persist the full review as a PR comment (idempotent)
    if (accumulated.trim()) {
      try {
        // Re-check idempotency before insert
        const [existingCheck] = await db
          .select({ id: prComments.id })
          .from(prComments)
          .where(
            and(
              eq(prComments.pullRequestId, prId),
              eq(prComments.isAiReview, true),
              like(prComments.body, `%${STREAM_REVIEW_MARKER}%`)
            )
          )
          .limit(1);

        if (!existingCheck) {
          // Resolve author for the comment
          const [pr] = await db
            .select({ authorId: pullRequests.authorId })
            .from(pullRequests)
            .where(eq(pullRequests.id, prId))
            .limit(1);

          if (pr) {
            const commentAuthorId = await getBotUserIdOrFallback(pr.authorId);
            const commentBody = `## AI Stream Review\n\n${accumulated}\n\n${STREAM_REVIEW_MARKER}`;
            await db.insert(prComments).values({
              pullRequestId: prId,
              authorId: commentAuthorId,
              isAiReview: true,
              body: commentBody,
            });
          }
        }
      } catch (err) {
        // Non-fatal — review was streamed, just not persisted
        if (process.env.DEBUG_AI_REVIEW === "1") {
          console.error("[streaming-review] failed to persist review comment:", err);
        }
      }
    }

    yield { type: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: message };
  } finally {
    _streamingPrs.delete(prId);
  }
}

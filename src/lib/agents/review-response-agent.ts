/**
 * Block K6 — Autonomous review-response agent.
 *
 * Fires on `pr.review_comment`. Classifies the human reviewer's comment and
 * either drafts a prose reply explaining the change it would make, or posts
 * a short acknowledgement. v1 is strictly read-only with respect to the PR
 * branch — K5 (fix agent, wave 3) owns commit authorship. Every reply is
 * tagged with `isAiReview=true` and a marker string so future invocations
 * can skip replying to our own comments.
 *
 * Contract:
 *   - Never throws — all errors are caught and either recorded on the run
 *     or silently swallowed via `shouldSkip`.
 *   - If the skip rules fire we do NOT create an `agent_runs` row — agent
 *     runs should reflect work, not no-ops.
 *   - If the AI backend is unavailable we still create the run and write
 *     `summary = "AI backend unavailable; skipped reply"`, but post nothing.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  prComments,
  pullRequests,
  repositories,
  users,
} from "../../db/schema";
import {
  MODEL_HAIKU,
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
  parseJsonResponse,
} from "../ai-client";
import {
  executeAgentRun,
  startAgentRun,
  type AgentExecutorResult,
} from "../agent-runtime";
import { getDefaultBranch, getDiff } from "../../git/repository";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunReviewResponseAgentArgs {
  repositoryId: string;
  prId: string;
  prNumber: number;
  commentId: string;
  commentBody: string;
  commenterId?: string;
  filePath?: string;
  lineNumber?: number;
}

export interface RunReviewResponseAgentResult {
  skipped: boolean;
  skipReason?: string;
  runId?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without DB / network)
// ---------------------------------------------------------------------------

/**
 * Marker we embed at the tail of every AI-authored reply. Used as a
 * best-effort loop-breaker: if we see our own marker at the end of the
 * parent-comment body we refuse to reply again.
 */
export const AI_REPLY_MARKER =
  "— drafted by review-response agent; human must apply or reject";

/** Single-emoji / reaction detector. */
const EMOJI_RANGE =
  /^[\s\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u200d\uFE0F]+$/u;
const REACTION_WORDS: ReadonlySet<string> = new Set([
  "lgtm",
  "+1",
  "-1",
  "👍",
  "👎",
  "ok",
  "okay",
  "ack",
  "ty",
  "thx",
  "thanks",
  "nice",
  "cool",
  "great",
  "yep",
  "yes",
  "no",
  "nope",
  "same",
]);

/**
 * Args accepted by `shouldSkip`. Slightly wider than the runtime args so
 * tests can inject an explicit commenter username + PR state without
 * hitting the DB.
 */
export interface ShouldSkipInput {
  commentBody: string;
  commenterUsername?: string | null;
  prState?: string | null;
  parentBody?: string | null;
}

export interface ShouldSkipResult {
  skip: boolean;
  reason?: string;
}

/** Pure skip-logic. Exported for unit tests. */
export function shouldSkip(input: ShouldSkipInput): ShouldSkipResult {
  const body = (input.commentBody || "").trim();
  if (!body) return { skip: true, reason: "empty body" };
  if (body.length < 10) return { skip: true, reason: "body too short" };

  const username = input.commenterUsername || "";
  if (username.endsWith("[bot]")) {
    return { skip: true, reason: "bot author" };
  }

  // Single emoji (possibly with ZWJ / variation selectors).
  if (EMOJI_RANGE.test(body)) {
    return { skip: true, reason: "single emoji" };
  }

  // Single reaction word (case-insensitive, strip trailing punctuation).
  const stripped = body.toLowerCase().replace(/[!.?\s]+$/g, "");
  if (REACTION_WORDS.has(stripped)) {
    return { skip: true, reason: "reaction word" };
  }

  // PR already closed/merged — don't spam a dead thread.
  const prState = (input.prState || "").toLowerCase();
  if (prState === "closed" || prState === "merged") {
    return { skip: true, reason: "pr not open" };
  }

  // Reply to one of our own AI comments — best-effort loop-breaker.
  if (input.parentBody && input.parentBody.includes(AI_REPLY_MARKER)) {
    return { skip: true, reason: "reply to ai comment" };
  }
  if (body.includes(AI_REPLY_MARKER)) {
    // Someone quoted our marker verbatim — still treat as AI echo.
    return { skip: true, reason: "body contains ai marker" };
  }

  return { skip: false };
}

// ---------------------------------------------------------------------------
// AI classification + drafting
// ---------------------------------------------------------------------------

export interface CommentClassification {
  actionable: boolean;
  intent: "question" | "change_request" | "nit" | "praise" | "other";
  touches_files: string[];
  suggested_action: string;
  confidence: number;
}

const FALLBACK_CLASSIFICATION: CommentClassification = {
  actionable: false,
  intent: "other",
  touches_files: [],
  suggested_action: "",
  confidence: 0,
};

const ALLOWED_INTENTS: ReadonlyArray<CommentClassification["intent"]> = [
  "question",
  "change_request",
  "nit",
  "praise",
  "other",
];

/** Minimum classifier confidence to draft a Sonnet reply. */
export const CONFIDENCE_THRESHOLD = 0.6;

async function classifyComment(
  commentBody: string,
  filePath: string | undefined,
  lineNumber: number | undefined
): Promise<{ parsed: CommentClassification; inputTokens: number; outputTokens: number }> {
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `Classify this PR review comment. Respond ONLY with JSON:

{"actionable": true|false, "intent": "question|change_request|nit|praise|other", "touches_files": ["path1"], "suggested_action": "one sentence", "confidence": 0.0-1.0}

Comment${filePath ? ` on ${filePath}${lineNumber ? `:${lineNumber}` : ""}` : ""}:
"""
${commentBody.slice(0, 4000)}
"""

Rules:
- actionable=true only when the comment asks for or implies a concrete code change.
- intent: question = asks for info; change_request = wants code modified; nit = trivial style; praise = compliment only; other = anything else.
- confidence reflects certainty in the classification, not confidence a fix is possible.
- touches_files should only include paths the comment explicitly mentions or strongly implies. Omit if unclear.`,
        },
      ],
    });
    const parsed = parseJsonResponse<CommentClassification>(extractText(message));
    if (!parsed) return { parsed: FALLBACK_CLASSIFICATION, inputTokens: message.usage?.input_tokens ?? 0, outputTokens: message.usage?.output_tokens ?? 0 };
    const intent = ALLOWED_INTENTS.includes(parsed.intent as never)
      ? parsed.intent
      : "other";
    const normalised: CommentClassification = {
      actionable: !!parsed.actionable,
      intent,
      touches_files: Array.isArray(parsed.touches_files)
        ? parsed.touches_files.filter((s) => typeof s === "string").slice(0, 16)
        : [],
      suggested_action:
        typeof parsed.suggested_action === "string"
          ? parsed.suggested_action.slice(0, 500)
          : "",
      confidence:
        typeof parsed.confidence === "number" &&
        parsed.confidence >= 0 &&
        parsed.confidence <= 1
          ? parsed.confidence
          : 0,
    };
    return {
      parsed: normalised,
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    console.error("[review-response-agent] classify failed:", err);
    return { parsed: FALLBACK_CLASSIFICATION, inputTokens: 0, outputTokens: 0 };
  }
}

async function draftReply(
  repoFullName: string,
  prNumber: number,
  commentBody: string,
  classification: CommentClassification,
  diffContext: string,
  filePath: string | undefined,
  lineNumber: number | undefined
): Promise<{ body: string; inputTokens: number; outputTokens: number }> {
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are the GlueCron review-response agent on PR #${prNumber} of ${repoFullName}.
A human reviewer left this comment${filePath ? ` on ${filePath}${lineNumber ? `:${lineNumber}` : ""}` : ""}:

"""
${commentBody.slice(0, 4000)}
"""

Classifier said: intent=${classification.intent}, suggested_action="${classification.suggested_action}".

Relevant diff excerpt (may be empty):
\`\`\`
${diffContext.slice(0, 6000)}
\`\`\`

Write a short Markdown reply that:
1. Acknowledges the comment.
2. Describes the change you WOULD make in prose (no actual patch — you cannot push commits in v1).
3. If a diff excerpt in \`\`\`suggestion\`\`\` blocks helps, include at most one, kept minimal.
4. Ends with exactly this sentence on its own line:
${AI_REPLY_MARKER}

Keep it under 200 words. Be specific; reference file paths where possible. Do not apologise unless the reviewer found a real bug.`,
        },
      ],
    });
    let text = extractText(message).trim();
    if (!text.includes(AI_REPLY_MARKER)) {
      text = `${text}\n\n${AI_REPLY_MARKER}`;
    }
    return {
      body: text,
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    console.error("[review-response-agent] draft failed:", err);
    return { body: "", inputTokens: 0, outputTokens: 0 };
  }
}

function acknowledgementBody(intent: CommentClassification["intent"]): string {
  const lead =
    intent === "praise"
      ? "Thanks for the feedback!"
      : intent === "nit"
        ? "Noted — stylistic call-out."
        : intent === "question"
          ? "Noted — this looks informational."
          : "Noted — no code change required.";
  return `${lead} No change required from my side.\n\n${AI_REPLY_MARKER}`;
}

// ---------------------------------------------------------------------------
// DB lookups
// ---------------------------------------------------------------------------

async function lookupContext(args: RunReviewResponseAgentArgs): Promise<{
  commenterUsername: string | null;
  prState: string | null;
  prHeadBranch: string | null;
  repoOwnerUsername: string | null;
  repoName: string | null;
  parentBody: string | null;
  botAuthorId: string | null;
} | null> {
  try {
    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, args.prId))
      .limit(1);
    if (!pr) return null;

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, args.repositoryId))
      .limit(1);
    let ownerUsername: string | null = null;
    let repoName: string | null = null;
    if (repo) {
      repoName = repo.name;
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.id, repo.ownerId))
        .limit(1);
      ownerUsername = owner?.username ?? null;
    }

    let commenterUsername: string | null = null;
    if (args.commenterId) {
      const [commenter] = await db
        .select()
        .from(users)
        .where(eq(users.id, args.commenterId))
        .limit(1);
      commenterUsername = commenter?.username ?? null;
    }

    // Pick up the body of the comment we're responding to (for AI-marker check).
    let parentBody: string | null = null;
    try {
      const [parent] = await db
        .select()
        .from(prComments)
        .where(eq(prComments.id, args.commentId))
        .limit(1);
      parentBody = parent?.body ?? null;
    } catch {
      parentBody = null;
    }

    // Find a usable author id for the inserted row. Prefer the repo owner
    // (same pattern ai-incident uses to attribute auto-issues).
    let botAuthorId: string | null = null;
    if (repo) botAuthorId = repo.ownerId;

    return {
      commenterUsername,
      prState: pr.state,
      prHeadBranch: pr.headBranch,
      repoOwnerUsername: ownerUsername,
      repoName,
      parentBody,
      botAuthorId,
    };
  } catch (err) {
    console.error("[review-response-agent] lookupContext:", err);
    return null;
  }
}

async function fetchDiffContext(
  ownerUsername: string | null,
  repoName: string | null,
  headBranch: string | null
): Promise<string> {
  if (!ownerUsername || !repoName || !headBranch) return "";
  try {
    const defaultBranch =
      (await getDefaultBranch(ownerUsername, repoName).catch(() => null)) ||
      "main";
    const headSha = headBranch; // getDiff will resolve ref names too via git internally for common cases
    // Avoid enormous diffs — we just need enough context for a prose reply.
    const { raw } = await getDiff(ownerUsername, repoName, headSha).catch(
      () => ({ raw: "", files: [] as unknown[] })
    );
    if (raw && raw.length > 0) return raw;
    // Fallback: compare head to default if above failed
    const compare = await getDiff(ownerUsername, repoName, defaultBranch).catch(
      () => ({ raw: "" })
    );
    return compare.raw || "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget entry point invoked by the pulls.tsx review-comment POST
 * handler. Never throws. Returns metadata about whether a run was started.
 */
export async function runReviewResponseAgent(
  args: RunReviewResponseAgentArgs
): Promise<RunReviewResponseAgentResult> {
  try {
    // Fast skip without DB / AI: things we can decide from the body alone.
    const preSkip = shouldSkip({
      commentBody: args.commentBody,
      commenterUsername: null,
      prState: null,
      parentBody: null,
    });
    if (preSkip.skip) {
      return { skipped: true, skipReason: preSkip.reason };
    }

    const ctx = await lookupContext(args);
    if (!ctx) {
      return { skipped: true, skipReason: "context lookup failed" };
    }

    const fullSkip = shouldSkip({
      commentBody: args.commentBody,
      commenterUsername: ctx.commenterUsername,
      prState: ctx.prState,
      parentBody: ctx.parentBody,
    });
    if (fullSkip.skip) {
      return { skipped: true, skipReason: fullSkip.reason };
    }

    const run = await startAgentRun({
      repositoryId: args.repositoryId,
      kind: "review_response",
      trigger: "pr.review_comment",
      triggerRef: `${args.prNumber}:${args.commentId}`,
    });
    if (!run) {
      return { skipped: true, skipReason: "could not start run" };
    }

    await executeAgentRun(run.id, async (execCtx): Promise<AgentExecutorResult> => {
      await execCtx.appendLog(
        `classifying comment ${args.commentId} on PR #${args.prNumber}`
      );

      if (!isAiAvailable()) {
        await execCtx.appendLog("AI backend unavailable; skipping reply");
        return {
          ok: true,
          summary: "AI backend unavailable; skipped reply",
        };
      }

      const { parsed: classification, inputTokens: cIn, outputTokens: cOut } =
        await classifyComment(
          args.commentBody,
          args.filePath,
          args.lineNumber
        );
      await execCtx.recordCost(cIn, cOut, 0);
      await execCtx.appendLog(
        `classified: actionable=${classification.actionable} intent=${classification.intent} confidence=${classification.confidence}`
      );

      let replyBody: string;
      if (
        classification.actionable &&
        classification.confidence >= CONFIDENCE_THRESHOLD
      ) {
        const repoFullName =
          ctx.repoOwnerUsername && ctx.repoName
            ? `${ctx.repoOwnerUsername}/${ctx.repoName}`
            : "repository";
        const diffContext = await fetchDiffContext(
          ctx.repoOwnerUsername,
          ctx.repoName,
          ctx.prHeadBranch
        );
        const draft = await draftReply(
          repoFullName,
          args.prNumber,
          args.commentBody,
          classification,
          diffContext,
          args.filePath,
          args.lineNumber
        );
        await execCtx.recordCost(draft.inputTokens, draft.outputTokens, 0);
        if (!draft.body) {
          replyBody = acknowledgementBody(classification.intent);
          await execCtx.appendLog("draft failed; falling back to ack");
        } else {
          replyBody = draft.body;
        }
      } else {
        replyBody = acknowledgementBody(classification.intent);
      }

      if (!ctx.botAuthorId) {
        await execCtx.appendLog("no bot author resolvable; refusing to post");
        return {
          ok: false,
          summary: "no author id available for reply",
        };
      }

      try {
        await db.insert(prComments).values({
          pullRequestId: args.prId,
          authorId: ctx.botAuthorId,
          body: replyBody,
          isAiReview: true,
          filePath: args.filePath ?? null,
          lineNumber: args.lineNumber ?? null,
        });
      } catch (err) {
        await execCtx.appendLog(
          `insert failed: ${(err as Error).message || "unknown"}`
        );
        return {
          ok: false,
          summary: "reply insert failed",
        };
      }

      return {
        ok: true,
        summary: `replied (${classification.intent})`,
      };
    });

    return { skipped: false, runId: run.id };
  } catch (err) {
    console.error("[review-response-agent] unexpected:", err);
    return { skipped: true, skipReason: "unexpected error" };
  }
}

// Re-exported for tests.
export const __internal = {
  FALLBACK_CLASSIFICATION,
  acknowledgementBody,
};

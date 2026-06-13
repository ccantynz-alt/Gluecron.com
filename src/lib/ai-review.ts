/**
 * AI-powered code review using Claude.
 *
 * Generates inline review comments on pull request diffs.
 * Reviews are posted as PR comments with isAiReview=true.
 */

import Anthropic from "@anthropic-ai/sdk";
import { eq, and, like } from "drizzle-orm";
import { db } from "../db";
import { pullRequests, prComments } from "../db/schema";
import { getRepoPath } from "../git/repository";
import { config } from "./config";
import { recordAiCost, extractUsage } from "./ai-cost-tracker";
import {
  isTrioReviewEnabled,
  alreadyTrioReviewed,
  runTrioReview,
} from "./ai-review-trio";
import { assertAiQuota, AiQuotaExceededError } from "./billing";
import { getBotUserIdOrFallback } from "./bot-user";
import {
  getAutomationSettings,
  type AutomationSettingsLoader,
} from "./automation-settings";

interface ReviewComment {
  filePath: string;
  lineNumber: number | null;
  body: string;
}

interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  approved: boolean;
}

/**
 * Marker we drop into the AI summary comment body. Used to detect a
 * prior review and short-circuit duplicate runs (e.g. when a PR is
 * marked draft → ready → draft → ready).
 */
export const AI_REVIEW_MARKER = "<!-- gluecron-ai-review:summary -->";

/** Max bytes of diff we send to Claude. Matches reviewDiff's internal cap. */
const DIFF_BYTE_CAP = 100_000;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return _client;
}

/**
 * Run AI code review on a PR diff.
 */
export async function reviewDiff(
  repoFullName: string,
  prTitle: string,
  prBody: string | null,
  baseBranch: string,
  headBranch: string,
  diffText: string
): Promise<ReviewResult> {
  const client = getClient();

  const REVIEW_MODEL = "claude-sonnet-4-6";
  const message = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are reviewing a pull request on the repository "${repoFullName}".

**PR Title:** ${prTitle}
**PR Description:** ${prBody || "(none)"}
**Base branch:** ${baseBranch}
**Head branch:** ${headBranch}

Review the following diff. Look for:
- Bugs, logic errors, or potential runtime failures
- Security vulnerabilities (injection, XSS, auth bypasses, secrets in code)
- Performance issues (N+1 queries, unnecessary allocations, blocking I/O)
- Missing error handling at system boundaries
- Breaking changes or API contract violations

Do NOT comment on style, formatting, naming, missing docs, or minor nitpicks. Only flag issues that could cause real problems.

Respond in JSON format:
{
  "summary": "1-3 sentence overall assessment",
  "approved": true/false,
  "comments": [
    {
      "filePath": "path/to/file.ts",
      "lineNumber": 42,
      "body": "Explain the issue and suggest a fix"
    }
  ]
}

If the diff looks clean, return approved: true with an empty comments array.

\`\`\`diff
${diffText.slice(0, 100000)}
\`\`\``,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";

  // Best-effort cost capture. Caller passes "owner/repo" as repoFullName,
  // so we can't easily resolve the repo id here; the call site at
  // `triggerAiReview` records with a repository_id below.
  try {
    const usage = extractUsage(message);
    await recordAiCost({
      model: REVIEW_MODEL,
      inputTokens: usage.input,
      outputTokens: usage.output,
      category: "ai_review",
      sourceKind: "pull_request",
    });
  } catch {
    /* never escape — observational only */
  }

  try {
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // FAIL-CLOSED: parsing failure must NOT count as approval. Previously
      // this returned approved:true, which silently auto-approved PRs
      // whenever Claude's output drifted off the JSON spec — a real auto-
      // merge hazard. Surface the failure in the summary instead.
      return {
        summary:
          "AI review failed: model returned output that could not be parsed as JSON. Treating as not-approved; a human reviewer should look at this PR.",
        comments: [],
        approved: false,
      };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: parsed.summary || "Review complete.",
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      // Require explicit `approved: true` — undefined or any other value
      // is treated as not-approved. Same fail-closed principle as above.
      approved: parsed.approved === true,
    };
  } catch (err) {
    // FAIL-CLOSED: JSON.parse threw (truncated output, schema-shaped
    // garbage, etc.). Echo a short error tail so operators have a
    // breadcrumb in the comment body, but never approve.
    const tail = err instanceof Error ? err.message.slice(0, 200) : String(err);
    return {
      summary: `AI review failed to parse model output (${tail}). Treating as not-approved; a human reviewer should look at this PR.`,
      comments: [],
      approved: false,
    };
  }
}

/**
 * Check if AI review is available (API key configured).
 */
export function isAiReviewEnabled(): boolean {
  return !!config.anthropicApiKey;
}

/**
 * Compute the merge-base diff between two branches in a bare repo.
 * Returns "" on any error so callers can no-op cleanly. Uses the
 * three-dot `base...head` form so the diff is what changed on `head`
 * relative to the common ancestor with `base` (which is the PR
 * conventional view, not a literal range diff).
 */
async function diffBetweenBranches(
  ownerName: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): Promise<string> {
  try {
    const cwd = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      [
        "git",
        "diff",
        `${baseBranch}...${headBranch}`,
        "--",
      ],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}

/**
 * Resolve a branch name to its current commit SHA via `git rev-parse`.
 * Returns "" on any error — callers should treat that as "unknown" and
 * carry on; this is only used for audit metadata.
 */
async function resolveHeadSha(
  ownerName: string,
  repoName: string,
  branch: string
): Promise<string> {
  try {
    const cwd = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(["git", "rev-parse", branch], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
  } catch {
    return "";
  }
}

/**
 * Has this PR already been reviewed by the AI? Detected by an existing
 * PR comment carrying our summary marker. Cheap LIKE query — if it
 * fails (DB hiccup) we fall back to "not yet" and re-review, which is
 * idempotent at worst (a duplicate summary), never destructive.
 */
async function alreadyReviewed(prId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: prComments.id })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, prId),
          eq(prComments.isAiReview, true),
          like(prComments.body, `%${AI_REVIEW_MARKER}%`)
        )
      )
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Real AI review trigger. Replaces the previous stub. Pipeline:
 *
 *   1. Idempotency check — bail if a prior review summary exists.
 *   2. Compute the base...head diff via the bare repo.
 *   3. Call reviewDiff for a structured response (summary + per-file
 *      comments + approved boolean).
 *   4. Persist:
 *      - one summary comment (isAiReview=true, marker embedded), and
 *      - one comment per inline finding (isAiReview=true, filePath +
 *        lineNumber populated).
 *
 * Always fire-and-forget at the call site (`.catch(...)`); this
 * function still never throws so the catch is belt-and-braces. AI
 * comments are authored by the PR author so the existing comment
 * rendering can group them naturally — there is no synthetic bot user
 * yet (tracked alongside H2 app-bot identity work).
 */
export async function triggerAiReview(
  ownerName: string,
  repoName: string,
  prId: string,
  title: string,
  body: string,
  baseBranch: string,
  headBranch: string,
  options: { force?: boolean; loadSettings?: AutomationSettingsLoader } = {}
): Promise<void> {
  try {
    if (!isAiReviewEnabled()) return;
    const useTrio = isTrioReviewEnabled();
    if (
      !options.force &&
      (useTrio
        ? await alreadyTrioReviewed(prId)
        : await alreadyReviewed(prId))
    )
      return;

    const [pr] = await db
      .select({
        id: pullRequests.id,
        authorId: pullRequests.authorId,
        repositoryId: pullRequests.repositoryId,
      })
      .from(pullRequests)
      .where(eq(pullRequests.id, prId))
      .limit(1);
    if (!pr) return;

    // Per-repo automation gate — 'off' skips AI review entirely. The loader
    // fails open to the defaults ('suggest' = current behavior), so a broken
    // settings lookup can never disable reviews.
    const automation = await (options.loadSettings ?? getAutomationSettings)(
      pr.repositoryId
    );
    if (automation.aiReviewMode === "off") return;

    // Hard quota gate — post a comment and bail if the user's AI budget is
    // exhausted. This runs after loading the PR so we have authorId for the
    // comment insert.
    try {
      await assertAiQuota(pr.authorId);
    } catch (err) {
      if (err instanceof AiQuotaExceededError) {
        await db
          .insert(prComments)
          .values({
            pullRequestId: prId,
            authorId: pr.authorId,
            isAiReview: true,
            body: `${AI_REVIEW_MARKER}\n## AI review skipped\n\nYour monthly AI token budget has been reached. Upgrade at [/settings/billing](/settings/billing) to re-enable AI code review.`,
          })
          .catch(() => {});
        return;
      }
      // Any other error from assertAiQuota is unexpected — log and proceed
      // (fail open so a billing glitch never silently kills reviews).
      console.warn("[ai-review] assertAiQuota failed unexpectedly:", err);
    }

    let diffText = await diffBetweenBranches(
      ownerName,
      repoName,
      baseBranch,
      headBranch
    );
    if (!diffText.trim()) return;
    if (diffText.length > DIFF_BYTE_CAP) {
      diffText = diffText.slice(0, DIFF_BYTE_CAP);
    }

    // Trio path — replaces the single-Claude review when enabled. The
    // trio helper owns its own persistence + audit; we bail after it.
    if (useTrio) {
      try {
        const headSha = await resolveHeadSha(ownerName, repoName, headBranch);
        await runTrioReview({
          pullRequestId: prId,
          headSha,
          diff: diffText,
          repositoryId: pr.repositoryId,
        });
      } catch (err) {
        if (process.env.DEBUG_AI_REVIEW === "1") {
          console.error("[ai-review] trio crashed:", err);
        }
      }
      return;
    }

    // Resolve the bot user id once; fall back to the PR author so that
    // comment insertion never fails even before migration 0078 has run.
    const commentAuthorId = await getBotUserIdOrFallback(pr.authorId);

    let result: ReviewResult;
    try {
      result = await reviewDiff(
        `${ownerName}/${repoName}`,
        title,
        body || null,
        baseBranch,
        headBranch,
        diffText
      );
    } catch (err) {
      // Anthropic API failure — degrade to a single advisory comment so
      // PR authors see the attempt rather than silence.
      const reason = err instanceof Error ? err.message : "unknown error";
      await db
        .insert(prComments)
        .values({
          pullRequestId: prId,
          authorId: commentAuthorId,
          isAiReview: true,
          body: `${AI_REVIEW_MARKER}\n## AI review unavailable\n\nThe AI review attempt failed: ${reason}. The PR is otherwise unchanged.`,
        })
        .catch((err) => {
          // Was a silent .catch(() => {}) — DB blips here meant the user
          // saw no review comment AND no diagnostic. Log so operators
          // can investigate, but don't re-throw (caller is fire-and-forget).
          console.error(
            `[ai-review] failed to insert API-failure advisory comment for PR ${prId}:`,
            err instanceof Error ? err.message : err
          );
        });
      return;
    }

    const verdict = result.approved
      ? "**AI review:** no blocking issues found."
      : `**AI review:** flagged ${result.comments.length} item(s) for human attention.`;
    const summaryBody = `${AI_REVIEW_MARKER}\n## AI Code Review\n\n${verdict}\n\n${result.summary}`;
    await db
      .insert(prComments)
      .values({
        pullRequestId: prId,
        authorId: commentAuthorId,
        isAiReview: true,
        body: summaryBody,
      })
      .catch((err) => {
        console.error(
          `[ai-review] failed to insert summary comment for PR ${prId}:`,
          err instanceof Error ? err.message : err
        );
      });

    for (const c of result.comments) {
      if (!c || !c.body) continue;
      const filePath =
        typeof c.filePath === "string" && c.filePath ? c.filePath : null;
      const lineNumber =
        Number.isInteger(c.lineNumber) && (c.lineNumber as number) > 0
          ? (c.lineNumber as number)
          : null;
      await db
        .insert(prComments)
        .values({
          pullRequestId: prId,
          authorId: commentAuthorId,
          isAiReview: true,
          body: c.body,
          filePath,
          lineNumber,
        })
        .catch((err) => {
          console.error(
            `[ai-review] failed to insert inline comment for PR ${prId} (${filePath}:${lineNumber}):`,
            err instanceof Error ? err.message : err
          );
        });
    }

    if (process.env.DEBUG_AI_REVIEW === "1") {
      console.log(
        "[ai-review] reviewed",
        ownerName,
        repoName,
        prId,
        `comments=${result.comments.length}`,
        `approved=${result.approved}`
      );
    }
  } catch (err) {
    // Belt-and-braces: never escape into the request path.
    if (process.env.DEBUG_AI_REVIEW === "1") {
      console.error("[ai-review] crashed:", err);
    }
  }
}

/**
 * Test-only export: the internal helpers. Not part of the public API.
 */
export const __test = {
  diffBetweenBranches,
  alreadyReviewed,
};

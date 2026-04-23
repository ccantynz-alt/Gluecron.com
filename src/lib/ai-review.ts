/**
 * AI-powered code review using Claude.
 *
 * Generates inline review comments on pull request diffs.
 * Reviews are posted as PR comments with isAiReview=true.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { getRepoPath } from "../git/repository";

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
  if (!isAiReviewEnabled()) {
    return { summary: "AI review unavailable: ANTHROPIC_API_KEY not configured.", comments: [], approved: true };
  }
  const client = getClient();

  let text = "";
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
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
    text = message.content[0].type === "text" ? message.content[0].text : "";
  } catch (err) {
    console.error("[ai-review] reviewDiff API call failed:", err);
    return { summary: "AI review failed due to an API error.", comments: [], approved: true };
  }

  try {
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        summary: "AI review completed but could not parse structured output.",
        comments: [],
        approved: true,
      };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: parsed.summary || "Review complete.",
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      approved: parsed.approved !== false,
    };
  } catch {
    return {
      summary: text.slice(0, 500),
      comments: [],
      approved: true,
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
 * Fire-and-forget AI review trigger. Gets the branch diff, runs Claude review,
 * and posts the results as pr_comments with isAiReview=true.
 */
export async function triggerAiReview(
  ownerName: string,
  repoName: string,
  prId: string,
  title: string,
  body: string,
  baseBranch: string,
  headBranch: string,
): Promise<void> {
  if (!isAiReviewEnabled()) return;
  try {
    // Get branch diff
    const repoDir = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      ["git", "diff", `${baseBranch}...${headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const diffRaw = await new Response(proc.stdout).text();
    await proc.exited;

    if (!diffRaw.trim()) return;

    const result = await reviewDiff(
      `${ownerName}/${repoName}`,
      title,
      body,
      baseBranch,
      headBranch,
      diffRaw
    );

    // Load DB + schema lazily to avoid circular imports at module load time
    const { db } = await import("../db");
    const { pullRequests, prComments } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");

    const [pr] = await db
      .select({ repositoryId: pullRequests.repositoryId, authorId: pullRequests.authorId })
      .from(pullRequests)
      .where(eq(pullRequests.id, prId))
      .limit(1);

    if (!pr) return;

    // Post summary comment
    await db.insert(prComments).values({
      pullRequestId: prId,
      authorId: pr.authorId,
      body: `**AI Code Review** ${result.approved ? "✓ Approved" : "⚠ Changes requested"}\n\n${result.summary}`,
      isAiReview: true,
    });

    // Post inline comments
    for (const comment of result.comments) {
      if (!comment.body) continue;
      await db.insert(prComments).values({
        pullRequestId: prId,
        authorId: pr.authorId,
        body: comment.body,
        isAiReview: true,
        filePath: comment.filePath || null,
        lineNumber: comment.lineNumber || null,
      });
    }

    if (process.env.DEBUG_AI_REVIEW === "1") {
      console.log("[ai-review] posted", 1 + result.comments.length, "comments on", ownerName, repoName, prId);
    }
  } catch (err) {
    console.error("[ai-review] triggerAiReview failed:", err);
  }
}

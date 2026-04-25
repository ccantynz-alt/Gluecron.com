/**
 * AI-powered code review using Claude.
 *
 * Generates inline review comments on pull request diffs.
 * Reviews are posted as PR comments with isAiReview=true.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { MODEL_SONNET } from "./ai-client";

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
  const client = getClient();

  const message = await client.messages.create({
    model: MODEL_SONNET,
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
 * Fire-and-forget AI review trigger. Callers .catch() failures.
 * Currently a stub that defers to reviewDiff once the diff is available.
 */
export async function triggerAiReview(
  ownerName: string,
  repoName: string,
  _prId: string,
  _title: string,
  _body: string,
  _baseBranch: string,
  _headBranch: string,
): Promise<void> {
  if (!isAiReviewEnabled()) return;
  if (process.env.DEBUG_AI_REVIEW === "1") {
    console.log("[ai-review] queued", ownerName, repoName, _prId);
  }
}

/**
 * AI-powered code review using Claude.
 *
 * Generates inline review comments on pull request diffs.
 * Reviews are posted as PR comments with isAiReview=true.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { buildReviewContext } from "./flywheel";

interface ReviewComment {
  filePath: string;
  lineNumber: number | null;
  body: string;
  category?: string;
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
  diffText: string,
  opts?: { repositoryId?: string }
): Promise<ReviewResult> {
  const client = getClient();

  // Flywheel: inject learned patterns from historical review data
  const dominantLang = detectDominantLanguage(diffText);
  const learnedContext = await buildReviewContext(
    opts?.repositoryId ?? null,
    dominantLang ?? undefined
  ).catch(() => "");

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

Do NOT comment on style, formatting, naming, missing docs, or minor nitpicks. Only flag issues that could cause real problems.${learnedContext}

For each comment, classify it into one of these categories: bug, security, perf, logic, breaking.

Respond in JSON format:
{
  "summary": "1-3 sentence overall assessment",
  "approved": true/false,
  "comments": [
    {
      "filePath": "path/to/file.ts",
      "lineNumber": 42,
      "body": "Explain the issue and suggest a fix",
      "category": "bug"
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

function detectDominantLanguage(diff: string): string | null {
  const extCounts = new Map<string, number>();
  const fileHeaders = diff.matchAll(/^(?:\+\+\+|---) [ab]\/(.+)$/gm);
  for (const m of fileHeaders) {
    const ext = m[1].split(".").pop()?.toLowerCase();
    if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  if (extCounts.size === 0) return null;
  const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
  const extMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    kt: "kotlin", cs: "csharp", cpp: "cpp", c: "c", swift: "swift",
    php: "php", sql: "sql",
  };
  return extMap[sorted[0][0]] ?? sorted[0][0];
}

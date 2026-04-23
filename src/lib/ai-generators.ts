/**
 * AI generators — commit messages, PR descriptions, changelogs, issue triage.
 * All exposed via POST endpoints for CLI hooks + web UI convenience.
 */

import {
  getAnthropic,
  MODEL_HAIKU,
  MODEL_SONNET,
  extractText,
  parseJsonResponse,
  isAiAvailable,
} from "./ai-client";

export async function generateCommitMessage(diff: string): Promise<string> {
  if (!isAiAvailable() || !diff.trim()) {
    return "chore: update files";
  }
  const client = getAnthropic();
  const message = await client.messages.create({
    model: MODEL_HAIKU,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Write a single conventional-commit message for this diff. One line subject under 72 chars, lowercase type (feat/fix/refactor/chore/docs/test/perf/style), then optional body wrapped at 72 chars. No backticks or markdown.

Diff:
\`\`\`
${diff.slice(0, 40000)}
\`\`\``,
      },
    ],
  });
  return extractText(message).trim();
}

export async function generatePrSummary(
  title: string,
  diff: string
): Promise<string> {
  if (!isAiAvailable() || !diff.trim()) return "";
  const client = getAnthropic();
  const message = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Generate a Markdown PR description for the following changes. Include: Summary (1-3 sentences focused on why), Key changes (bullets), Test plan (bullets), Risks (bullets — omit if minor).

Title: ${title}

Diff:
\`\`\`
${diff.slice(0, 60000)}
\`\`\``,
      },
    ],
  });
  return extractText(message).trim();
}

export async function generateChangelog(
  repoFullName: string,
  fromRef: string | null,
  toRef: string,
  commits: Array<{ sha: string; message: string; author: string }>
): Promise<string> {
  if (!isAiAvailable() || commits.length === 0) {
    const header = `## ${toRef}${fromRef ? ` (since ${fromRef})` : ""}\n\n`;
    return (
      header +
      commits
        .map((c) => `- ${c.message.split("\n")[0]} (${c.sha.slice(0, 7)}) — ${c.author}`)
        .join("\n")
    );
  }
  const client = getAnthropic();
  const commitBlob = commits
    .slice(0, 200)
    .map((c) => `- ${c.sha.slice(0, 7)} ${c.message.split("\n")[0]} — ${c.author}`)
    .join("\n");
  const plainFallback = () =>
    `## ${toRef}${fromRef ? ` (since ${fromRef})` : ""}\n\n` +
    commits.map((c) => `- ${c.message.split("\n")[0]} (${c.sha.slice(0, 7)}) — ${c.author}`).join("\n");
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Generate a polished release-notes changelog in Markdown for ${repoFullName}.

Release: ${toRef}
Previous: ${fromRef || "(initial)"}

Group commits by category (Features, Fixes, Performance, Refactoring, Docs, Other). Omit empty categories. Use bullet points. Keep it concise — no marketing fluff, just the facts a user of the project needs. Reference SHAs in parentheses.

Commits:
${commitBlob}`,
        },
      ],
    });
    return extractText(message).trim() || plainFallback();
  } catch (err) {
    console.error("[ai-generators] generateChangelog failed:", err);
    return plainFallback();
  }
}

interface IssueTriage {
  suggestedLabels: string[];
  duplicateOfIssueNumber: number | null;
  priority: "critical" | "high" | "medium" | "low";
  summary: string;
}

export async function triageIssue(
  title: string,
  body: string,
  existingLabels: string[],
  recentIssues: Array<{ number: number; title: string }>
): Promise<IssueTriage> {
  const fallback: IssueTriage = {
    suggestedLabels: [],
    duplicateOfIssueNumber: null,
    priority: "medium",
    summary: "",
  };
  if (!isAiAvailable()) return fallback;
  const client = getAnthropic();
  const message = await client.messages.create({
    model: MODEL_HAIKU,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Triage this new GitHub-style issue.

Title: ${title}
Body:
${body.slice(0, 4000)}

Available labels: ${existingLabels.join(", ") || "(none)"}
Recent issues (to check for duplicates):
${recentIssues.map((i) => `#${i.number}: ${i.title}`).join("\n")}

Respond ONLY with JSON:
{
  "suggestedLabels": ["label1", "label2"],
  "duplicateOfIssueNumber": null,
  "priority": "medium",
  "summary": "one sentence"
}
Only suggest labels from the available list. Set duplicateOfIssueNumber only when confident.`,
      },
    ],
  });
  const parsed = parseJsonResponse<IssueTriage>(extractText(message));
  if (!parsed) return fallback;
  return {
    suggestedLabels: Array.isArray(parsed.suggestedLabels)
      ? parsed.suggestedLabels.filter((l) => existingLabels.includes(l))
      : [],
    duplicateOfIssueNumber:
      typeof parsed.duplicateOfIssueNumber === "number"
        ? parsed.duplicateOfIssueNumber
        : null,
    priority: (["critical", "high", "medium", "low"] as const).includes(
      parsed.priority as never
    )
      ? parsed.priority
      : "medium",
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

/**
 * D3 — AI PR triage. Reads the PR title/body + optional diff summary and
 * suggests labels, reviewers, and a priority. Never throws; degrades to
 * empty suggestions when the Anthropic key is absent.
 */
export interface PrTriage {
  suggestedLabels: string[];
  suggestedReviewerUsernames: string[];
  priority: "critical" | "high" | "medium" | "low";
  riskArea: "frontend" | "backend" | "infra" | "docs" | "tests" | "mixed";
  summary: string;
}

export async function triagePullRequest(
  title: string,
  body: string,
  diffSummary: string,
  availableLabels: string[],
  candidateReviewers: string[]
): Promise<PrTriage> {
  const fallback: PrTriage = {
    suggestedLabels: [],
    suggestedReviewerUsernames: [],
    priority: "medium",
    riskArea: "mixed",
    summary: "",
  };
  if (!isAiAvailable()) return fallback;
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `Triage this new pull request.

Title: ${title}
Body:
${body.slice(0, 4000)}

Diff summary (paths + line counts):
${diffSummary.slice(0, 4000)}

Available labels: ${availableLabels.join(", ") || "(none)"}
Candidate reviewers (usernames): ${candidateReviewers.join(", ") || "(none)"}

Respond ONLY with JSON:
{
  "suggestedLabels": ["label1"],
  "suggestedReviewerUsernames": ["alice"],
  "priority": "medium",
  "riskArea": "backend",
  "summary": "one-sentence description of the change"
}
Only pick labels from the available list. Only pick reviewers from the candidate list. Priority must be one of critical|high|medium|low. riskArea must be one of frontend|backend|infra|docs|tests|mixed.`,
        },
      ],
    });
    const parsed = parseJsonResponse<PrTriage>(extractText(message));
    if (!parsed) return fallback;
    const allowedRisk = ["frontend", "backend", "infra", "docs", "tests", "mixed"] as const;
    const allowedPriority = ["critical", "high", "medium", "low"] as const;
    return {
      suggestedLabels: Array.isArray(parsed.suggestedLabels)
        ? parsed.suggestedLabels.filter((l) => availableLabels.includes(l))
        : [],
      suggestedReviewerUsernames: Array.isArray(parsed.suggestedReviewerUsernames)
        ? parsed.suggestedReviewerUsernames.filter((u) =>
            candidateReviewers.includes(u)
          )
        : [],
      priority: allowedPriority.includes(parsed.priority as never)
        ? parsed.priority
        : "medium",
      riskArea: allowedRisk.includes(parsed.riskArea as never)
        ? parsed.riskArea
        : "mixed",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch (err) {
    console.error("[triagePullRequest]", err);
    return fallback;
  }
}

/**
 * AI chat assistant — conversational interface grounded in repo context.
 *
 * The assistant can:
 *   - Answer questions about the codebase ("where is auth handled?")
 *   - Explain files / functions ("explain src/lib/gate.ts")
 *   - Draft code (answered verbally, user applies manually)
 *   - Summarise recent activity ("what changed this week?")
 *
 * Grounds its answers in a curated context window built from:
 *   - Repo README
 *   - Recent commits
 *   - Tree listing
 *   - Files the user explicitly @-mentions in the message
 */

import {
  getAnthropic,
  MODEL_SONNET,
  extractText,
  isAiAvailable,
} from "./ai-client";
import {
  getReadme,
  getTree,
  getBlob,
  listCommits,
  getDefaultBranch,
} from "../git/repository";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  citedFiles: string[];
}

/**
 * Build a concise repo context block.
 * Keeps under ~60k chars to leave room for conversation.
 */
async function buildRepoContext(
  owner: string,
  repo: string,
  mentionedFiles: string[]
): Promise<{ context: string; files: string[] }> {
  const branch = (await getDefaultBranch(owner, repo)) || "main";
  const citedFiles: string[] = [];
  const parts: string[] = [];

  parts.push(`# Repository: ${owner}/${repo}\nDefault branch: ${branch}\n`);

  // README
  const readme = await getReadme(owner, repo, branch);
  if (readme) {
    parts.push(`## README\n${readme.slice(0, 8000)}\n`);
  }

  // Top-level tree
  const tree = await getTree(owner, repo, branch);
  if (tree.length > 0) {
    parts.push(
      `## Top-level files\n${tree
        .slice(0, 60)
        .map((e) => `- ${e.type === "tree" ? e.name + "/" : e.name}`)
        .join("\n")}\n`
    );
  }

  // Recent commits
  const commits = await listCommits(owner, repo, branch, 15);
  if (commits.length > 0) {
    parts.push(
      `## Recent commits\n${commits
        .map((c) => `- ${c.sha.slice(0, 7)} ${c.message.split("\n")[0]} — ${c.author}`)
        .join("\n")}\n`
    );
  }

  // Mentioned files
  for (const file of mentionedFiles.slice(0, 8)) {
    try {
      const blob = await getBlob(owner, repo, branch, file);
      if (blob && !blob.isBinary) {
        citedFiles.push(file);
        parts.push(`## File: ${file}\n\`\`\`\n${blob.content.slice(0, 12000)}\n\`\`\`\n`);
      }
    } catch {
      // ignore
    }
  }

  return { context: parts.join("\n"), files: citedFiles };
}

/**
 * Extract @-mentions of files from a user's message.
 * Supports @filename.ext and @path/to/file.ext.
 */
function extractFileMentions(text: string): string[] {
  const matches = text.match(/@([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/g);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.slice(1))));
}

export async function chat(
  owner: string,
  repo: string | null,
  history: ChatMessage[],
  userMessage: string
): Promise<ChatResponse> {
  if (!isAiAvailable()) {
    return {
      reply:
        "AI chat is not available — the server needs an ANTHROPIC_API_KEY to be configured.",
      citedFiles: [],
    };
  }
  const client = getAnthropic();

  const mentioned = extractFileMentions(userMessage);
  const { context: repoContext, files } = repo
    ? await buildRepoContext(owner, repo, mentioned)
    : { context: "", files: [] };

  const system = repo
    ? `You are GlueCron's AI assistant. You help developers understand and work with the repository ${owner}/${repo}. Be concise, accurate, and reference specific files and line numbers when relevant. If the user asks about something not in your context, say so.`
    : `You are GlueCron's AI assistant. You help developers navigate the GlueCron platform — a git host with green-gate enforcement, AI code review, and auto-repair. Keep answers concise.`;

  const messages: ChatMessage[] = [
    ...history,
    {
      role: "user",
      content: repoContext
        ? `${repoContext}\n\n---\n\nUser question: ${userMessage}`
        : userMessage,
    },
  ];

  const response = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: 2048,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  return {
    reply: extractText(response).trim(),
    citedFiles: files,
  };
}

/**
 * Explain a single file — used for the "Explain this file" button on blob views.
 */
export async function explainFile(
  owner: string,
  repo: string,
  filePath: string,
  content: string
): Promise<string> {
  if (!isAiAvailable()) {
    return "AI explanations are not available — server needs ANTHROPIC_API_KEY.";
  }
  const client = getAnthropic();
  const message = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Explain this file from ${owner}/${repo} in plain English.

Structure:
1. **Purpose** — one sentence
2. **Key exports / APIs** — bulleted list
3. **How it works** — 2-4 sentences
4. **Gotchas / caveats** — only if any

Be concise.

File: ${filePath}
\`\`\`
${content.slice(0, 40000)}
\`\`\``,
      },
    ],
  });
  return extractText(message).trim();
}

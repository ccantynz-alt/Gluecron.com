/**
 * AI incident analysis — given an alert title/description and a repo, identify
 * the likely guilty commit(s) and produce a fix suggestion.
 *
 * Used by src/routes/incident-hooks.tsx when PagerDuty / Datadog / Opsgenie /
 * generic webhook alerts land. Degrades gracefully: without ANTHROPIC_API_KEY
 * the analysis fields are populated with safe fallback text and the caller
 * still opens the issue, it just skips the draft PR.
 */

import { getRepoPath } from "../git/repository";
import {
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
  parseJsonResponse,
} from "./ai-client";

export interface IncidentAnalysisResult {
  likelyFiles: Array<{ path: string; reason: string }>;
  suggestedFix: string; // markdown with code blocks
  issueTitle: string;
  issueBody: string;
  branchName: string;
}

export interface AnalyzeIncidentParams {
  title: string;
  description: string;
  owner: string;
  repo: string;
  repoId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Git helpers (all fire-and-forget safe — return empty on error)
// ─────────────────────────────────────────────────────────────────────────────

async function runGit(
  args: string[],
  cwd: string
): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], {
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

/** Get commits from the last 24 hours: "<sha> <subject>" lines. */
async function recentCommits(owner: string, repo: string): Promise<string> {
  const cwd = getRepoPath(owner, repo);
  return runGit(
    ["log", "--since=24 hours ago", "--format=%H %s", "HEAD", "--"],
    cwd
  );
}

/** Files changed in the last 10 commits (unique). */
async function recentChangedFiles(
  owner: string,
  repo: string
): Promise<string[]> {
  const cwd = getRepoPath(owner, repo);
  const out = await runGit(
    ["diff", "--name-only", "HEAD~10..HEAD", "--"],
    cwd
  );
  if (!out) return [];
  return [
    ...new Set(
      out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    ),
  ];
}

/** Read the first `lines` lines of a file from the HEAD commit. */
async function readFileHead(
  owner: string,
  repo: string,
  path: string,
  lines = 100
): Promise<string> {
  const cwd = getRepoPath(owner, repo);
  const full = await runGit(["show", `HEAD:${path}`], cwd);
  if (!full) return "";
  return full.split("\n").slice(0, lines).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude prompt
// ─────────────────────────────────────────────────────────────────────────────

interface AiResponse {
  likelyFiles: Array<{ path: string; reason: string }>;
  suggestedFix: string;
  issueTitle: string;
  issueBody: string;
  branchName: string;
}

async function callClaude(
  title: string,
  description: string,
  commits: string,
  fileContents: string
): Promise<AiResponse | null> {
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      system:
        "You are a senior on-call engineer. Given a production incident and recent code changes, identify the likely cause and suggest a fix. Always respond with valid JSON only.",
      messages: [
        {
          role: "user",
          content: `Incident: ${title}

${description || "(no additional details)"}

Recent commits (last 24h):
${commits || "(none)"}

Changed files (last 10 commits — first 100 lines each):
${fileContents || "(none)"}

Return JSON exactly matching this shape:
{
  "likelyFiles": [{"path": "string", "reason": "string"}],
  "suggestedFix": "markdown code block with the fix",
  "issueTitle": "string",
  "issueBody": "string (markdown, include context + fix steps)",
  "branchName": "string (slugified, e.g. fix/incident-db-spike)"
}`,
        },
      ],
    });

    const raw = extractText(message);
    const parsed = parseJsonResponse<AiResponse>(raw);
    if (!parsed) return null;

    // Validate + normalise
    return {
      likelyFiles: Array.isArray(parsed.likelyFiles) ? parsed.likelyFiles : [],
      suggestedFix:
        typeof parsed.suggestedFix === "string" ? parsed.suggestedFix : "",
      issueTitle:
        typeof parsed.issueTitle === "string" && parsed.issueTitle.trim()
          ? parsed.issueTitle.trim().slice(0, 200)
          : `Incident: ${title}`,
      issueBody:
        typeof parsed.issueBody === "string" ? parsed.issueBody : "",
      branchName:
        typeof parsed.branchName === "string" && parsed.branchName.trim()
          ? parsed.branchName
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9/-]/g, "-")
              .replace(/-{2,}/g, "-")
              .slice(0, 80)
          : `fix/incident-${Date.now()}`,
    };
  } catch (err) {
    console.error("[incident-analyzer] claude call failed:", err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeIncident(
  params: AnalyzeIncidentParams
): Promise<IncidentAnalysisResult> {
  const { title, description, owner, repo } = params;
  const ts = Date.now();

  // Fallback (no AI or git fails): still produces a usable issue.
  const fallback: IncidentAnalysisResult = {
    likelyFiles: [],
    suggestedFix: "",
    issueTitle: `Incident: ${title}`,
    issueBody: [
      `## Alert`,
      `**${title}**`,
      "",
      description || "(no additional details)",
      "",
      "---",
      "_AI analysis unavailable — ANTHROPIC_API_KEY not set._",
    ].join("\n"),
    branchName: `fix/incident-${ts}`,
  };

  if (!isAiAvailable()) {
    return fallback;
  }

  // 1. Gather git context (best-effort — failures return empty strings/arrays)
  let commits = "";
  let changedFiles: string[] = [];
  try {
    [commits, changedFiles] = await Promise.all([
      recentCommits(owner, repo),
      recentChangedFiles(owner, repo),
    ]);
  } catch {
    /* swallow */
  }

  // 2. Read file content for recently changed files (up to 10 files, 100 lines each)
  const fileSnippets: string[] = [];
  for (const f of changedFiles.slice(0, 10)) {
    try {
      const content = await readFileHead(owner, repo, f, 100);
      if (content) {
        fileSnippets.push(`### ${f}\n\`\`\`\n${content}\n\`\`\``);
      }
    } catch {
      /* skip */
    }
  }
  const fileContents = fileSnippets.join("\n\n");

  // 3. Call Claude
  const ai = await callClaude(title, description, commits, fileContents);
  if (!ai) return fallback;

  return ai;
}

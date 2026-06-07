/**
 * PR Split Suggestions — AI-powered guidance for decomposing large PRs.
 *
 * When a PR has >400 lines changed, Claude Sonnet is asked to suggest how
 * to split it into 2-4 smaller, independently-mergeable PRs grouped by
 * logical concern (schema / API / UI / tests etc.).
 *
 * Results are cached in memory for 1 hour per PR — the AI call is expensive
 * and the diff doesn't change between page loads.
 *
 * Returns `null` when:
 *   - PR has <=400 changed lines
 *   - AI is unavailable (no ANTHROPIC_API_KEY)
 *   - Claude returns fewer than 2 suggestions
 *   - Any error occurs (always degrades gracefully)
 */

import { getAnthropic, MODEL_SONNET, extractText, parseJsonResponse, isAiAvailable } from "./ai-client";
import { join } from "path";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SplitPr {
  title: string;
  rationale: string;
  files: string[];
  estimatedLines: number;
  suggestedBranch: string;
}

export interface SplitSuggestion {
  originalPrTitle: string;
  totalFiles: number;
  totalLines: number;
  suggestedPrs: SplitPr[];
  mergeOrder: string[];
}

// ---------------------------------------------------------------------------
// In-memory cache (1h TTL per prId)
// ---------------------------------------------------------------------------

interface CacheEntry {
  suggestion: SplitSuggestion | null;
  cachedAt: number;
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCached(prId: string): SplitSuggestion | null | undefined {
  const entry = _cache.get(prId);
  if (!entry) return undefined; // cache miss
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    _cache.delete(prId);
    return undefined;
  }
  return entry.suggestion;
}

function setCached(prId: string, suggestion: SplitSuggestion | null): void {
  _cache.set(prId, { suggestion, cachedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Diff stat parsing
// ---------------------------------------------------------------------------

interface FileStatLine {
  path: string;
  added: number;
  deleted: number;
  total: number;
}

function parseNumstat(raw: string): FileStatLine[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 3) return null;
      const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
      const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
      return { path: parts[2], added, deleted, total: added + deleted };
    })
    .filter((x): x is FileStatLine => x !== null);
}

function getRepoDir(owner: string, repo: string): string {
  return join(config.gitReposPath, `${owner}/${repo}.git`);
}

async function getDiffStat(
  owner: string,
  repo: string,
  baseBranch: string,
  headBranch: string
): Promise<FileStatLine[]> {
  const repoDir = getRepoDir(owner, repo);
  const proc = Bun.spawn(
    ["git", "--git-dir", repoDir, "diff", "--numstat", `${baseBranch}...${headBranch}`],
    { stdout: "pipe", stderr: "pipe" }
  );
  const raw = await new Response(proc.stdout).text();
  await proc.exited;
  return parseNumstat(raw);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Suggest how to split a large PR.
 * Returns null when the PR is small, AI is unavailable, or any error occurs.
 */
export async function suggestPrSplit(
  prId: string,
  prTitle: string,
  ownerName: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): Promise<SplitSuggestion | null> {
  // Check cache first
  const cached = getCached(prId);
  if (cached !== undefined) return cached;

  try {
    const fileStats = await getDiffStat(ownerName, repoName, baseBranch, headBranch);
    const totalLines = fileStats.reduce((s, f) => s + f.total, 0);
    const totalFiles = fileStats.length;

    if (totalLines < 400) {
      setCached(prId, null);
      return null;
    }

    if (!isAiAvailable()) {
      setCached(prId, null);
      return null;
    }

    const fileList = fileStats
      .map((f) => `${f.path}  +${f.added} -${f.deleted}`)
      .join("\n");

    const prompt = `This PR is too large to review effectively (${totalLines} lines across ${totalFiles} files).
Suggest how to split it into 2-4 smaller PRs that can be reviewed and merged independently.

PR title: ${prTitle}
Files changed:
${fileList}

Return JSON with this exact shape (no extra keys, no prose outside the JSON block):
{
  "suggestedPrs": [
    {
      "title": "...",
      "rationale": "...",
      "files": ["..."],
      "estimatedLines": N,
      "suggestedBranch": "..."
    }
  ],
  "mergeOrder": ["PR title 1", "PR title 2"]
}

Rules:
- Group by logical concern (schema changes together, API layer together, UI together)
- Each suggested PR should be independently mergeable
- Suggest merge order to minimise conflicts
- suggestedBranch should be kebab-case derived from the PR title (e.g. feat/auth-schema-only)
- Return between 2 and 4 suggested PRs`;

    const anthropic = getAnthropic();
    const message = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractText(message);
    const parsed = parseJsonResponse<{
      suggestedPrs: SplitPr[];
      mergeOrder: string[];
    }>(text);

    if (!parsed || !Array.isArray(parsed.suggestedPrs) || parsed.suggestedPrs.length < 2) {
      setCached(prId, null);
      return null;
    }

    const suggestion: SplitSuggestion = {
      originalPrTitle: prTitle,
      totalFiles,
      totalLines,
      suggestedPrs: parsed.suggestedPrs,
      mergeOrder: Array.isArray(parsed.mergeOrder) ? parsed.mergeOrder : [],
    };

    setCached(prId, suggestion);
    return suggestion;
  } catch {
    // Always degrade gracefully
    setCached(prId, null);
    return null;
  }
}

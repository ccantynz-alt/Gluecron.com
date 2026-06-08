/**
 * AI Code Archaeology — excavate the "why" behind any file.
 *
 * Given a file path in a repository, searches git history, PRs, and issues
 * to reconstruct the reasoning and original motivation behind the code.
 *
 * Uses a 30-minute in-memory cache keyed on `${repoId}:${filePath}`.
 * The query does not affect the cache key — same file, same archaeology.
 */

import { basename } from "path";
import { eq, and, desc, ilike, or } from "drizzle-orm";
import { db } from "../db";
import { pullRequests, prComments, issues, issueComments } from "../db/schema";
import { getRepoPath, getBlob } from "../git/repository";
import {
  getAnthropic,
  isAiAvailable,
  extractText,
  MODEL_SONNET,
} from "./ai-client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArchaeologyFinding {
  type: "commit" | "pr" | "issue";
  id: string;     // commit sha, pr number (string), or issue number (string)
  title: string;
  summary: string; // 1-2 sentences explaining relevance
  date: string;   // ISO string
  url: string;    // relative URL e.g. /owner/repo/commit/sha
  author: string;
}

export interface ArchaeologyReport {
  filePath: string;
  query: string;       // the "why" question asked
  explanation: string; // Claude's synthesized answer (markdown)
  findings: ArchaeologyFinding[];
  confidence: "high" | "medium" | "low";
  analyzedAt: Date;
}

// ---------------------------------------------------------------------------
// In-memory cache (30-min TTL, keyed on repoId:filePath)
// ---------------------------------------------------------------------------

interface CacheEntry {
  report: ArchaeologyReport;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCached(repoId: string, filePath: string): ArchaeologyReport | null {
  const key = `${repoId}:${filePath}`;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.report;
}

function setCached(repoId: string, filePath: string, report: ArchaeologyReport): void {
  const key = `${repoId}:${filePath}`;
  cache.set(key, { report, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function invalidateCache(repoId: string, filePath: string): void {
  const key = `${repoId}:${filePath}`;
  cache.delete(key);
}

// ---------------------------------------------------------------------------
// Git helpers (run in the repo's bare git dir)
// ---------------------------------------------------------------------------

interface GitLogEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
}

async function gitExec(
  cmd: string[],
  cwd: string
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

/**
 * Step 1 — Run `git log --follow --oneline --max-count=20 -- <filePath>`
 * and also grab author + date via a custom format. Cap at 20 commits.
 */
async function getFileGitLog(
  repoPath: string,
  filePath: string
): Promise<GitLogEntry[]> {
  try {
    // Use null-delimiter format: sha%x00message%x00author%x00date
    const { stdout, exitCode } = await gitExec(
      [
        "git",
        "log",
        "--follow",
        "--format=%H%x00%s%x00%an%x00%aI",
        "--max-count=20",
        "--",
        filePath,
      ],
      repoPath
    );
    if (exitCode !== 0) return [];
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, message, author, date] = line.split("\0");
        return { sha, message: message || "(no message)", author: author || "unknown", date: date || "" };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface PrRecord {
  number: number;
  title: string;
  body: string | null;
  createdAt: Date;
  comments: Array<{ body: string }>;
}

interface IssueRecord {
  number: number;
  title: string;
  body: string | null;
  createdAt: Date;
  comments: Array<{ body: string }>;
}

async function findRelatedPRs(
  repoId: string,
  fileName: string
): Promise<PrRecord[]> {
  try {
    const pattern = `%${fileName}%`;
    const prs = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        body: pullRequests.body,
        createdAt: pullRequests.createdAt,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repoId),
          or(
            ilike(pullRequests.title, pattern),
            ilike(pullRequests.body, pattern)
          )
        )
      )
      .orderBy(desc(pullRequests.createdAt))
      .limit(5);

    const results: PrRecord[] = [];
    for (const pr of prs) {
      const comments = await db
        .select({ body: prComments.body })
        .from(prComments)
        .where(
          and(
            eq(prComments.pullRequestId, pr.id),
            eq(prComments.isAiReview, false)
          )
        )
        .orderBy(desc(prComments.createdAt))
        .limit(3);

      results.push({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        createdAt: pr.createdAt,
        comments: comments.map((c) => ({
          body: c.body.slice(0, 500),
        })),
      });
    }
    return results;
  } catch {
    return [];
  }
}

async function findRelatedIssues(
  repoId: string,
  fileName: string
): Promise<IssueRecord[]> {
  try {
    const pattern = `%${fileName}%`;
    const found = await db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        body: issues.body,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, repoId),
          or(
            ilike(issues.title, pattern),
            ilike(issues.body, pattern)
          )
        )
      )
      .orderBy(desc(issues.createdAt))
      .limit(5);

    const results: IssueRecord[] = [];
    for (const issue of found) {
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issue.id))
        .orderBy(desc(issueComments.createdAt))
        .limit(2);

      results.push({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        createdAt: issue.createdAt,
        comments: comments.map((c) => ({
          body: c.body.slice(0, 300),
        })),
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Confidence heuristic
// ---------------------------------------------------------------------------

function deriveConfidence(
  commits: GitLogEntry[],
  prs: PrRecord[],
  issues: IssueRecord[]
): "high" | "medium" | "low" {
  const total = commits.length + prs.length + issues.length;
  if (total >= 8) return "high";
  if (total >= 3) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Main excavate function
// ---------------------------------------------------------------------------

export async function excavate(
  ownerName: string,
  repoName: string,
  repoId: string,
  filePath: string,
  query: string
): Promise<ArchaeologyReport> {
  // Check cache first
  const cached = getCached(repoId, filePath);
  if (cached) {
    // Return cached with updated query
    return { ...cached, query };
  }

  // Guard: AI not available
  if (!isAiAvailable()) {
    const report: ArchaeologyReport = {
      filePath,
      query,
      explanation: "ANTHROPIC_API_KEY not set — AI archaeology is unavailable.",
      findings: [],
      confidence: "low",
      analyzedAt: new Date(),
    };
    return report;
  }

  try {
    const repoPath = getRepoPath(ownerName, repoName);
    const fileName = basename(filePath);

    // Step 1: Git log for this file
    const commits = await getFileGitLog(repoPath, filePath);

    // Step 2: Load current file content (cap at 10KB)
    let fileContent = "";
    try {
      const blob = await getBlob(ownerName, repoName, "HEAD", filePath);
      if (blob && !blob.isBinary) {
        fileContent = blob.content.slice(0, 10 * 1024);
      }
    } catch {
      // file may not exist — continue
    }

    // First 50 lines of file content for Claude
    const first50Lines = fileContent
      .split("\n")
      .slice(0, 50)
      .join("\n");

    // Step 3: Related PRs
    const prs = await findRelatedPRs(repoId, fileName);

    // Step 4: Related issues
    const relatedIssues = await findRelatedIssues(repoId, fileName);

    // Step 5: Claude synthesis
    const gitLogText = commits.length > 0
      ? commits
          .map(
            (c) =>
              `- ${c.sha.slice(0, 8)} | ${c.date.slice(0, 10)} | ${c.author} | ${c.message}`
          )
          .join("\n")
      : "(no commits found for this file)";

    const prText = prs.length > 0
      ? prs
          .map((pr) => {
            const bodySnippet = pr.body ? pr.body.slice(0, 800) : "";
            const commentsText = pr.comments.length > 0
              ? pr.comments.map((c) => `  Comment: ${c.body}`).join("\n")
              : "";
            return `PR #${pr.number} (${pr.createdAt.toISOString().slice(0, 10)}): ${pr.title}\n${bodySnippet ? `Body: ${bodySnippet}` : ""}${commentsText ? `\n${commentsText}` : ""}`;
          })
          .join("\n\n")
      : "(no related PRs found)";

    const issueText = relatedIssues.length > 0
      ? relatedIssues
          .map((issue) => {
            const bodySnippet = issue.body ? issue.body.slice(0, 600) : "";
            const commentsText = issue.comments.length > 0
              ? issue.comments.map((c) => `  Comment: ${c.body}`).join("\n")
              : "";
            return `Issue #${issue.number} (${issue.createdAt.toISOString().slice(0, 10)}): ${issue.title}\n${bodySnippet ? `Body: ${bodySnippet}` : ""}${commentsText ? `\n${commentsText}` : ""}`;
          })
          .join("\n\n")
      : "(no related issues found)";

    const userPrompt = `File: ${filePath}
Question: ${query}

Current file content (first 50 lines):
\`\`\`
${first50Lines || "(file is empty or binary)"}
\`\`\`

Git history (recent commits touching this file):
${gitLogText}

Related PRs:
${prText}

Related issues:
${issueText}

Synthesize: why does this code exist? What problem does it solve? What decisions were made?`;

    let explanation = "";
    try {
      const anthropic = getAnthropic();
      const message = await anthropic.messages.create({
        model: MODEL_SONNET,
        max_tokens: 2048,
        system:
          "You are a software archaeologist. Given the git history, PR discussions, and issue tracker for a file, synthesize a clear explanation of WHY this code exists — the original motivation, key decisions, and any important context. Be concise but complete. Use markdown.",
        messages: [{ role: "user", content: userPrompt }],
      });
      explanation = extractText(message);
    } catch (err) {
      explanation = `Unable to generate explanation: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Step 6: Build findings list sorted by date desc
    const findings: ArchaeologyFinding[] = [];

    // Add commits
    for (const commit of commits) {
      findings.push({
        type: "commit",
        id: commit.sha,
        title: commit.message,
        summary: `Commit by ${commit.author} touching this file.`,
        date: commit.date,
        url: `/${ownerName}/${repoName}/commit/${commit.sha}`,
        author: commit.author,
      });
    }

    // Add PRs
    for (const pr of prs) {
      findings.push({
        type: "pr",
        id: String(pr.number),
        title: pr.title,
        summary: `Pull request referencing ${fileName}.`,
        date: pr.createdAt.toISOString(),
        url: `/${ownerName}/${repoName}/pulls/${pr.number}`,
        author: "",
      });
    }

    // Add issues
    for (const issue of relatedIssues) {
      findings.push({
        type: "issue",
        id: String(issue.number),
        title: issue.title,
        summary: `Issue referencing ${fileName}.`,
        date: issue.createdAt.toISOString(),
        url: `/${ownerName}/${repoName}/issues/${issue.number}`,
        author: "",
      });
    }

    // Sort by date descending
    findings.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db2 = b.date ? new Date(b.date).getTime() : 0;
      return db2 - da;
    });

    const confidence = deriveConfidence(commits, prs, relatedIssues);

    const report: ArchaeologyReport = {
      filePath,
      query,
      explanation,
      findings,
      confidence,
      analyzedAt: new Date(),
    };

    setCached(repoId, filePath, report);
    return report;
  } catch (err) {
    // Never throws — return a degraded report
    return {
      filePath,
      query,
      explanation: `Archaeology failed: ${err instanceof Error ? err.message : String(err)}`,
      findings: [],
      confidence: "low",
      analyzedAt: new Date(),
    };
  }
}

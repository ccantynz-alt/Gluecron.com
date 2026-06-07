/**
 * AI Auto-Issue Opener — scans every git push diff for common code quality
 * and security signals, then automatically opens issues for any findings.
 *
 * Feature is gated on env var `AI_AUTO_ISSUES=1`. If unset, the entry point
 * returns immediately. Never throws — all failures are caught so the push
 * path is never blocked.
 *
 * Patterns detected:
 *   - TODO / FIXME / HACK / XXX / BUG / OPTIMIZE comments
 *   - Hardcoded secrets (password=, api_key=, token=, etc.)
 *   - SQL injection vectors (template literals inside SQL keywords)
 *   - Debug console.log/debug/info calls left in production code
 *
 * Rate limiting: maximum MAX_ISSUES_PER_PUSH issues per push. If more findings
 * exist, a single summary issue is opened instead of the individual ones.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  issueLabels,
  labels,
  repositories,
  users,
} from "../db/schema";
import { getRepoPath } from "../git/repository";

// ---------------------------------------------------------------------------
// Diff scanning patterns
// ---------------------------------------------------------------------------

const TODO_PATTERN = /^\+.*\b(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\b.*$/gm;
const SECRET_PATTERN =
  /^\+.*(password|secret|api_key|apikey|token|private_key|privatekey)\s*=\s*["'][^"']{8,}/gim;
const SQL_INJECTION_PATTERN =
  /^\+.*\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/gim;
const CONSOLE_LOG_PATTERN = /^\+.*console\.(log|debug|info)\(/gm;

type FindingType = "todo" | "secret" | "sql-injection" | "console-log";

interface Finding {
  type: FindingType;
  filePath: string;
  lineNumber: number;
  matchText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum auto-issues opened per push before collapsing into a summary. */
const MAX_ISSUES_PER_PUSH = 5;

/** Hard cap on diff size consumed (500 KB). */
const MAX_DIFF_BYTES = 500 * 1024;

/** Label applied to every auto-opened issue. */
const LABEL_NAME = "ai-detected";
const LABEL_COLOR = "#e11d48"; // vivid red — stands out in the issue list

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/**
 * Run `git diff <oldSha> <newSha>` inside the bare repo and return the output
 * capped at MAX_DIFF_BYTES. For an initial push where oldSha is all zeros,
 * runs `git show <newSha>` instead so we still get the diff.
 */
async function getDiff(
  owner: string,
  repo: string,
  oldSha: string,
  newSha: string
): Promise<string> {
  const cwd = getRepoPath(owner, repo);
  const allZero = /^0+$/.test(oldSha);
  const cmd = allZero
    ? ["git", "show", "--format=", newSha]
    : ["git", "diff", oldSha, newSha];
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    // Read up to MAX_DIFF_BYTES to avoid huge diffs
    const reader = proc.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (totalBytes + value.byteLength > MAX_DIFF_BYTES) {
          const remaining = MAX_DIFF_BYTES - totalBytes;
          if (remaining > 0) {
            chunks.push(value.slice(0, remaining));
          }
          break;
        }
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    }
    reader.cancel();
    await proc.exited;
    const decoder = new TextDecoder();
    return chunks.map((c) => decoder.decode(c)).join("");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Diff parser
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff text into a list of findings. Groups findings by
 * (filePath, type) to avoid opening many issues for a single noisy file.
 */
export function parseDiffForFindings(diff: string): Finding[] {
  const findings: Finding[] = [];

  // Track current file and current line offset within the new file
  let currentFile = "";
  let currentNewLine = 0;

  const lines = diff.split("\n");

  for (const line of lines) {
    // File header: diff --git a/... b/...
    const fileMatch = line.match(/^diff --git a\/.* b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      currentNewLine = 0;
      continue;
    }

    // +++ b/... header (fallback for file name)
    const plusHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusHeader) {
      currentFile = plusHeader[1];
      continue;
    }

    // Hunk header: @@ -x,y +a,b @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1], 10) - 1; // will be incremented below
      continue;
    }

    // Track new-file line numbers
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentNewLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deleted lines don't advance the new-file line counter
      continue;
    } else if (!line.startsWith("\\")) {
      // Context line or header — advance counter only for context lines
      if (!line.startsWith("diff") && !line.startsWith("index") &&
          !line.startsWith("---") && !line.startsWith("+++")) {
        currentNewLine++;
      }
      continue;
    }

    if (!line.startsWith("+") || !currentFile) continue;
  }

  // Second pass: collect matches with proper line tracking
  return scanDiffLines(diff);
}

/**
 * Scan diff lines with proper hunk-aware line number tracking. Returns one
 * Finding per matched line — callers should deduplicate by (file, type).
 */
function scanDiffLines(diff: string): Finding[] {
  const findings: Finding[] = [];
  let currentFile = "";
  let currentNewLine = 0;
  let lineIdx = 0;

  const lines = diff.split("\n");

  for (const line of lines) {
    lineIdx++;

    // File header
    const fileMatch = line.match(/^diff --git a\/.* b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      currentNewLine = 0;
      continue;
    }

    const plusHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusHeader) {
      currentFile = plusHeader[1];
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      // Removed lines — skip (don't open issues for deleted code)
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentNewLine++;

      if (!currentFile) continue;

      // Match each pattern against the added line
      const matchText = line.slice(0, 200); // cap at 200 chars

      if (TODO_PATTERN.test(line)) {
        findings.push({
          type: "todo",
          filePath: currentFile,
          lineNumber: currentNewLine,
          matchText,
        });
      }
      TODO_PATTERN.lastIndex = 0;

      if (SECRET_PATTERN.test(line)) {
        findings.push({
          type: "secret",
          filePath: currentFile,
          lineNumber: currentNewLine,
          matchText: maskSecretValue(matchText),
        });
      }
      SECRET_PATTERN.lastIndex = 0;

      if (SQL_INJECTION_PATTERN.test(line)) {
        findings.push({
          type: "sql-injection",
          filePath: currentFile,
          lineNumber: currentNewLine,
          matchText,
        });
      }
      SQL_INJECTION_PATTERN.lastIndex = 0;

      if (CONSOLE_LOG_PATTERN.test(line)) {
        findings.push({
          type: "console-log",
          filePath: currentFile,
          lineNumber: currentNewLine,
          matchText,
        });
      }
      CONSOLE_LOG_PATTERN.lastIndex = 0;
    } else {
      // Context line
      currentNewLine++;
    }
  }

  return findings;
}

/** Replace the value portion of a secret match with asterisks. */
function maskSecretValue(text: string): string {
  return text.replace(
    /(password|secret|api_key|apikey|token|private_key|privatekey)\s*=\s*["'][^"']{0,200}/gi,
    (m) => {
      const eqIdx = m.indexOf("=");
      const quoteIdx = m.indexOf('"', eqIdx) !== -1
        ? m.indexOf('"', eqIdx)
        : m.indexOf("'", eqIdx);
      return m.slice(0, quoteIdx + 1) + "****";
    }
  );
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

interface GroupedFinding {
  type: FindingType;
  filePath: string;
  /** All line numbers in this file for this finding type. */
  lineNumbers: number[];
  /** First matched text (representative sample). */
  sampleText: string;
}

function groupFindings(findings: Finding[]): GroupedFinding[] {
  const map = new Map<string, GroupedFinding>();
  for (const f of findings) {
    const key = `${f.type}::${f.filePath}`;
    const existing = map.get(key);
    if (existing) {
      existing.lineNumbers.push(f.lineNumber);
    } else {
      map.set(key, {
        type: f.type,
        filePath: f.filePath,
        lineNumbers: [f.lineNumber],
        sampleText: f.matchText,
      });
    }
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Issue rendering
// ---------------------------------------------------------------------------

const FINDING_LABELS: Record<FindingType, string> = {
  "todo": "TODO/FIXME",
  "secret": "Potential Secret Exposure",
  "sql-injection": "SQL Injection Risk",
  "console-log": "Debug Console Log",
};

function renderIssueTitle(
  group: GroupedFinding,
  pusherUsername: string
): string {
  const label = FINDING_LABELS[group.type];
  const loc = `${group.filePath}`;
  return `[AI] ${label} found in ${loc} (pushed by @${pusherUsername})`;
}

function renderIssueBody(
  group: GroupedFinding,
  owner: string,
  repo: string,
  commitSha: string,
  pusherUsername: string
): string {
  const label = FINDING_LABELS[group.type];
  const shortSha = commitSha.slice(0, 7);
  const lineList = group.lineNumbers.slice(0, 10).join(", ");
  const firstLine = group.lineNumbers[0];

  const fileLink = `[\`${group.filePath}:${firstLine}\`](/${owner}/${repo}/blob/${commitSha}/${group.filePath}#L${firstLine})`;

  const description = findingDescription(group.type);

  const lines = [
    `**Automated AI scan** detected a **${label}** in commit \`${shortSha}\` pushed by @${pusherUsername}.`,
    "",
    `**File:** ${fileLink}`,
    `**Line(s):** ${lineList}${group.lineNumbers.length > 10 ? ` (and ${group.lineNumbers.length - 10} more)` : ""}`,
    "",
    "## Matched code",
    "```",
    group.sampleText.trim(),
    "```",
    "",
    "## Why this matters",
    description,
    "",
    "---",
    "_This issue was auto-opened by Gluecron's AI push scanner. Close it if the finding is a false positive._",
  ];

  return lines.join("\n");
}

function findingDescription(type: FindingType): string {
  switch (type) {
    case "todo":
      return "TODO/FIXME/HACK comments indicate incomplete or workaround code that should be tracked as proper issues rather than buried in source files.";
    case "secret":
      return "Hardcoded credentials or API keys in source code can be extracted from git history even after deletion. Rotate the exposed credential immediately and use environment variables or a secrets manager instead.";
    case "sql-injection":
      return "Template literals interpolated directly into SQL statements may allow SQL injection if user-controlled data reaches this code path. Use parameterised queries or a query builder instead.";
    case "console-log":
      return "Debug `console.log` calls left in production code can expose sensitive data in logs and add unnecessary noise. Remove or replace with a proper logging library with log-level controls.";
  }
}

function renderSummaryIssueBody(
  totalFindings: number,
  groups: GroupedFinding[],
  owner: string,
  repo: string,
  commitSha: string,
  pusherUsername: string
): string {
  const shortSha = commitSha.slice(0, 7);
  const lines = [
    `**Automated AI scan** detected **${totalFindings} findings** in commit \`${shortSha}\` pushed by @${pusherUsername}.`,
    "",
    "The push scanner limit was reached — here is a summary of all findings:",
    "",
    "| Type | File | Lines |",
    "| ---- | ---- | ----- |",
    ...groups.map((g) => {
      const label = FINDING_LABELS[g.type];
      const fileLink = `[${g.filePath}](/${owner}/${repo}/blob/${commitSha}/${g.filePath})`;
      const lineStr = g.lineNumbers.slice(0, 5).join(", ") +
        (g.lineNumbers.length > 5 ? ` (+${g.lineNumbers.length - 5})` : "");
      return `| ${label} | ${fileLink} | ${lineStr} |`;
    }),
    "",
    "Address the individual findings and re-push to trigger a fresh scan.",
    "",
    "---",
    "_This issue was auto-opened by Gluecron's AI push scanner._",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Resolve or create the `ai-detected` label for a repository.
 * Returns the label id, or null on any failure.
 */
async function ensureAiDetectedLabel(repositoryId: string): Promise<string | null> {
  try {
    // Try to find existing label
    const [existing] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.repositoryId, repositoryId), eq(labels.name, LABEL_NAME)))
      .limit(1);
    if (existing) return existing.id;

    // Create it
    const [created] = await db
      .insert(labels)
      .values({
        repositoryId,
        name: LABEL_NAME,
        color: LABEL_COLOR,
        description: "Automatically detected by Gluecron AI push scanner",
      })
      .onConflictDoNothing()
      .returning({ id: labels.id });
    return created?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Insert one issue and optionally attach the ai-detected label.
 * Bumps `repositories.issueCount` by 1.
 * Returns the new issue number, or null on failure.
 */
async function insertIssue(opts: {
  repositoryId: string;
  authorId: string;
  title: string;
  body: string;
  labelId: string | null;
  currentIssueCount: number;
}): Promise<number | null> {
  try {
    const [inserted] = await db
      .insert(issues)
      .values({
        repositoryId: opts.repositoryId,
        authorId: opts.authorId,
        title: opts.title.slice(0, 255),
        body: opts.body,
        state: "open",
      })
      .returning({ id: issues.id, number: issues.number });

    if (!inserted) return null;

    // Attach label — best-effort
    if (opts.labelId) {
      await db
        .insert(issueLabels)
        .values({ issueId: inserted.id, labelId: opts.labelId })
        .catch(() => {/* ignore */});
    }

    // Bump issue count — best-effort
    await db
      .update(repositories)
      .set({ issueCount: opts.currentIssueCount + 1 })
      .where(eq(repositories.id, opts.repositoryId))
      .catch(() => {/* ignore */});

    return inserted.number;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ScanResult {
  findingsCount: number;
  issuesOpened: number;
  skipped: boolean;
}

/**
 * Scan the diff between `oldSha` and `newSha` for code quality / security
 * signals and open issues in the repository for any findings.
 *
 * Gated on `AI_AUTO_ISSUES=1`. Never throws.
 */
export async function scanDiffForIssues(
  owner: string,
  repo: string,
  oldSha: string,
  newSha: string,
  pusherUserId: string
): Promise<ScanResult> {
  // Feature flag gate
  if (process.env.AI_AUTO_ISSUES !== "1") {
    return { findingsCount: 0, issuesOpened: 0, skipped: true };
  }

  try {
    // 1. Resolve repo row
    const [repoRow] = await db
      .select({
        id: repositories.id,
        ownerId: repositories.ownerId,
        issueCount: repositories.issueCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);

    if (!repoRow) {
      return { findingsCount: 0, issuesOpened: 0, skipped: true };
    }

    // 2. Resolve pusher username for issue titles
    let pusherUsername = "unknown";
    try {
      const [pusherRow] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, pusherUserId))
        .limit(1);
      if (pusherRow) pusherUsername = pusherRow.username;
    } catch {
      /* fall back to "unknown" */
    }

    // 3. Fetch diff
    const diff = await getDiff(owner, repo, oldSha, newSha);
    if (!diff.trim()) {
      return { findingsCount: 0, issuesOpened: 0, skipped: false };
    }

    // 4. Parse and group findings
    const rawFindings = scanDiffLines(diff);
    const groups = groupFindings(rawFindings);

    if (groups.length === 0) {
      return { findingsCount: 0, issuesOpened: 0, skipped: false };
    }

    // 5. Ensure ai-detected label exists
    const labelId = await ensureAiDetectedLabel(repoRow.id);

    // 6. Open issues — up to MAX_ISSUES_PER_PUSH, then a summary
    let issuesOpened = 0;
    let currentIssueCount = repoRow.issueCount ?? 0;

    if (groups.length <= MAX_ISSUES_PER_PUSH) {
      for (const group of groups) {
        const title = renderIssueTitle(group, pusherUsername);
        const body = renderIssueBody(group, owner, repo, newSha, pusherUsername);
        const num = await insertIssue({
          repositoryId: repoRow.id,
          authorId: repoRow.ownerId,
          title,
          body,
          labelId,
          currentIssueCount,
        });
        if (num !== null) {
          issuesOpened++;
          currentIssueCount++;
        }
      }
    } else {
      // Too many findings — open one summary issue
      const title = `[AI] Multiple issues found in this push (${rawFindings.length} findings) — see details`;
      const body = renderSummaryIssueBody(
        rawFindings.length,
        groups,
        owner,
        repo,
        newSha,
        pusherUsername
      );
      const num = await insertIssue({
        repositoryId: repoRow.id,
        authorId: repoRow.ownerId,
        title,
        body,
        labelId,
        currentIssueCount,
      });
      if (num !== null) {
        issuesOpened++;
      }
    }

    console.log(
      `[ai-auto-issues] ${owner}/${repo}@${newSha.slice(0, 7)}: ${rawFindings.length} finding(s), ${issuesOpened} issue(s) opened`
    );

    return {
      findingsCount: rawFindings.length,
      issuesOpened,
      skipped: false,
    };
  } catch (err) {
    console.warn(
      `[ai-auto-issues] error for ${owner}/${repo}@${newSha.slice(0, 7)}:`,
      err instanceof Error ? err.message : err
    );
    return { findingsCount: 0, issuesOpened: 0, skipped: false };
  }
}

/** Test-only exports — do not import in production code paths. */
export const __test = {
  scanDiffLines,
  groupFindings,
  parseDiffForFindings,
  renderIssueTitle,
  renderIssueBody,
  renderSummaryIssueBody,
  maskSecretValue,
};

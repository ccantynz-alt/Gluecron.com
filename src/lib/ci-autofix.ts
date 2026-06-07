/**
 * CI Auto-Fix — when a gate run or workflow run fails on a PR, Claude reads
 * the error logs, the failing test file, and the PR diff, then posts a
 * ready-to-apply patch as a comment on the PR.
 *
 * Entry points:
 *   triggerCiAutofix(gateRunId) — fire-and-forget; call after a gate_run
 *     row is written with status="failed".
 *   applyAutofix(prCommentId, userId) — apply the patch from a comment onto
 *     a new branch and return the branch name.
 *
 * Route wiring (src/routes/pulls.tsx or src/routes/api.ts):
 *   POST /api/pr-comments/:commentId/apply-autofix → applyAutofix
 */

import { and, eq } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { db } from "../db";
import {
  gateRuns,
  pullRequests,
  prComments,
  repositories,
  users,
  repoCollaborators,
} from "../db/schema";
import { getRepoPath } from "../git/repository";
import { getBotUserIdOrFallback } from "./bot-user";
import {
  getAnthropic,
  isAiAvailable,
  MODEL_SONNET,
  extractText,
  parseJsonResponse,
} from "./ai-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutofixResult {
  prNumber: number;
  repoId: string;
  gateRunId: string;
  patch: string;          // unified diff format
  explanation: string;    // 2-3 sentence explanation
  confidence: "high" | "medium" | "low";
  affectedFiles: string[];
}

interface ClaudeAutofixResponse {
  patch: string;
  explanation: string;
  confidence: "high" | "medium" | "low";
  affectedFiles: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Idempotency marker embedded in every autofix comment. */
export const CI_AUTOFIX_MARKER = "<!-- gluecron:ci-autofix:v1 -->";

/** Max bytes of PR diff sent to Claude. */
const MAX_DIFF_BYTES = 80 * 1024;

/** Max bytes of error log sent to Claude. */
const MAX_LOG_BYTES = 3 * 1024;

/** Max bytes per test file read. */
const MAX_FILE_BYTES = 10 * 1024;

/** Max number of failing test files to read. */
const MAX_TEST_FILES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function spawnGit(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.slice(0, maxBytes).toString("utf8") + "\n[truncated]";
}

/**
 * Extract failing test file paths, error message, and stack trace from a
 * raw CI error log string. Heuristic — good enough for most JS/TS test
 * runners (Jest, Vitest, Bun test) and Python pytest output.
 */
function parseErrorLog(errorLog: string): {
  testFiles: string[];
  errorSummary: string;
} {
  const lines = errorLog.split("\n");

  // Collect candidate test file paths:
  //   - lines mentioning .test.ts/.spec.ts/.test.js/.spec.js/.test.py paths
  //   - lines with "FAIL <path>" (Jest pattern)
  const filePatterns = [
    /(?:^|\s)([\w./\-]+\.(?:test|spec)\.[jt]sx?)/gm,
    /(?:^|\s)([\w./\-]+_test\.py)/gm,
    /(?:^FAIL\s+)([\w./\-]+)/gm,
  ];

  const filesSet = new Set<string>();
  for (const pattern of filePatterns) {
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(errorLog)) !== null) {
      const path = m[1].trim();
      if (path && !path.startsWith("-") && !path.startsWith("+")) {
        filesSet.add(path);
      }
    }
  }

  // Error summary: first 3KB of the log (most runners put the error first).
  const errorSummary = truncate(errorLog, MAX_LOG_BYTES);

  return {
    testFiles: Array.from(filesSet).slice(0, MAX_TEST_FILES),
    errorSummary,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget entry point called after a gate_run row is set to 'failed'.
 * Never throws — all errors are swallowed after logging.
 */
export async function triggerCiAutofix(gateRunId: string): Promise<void> {
  if (!isAiAvailable()) return;

  try {
    await _runAutofix(gateRunId);
  } catch (err) {
    console.error(
      "[ci-autofix] crashed:",
      err instanceof Error ? err.message : err
    );
  }
}

async function _runAutofix(gateRunId: string): Promise<void> {
  // 1. Load the gate run
  const [gateRun] = await db
    .select()
    .from(gateRuns)
    .where(eq(gateRuns.id, gateRunId))
    .limit(1);

  if (!gateRun) return;
  if (gateRun.status !== "failed") return;
  if (!gateRun.pullRequestId) return;

  // 2. Load the PR row
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, gateRun.pullRequestId))
    .limit(1);

  if (!pr) return;

  // 3. Load repo (owner/name)
  const [repoRow] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      diskPath: repositories.diskPath,
      ownerUsername: users.username,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(eq(repositories.id, gateRun.repositoryId))
    .limit(1);

  if (!repoRow) return;

  // 4. Check idempotency — skip if already posted for this gateRunId
  const idempotencyMarker = `<!-- gluecron:ci-autofix:run:${gateRunId} -->`;
  const existing = await db
    .select({ id: prComments.id })
    .from(prComments)
    .where(
      and(
        eq(prComments.pullRequestId, gateRun.pullRequestId),
        // We check by looking for comments with the autofix marker.
        // drizzle doesn't have LIKE with dynamic params easily, but
        // we query all AI comments and filter client-side (there won't be many).
        eq(prComments.isAiReview, true)
      )
    )
    .limit(50);

  for (const row of existing) {
    // Load the body to check idempotency marker
    const [full] = await db
      .select({ body: prComments.body })
      .from(prComments)
      .where(eq(prComments.id, row.id))
      .limit(1);
    if (full?.body?.includes(idempotencyMarker)) return;
  }

  const repoDir = getRepoPath(repoRow.ownerUsername, repoRow.name);

  // 5. Get the PR diff (max 80KB)
  const diffResult = await spawnGit(
    ["diff", `${pr.baseBranch}...${pr.headBranch}`],
    repoDir
  );
  const prDiff = truncate(diffResult.stdout, MAX_DIFF_BYTES);

  if (!prDiff.trim()) return; // nothing to work with

  // 6. Parse errorLog to extract test files + error summary
  const errorLog = gateRun.summary || gateRun.details || "";
  const { testFiles, errorSummary } = parseErrorLog(
    typeof errorLog === "string" ? errorLog : JSON.stringify(errorLog)
  );

  // 7. Read failing test files via git show HEAD:path
  let testFileContent = "";
  for (const filePath of testFiles) {
    const showResult = await spawnGit(
      ["show", `${pr.headBranch}:${filePath}`],
      repoDir
    );
    if (showResult.exitCode === 0 && showResult.stdout) {
      const content = truncate(showResult.stdout, MAX_FILE_BYTES);
      testFileContent += `\n\n--- ${filePath} ---\n${content}`;
    }
  }

  // 8. Call Claude Sonnet 4.6
  const client = getAnthropic();
  const prompt = `You are a senior engineer fixing a CI failure.

PR diff (what changed):
${prDiff}

Failing test output:
${errorSummary}

Test file content:${testFileContent || "\n(no test files detected)"}

Produce a minimal unified diff patch that fixes the CI failure. The patch must:
1. Be valid unified diff format (--- a/file, +++ b/file, @@ lines)
2. Fix only what's needed — no refactoring
3. Not modify the test itself unless the test expectation is genuinely wrong

Return JSON: {"patch": "...", "explanation": "...", "confidence": "high|medium|low", "affectedFiles": ["..."]}`;

  const message = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = extractText(message);
  const parsed = parseJsonResponse<ClaudeAutofixResponse>(rawText);

  if (!parsed || !parsed.patch || !parsed.explanation) return;

  // 10. If confidence === 'low' → skip
  if (parsed.confidence === "low") return;

  // 11. Build and post the comment
  const commentBody = buildAutofixComment(
    parsed,
    idempotencyMarker,
    gateRunId
  );

  const botAuthorId = await getBotUserIdOrFallback(repoRow.id);
  if (!botAuthorId) return;

  await db.insert(prComments).values({
    pullRequestId: gateRun.pullRequestId,
    authorId: botAuthorId,
    body: commentBody,
    isAiReview: true,
  });
}

function buildAutofixComment(
  result: ClaudeAutofixResponse,
  idempotencyMarker: string,
  gateRunId: string
): string {
  const confidenceBadge =
    result.confidence === "high"
      ? "🟢 High confidence"
      : result.confidence === "medium"
        ? "🟡 Medium confidence"
        : "🔴 Low confidence";

  return `${CI_AUTOFIX_MARKER}
${idempotencyMarker}

## 🔧 AI Auto-Fix

${result.explanation}

**Confidence:** ${confidenceBadge}

\`\`\`diff
${result.patch}
\`\`\`

<details><summary>Apply this fix</summary>

Copy the patch above or click **Apply Fix** to commit it automatically.

<form method="post" action="/api/pr-comments/COMMENT_ID/apply-autofix" style="display:inline">
  <button type="submit" style="margin-top:8px;padding:6px 14px;background:#6c63ff;color:#fff;border:none;border-radius:6px;cursor:pointer">
    ⚡ Apply Fix
  </button>
</form>

</details>

<sub>Gate run: <code>${gateRunId}</code> · Affected files: ${result.affectedFiles.join(", ") || "see patch above"}</sub>`;
}

// ---------------------------------------------------------------------------
// Apply autofix
// ---------------------------------------------------------------------------

/**
 * Applies the patch from a PR comment onto a new branch.
 * Returns the new branch name so the caller can redirect to compare view.
 */
export async function applyAutofix(
  prCommentId: string,
  userId: string
): Promise<{ branchName: string }> {
  // 1. Load the comment
  const [comment] = await db
    .select({
      id: prComments.id,
      pullRequestId: prComments.pullRequestId,
      body: prComments.body,
      isAiReview: prComments.isAiReview,
    })
    .from(prComments)
    .where(eq(prComments.id, prCommentId))
    .limit(1);

  if (!comment) throw new Error("Comment not found");
  if (!comment.body.includes(CI_AUTOFIX_MARKER)) {
    throw new Error("Not an autofix comment");
  }

  // 2. Load PR + repo for access check
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, comment.pullRequestId))
    .limit(1);

  if (!pr) throw new Error("PR not found");

  const [repoRow] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerId: repositories.ownerId,
      ownerUsername: users.username,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(eq(repositories.id, pr.repositoryId))
    .limit(1);

  if (!repoRow) throw new Error("Repository not found");

  // Verify write access: must be repo owner or collaborator
  const isOwner = repoRow.ownerId === userId;
  if (!isOwner) {
    const [collab] = await db
      .select({ id: repoCollaborators.id })
      .from(repoCollaborators)
      .where(
        and(
          eq(repoCollaborators.repositoryId, repoRow.id),
          eq(repoCollaborators.userId, userId)
        )
      )
      .limit(1);
    if (!collab) throw new Error("Forbidden: no write access");
  }

  // 3. Extract patch from comment body
  const patchMatch = comment.body.match(/```diff\n([\s\S]*?)```/);
  if (!patchMatch) throw new Error("No patch found in comment");
  const patch = patchMatch[1];

  // 4. Create a new branch from the PR's head
  const branchName = `fix/autofix-${Date.now()}`;
  const repoDir = getRepoPath(repoRow.ownerUsername, repoRow.name);

  // Create the branch at the PR head SHA
  const headSha = await spawnGit(
    ["rev-parse", pr.headBranch],
    repoDir
  );
  if (headSha.exitCode !== 0) throw new Error("Cannot resolve head branch");

  await spawnGit(
    ["branch", branchName, headSha.stdout.trim()],
    repoDir
  );

  // 5. Apply the patch via git apply in a temp worktree
  const tmpDir = await mkdtemp(join(tmpdir(), "autofix-"));
  try {
    // Add worktree for the new branch
    const wtResult = await spawnGit(
      ["worktree", "add", tmpDir, branchName],
      repoDir
    );
    if (wtResult.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${wtResult.stderr}`);
    }

    // Write the patch to a temp file
    const patchFile = join(tmpDir, "autofix.patch");
    await writeFile(patchFile, patch, "utf8");

    // Apply the patch
    const applyResult = await spawnGit(
      ["apply", "--index", patchFile],
      tmpDir
    );
    if (applyResult.exitCode !== 0) {
      throw new Error(`git apply failed: ${applyResult.stderr}`);
    }

    // 6. Commit
    const commitResult = await spawnGit(
      [
        "commit",
        "-m",
        "fix: apply AI autofix for CI failure",
        "--author",
        "gluecron[bot] <bot@gluecron.com>",
      ],
      tmpDir
    );
    if (commitResult.exitCode !== 0) {
      throw new Error(`git commit failed: ${commitResult.stderr}`);
    }

    // 7. Push the branch back to the bare repo
    // In a bare-repo + worktree setup the push target is the bare repo itself.
    await spawnGit(
      ["push", repoDir, `HEAD:refs/heads/${branchName}`],
      tmpDir
    );
  } finally {
    // Cleanup worktree
    await spawnGit(["worktree", "remove", "--force", tmpDir], repoDir).catch(
      () => {}
    );
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return { branchName };
}

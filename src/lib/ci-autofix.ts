/**
 * CI Auto-Fix — when a gate run or workflow run fails on a PR, the repair
 * flywheel cache is consulted first (Tier 0); on a miss Claude reads the
 * error logs, the failing test file, and the PR diff. Either way a
 * ready-to-apply patch is posted as a comment on the PR.
 *
 * Entry points:
 *   triggerCiAutofix(gateRunId) — fire-and-forget; call after a gate_run
 *     row is written with status="failed".
 *   applyAutofix(prCommentId, userId) — apply the patch from a comment onto
 *     a new branch and return the branch name. Settles the flywheel entry
 *     (success/failed) so the cache's confidence accumulates.
 *
 * Route wiring (src/routes/pulls.tsx or src/routes/api.ts):
 *   POST /api/pr-comments/:commentId/apply-autofix → applyAutofix
 *
 * Flywheel wiring (BUILD_BIBLE §7 finding 1): every failure is fingerprinted
 * via repair-flywheel.ts; a previously-successful patch with the same
 * signature and a good success rate is served WITHOUT an AI call. All served
 * fixes are recorded as 'pending' flywheel rows and settled on apply.
 * Flywheel/DB errors never break this path — a broken cache degrades to the
 * old always-call-AI behaviour.
 */

import { and, eq } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { db } from "../db";
import {
  findCachedRepair,
  recordRepair,
  updateOutcome,
  type CachedRepair,
  type RecordRepairInput,
} from "./repair-flywheel";
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

export interface ClaudeAutofixResponse {
  patch: string;
  explanation: string;
  confidence: "high" | "medium" | "low";
  affectedFiles: string[];
}

/**
 * DI seam for the repair-flywheel wiring. Production callers omit this and
 * get the real implementations; tests inject fakes so no DB is touched.
 */
export interface CiAutofixDeps {
  findCachedRepair?: typeof findCachedRepair;
  recordRepair?: typeof recordRepair;
  updateOutcome?: typeof updateOutcome;
  aiAvailable?: () => boolean;
}

/** The fix triggerCiAutofix decided to post, plus its flywheel bookkeeping. */
export interface AutofixPlan {
  /** 'cache' = Tier-0 flywheel replay (no AI call); 'ai' = fresh Sonnet patch. */
  source: "cache" | "ai";
  fix: ClaudeAutofixResponse;
  /** Flywheel row recorded as 'pending' for this attempt; null if recording failed. */
  flywheelEntryId: string | null;
  /** On a cache hit: the parent pattern that was replayed. */
  cachedPatternId: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Idempotency marker embedded in every autofix comment. */
export const CI_AUTOFIX_MARKER = "<!-- gluecron:ci-autofix:v1 -->";

/**
 * Marker carrying the pending flywheel entry id, embedded in the autofix
 * comment so applyAutofix can settle the outcome (success/failed) later.
 */
export const FLYWHEEL_MARKER_PREFIX = "<!-- gluecron:ci-autofix:flywheel:";

/**
 * Minimum settled success rate before a cached pattern is replayed instead
 * of calling the AI. Below this the cache is considered unreliable for the
 * signature and we fall through to a fresh Sonnet patch.
 */
export const CACHE_MIN_SUCCESS_RATE = 0.5;

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
// Repair flywheel wiring (Tier 0)
// ---------------------------------------------------------------------------

/** Matches the id inside a FLYWHEEL_MARKER_PREFIX comment marker. */
const FLYWHEEL_MARKER_RE = /<!-- gluecron:ci-autofix:flywheel:([0-9a-fA-F-]{8,64}) -->/;

/** Parse the flywheel entry id out of an autofix comment body, if present. */
export function extractFlywheelEntryId(commentBody: string): string | null {
  const m = commentBody.match(FLYWHEEL_MARKER_RE);
  return m ? m[1] : null;
}

/**
 * Record a 'pending' flywheel row for a fix we're about to post. Never
 * throws — a flywheel write failure must not stop the fix from shipping,
 * it only means this attempt won't contribute to the cache's learning.
 */
async function safeRecordRepair(
  input: RecordRepairInput,
  deps: CiAutofixDeps
): Promise<string | null> {
  const record = deps.recordRepair ?? recordRepair;
  try {
    return await record(input);
  } catch (err) {
    console.warn(
      "[ci-autofix] flywheel record failed (fix still served):",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Settle the flywheel entry referenced by an autofix comment (if any) so
 * the pattern's success rate accumulates. Never throws — flywheel
 * bookkeeping must not break the apply path.
 */
export async function recordAutofixOutcome(
  commentBody: string,
  outcome: "success" | "failed",
  deps: CiAutofixDeps = {}
): Promise<void> {
  const entryId = extractFlywheelEntryId(commentBody);
  if (!entryId) return;
  const settle = deps.updateOutcome ?? updateOutcome;
  try {
    await settle(entryId, outcome);
  } catch (err) {
    console.warn(
      "[ci-autofix] flywheel outcome update failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Tier-0-then-AI resolution for a CI failure (BUILD_BIBLE §7 finding 1).
 *
 *   1. Tier 0 — consult the repair flywheel for a previously-successful fix
 *      with the same failure signature. On a usable hit (success rate ≥
 *      CACHE_MIN_SUCCESS_RATE and a stored patch) the cached patch is
 *      served directly: no Anthropic call at all.
 *   2. Tier 2 — fall through to a fresh Claude Sonnet patch via the
 *      `generateAiFix` thunk (guarded by isAiAvailable(); the thunk also
 *      keeps the expensive git context-gathering off the cache-hit path).
 *
 * Every served fix is recorded as a 'pending' flywheel row; applyAutofix
 * settles it via recordAutofixOutcome. Flywheel/DB failures NEVER break
 * this path — a broken cache degrades to the old always-call-AI behaviour.
 */
export async function resolveAutofix(args: {
  repositoryId: string;
  failureText: string;
  generateAiFix: () => Promise<ClaudeAutofixResponse | null>;
  deps?: CiAutofixDeps;
}): Promise<AutofixPlan | null> {
  const deps = args.deps ?? {};
  const lookup = deps.findCachedRepair ?? findCachedRepair;
  const aiOk = deps.aiAvailable ?? isAiAvailable;

  // ── Tier 0: flywheel cache. Fail open — any error counts as a miss.
  let cached: CachedRepair | null = null;
  if (args.failureText.trim()) {
    try {
      cached = await lookup(args.repositoryId, args.failureText);
    } catch (err) {
      console.warn(
        "[ci-autofix] flywheel lookup failed (falling through to AI):",
        err instanceof Error ? err.message : err
      );
    }
  }

  // A usable hit needs a stored full patch (pre-0105 rows have none) AND a
  // good settled success rate; anything else falls through to the AI tier.
  if (
    cached &&
    cached.patch?.trim() &&
    cached.successRate >= CACHE_MIN_SUCCESS_RATE
  ) {
    const fix: ClaudeAutofixResponse = {
      patch: cached.patch,
      explanation:
        cached.patchSummary ||
        "Replayed a previously-successful repair for this failure signature.",
      // A pattern that keeps working is high confidence; anything that has
      // failed at least occasionally is medium.
      confidence: cached.successRate >= 0.9 ? "high" : "medium",
      affectedFiles: cached.filesChanged,
    };
    const entryId = await safeRecordRepair(
      {
        repositoryId: args.repositoryId,
        failureText: args.failureText,
        classification: cached.classification,
        tier: "cached",
        patchSummary: fix.explanation,
        // Carry the patch onto the new row so it is itself replayable once
        // it settles (findCachedRepair prefers the most recent success).
        patch: cached.patch,
        filesChanged: fix.affectedFiles,
        commitSha: null,
        parentPatternId: cached.id,
      },
      deps
    );
    // Audit the saved AI call — this line is the flywheel's whole point.
    console.log(
      `[ci-autofix] flywheel cache HIT — pattern ${cached.id} (success rate ${(cached.successRate * 100).toFixed(0)}%, ${cached.hitCount} prior hits) served without an AI call`
    );
    return { source: "cache", fix, flywheelEntryId: entryId, cachedPatternId: cached.id };
  }

  // ── Tier 2: fresh AI patch. All AI features degrade gracefully when no
  // API key is configured — cached fixes above still work without one.
  if (!aiOk()) return null;

  const fix = await args.generateAiFix();
  if (!fix || !fix.patch || !fix.explanation) return null;
  if (fix.confidence === "low") return null;

  const entryId = await safeRecordRepair(
    {
      repositoryId: args.repositoryId,
      failureText: args.failureText,
      classification: null,
      tier: "ai-sonnet",
      patchSummary: fix.explanation,
      // Stored so the entry is replayable by the Tier-0 cache once it
      // settles to 'success'.
      patch: fix.patch,
      filesChanged: fix.affectedFiles,
      commitSha: null,
    },
    deps
  );
  return { source: "ai", fix, flywheelEntryId: entryId, cachedPatternId: null };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget entry point called after a gate_run row is set to 'failed'.
 * Never throws — all errors are swallowed after logging.
 *
 * Note: no isAiAvailable() gate here — the Tier-0 flywheel cache needs no
 * API key, so cached fixes still flow when AI is unconfigured. The actual
 * Anthropic call is guarded inside resolveAutofix (graceful degradation).
 */
export async function triggerCiAutofix(
  gateRunId: string,
  deps: CiAutofixDeps = {}
): Promise<void> {
  try {
    await _runAutofix(gateRunId, deps);
  } catch (err) {
    console.error(
      "[ci-autofix] crashed:",
      err instanceof Error ? err.message : err
    );
  }
}

async function _runAutofix(
  gateRunId: string,
  deps: CiAutofixDeps = {}
): Promise<void> {
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

  // 5. Failure text — drives both the flywheel signature and the AI prompt.
  const errorLog = gateRun.summary || gateRun.details || "";
  const failureText =
    typeof errorLog === "string" ? errorLog : JSON.stringify(errorLog);

  // 6. Tier 0 (flywheel cache) first, then the AI fallback. The expensive
  //    context gathering (PR diff + failing test files + Sonnet call) lives
  //    inside the thunk so a cache hit never touches git or the API.
  const plan = await resolveAutofix({
    repositoryId: repoRow.id,
    failureText,
    deps,
    generateAiFix: async () => {
      // 6a. Get the PR diff (max 80KB)
      const diffResult = await spawnGit(
        ["diff", `${pr.baseBranch}...${pr.headBranch}`],
        repoDir
      );
      const prDiff = truncate(diffResult.stdout, MAX_DIFF_BYTES);

      if (!prDiff.trim()) return null; // nothing to work with

      // 6b. Parse errorLog to extract test files + error summary
      const { testFiles, errorSummary } = parseErrorLog(failureText);

      // 6c. Read failing test files via git show HEAD:path
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

      // 6d. Call Claude Sonnet 4.6
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
      return parseJsonResponse<ClaudeAutofixResponse>(rawText);
    },
  });

  // No usable fix (cache miss + AI declined/low-confidence/unavailable).
  if (!plan) return;

  // 7. Build and post the comment
  const commentBody = buildAutofixComment(plan, idempotencyMarker, gateRunId);

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
  plan: AutofixPlan,
  idempotencyMarker: string,
  gateRunId: string
): string {
  const result = plan.fix;
  const confidenceBadge =
    result.confidence === "high"
      ? "🟢 High confidence"
      : result.confidence === "medium"
        ? "🟡 Medium confidence"
        : "🔴 Low confidence";

  // Flywheel bookkeeping marker — applyAutofix parses this to settle the
  // pending entry's outcome. Absent when the flywheel write failed.
  const flywheelMarker = plan.flywheelEntryId
    ? `\n${FLYWHEEL_MARKER_PREFIX}${plan.flywheelEntryId} -->`
    : "";

  const sourceNote =
    plan.source === "cache"
      ? `\n\n♻️ **Served from the repair cache** — this failure signature was fixed successfully before; no AI call was made.`
      : "";

  return `${CI_AUTOFIX_MARKER}
${idempotencyMarker}${flywheelMarker}

## 🔧 AI Auto-Fix

${result.explanation}${sourceNote}

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
 *
 * Also settles the comment's pending flywheel entry: a clean apply+commit
 * records 'success' (the pattern becomes replayable by the Tier-0 cache),
 * an apply failure records 'failed' so unreliable patterns lose confidence.
 */
export async function applyAutofix(
  prCommentId: string,
  userId: string,
  deps: CiAutofixDeps = {}
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

    // 8. The repair landed — settle the flywheel entry so this pattern's
    // success rate climbs and future identical failures hit the Tier-0 cache.
    await recordAutofixOutcome(comment.body, "success", deps);
  } catch (err) {
    // The patch failed to apply/commit/push — settle as 'failed' so the
    // flywheel learns this pattern is unreliable. Best-effort: the original
    // error is always rethrown for the route to surface.
    await recordAutofixOutcome(comment.body, "failed", deps);
    throw err;
  } finally {
    // Cleanup worktree
    await spawnGit(["worktree", "remove", "--force", tmpDir], repoDir).catch(
      () => {}
    );
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return { branchName };
}

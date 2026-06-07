/**
 * Autonomous Issue-to-Merged-PR Loop (ai-loop).
 *
 * After spec-to-pr creates a PR, this module drives a self-healing cycle:
 *   1. Check if the latest gate run for the PR is green or red.
 *   2. Green → call performMerge and mark the PR as merged.
 *   3. Red and attempts < MAX_ATTEMPTS → call triggerCiAutofix, poll for a
 *      new gate run (up to 2 minutes), then loop.
 *   4. Attempts exhausted → post a failure comment and give up.
 *
 * Idempotency:
 *   - Before starting, check for a <!-- gluecron:ai-loop:v1 --> marker in
 *     existing PR comments. If present: skip (already handled).
 *   - Each attempt is annotated with <!-- gluecron:ai-loop:attempt:N -->.
 *
 * Safe-default: the env var AI_LOOP_ENABLED must equal "1" for fire-and-
 * forget callers that pass through ai-build-tasks.ts. The `runAutonomousLoop`
 * export itself has no such guard so tests and targeted callers can invoke it
 * unconditionally.
 *
 * Guard: isAiAvailable() is checked at the top of runAutonomousLoop; callers
 * may also check it before invoking fire-and-forget. When the API key is
 * absent the function returns immediately with {success:false}.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { gateRuns, prComments, pullRequests, repositories, users } from "../db/schema";
import { isAiAvailable } from "./ai-client";
import { performMerge } from "./pr-merge";
import { triggerCiAutofix } from "./ci-autofix";
import { getBotUserIdOrFallback } from "./bot-user";
import { AI_BUILD_MARKER } from "./ai-build-tasks";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoopResult {
  success: boolean;
  attempts: number;
  mergedAt?: Date;
  failReason?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable marker embedded in the initial "loop started" comment. */
export const AI_LOOP_MARKER = "<!-- gluecron:ai-loop:v1 -->";
/** Per-attempt progress marker prefix. */
const AI_LOOP_ATTEMPT_PREFIX = "<!-- gluecron:ai-loop:attempt:";

/** Maximum fix-and-retry cycles before giving up. */
const MAX_ATTEMPTS = 3;

/** How long to poll for a new gate run after triggering autofix (ms). */
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

/** Interval between polls (ms). */
const POLL_INTERVAL_MS = 10 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true if any PR comment contains the ai-loop:v1 idempotency marker.
 */
async function hasLoopMarker(prId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: prComments.id })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, prId),
          sql`${prComments.body} LIKE ${"%" + AI_LOOP_MARKER + "%"}`
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    // Conservative: assume already handled on DB error.
    return true;
  }
}

/**
 * Post a comment on the PR authored by the bot (or fallback to the PR author).
 * Never throws.
 */
async function postComment(
  prId: string,
  fallbackAuthorId: string,
  body: string
): Promise<void> {
  try {
    const authorId = await getBotUserIdOrFallback(fallbackAuthorId);
    await db.insert(prComments).values({
      pullRequestId: prId,
      authorId,
      body,
      isAiReview: true,
    });
  } catch (err) {
    console.error("[ai-loop] postComment failed:", err);
  }
}

/**
 * Load the latest gate run for this PR. Returns null when none exists.
 */
async function loadLatestGateRun(prId: string): Promise<{
  id: string;
  status: string;
  summary: string | null;
  details: string | null;
  createdAt: Date;
} | null> {
  try {
    const rows = await db
      .select({
        id: gateRuns.id,
        status: gateRuns.status,
        summary: gateRuns.summary,
        details: gateRuns.details,
        createdAt: gateRuns.createdAt,
      })
      .from(gateRuns)
      .where(eq(gateRuns.pullRequestId, prId))
      .orderBy(desc(gateRuns.createdAt))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Update the ai_loop_attempts and ai_loop_status columns on the PR row.
 * Best-effort — failures are logged but not rethrown.
 */
async function updatePrLoopState(
  prId: string,
  attempts: number,
  status: "running" | "merged" | "failed"
): Promise<void> {
  try {
    await db
      .update(pullRequests)
      .set({
        aiLoopAttempts: attempts,
        aiLoopStatus: status,
        updatedAt: new Date(),
      })
      .where(eq(pullRequests.id, prId));
  } catch (err) {
    console.error("[ai-loop] updatePrLoopState failed:", err);
  }
}

/**
 * Poll until a gate run newer than `afterDate` appears for this PR (or times out).
 * Returns the new gate run, or null on timeout.
 */
async function pollForNewGateRun(
  prId: string,
  afterDate: Date
): Promise<{ id: string; status: string } | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const rows = await db
        .select({ id: gateRuns.id, status: gateRuns.status })
        .from(gateRuns)
        .where(
          and(
            eq(gateRuns.pullRequestId, prId),
            sql`${gateRuns.createdAt} > ${afterDate}`
          )
        )
        .orderBy(desc(gateRuns.createdAt))
        .limit(1);
      if (rows.length > 0) return rows[0];
    } catch {
      // continue polling
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core export
// ---------------------------------------------------------------------------

/**
 * Drive the autonomous fix-and-merge loop for a single PR.
 *
 * Flow:
 *   • Guard: isAiAvailable() → no-op return when ANTHROPIC_API_KEY missing.
 *   • Idempotency: check for AI_LOOP_MARKER in existing PR comments.
 *   • Load PR + repo metadata needed for performMerge.
 *   • Loop up to MAX_ATTEMPTS:
 *       - Fetch latest gate run.
 *       - No gate run yet → wait for one (poll up to 2 min).
 *       - Gate is green (passed/skipped) → performMerge → done.
 *       - Gate is red → post attempt comment, triggerCiAutofix, poll for
 *         new gate run, loop.
 *       - Gate is pending/running → wait for it to settle (poll 2 min).
 *   • Attempts exhausted → post failure comment, set aiLoopStatus='failed'.
 */
export async function runAutonomousLoop(
  prId: string,
  repoId: string
): Promise<LoopResult> {
  if (!isAiAvailable()) {
    return { success: false, attempts: 0, failReason: "ANTHROPIC_API_KEY not set" };
  }

  // Load PR row.
  let pr: {
    id: string;
    number: number;
    title: string;
    body: string | null;
    baseBranch: string;
    headBranch: string;
    state: string;
    isDraft: boolean;
    authorId: string;
    repositoryId: string;
    aiLoopAttempts: number;
    aiLoopStatus: string | null;
  } | undefined;

  try {
    const rows = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        body: pullRequests.body,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
        state: pullRequests.state,
        isDraft: pullRequests.isDraft,
        authorId: pullRequests.authorId,
        repositoryId: pullRequests.repositoryId,
        aiLoopAttempts: pullRequests.aiLoopAttempts,
        aiLoopStatus: pullRequests.aiLoopStatus,
      })
      .from(pullRequests)
      .where(eq(pullRequests.id, prId))
      .limit(1);
    pr = rows[0];
  } catch (err) {
    return {
      success: false,
      attempts: 0,
      failReason: `DB load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!pr) {
    return { success: false, attempts: 0, failReason: "PR not found" };
  }
  if (pr.state !== "open") {
    return {
      success: false,
      attempts: 0,
      failReason: `PR is not open (state=${pr.state})`,
    };
  }
  // Already handled by another loop run.
  if (pr.aiLoopStatus === "running" || pr.aiLoopStatus === "merged") {
    return {
      success: pr.aiLoopStatus === "merged",
      attempts: pr.aiLoopAttempts,
      failReason:
        pr.aiLoopStatus === "running"
          ? "Another loop run is already in progress"
          : undefined,
    };
  }

  // Idempotency: skip if the loop marker already exists.
  if (await hasLoopMarker(prId)) {
    return {
      success: false,
      attempts: 0,
      failReason: "Loop already started (marker present)",
    };
  }

  // Load repo + owner for performMerge.
  let repoRow: { name: string; ownerUsername: string } | undefined;
  try {
    const rows = await db
      .select({
        name: repositories.name,
        ownerUsername: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.id, repoId))
      .limit(1);
    repoRow = rows[0];
  } catch {
    /* fall through — caught below */
  }

  if (!repoRow) {
    return { success: false, attempts: 0, failReason: "Repo not found" };
  }

  // Mark loop as started: post the idempotency marker comment and update DB.
  await postComment(
    prId,
    pr.authorId,
    `${AI_LOOP_MARKER}\nThe autonomous AI loop has started for this PR. It will attempt to fix any CI failures and merge automatically (up to ${MAX_ATTEMPTS} attempts).`
  );
  await updatePrLoopState(prId, 0, "running");

  let attempts = 0;

  // ---------------------------------------------------------------------------
  // Main retry loop
  // ---------------------------------------------------------------------------
  while (attempts < MAX_ATTEMPTS) {
    // Re-fetch PR state in case it was closed/merged externally.
    try {
      const rows = await db
        .select({ state: pullRequests.state, isDraft: pullRequests.isDraft })
        .from(pullRequests)
        .where(eq(pullRequests.id, prId))
        .limit(1);
      const current = rows[0];
      if (!current || current.state !== "open") {
        return {
          success: current?.state === "merged",
          attempts,
          failReason:
            current?.state !== "merged"
              ? `PR no longer open (state=${current?.state ?? "unknown"})`
              : undefined,
        };
      }
      // Refresh isDraft flag in case someone changed it.
      pr = { ...pr, isDraft: current.isDraft };
    } catch {
      // Continue with stale data — best effort.
    }

    // Fetch the latest gate run.
    let gateRun = await loadLatestGateRun(prId);

    // If no gate run exists yet, wait for one.
    if (!gateRun) {
      const found = await pollForNewGateRun(prId, new Date(0));
      if (!found) {
        // Still nothing — treat as a failure to progress.
        break;
      }
      gateRun = { ...found, summary: null, details: null, createdAt: new Date() };
    }

    // If gate is still pending/running, wait for it to settle.
    if (gateRun.status === "pending" || gateRun.status === "running") {
      const settled = await pollForNewGateRun(prId, new Date(gateRun.createdAt.getTime() - 1));
      if (settled) {
        gateRun = { ...gateRun, ...settled };
      }
      // If still not settled, we'll try to evaluate with what we have.
    }

    const gateGreen =
      gateRun.status === "passed" ||
      gateRun.status === "skipped" ||
      gateRun.status === "repaired";

    if (gateGreen) {
      // Gate is green — attempt to merge.
      const mergeResult = await performMerge({
        pr: {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
          repositoryId: pr.repositoryId,
          authorId: pr.authorId,
          state: "open",
          isDraft: pr.isDraft,
        },
        ownerName: repoRow.ownerUsername,
        repoName: repoRow.name,
        actorUserId: pr.authorId,
        hasConflicts: false,
      });

      if (mergeResult.ok) {
        const mergedAt = new Date();
        await updatePrLoopState(prId, attempts, "merged");
        await postComment(
          prId,
          pr.authorId,
          `${AI_LOOP_MARKER}\nThe autonomous AI loop successfully merged this PR after ${attempts === 0 ? "0 fix attempts (gate was already green)" : `${attempts} fix attempt${attempts === 1 ? "" : "s"}`}.`
        );
        return { success: true, attempts, mergedAt };
      }

      // Merge failed despite green gate — this is unexpected; give up.
      const reason = mergeResult.error || "unknown merge error";
      await updatePrLoopState(prId, attempts, "failed");
      await postComment(
        prId,
        pr.authorId,
        `${AI_LOOP_MARKER}\n**AI Loop: merge failed**\n\nThe gate was green but the merge failed: ${reason}\n\nManual intervention required.`
      );
      return { success: false, attempts, failReason: `Merge failed: ${reason}` };
    }

    // Gate is red — attempt a fix.
    attempts += 1;
    await updatePrLoopState(prId, attempts, "running");

    const attemptMarker = `${AI_LOOP_ATTEMPT_PREFIX}${attempts} -->`;
    await postComment(
      prId,
      pr.authorId,
      `${attemptMarker}\n**AI Loop: fix attempt ${attempts}/${MAX_ATTEMPTS}**\n\nGate run \`${gateRun.id}\` reported status \`${gateRun.status}\`. Triggering CI autofix…`
    );

    // Trigger the autofix (fire-and-forget inside ci-autofix, but we await
    // the wrapper because it does the Claude call synchronously).
    await triggerCiAutofix(gateRun.id);

    // Wait for a new gate run to appear (autofix triggers a new push → new run).
    const newRun = await pollForNewGateRun(prId, gateRun.createdAt);
    if (!newRun) {
      // Autofix didn't produce a new gate run within the timeout.
      if (attempts >= MAX_ATTEMPTS) break;
      // Try the next attempt anyway — maybe the push just didn't start a new run.
    }
  }

  // Exhausted all attempts.
  await updatePrLoopState(prId, attempts, "failed");
  await postComment(
    prId,
    pr.authorId,
    `${AI_LOOP_MARKER}\n**AI Loop: exhausted ${MAX_ATTEMPTS} fix attempts**\n\nThe autonomous loop was unable to repair CI failures after ${MAX_ATTEMPTS} attempt${MAX_ATTEMPTS > 1 ? "s" : ""}. Manual intervention required.\n\nCC: @${repoRow.ownerUsername}`
  );

  return {
    success: false,
    attempts,
    failReason: `Exhausted ${MAX_ATTEMPTS} fix attempts`,
  };
}

// ---------------------------------------------------------------------------
// Autopilot sweep helper
// ---------------------------------------------------------------------------

/**
 * Scan for open PRs whose body contains the AI_BUILD_MARKER (created by the
 * ai-build flow) and that have no AI_LOOP_MARKER comment yet. Runs up to
 * `cap` per tick. Called by the autopilot `ai-loop-sweep` task.
 *
 * Never throws.
 */
export async function runAiLoopSweepOnce(cap = 5): Promise<{
  considered: number;
  started: number;
  skipped: number;
}> {
  if (!isAiAvailable()) {
    return { considered: 0, started: 0, skipped: 0 };
  }

  let candidates: { id: string; repositoryId: string }[] = [];
  try {
    candidates = await db
      .select({ id: pullRequests.id, repositoryId: pullRequests.repositoryId })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.state, "open"),
          sql`${pullRequests.body} LIKE ${"%" + AI_BUILD_MARKER + "%"}`
        )
      )
      .limit(cap * 3); // over-fetch so we can filter idempotent ones in JS
  } catch (err) {
    console.error("[ai-loop] sweep candidate query failed:", err);
    return { considered: 0, started: 0, skipped: 0 };
  }

  let considered = 0;
  let started = 0;
  let skipped = 0;

  for (const cand of candidates) {
    if (started >= cap) break;
    considered += 1;

    // Skip if loop already has a marker comment.
    const already = await hasLoopMarker(cand.id);
    if (already) {
      skipped += 1;
      continue;
    }

    // Fire-and-forget — the loop is long-running (up to 6 minutes).
    try {
      void runAutonomousLoop(cand.id, cand.repositoryId).catch((err) => {
        console.error(
          `[ai-loop] runAutonomousLoop threw for pr=${cand.id}:`,
          err
        );
      });
      started += 1;
    } catch (err) {
      console.error(`[ai-loop] sweep: failed to start loop for pr=${cand.id}:`, err);
      skipped += 1;
    }
  }

  return { considered, started, skipped };
}

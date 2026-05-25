/**
 * Autopilot task — `pr-test-generator`.
 *
 * Every tick (cadence-gated to ~5 min) pick up freshly-opened PRs that:
 *   1. Are not themselves AI-generated (no `ai:spec-implementation`
 *      marker in the body — avoid recursion).
 *   2. Don't already have an `ai:added-tests` marker comment.
 *   3. Have at least one source-file change in the diff (we delegate
 *      that filter to `generateTestsForPr` which scans the diff anyway).
 *   4. Live on a repo whose owner has `autoGenerateTests = true`.
 *
 * Mirrors the DI shape of `autopilot-spec-to-pr.ts` and friends:
 *   - `findCandidates` — surface fresh open PRs across opted-in repos.
 *   - `dispatcher`     — runs `generateTestsForPr`. Tests inject a stub.
 *
 * Skip rules:
 *   - `AUTOPILOT_DISABLED=1` short-circuits.
 *   - Missing `ANTHROPIC_API_KEY` short-circuits.
 *
 * Never throws — per-PR failures are logged and swallowed so one broken
 * PR can't wedge the tick.
 */

import { and, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { pullRequests, repositories } from "../db/schema";
import {
  generateTestsForPr,
  type GenerateTestsForPrResult,
} from "./ai-test-generator";

/** Window of "freshly opened" — PRs created within this many minutes. */
export const FRESH_PR_WINDOW_MIN = 30;
/** Hard cap on PRs processed per tick. */
export const DEFAULT_MAX_PRS_PER_TICK = 5;

export interface PrTestGenCandidate {
  prId: string;
  prNumber: number;
  repositoryId: string;
  body: string | null;
}

export interface PrTestGenDispatcher {
  (args: { prId: string }): Promise<GenerateTestsForPrResult>;
}

export interface PrTestGenTaskDeps {
  /** Inject candidate-finder. */
  findCandidates?: (
    windowMinutes: number,
    limit: number
  ) => Promise<PrTestGenCandidate[]>;
  /** Inject dispatcher (real one calls `generateTestsForPr`). */
  dispatcher?: PrTestGenDispatcher;
  /** Override per-tick cap. */
  maxPrsPerTick?: number;
  /** Override the freshness window (minutes). */
  windowMinutes?: number;
}

export interface PrTestGenTaskSummary {
  considered: number;
  dispatched: number;
  skipped: number;
  failed: number;
}

/**
 * Default candidate finder. Open, non-draft PRs created in the last
 * `windowMinutes` whose repo has `autoGenerateTests = true`. Body is
 * surfaced so the runner can skip AI-generated PRs without an extra
 * round-trip.
 */
async function defaultFindCandidates(
  windowMinutes: number,
  limit: number
): Promise<PrTestGenCandidate[]> {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);
  try {
    const rows = await db
      .select({
        prId: pullRequests.id,
        prNumber: pullRequests.number,
        repositoryId: pullRequests.repositoryId,
        body: pullRequests.body,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
      .where(
        and(
          eq(pullRequests.state, "open"),
          eq(pullRequests.isDraft, false),
          eq(repositories.isArchived, false),
          eq(repositories.autoGenerateTests, true),
          gte(pullRequests.createdAt, cutoff)
        )
      )
      .limit(limit);
    return rows.map((r) => ({
      prId: r.prId,
      prNumber: r.prNumber,
      repositoryId: r.repositoryId,
      body: r.body,
    }));
  } catch (err) {
    console.error(
      "[autopilot] pr-test-generator: candidate query failed:",
      err
    );
    return [];
  }
}

/**
 * Default dispatcher — just calls `generateTestsForPr` in append-commit
 * mode. The follow-up-pr mode is reserved for the explicit-user-trigger
 * route (`POST /:owner/:repo/pulls/:n/generate-tests`).
 */
async function defaultDispatcher(args: {
  prId: string;
}): Promise<GenerateTestsForPrResult> {
  try {
    return await generateTestsForPr({
      prId: args.prId,
      mode: "append-commit",
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * One iteration of the pr-test-generator task. Returns a counts summary
 * for the autopilot tick log. Never throws.
 */
export async function runPrTestGeneratorTaskOnce(
  deps: PrTestGenTaskDeps = {}
): Promise<PrTestGenTaskSummary> {
  if (process.env.AUTOPILOT_DISABLED === "1") {
    return { considered: 0, dispatched: 0, skipped: 0, failed: 0 };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { considered: 0, dispatched: 0, skipped: 0, failed: 0 };
  }

  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const dispatcher = deps.dispatcher ?? defaultDispatcher;
  const limit = deps.maxPrsPerTick ?? DEFAULT_MAX_PRS_PER_TICK;
  const windowMinutes = deps.windowMinutes ?? FRESH_PR_WINDOW_MIN;

  let candidates: PrTestGenCandidate[] = [];
  try {
    candidates = await findCandidates(windowMinutes, limit);
  } catch (err) {
    console.error(
      "[autopilot] pr-test-generator: findCandidates threw:",
      err
    );
    return { considered: 0, dispatched: 0, skipped: 0, failed: 0 };
  }

  let dispatched = 0;
  let skipped = 0;
  let failed = 0;

  for (const cand of candidates) {
    try {
      const result = await dispatcher({ prId: cand.prId });
      if (!result.ok) {
        // Treat "PR not found" / "no candidate source files" / spec-PR
        // refusals as skips, not failures, so the tick log is calm.
        const err = (result.error || "").toLowerCase();
        if (
          err.includes("no candidate") ||
          err.includes("ai-generated") ||
          err.includes("not found")
        ) {
          skipped += 1;
        } else {
          failed += 1;
          console.warn(
            `[autopilot] pr-test-generator: PR #${cand.prNumber} failed: ${result.error}`
          );
        }
        continue;
      }
      if (result.alreadyDone) {
        skipped += 1;
        continue;
      }
      dispatched += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[autopilot] pr-test-generator: per-PR failure for pr=${cand.prId}:`,
        err
      );
    }
  }

  return {
    considered: candidates.length,
    dispatched,
    skipped,
    failed,
  };
}

/** Test-only exports. */
export const __test = {
  defaultFindCandidates,
  defaultDispatcher,
  FRESH_PR_WINDOW_MIN,
  DEFAULT_MAX_PRS_PER_TICK,
};

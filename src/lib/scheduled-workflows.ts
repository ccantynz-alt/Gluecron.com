/**
 * Scheduled workflows — fires `on: schedule` triggers from the autopilot
 * tick.
 *
 * Pipeline (per tick, default every 5 minutes via src/lib/autopilot.ts):
 *
 *   1. Select all non-disabled workflows whose serialised `parsed` JSON
 *      includes a non-empty `schedules` array. (Cheap LIKE filter — DB
 *      doesn't natively know about JSON keys here, and we want to avoid
 *      pulling all workflows on every tick.)
 *   2. For each workflow:
 *        - Look up the latest schedule-triggered run (event="schedule").
 *          That row's queuedAt is the `since` boundary; absent → use
 *          (now - 6 minutes), so a freshly-imported workflow doesn't
 *          back-fire for hours of crons.
 *        - For each cron string, parse via src/lib/cron.ts and ask
 *          `cronFiredBetween(since, now)`. The first cron that fired
 *          wins — we enqueue exactly one run per workflow per tick.
 *   3. enqueueRun(...) with event="schedule", ref=defaultBranch,
 *      commitSha=resolved-default-branch-HEAD. The existing runner
 *      (src/lib/workflow-runner.ts) picks it up exactly like a manual
 *      run.
 *
 * Fail-open: every step swallows DB errors and returns a result object
 * so the autopilot ticker never wedges. Returns a per-call summary so
 * callers (e.g. the admin dashboard) can show "last tick fired N runs."
 *
 * Safety guard: caps each tick at MAX_RUNS_PER_TICK so a misconfigured
 * cron and an empty schedule-runs table cannot stampede the queue.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  workflowRuns,
  workflows,
  repositories,
} from "../db/schema";
import { parseCron, cronFiredBetween } from "./cron";
import { enqueueRun } from "./workflow-runner";
import { resolveRef, getDefaultBranch } from "../git/repository";

export const MAX_RUNS_PER_TICK = 50;
const SINCE_FALLBACK_MS = 6 * 60_000; // 6 min — slightly > default 5-min tick

export type ScheduledTickResult = {
  considered: number;
  fired: number;
  errors: number;
};

type WorkflowRow = {
  id: string;
  repositoryId: string;
  parsed: string;
};

/**
 * Parse the `parsed` JSON column and return the cron expressions, or [].
 * Defensive — never throws.
 */
export function schedulesFromParsedJson(parsedJson: string): string[] {
  try {
    const obj = JSON.parse(parsedJson || "{}");
    const out = Array.isArray(obj?.schedules) ? obj.schedules : [];
    return out.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Pure decision helper — given a workflow's schedules + last fire wall +
 * current wall, return the first cron that should fire (or null).
 * Exposed for unit tests so the cron→fire wiring is verifiable without
 * a DB.
 */
export function firstCronToFire(
  schedules: string[],
  since: Date,
  until: Date
): string | null {
  for (const expr of schedules) {
    const parsed = parseCron(expr);
    if (!parsed.ok) continue;
    if (cronFiredBetween(parsed.cron, since, until)) return expr;
  }
  return null;
}

async function lastScheduleRunQueuedAt(
  workflowId: string
): Promise<Date | null> {
  try {
    const [row] = await db
      .select({ queuedAt: workflowRuns.queuedAt })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowId, workflowId),
          eq(workflowRuns.event, "schedule")
        )
      )
      .orderBy(desc(workflowRuns.queuedAt))
      .limit(1);
    return row ? new Date(row.queuedAt) : null;
  } catch {
    return null;
  }
}

async function loadOwnerAndRepoName(
  repositoryId: string
): Promise<{ ownerName: string; repoName: string; defaultBranch: string } | null> {
  try {
    const [row] = await db
      .select({
        repoName: repositories.name,
        ownerId: repositories.ownerId,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!row) return null;
    // Owner username lookup via the standard repositories.owner_id → users
    // join. Performed lazily to avoid a join on the hot list query.
    const { users } = await import("../db/schema");
    const [owner] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, row.ownerId))
      .limit(1);
    if (!owner) return null;
    return {
      ownerName: owner.username,
      repoName: row.repoName,
      defaultBranch: row.defaultBranch || "main",
    };
  } catch {
    return null;
  }
}

/**
 * Walk every non-disabled workflow whose parsed JSON could include a
 * schedules field, decide if any cron fired since the last schedule-run,
 * and enqueue at most one run per workflow per tick.
 */
export async function runScheduledWorkflowsTick(
  now: Date = new Date()
): Promise<ScheduledTickResult> {
  const result: ScheduledTickResult = { considered: 0, fired: 0, errors: 0 };

  let candidates: WorkflowRow[] = [];
  try {
    candidates = await db
      .select({
        id: workflows.id,
        repositoryId: workflows.repositoryId,
        parsed: workflows.parsed,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.disabled, false),
          // Cheap pre-filter: only workflows whose parsed JSON contains
          // the literal token "schedules" (presence implies non-empty
          // array via the parser contract). This is intentionally a
          // string-LIKE — JSON-aware operators are nice-to-have.
          sql`${workflows.parsed} LIKE '%"schedules"%'`
        )
      );
  } catch {
    candidates = [];
    result.errors += 1;
  }

  for (const w of candidates) {
    if (result.fired >= MAX_RUNS_PER_TICK) break;
    result.considered += 1;

    const schedules = schedulesFromParsedJson(w.parsed);
    if (schedules.length === 0) continue;

    const lastQ = await lastScheduleRunQueuedAt(w.id);
    const since = lastQ
      ? lastQ
      : new Date(now.getTime() - SINCE_FALLBACK_MS);

    const expr = firstCronToFire(schedules, since, now);
    if (!expr) continue;

    const repoMeta = await loadOwnerAndRepoName(w.repositoryId);
    if (!repoMeta) {
      result.errors += 1;
      continue;
    }

    let commitSha: string | null = null;
    try {
      commitSha = await resolveRef(
        repoMeta.ownerName,
        repoMeta.repoName,
        repoMeta.defaultBranch
      );
    } catch {
      commitSha = null;
    }
    if (!commitSha) {
      // Try to recover the default branch via the on-disk repo if the DB
      // value is stale — best-effort. If still unknown, skip.
      try {
        const def = await getDefaultBranch(
          repoMeta.ownerName,
          repoMeta.repoName
        );
        if (def) {
          commitSha = await resolveRef(
            repoMeta.ownerName,
            repoMeta.repoName,
            def
          );
        }
      } catch {
        commitSha = null;
      }
    }
    if (!commitSha) {
      result.errors += 1;
      continue;
    }

    try {
      await enqueueRun({
        workflowId: w.id,
        repositoryId: w.repositoryId,
        event: "schedule",
        ref: `refs/heads/${repoMeta.defaultBranch}`,
        commitSha,
        triggeredBy: null,
      });
      result.fired += 1;
    } catch {
      result.errors += 1;
    }
  }

  return result;
}

/** Test-only exposed internals so DB-less test cases can pin behaviour. */
export const __test = {
  schedulesFromParsedJson,
  firstCronToFire,
  SINCE_FALLBACK_MS,
};

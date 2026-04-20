/**
 * Autopilot — self-sufficiency loop.
 *
 * Runs existing platform-maintenance tasks (mirror sync, merge queue progress,
 * weekly digests, advisory rescans) on an interval so the host runs itself
 * without an external cron. All sub-tasks are injected so tests can stub them
 * without touching the DB; the default task set wires real helpers from the
 * locked libs. Nothing here throws — every sub-task and the outer tick are
 * try/caught so a single failure never blocks the others.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { mergeQueueEntries, repoDependencies } from "../db/schema";
import { syncAllDue } from "./mirrors";
import { peekHead } from "./merge-queue";
import { sendDigestsToAll } from "./email-digest";
import { scanRepositoryForAlerts } from "./advisories";

export interface AutopilotTaskResult {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface AutopilotTickResult {
  startedAt: string;
  finishedAt: string;
  tasks: AutopilotTaskResult[];
}

export interface AutopilotTask {
  name: string;
  run: () => Promise<void>;
}

export interface StartAutopilotOpts {
  intervalMs?: number;
  now?: () => number;
  tasks?: AutopilotTask[];
}

export interface RunTickOpts {
  tasks?: AutopilotTask[];
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const ADVISORY_RESCAN_BATCH = 5;

/**
 * Default task set. Each task is a thin wrapper around an existing locked
 * helper — no gate/merge logic is duplicated here.
 */
export function defaultTasks(): AutopilotTask[] {
  return [
    {
      name: "mirror-sync",
      run: async () => {
        await syncAllDue();
      },
    },
    {
      name: "merge-queue",
      run: async () => {
        await processMergeQueues();
      },
    },
    {
      name: "weekly-digest",
      run: async () => {
        await sendDigestsToAll();
      },
    },
    {
      name: "advisory-rescan",
      run: async () => {
        await rescanAdvisoriesBatch(ADVISORY_RESCAN_BATCH);
      },
    },
  ];
}

/**
 * Visits each distinct (repo, base_branch) that has queued rows and logs a
 * stub depth line. The actual gate-running + merge happens in the pulls
 * route; this tick is just a heartbeat so we can wire per-queue progress
 * through without duplicating merge logic.
 */
async function processMergeQueues(): Promise<void> {
  let distinct: Array<{ repositoryId: string; baseBranch: string }> = [];
  try {
    const rows = await db
      .selectDistinct({
        repositoryId: mergeQueueEntries.repositoryId,
        baseBranch: mergeQueueEntries.baseBranch,
      })
      .from(mergeQueueEntries)
      .where(sql`${mergeQueueEntries.state} IN ('queued','running')`);
    distinct = rows;
  } catch (err) {
    console.error("[autopilot] merge-queue: distinct query failed:", err);
    return;
  }
  for (const d of distinct) {
    try {
      const head = await peekHead(d.repositoryId, d.baseBranch);
      if (head) {
        console.log(
          `[autopilot] merge queue depth head=${head.id.slice(0, 8)} repo=${d.repositoryId.slice(0, 8)} base=${d.baseBranch}`
        );
      }
    } catch (err) {
      console.error(
        `[autopilot] merge-queue: peek failed for repo=${d.repositoryId}:`,
        err
      );
    }
  }
}

/**
 * Pick a small batch of repos that actually have dep rows and re-run
 * advisory scan against them. Cheap — one SELECT DISTINCT with LIMIT.
 */
async function rescanAdvisoriesBatch(limit: number): Promise<void> {
  let repoIds: string[] = [];
  try {
    const rows = await db
      .selectDistinct({ repositoryId: repoDependencies.repositoryId })
      .from(repoDependencies)
      .limit(limit);
    repoIds = rows.map((r) => r.repositoryId);
  } catch (err) {
    console.error("[autopilot] advisory-rescan: query failed:", err);
    return;
  }
  for (const id of repoIds) {
    try {
      await scanRepositoryForAlerts(id);
    } catch (err) {
      console.error(
        `[autopilot] advisory-rescan: scan failed for repo=${id}:`,
        err
      );
    }
  }
}

/** Resolve the tick interval from env → opts → default. */
function resolveIntervalMs(optsMs?: number): number {
  if (typeof optsMs === "number" && optsMs > 0) return optsMs;
  const raw = process.env.AUTOPILOT_INTERVAL_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INTERVAL_MS;
}

/**
 * Start the recurring autopilot loop. No-op when AUTOPILOT_DISABLED=1.
 * The first tick fires after `intervalMs`, not immediately, to keep boot
 * fast. Returns a `stop()` that clears the interval.
 */
export function startAutopilot(opts?: StartAutopilotOpts): { stop: () => void } {
  if (process.env.AUTOPILOT_DISABLED === "1") {
    return { stop: () => {} };
  }
  const intervalMs = resolveIntervalMs(opts?.intervalMs);
  const tasks = opts?.tasks ?? defaultTasks();
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void runAutopilotTick({ tasks, now: opts?.now })
      .catch(() => {
        // runAutopilotTick already never throws, but belt-and-braces.
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return {
    stop: () => clearInterval(handle),
  };
}

/**
 * Run one tick: invokes every sub-task with its own try/catch, records a
 * per-task result, and emits a single summary line. Never throws.
 */
export async function runAutopilotTick(
  opts?: RunTickOpts
): Promise<AutopilotTickResult> {
  const now = opts?.now ?? Date.now;
  const tasks = opts?.tasks ?? defaultTasks();
  const startedAt = new Date(now()).toISOString();
  const results: AutopilotTaskResult[] = [];
  for (const t of tasks) {
    const t0 = now();
    try {
      await t.run();
      results.push({ name: t.name, ok: true, durationMs: now() - t0 });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      console.error(`[autopilot] ${t.name}: ${message}`);
      results.push({
        name: t.name,
        ok: false,
        durationMs: now() - t0,
        error: message,
      });
    }
  }
  const finishedAt = new Date(now()).toISOString();
  const totalMs = results.reduce((a, r) => a + r.durationMs, 0);
  const okCount = results.filter((r) => r.ok).length;
  console.log(
    `[autopilot] tick ok tasks=${okCount}/${results.length} ms=${totalMs}`
  );
  return { startedAt, finishedAt, tasks: results };
}

/** Exposed for unit tests. */
export const __test = {
  resolveIntervalMs,
  processMergeQueues,
  rescanAdvisoriesBatch,
  DEFAULT_INTERVAL_MS,
  ADVISORY_RESCAN_BATCH,
};

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

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  mergeQueueEntries,
  prComments,
  pullRequests,
  repoDependencies,
  repositories,
  users,
} from "../db/schema";
import { syncAllDue } from "./mirrors";
import { peekHead } from "./merge-queue";
import { sendDigestsToAll } from "./email-digest";
import { scanRepositoryForAlerts } from "./advisories";
import { releaseExpiredWaitTimers } from "./environments";
import { runScheduledWorkflowsTick } from "./scheduled-workflows";
import {
  evaluateAutoMerge,
  recordAutoMergeAttempt,
  type AutoMergeContext,
  type AutoMergeDecision,
} from "./auto-merge";
import { matchProtection } from "./branch-protection";
import { performMerge, type PerformMergeResult } from "./pr-merge";
import { audit } from "./notify";
import { runAiBuildTaskOnce } from "./ai-build-tasks";
import {
  sendSleepModeDigestForUser,
  SLEEP_MODE_USER_CAP_PER_TICK,
  SLEEP_MODE_COOLDOWN_HOURS,
} from "./sleep-mode";
import {
  runStalePrSweepOnce,
  runStaleIssueSweepOnce,
} from "./stale-sweep";
import { computePrRiskForPullRequest } from "./pr-risk";
import { prRiskScores } from "../db/schema";
import { purgeScheduledAccounts } from "./account-deletion";
import { purgeExpiredPlaygroundAccounts } from "./playground";
import {
  runSyntheticChecks,
  persistChecks,
  latestStatusByCheck,
  type SyntheticCheckResult,
} from "./synthetic-monitor";
import { aiProactiveMonitorTick } from "./ai-proactive-monitor";

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
/** K3 — recency window for auto-merge candidate selection. */
const AUTO_MERGE_LOOKBACK_HOURS = 24;
/** K3 — hard cap on PRs evaluated per tick (runaway protection). */
const AUTO_MERGE_MAX_PER_TICK = 50;
/** K3 — stable marker for the auto-merge audit comment. */
const AUTO_MERGE_COMMENT_MARKER = "<!-- gluecron:auto-merge:v1 -->";
/** M3 — hard cap on PRs scored per tick (runaway protection). */
const PR_RISK_RESCORE_MAX_PER_TICK = 20;
/** M3 — recency window for the pr-risk-rescore sweep. */
const PR_RISK_RESCORE_LOOKBACK_HOURS = 1;
/** Proactive monitor cadence — Claude scans platform telemetry hourly. */
const PROACTIVE_MONITOR_INTERVAL_MS = 60 * 60 * 1000;
let _lastProactiveMonitorAt = 0;

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
    {
      name: "wait-timer-release",
      run: async () => {
        await releaseExpiredWaitTimers();
      },
    },
    {
      name: "scheduled-workflows",
      run: async () => {
        await runScheduledWorkflowsTick();
      },
    },
    {
      name: "auto-merge-sweep",
      run: async () => {
        await runAutoMergeSweep();
      },
    },
    {
      name: "ai-build-from-issues",
      run: async () => {
        const summary = await runAiBuildTaskOnce();
        console.log(
          `[autopilot] ai-build: queued=${summary.queued} skipped=${summary.skipped}`
        );
      },
    },
    {
      name: "sleep-mode-digest",
      run: async () => {
        const summary = await runSleepModeDigestTaskOnce();
        console.log(
          `[autopilot] sleep-mode-digest: sent=${summary.sent} skipped=${summary.skipped}`
        );
      },
    },
    {
      name: "stale-pr-sweep",
      run: async () => {
        // Two-stage gate: poke at 7d stale, close at 14d after poke
        // (when the repo opts in via `auto_close_stale_prs`).
        // Wrapped in try/catch so a finder crash never wedges the tick.
        try {
          const summary = await runStalePrSweepOnce();
          console.log(
            `[autopilot] stale-pr-sweep: poked=${summary.poked} closed=${summary.closed}`
          );
        } catch (err) {
          console.error("[autopilot] stale-pr-sweep: threw:", err);
        }
      },
    },
    {
      name: "stale-issue-sweep",
      run: async () => {
        // Mirror of stale-pr-sweep with the issue thresholds (30d/60d).
        try {
          const summary = await runStaleIssueSweepOnce();
          console.log(
            `[autopilot] stale-issue-sweep: poked=${summary.poked} closed=${summary.closed}`
          );
        } catch (err) {
          console.error("[autopilot] stale-issue-sweep: threw:", err);
        }
      },
    },
    {
      name: "pr-risk-rescore",
      run: async () => {
        const summary = await runPrRiskRescoreTaskOnce();
        console.log(
          `[autopilot] pr-risk-rescore: scored=${summary.scored} skipped=${summary.skipped}`
        );
      },
    },

    {
      // Block P5 — Hard-delete users whose 30-day grace period expired.
      name: "account-purge",
      run: async () => {
        try {
          const summary = await purgeScheduledAccounts({ cap: 50 });
          console.log(
            `[autopilot] account-purge: purged=${summary.purged} errors=${summary.errors}`
          );
        } catch (err) {
          console.error("[autopilot] account-purge: threw:", err);
        }
      },
    },
    {
      // Block Q3 — Hard-delete anonymous playground accounts past their
      // 24h TTL. CASCADE handles repos, sessions, issues. Per-user
      // try/catch in the lib so one FK violation can't stall the queue.
      name: "playground-purge",
      run: async () => {
        try {
          const summary = await purgeExpiredPlaygroundAccounts({ cap: 50 });
          console.log(
            `[autopilot] playground-purge: purged=${summary.purged} errors=${summary.errors}`
          );
        } catch (err) {
          console.error("[autopilot] playground-purge: threw:", err);
        }
      },
    },
    {
      // Proactive AI monitor — hourly. Claude reads 24h of audit_log +
      // platformDeploys + workflowRuns and opens issues on anomalies
      // (degraded deploy times, recurring failures, suspicious audit
      // patterns). Skips when ANTHROPIC_API_KEY is unset (the lib
      // itself short-circuits, but the cadence gate avoids redundant
      // work on every 5-min tick too).
      name: "ai-proactive-monitor",
      run: async () => {
        if (!process.env.ANTHROPIC_API_KEY) return;
        const now = Date.now();
        if (now - _lastProactiveMonitorAt < PROACTIVE_MONITOR_INTERVAL_MS) {
          return;
        }
        _lastProactiveMonitorAt = now;
        try {
          const summary = await aiProactiveMonitorTick();
          console.log(
            `[autopilot] ai-proactive-monitor: opened=${summary.opened} considered=${summary.considered} dedup=${summary.skippedDedupe}`
          );
        } catch (err) {
          console.error("[autopilot] ai-proactive-monitor: threw:", err);
        }
      },
    },
    {
      // BLOCK S4 — Synthetic monitor.
      //
      // Runs the URL-only smoke suite (see src/lib/synthetic-monitor.ts),
      // records the outcome into `synthetic_checks`, and on a
      // green->red transition fires a webhook to MONITOR_ALERT_WEBHOOK_URL
      // (when configured) so the owner finds out instantly that the live
      // site is broken. Wrapped in try/catch — the monitor must never
      // wedge the tick.
      name: "synthetic-monitor",
      run: async () => {
        try {
          const summary = await runSyntheticMonitorTaskOnce();
          console.log(
            `[autopilot] synthetic-monitor: green=${summary.green} red=${summary.red} transitions=${summary.transitions}`
          );
        } catch (err) {
          console.error("[autopilot] synthetic-monitor: threw:", err);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// BLOCK S4 — synthetic-monitor task
// ---------------------------------------------------------------------------

export interface SyntheticMonitorTaskDeps {
  /** Override the suite runner (DI for tests). */
  runChecks?: () => Promise<SyntheticCheckResult[]>;
  /** Override the persistence step (DI for tests). */
  persist?: (results: SyntheticCheckResult[]) => Promise<void>;
  /** Override the previous-state loader (DI for tests). */
  loadPrevious?: () => Promise<Record<string, SyntheticCheckResult>>;
  /** Override the webhook poster (DI for tests). */
  postAlert?: (url: string, payload: unknown) => Promise<void>;
  /** Override the alert-webhook URL lookup (defaults to env). */
  alertUrl?: () => string;
}

export interface SyntheticMonitorTaskSummary {
  green: number;
  red: number;
  yellow: number;
  transitions: number;
}

async function defaultPostAlert(
  url: string,
  payload: unknown
): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[autopilot] synthetic-monitor: alert webhook failed:", err);
  }
}

/**
 * One iteration of the synthetic-monitor task. Runs the checks, persists
 * them, compares against the prior state, and fires a webhook on each
 * green->red transition (red->red repeats stay quiet so we don't spam
 * the channel). Never throws.
 */
export async function runSyntheticMonitorTaskOnce(
  deps: SyntheticMonitorTaskDeps = {}
): Promise<SyntheticMonitorTaskSummary> {
  const runChecks = deps.runChecks ?? (() => runSyntheticChecks());
  const persist = deps.persist ?? persistChecks;
  const loadPrevious =
    deps.loadPrevious ??
    (async () => {
      const latest = await latestStatusByCheck();
      // Strip the `checkedAt` from the result shape so the diff loop
      // compares the canonical SyntheticCheckResult fields only.
      const out: Record<string, SyntheticCheckResult> = {};
      for (const [k, v] of Object.entries(latest)) {
        const { checkedAt: _unused, ...rest } = v;
        void _unused;
        out[k] = rest;
      }
      return out;
    });
  const postAlert = deps.postAlert ?? defaultPostAlert;
  const alertUrl =
    deps.alertUrl ?? (() => process.env.MONITOR_ALERT_WEBHOOK_URL || "");

  let previous: Record<string, SyntheticCheckResult> = {};
  try {
    previous = await loadPrevious();
  } catch (err) {
    console.error(
      "[autopilot] synthetic-monitor: loadPrevious threw:",
      err
    );
    previous = {};
  }

  const results = await runChecks();
  await persist(results);

  let green = 0;
  let red = 0;
  let yellow = 0;
  let transitions = 0;
  const url = alertUrl();

  for (const r of results) {
    if (r.status === "green") green += 1;
    else if (r.status === "red") red += 1;
    else yellow += 1;

    const prior = previous[r.name];
    // green->red transition: prior was green (or absent and current is red
    // after a green is also a transition — but absent-before is treated as
    // green to avoid spamming on a fresh DB). We only alert on the
    // green->red edge so red->red doesn't re-fire.
    const priorWasGreen = !prior || prior.status === "green";
    if (priorWasGreen && r.status === "red") {
      transitions += 1;
      if (url) {
        await postAlert(url, {
          check: r.name,
          status: r.status,
          statusCode: r.statusCode ?? null,
          durationMs: r.durationMs,
          error: r.error ?? null,
          checkedAt: new Date().toISOString(),
        });
      }
    }
  }

  return { green, red, yellow, transitions };
}

// ---------------------------------------------------------------------------
// L1 — sleep-mode-digest
// ---------------------------------------------------------------------------

export interface SleepModeDigestCandidate {
  userId: string;
  digestHourUtc: number;
  lastDigestSentAt: Date | null;
}

export interface SleepModeDigestTaskDeps {
  /** Override the candidate finder. */
  findCandidates?: (cap: number) => Promise<SleepModeDigestCandidate[]>;
  /** Override the send-one-user helper (DI for tests). */
  sendOne?: (userId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Override the wall clock (DI for tests). */
  now?: () => Date;
  /** Override the per-tick cap. */
  cap?: number;
  /** Override the cooldown hours. */
  cooldownHours?: number;
}

export interface SleepModeDigestTaskSummary {
  sent: number;
  skipped: number;
}

/**
 * Default candidate-finder. Returns enabled users whose
 * `lastDigestSentAt` is older than the cooldown OR null. The hour-match
 * filter is applied in JS by `runSleepModeDigestTaskOnce` so it stays
 * timezone-independent of any SQL `extract(hour ...)` behaviour.
 */
async function defaultFindSleepModeCandidates(
  cap: number
): Promise<SleepModeDigestCandidate[]> {
  try {
    const rows = await db
      .select({
        userId: users.id,
        digestHourUtc: users.sleepModeDigestHourUtc,
        lastDigestSentAt: users.lastDigestSentAt,
      })
      .from(users)
      .where(eq(users.sleepModeEnabled, true))
      .limit(cap);
    return rows.map((r) => ({
      userId: r.userId,
      digestHourUtc: r.digestHourUtc,
      lastDigestSentAt: r.lastDigestSentAt,
    }));
  } catch (err) {
    console.error("[autopilot] sleep-mode-digest: candidate query failed:", err);
    return [];
  }
}

/**
 * One iteration of the sleep-mode-digest task. Never throws.
 *
 * Per-user filters (applied in JS so we can DI a clock):
 *   1. `lastDigestSentAt` is null OR older than cooldown (23h).
 *   2. `now.getUTCHours() === digestHourUtc` — fires once at the user's
 *      configured local UTC hour.
 *
 * Caps at `SLEEP_MODE_USER_CAP_PER_TICK` (100) users per tick.
 */
export async function runSleepModeDigestTaskOnce(
  deps: SleepModeDigestTaskDeps = {}
): Promise<SleepModeDigestTaskSummary> {
  const findCandidates =
    deps.findCandidates ?? defaultFindSleepModeCandidates;
  const sendOne = deps.sendOne ?? sendSleepModeDigestForUser;
  const now = deps.now ?? (() => new Date());
  const cap = deps.cap ?? SLEEP_MODE_USER_CAP_PER_TICK;
  const cooldownHours = deps.cooldownHours ?? SLEEP_MODE_COOLDOWN_HOURS;

  let candidates: SleepModeDigestCandidate[] = [];
  try {
    candidates = await findCandidates(cap);
  } catch (err) {
    console.error("[autopilot] sleep-mode-digest: findCandidates threw:", err);
    return { sent: 0, skipped: 0 };
  }

  const nowDate = now();
  const currentHour = nowDate.getUTCHours();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;

  let sent = 0;
  let skipped = 0;

  for (const cand of candidates) {
    try {
      // Hour-match: must equal the user's configured UTC delivery hour.
      if (cand.digestHourUtc !== currentHour) {
        skipped += 1;
        continue;
      }
      // Cooldown: skip if we sent within the last cooldown window.
      if (
        cand.lastDigestSentAt &&
        nowDate.getTime() - new Date(cand.lastDigestSentAt).getTime() <
          cooldownMs
      ) {
        skipped += 1;
        continue;
      }
      const result = await sendOne(cand.userId);
      if (result.ok) sent += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(
        `[autopilot] sleep-mode-digest: per-user failure for user=${cand.userId}:`,
        err
      );
    }
  }

  return { sent, skipped };
}

// ---------------------------------------------------------------------------
// M3 — pr-risk-rescore
// ---------------------------------------------------------------------------

export interface PrRiskRescoreCandidate {
  pullRequestId: string;
  headBranch: string;
  updatedAt: Date;
}

export interface PrRiskRescoreTaskDeps {
  /** Override candidate finder for tests. */
  findCandidates?: (
    lookbackHours: number,
    cap: number
  ) => Promise<PrRiskRescoreCandidate[]>;
  /** Override score computation for tests. */
  scoreOne?: (prId: string) => Promise<{ ok: boolean }>;
  /** Override per-tick cap. */
  cap?: number;
  /** Override lookback. */
  lookbackHours?: number;
}

export interface PrRiskRescoreTaskSummary {
  scored: number;
  skipped: number;
}

/**
 * Default candidate-finder. Returns open, non-draft PRs from non-archived
 * repos whose `updated_at` falls inside the lookback window. The "scored
 * at all" filter is applied as a second pass via `defaultFilterNeedsScoring`.
 */
async function defaultFindPrRiskCandidates(
  lookbackHours: number,
  cap: number
): Promise<PrRiskRescoreCandidate[]> {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  try {
    const rows = await db
      .select({
        pullRequestId: pullRequests.id,
        headBranch: pullRequests.headBranch,
        updatedAt: pullRequests.updatedAt,
      })
      .from(pullRequests)
      .innerJoin(
        repositories,
        eq(repositories.id, pullRequests.repositoryId)
      )
      .where(
        and(
          eq(pullRequests.state, "open"),
          eq(pullRequests.isDraft, false),
          eq(repositories.isArchived, false),
          gte(pullRequests.updatedAt, cutoff)
        )
      )
      .orderBy(sql`${pullRequests.updatedAt} DESC`)
      .limit(cap);
    return rows.map((r) => ({
      pullRequestId: r.pullRequestId,
      headBranch: r.headBranch,
      updatedAt: r.updatedAt,
    }));
  } catch (err) {
    console.error("[autopilot] pr-risk-rescore: candidate query failed:", err);
    return [];
  }
}

/**
 * Drop candidates that already have ANY cached score row. The unique
 * constraint on (pull_request_id, commit_sha) handles the "score-the-
 * same-SHA-twice" case at persist time; this filter just keeps the work
 * list small enough to fit under the per-tick cap when many PRs are
 * being pushed concurrently.
 */
async function defaultFilterNeedsScoring(
  candidates: PrRiskRescoreCandidate[]
): Promise<PrRiskRescoreCandidate[]> {
  if (candidates.length === 0) return [];
  try {
    const rows = await db
      .select({ pullRequestId: prRiskScores.pullRequestId })
      .from(prRiskScores);
    const scoredIds = new Set(rows.map((r) => r.pullRequestId));
    return candidates.filter((c) => !scoredIds.has(c.pullRequestId));
  } catch (err) {
    console.error("[autopilot] pr-risk-rescore: filter query failed:", err);
    // Fail-open: better to score everything than silently skip.
    return candidates;
  }
}

/**
 * One iteration of the pr-risk-rescore task. Never throws. Compute risk
 * for up to `cap` recently-touched open PRs that have no cached score
 * yet, so reviewers usually see a populated card on first visit.
 */
export async function runPrRiskRescoreTaskOnce(
  deps: PrRiskRescoreTaskDeps = {}
): Promise<PrRiskRescoreTaskSummary> {
  const findCandidates = deps.findCandidates ?? defaultFindPrRiskCandidates;
  const scoreOne =
    deps.scoreOne ??
    (async (prId: string) => {
      try {
        const result = await computePrRiskForPullRequest(prId);
        return { ok: result !== null };
      } catch {
        return { ok: false };
      }
    });
  const cap = deps.cap ?? PR_RISK_RESCORE_MAX_PER_TICK;
  const lookbackHours =
    deps.lookbackHours ?? PR_RISK_RESCORE_LOOKBACK_HOURS;

  let candidates: PrRiskRescoreCandidate[] = [];
  try {
    candidates = await findCandidates(lookbackHours, cap);
  } catch (err) {
    console.error("[autopilot] pr-risk-rescore: findCandidates threw:", err);
    return { scored: 0, skipped: 0 };
  }

  // Only score PRs missing a cached row. Skip filter when the caller
  // injected a custom finder (tests pass already-filtered lists).
  const needsScoring =
    deps.findCandidates === undefined
      ? await defaultFilterNeedsScoring(candidates)
      : candidates;

  let scored = 0;
  let skipped = 0;
  for (const cand of needsScoring.slice(0, cap)) {
    try {
      const result = await scoreOne(cand.pullRequestId);
      if (result.ok) scored += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(
        `[autopilot] pr-risk-rescore: per-PR failure for pr=${cand.pullRequestId}:`,
        err
      );
    }
  }
  if (needsScoring.length > cap) {
    skipped += needsScoring.length - cap;
  }

  return { scored, skipped };
}

// ---------------------------------------------------------------------------
// K3 — auto-merge-sweep
// ---------------------------------------------------------------------------

interface SweepCandidate {
  prId: string;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  baseBranch: string;
  headBranch: string;
  isDraft: boolean;
  repositoryId: string;
  authorUserId: string;
  ownerUsername: string | null;
  repoName: string;
  state: string;
}

export interface AutoMergeSweepDeps {
  /** Inject candidate-finder for tests. */
  findCandidates?: (lookbackHours: number, limit: number) => Promise<SweepCandidate[]>;
  /** Inject evaluator for tests. */
  evaluate?: (ctx: AutoMergeContext) => Promise<AutoMergeDecision>;
  /** Inject the merge executor for tests. */
  merge?: (cand: SweepCandidate) => Promise<PerformMergeResult>;
  /** Inject the audit-recording side-effect for tests. */
  recordAttempt?: (
    repoId: string,
    prId: string,
    decision: AutoMergeDecision
  ) => Promise<void>;
  /** Inject the audit/comment side-effects for the merged path (tests). */
  onMerged?: (
    cand: SweepCandidate,
    result: PerformMergeResult
  ) => Promise<void>;
  /** Inject the audit side-effect for the merge-failed path (tests). */
  onMergeFailed?: (cand: SweepCandidate, error: string) => Promise<void>;
  /** Inject the AI-key short-circuit signal for tests. */
  shouldShortCircuitAi?: (cand: SweepCandidate) => Promise<boolean>;
}

export interface AutoMergeSweepSummary {
  evaluated: number;
  merged: number;
  blocked: number;
}

/**
 * Default candidate-finder. Selects open, non-draft PRs from non-archived
 * repos whose `updated_at` is within the lookback window. Joins repo +
 * owner so the merge executor doesn't need extra round trips. Cap is
 * enforced at the SQL layer.
 */
async function defaultFindAutoMergeCandidates(
  lookbackHours: number,
  limit: number
): Promise<SweepCandidate[]> {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  try {
    const rows = await db
      .select({
        prId: pullRequests.id,
        prNumber: pullRequests.number,
        prTitle: pullRequests.title,
        prBody: pullRequests.body,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
        isDraft: pullRequests.isDraft,
        repositoryId: pullRequests.repositoryId,
        authorUserId: pullRequests.authorId,
        ownerUsername: users.username,
        repoName: repositories.name,
        state: pullRequests.state,
      })
      .from(pullRequests)
      .innerJoin(
        repositories,
        eq(repositories.id, pullRequests.repositoryId)
      )
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .where(
        and(
          eq(pullRequests.state, "open"),
          eq(pullRequests.isDraft, false),
          eq(repositories.isArchived, false),
          gte(pullRequests.updatedAt, cutoff)
        )
      )
      .limit(limit);
    return rows.map((r) => ({
      prId: r.prId,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      prBody: r.prBody,
      baseBranch: r.baseBranch,
      headBranch: r.headBranch,
      isDraft: r.isDraft,
      repositoryId: r.repositoryId,
      authorUserId: r.authorUserId,
      ownerUsername: r.ownerUsername ?? null,
      repoName: r.repoName,
      state: r.state,
    }));
  } catch (err) {
    console.error("[autopilot] auto-merge: candidate query failed:", err);
    return [];
  }
}

/**
 * Determine whether the matched branch_protection rule on this PR
 * requires AI approval but no `ANTHROPIC_API_KEY` is configured. In that
 * case the AI-approval check would inevitably fail downstream, so we
 * short-circuit to a "blocked" decision without invoking `evaluateAutoMerge`
 * — keeps the log readable and prevents misleading "AI review unavailable"
 * lines in the audit trail.
 */
async function defaultShouldShortCircuitAi(
  cand: SweepCandidate
): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY) return false;
  try {
    const rule = await matchProtection(cand.repositoryId, cand.baseBranch);
    return !!(rule && rule.requireAiApproval);
  } catch {
    return false;
  }
}

/**
 * Default success-path: post an `auto_merge.merged` audit row + a stable
 * marker comment on the PR so a partial-merge retry doesn't double-post.
 * Both are best-effort; failures are logged not thrown.
 */
async function defaultOnMerged(
  cand: SweepCandidate,
  result: PerformMergeResult
): Promise<void> {
  try {
    await audit({
      repositoryId: cand.repositoryId,
      action: "auto_merge.merged",
      targetType: "pull_request",
      targetId: cand.prId,
      metadata: {
        prNumber: cand.prNumber,
        baseBranch: cand.baseBranch,
        headBranch: cand.headBranch,
        closedIssueNumbers: result.closedIssueNumbers,
        resolvedFiles: result.resolvedFiles,
      },
    });
  } catch (err) {
    console.error("[autopilot] auto-merge: merged audit failed:", err);
  }
  try {
    await db.insert(prComments).values({
      pullRequestId: cand.prId,
      authorId: cand.authorUserId,
      isAiReview: true,
      body: `${AUTO_MERGE_COMMENT_MARKER}\nAuto-merged by Gluecron autopilot — branch protection conditions satisfied.`,
    });
  } catch (err) {
    console.error("[autopilot] auto-merge: comment insert failed:", err);
  }
}

/** Default failure-path: only an audit row; no comment (we may retry). */
async function defaultOnMergeFailed(
  cand: SweepCandidate,
  error: string
): Promise<void> {
  try {
    await audit({
      repositoryId: cand.repositoryId,
      action: "auto_merge.merge_failed",
      targetType: "pull_request",
      targetId: cand.prId,
      metadata: {
        prNumber: cand.prNumber,
        baseBranch: cand.baseBranch,
        headBranch: cand.headBranch,
        error,
      },
    });
  } catch (err) {
    console.error("[autopilot] auto-merge: merge_failed audit failed:", err);
  }
}

/**
 * Execute one sweep over recently-updated open PRs. For each, evaluate
 * with K2's `evaluateAutoMerge`; on `merge: true`, call `performMerge` and
 * record the merged/merge-failed audit row + comment. Always record the
 * `auto_merge.evaluated` audit row via `recordAutoMergeAttempt`.
 *
 * Returns a counts summary that the autopilot prints as the tick log line.
 * Never throws.
 */
export async function runAutoMergeSweep(
  deps: AutoMergeSweepDeps = {}
): Promise<AutoMergeSweepSummary> {
  const findCandidates = deps.findCandidates ?? defaultFindAutoMergeCandidates;
  const evaluate =
    deps.evaluate ?? ((ctx) => evaluateAutoMerge(ctx, {}));
  const merge =
    deps.merge ??
    (async (cand) => {
      if (!cand.ownerUsername) {
        return {
          ok: false,
          error: "owner username unresolved",
          closedIssueNumbers: [],
          resolvedFiles: [],
        };
      }
      return performMerge({
        pr: {
          id: cand.prId,
          number: cand.prNumber,
          title: cand.prTitle,
          body: cand.prBody,
          baseBranch: cand.baseBranch,
          headBranch: cand.headBranch,
          repositoryId: cand.repositoryId,
          authorId: cand.authorUserId,
          state: cand.state as "open",
          isDraft: cand.isDraft,
        },
        ownerName: cand.ownerUsername,
        repoName: cand.repoName,
        actorUserId: cand.authorUserId,
      });
    });
  const recordAttempt = deps.recordAttempt ?? recordAutoMergeAttempt;
  const onMerged = deps.onMerged ?? defaultOnMerged;
  const onMergeFailed = deps.onMergeFailed ?? defaultOnMergeFailed;
  const shouldShortCircuitAi =
    deps.shouldShortCircuitAi ?? defaultShouldShortCircuitAi;

  let candidates: SweepCandidate[] = [];
  try {
    candidates = await findCandidates(
      AUTO_MERGE_LOOKBACK_HOURS,
      AUTO_MERGE_MAX_PER_TICK
    );
  } catch (err) {
    console.error("[autopilot] auto-merge: findCandidates threw:", err);
    return { evaluated: 0, merged: 0, blocked: 0 };
  }

  let evaluated = 0;
  let merged = 0;
  let blocked = 0;

  for (const cand of candidates) {
    try {
      evaluated += 1;

      // AI-key short-circuit: if the rule requires AI approval and we have
      // no key, treat as blocked without calling the evaluator (which would
      // log a misleading "AI review unavailable").
      let decision: AutoMergeDecision;
      if (await shouldShortCircuitAi(cand)) {
        decision = {
          merge: false,
          reason:
            "Branch protection requires AI approval but ANTHROPIC_API_KEY is unset.",
          blocking: [
            "ANTHROPIC_API_KEY missing; AI approval cannot be sourced.",
          ],
        };
      } else {
        decision = await evaluate({
          pullRequestId: cand.prId,
          repositoryId: cand.repositoryId,
          baseBranch: cand.baseBranch,
          isDraft: cand.isDraft,
          authorUserId: cand.authorUserId,
        });
      }

      // Always record the evaluation, regardless of outcome.
      try {
        await recordAttempt(cand.repositoryId, cand.prId, decision);
      } catch (err) {
        console.error(
          `[autopilot] auto-merge: recordAttempt failed for pr=${cand.prId}:`,
          err
        );
      }

      if (!decision.merge) {
        blocked += 1;
        continue;
      }

      // Perform the actual merge.
      const result = await merge(cand);
      if (result.ok) {
        merged += 1;
        await onMerged(cand, result);
      } else {
        blocked += 1;
        await onMergeFailed(cand, result.error || "unknown merge error");
      }
    } catch (err) {
      blocked += 1;
      console.error(
        `[autopilot] auto-merge: per-PR failure for pr=${cand.prId}:`,
        err
      );
    }
  }

  console.log(
    `[autopilot] auto-merge: evaluated=${evaluated} merged=${merged} blocked=${blocked}`
  );

  return { evaluated, merged, blocked };
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

/** Last tick snapshot for observability. Module-level, swap-on-complete. */
let lastTick: AutopilotTickResult | null = null;
let tickCount = 0;

/** Return the most recent completed tick, or null if autopilot hasn't run yet. */
export function getLastTick(): AutopilotTickResult | null {
  return lastTick;
}

/** Return the total number of completed ticks in this process. */
export function getTickCount(): number {
  return tickCount;
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
  const result: AutopilotTickResult = { startedAt, finishedAt, tasks: results };
  lastTick = result;
  tickCount += 1;
  return result;
}

/** Exposed for unit tests. */
export const __test = {
  resolveIntervalMs,
  processMergeQueues,
  rescanAdvisoriesBatch,
  DEFAULT_INTERVAL_MS,
  ADVISORY_RESCAN_BATCH,
  AUTO_MERGE_LOOKBACK_HOURS,
  AUTO_MERGE_MAX_PER_TICK,
  AUTO_MERGE_COMMENT_MARKER,
  PR_RISK_RESCORE_MAX_PER_TICK,
  PR_RISK_RESCORE_LOOKBACK_HOURS,
  defaultFindAutoMergeCandidates,
  defaultOnMerged,
  defaultOnMergeFailed,
  defaultShouldShortCircuitAi,
  defaultFindPrRiskCandidates,
  defaultFilterNeedsScoring,
};

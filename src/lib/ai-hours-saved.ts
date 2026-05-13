/**
 * Block L9 — AI hours-saved counter.
 *
 * Pure compute layer for the "Claude saved you X hours this week" widget
 * on the Command Center dashboard. Tallies AI-driven events across repos
 * the user owns and translates them into a transparent, audit-friendly
 * hours-saved estimate.
 *
 * ─── Formula (conservative, intentionally) ──────────────────────────
 *
 *   hoursSaved =
 *       prsAutoMerged       * 0.30   // avoid a click + a refresh
 *     + issuesBuiltByAi     * 1.50   // AI did the writing
 *     + aiReviewsPosted     * 0.25   // saved a manual review pass
 *     + aiTriagesPosted     * 0.10   // labels + reviewer suggestions
 *     + aiCommitMsgs        * 0.05   // tiny but counts
 *     + secretsAutoRepaired * 0.50   // would've been a panic
 *     + gateAutoRepairs     * 0.40   // would've been a re-run
 *
 * Round the final number to 1 decimal place. Constants are heuristics
 * — keep them conservative so users trust the counter. Audit-friendly
 * is the brand.
 *
 * `computeHoursSaved` is exported so L1 Sleep Mode (and anyone else
 * who needs the same value) can reuse the identical formula.
 *
 * Every async function in this module **never throws**: on DB error,
 * the report falls back to all-zero counts so the dashboard widget
 * always renders.
 */

import { and, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  gateRuns,
  issueComments,
  issues,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";

// ───────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────

export type AiSavingsBreakdown = {
  prsAutoMerged: number;
  issuesBuiltByAi: number;
  aiReviewsPosted: number;
  aiTriagesPosted: number;
  aiCommitMsgs: number;
  secretsAutoRepaired: number;
  gateAutoRepairs: number;
};

export type AiSavingsReport = {
  windowHours: number;
  breakdown: AiSavingsBreakdown;
  hoursSaved: number;
};

export type AiSavingsLifetimeReport = {
  hoursSaved: number;
  breakdown: AiSavingsBreakdown;
  sinceCreatedAt: Date;
};

/**
 * Marker substrings used to identify AI-authored content in tables
 * that don't have a dedicated `is_ai_*` flag. Importing from each
 * module would create a circular dependency in some test setups,
 * so we duplicate the small string constants here. If they ever
 * drift, the search will under-count — preferable to over-counting.
 */
const PR_TRIAGE_MARKER_FRAGMENT = "gluecron-pr-triage:summary";
const ISSUE_TRIAGE_MARKER_FRAGMENT = "gluecron-issue-triage:summary";

/** Audit-log action constants we look for. Public so callers (and
 *  tests) don't have to repeat string literals. */
export const AI_AUDIT_ACTIONS = {
  AUTO_MERGE_MERGED: "auto_merge.merged",
  AI_BUILD_DISPATCHED: "ai_build.dispatched",
  AI_COMMIT_MESSAGE: "ai.commit_message.generated",
} as const;

// ───────────────────────────────────────────────────────────────────
// Pure formula
// ───────────────────────────────────────────────────────────────────

/**
 * Pure decision helper. Translates an event breakdown into hours
 * saved using the documented formula. Synchronous + deterministic.
 *
 * Re-exported so Block L1 (Sleep Mode) can call the same function
 * and stay in lock-step with the dashboard widget number.
 */
export function computeHoursSaved(breakdown: AiSavingsBreakdown): number {
  const raw =
    breakdown.prsAutoMerged * 0.30 +
    breakdown.issuesBuiltByAi * 1.50 +
    breakdown.aiReviewsPosted * 0.25 +
    breakdown.aiTriagesPosted * 0.10 +
    breakdown.aiCommitMsgs * 0.05 +
    breakdown.secretsAutoRepaired * 0.50 +
    breakdown.gateAutoRepairs * 0.40;
  // Round to 1dp without floating-point drift surfacing in the UI.
  return Math.round(raw * 10) / 10;
}

/** Zero-valued breakdown — used as the fallback on DB error. */
export function emptyBreakdown(): AiSavingsBreakdown {
  return {
    prsAutoMerged: 0,
    issuesBuiltByAi: 0,
    aiReviewsPosted: 0,
    aiTriagesPosted: 0,
    aiCommitMsgs: 0,
    secretsAutoRepaired: 0,
    gateAutoRepairs: 0,
  };
}

// ───────────────────────────────────────────────────────────────────
// DI seam — collaborator interface for the counters
// ───────────────────────────────────────────────────────────────────

/**
 * One async function per breakdown counter, plus a `getRepoIds` helper
 * that resolves the set of repos a user owns. The default implementations
 * hit the DB; tests inject deterministic fakes.
 */
export interface AiSavingsDeps {
  getRepoIds: (userId: string) => Promise<string[]>;
  countPrsAutoMerged: (repoIds: string[], since: Date) => Promise<number>;
  countIssuesBuiltByAi: (repoIds: string[], since: Date) => Promise<number>;
  countAiReviewsPosted: (repoIds: string[], since: Date) => Promise<number>;
  countAiTriagesPosted: (repoIds: string[], since: Date) => Promise<number>;
  countAiCommitMsgs: (repoIds: string[], since: Date) => Promise<number>;
  countSecretsAutoRepaired: (repoIds: string[], since: Date) => Promise<number>;
  countGateAutoRepairs: (repoIds: string[], since: Date) => Promise<number>;
  getUserCreatedAt: (userId: string) => Promise<Date | null>;
}

// ───────────────────────────────────────────────────────────────────
// Default DB-backed implementations
// ───────────────────────────────────────────────────────────────────

const SECRET_GATE_NAMES = ["Secret scan", "Secret Scan", "Security scan", "Security Scan"];

async function defaultGetRepoIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.ownerId, userId));
  return rows.map((r) => r.id);
}

async function defaultGetUserCreatedAt(userId: string): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

async function countAuditAction(
  repoIds: string[],
  since: Date,
  action: string
): Promise<number> {
  if (repoIds.length === 0) return 0;
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, action),
        inArray(auditLog.repositoryId, repoIds),
        gte(auditLog.createdAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountPrsAutoMerged(repoIds: string[], since: Date): Promise<number> {
  return countAuditAction(repoIds, since, AI_AUDIT_ACTIONS.AUTO_MERGE_MERGED);
}

async function defaultCountIssuesBuiltByAi(repoIds: string[], since: Date): Promise<number> {
  return countAuditAction(repoIds, since, AI_AUDIT_ACTIONS.AI_BUILD_DISPATCHED);
}

async function defaultCountAiCommitMsgs(repoIds: string[], since: Date): Promise<number> {
  // FOLLOW-UP: no producer currently emits this action — `ai-generators.ts
  // generateCommitMessage` is wired into routes but doesn't audit. Count is
  // always zero until a producer is added. Keep the formula honest by leaving
  // the constant at the smallest weight (0.05) so its omission rounds away.
  return countAuditAction(repoIds, since, AI_AUDIT_ACTIONS.AI_COMMIT_MESSAGE);
}

async function defaultCountAiReviewsPosted(repoIds: string[], since: Date): Promise<number> {
  if (repoIds.length === 0) return 0;
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(prComments)
    .innerJoin(pullRequests, eq(prComments.pullRequestId, pullRequests.id))
    .where(
      and(
        eq(prComments.isAiReview, true),
        inArray(pullRequests.repositoryId, repoIds),
        gte(prComments.createdAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountAiTriagesPosted(repoIds: string[], since: Date): Promise<number> {
  if (repoIds.length === 0) return 0;
  const [prRows, issueRows] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(prComments)
      .innerJoin(pullRequests, eq(prComments.pullRequestId, pullRequests.id))
      .where(
        and(
          like(prComments.body, `%${PR_TRIAGE_MARKER_FRAGMENT}%`),
          inArray(pullRequests.repositoryId, repoIds),
          gte(prComments.createdAt, since)
        )
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(issueComments)
      .innerJoin(issues, eq(issueComments.issueId, issues.id))
      .where(
        and(
          like(issueComments.body, `%${ISSUE_TRIAGE_MARKER_FRAGMENT}%`),
          inArray(issues.repositoryId, repoIds),
          gte(issueComments.createdAt, since)
        )
      ),
  ]);
  return Number(prRows[0]?.n ?? 0) + Number(issueRows[0]?.n ?? 0);
}

async function defaultCountSecretsAutoRepaired(
  repoIds: string[],
  since: Date
): Promise<number> {
  if (repoIds.length === 0) return 0;
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(gateRuns)
    .where(
      and(
        eq(gateRuns.status, "repaired"),
        inArray(gateRuns.gateName, SECRET_GATE_NAMES),
        inArray(gateRuns.repositoryId, repoIds),
        gte(gateRuns.createdAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountGateAutoRepairs(
  repoIds: string[],
  since: Date
): Promise<number> {
  if (repoIds.length === 0) return 0;
  // All gates EXCEPT the secret/security ones (those are counted separately).
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(gateRuns)
    .where(
      and(
        eq(gateRuns.status, "repaired"),
        inArray(gateRuns.repositoryId, repoIds),
        gte(gateRuns.createdAt, since),
        sql`${gateRuns.gateName} NOT IN ('Secret scan','Secret Scan','Security scan','Security Scan')`
      )
    );
  return Number(rows[0]?.n ?? 0);
}

const DEFAULT_DEPS: AiSavingsDeps = {
  getRepoIds: defaultGetRepoIds,
  countPrsAutoMerged: defaultCountPrsAutoMerged,
  countIssuesBuiltByAi: defaultCountIssuesBuiltByAi,
  countAiReviewsPosted: defaultCountAiReviewsPosted,
  countAiTriagesPosted: defaultCountAiTriagesPosted,
  countAiCommitMsgs: defaultCountAiCommitMsgs,
  countSecretsAutoRepaired: defaultCountSecretsAutoRepaired,
  countGateAutoRepairs: defaultCountGateAutoRepairs,
  getUserCreatedAt: defaultGetUserCreatedAt,
};

// ───────────────────────────────────────────────────────────────────
// Public orchestrators
// ───────────────────────────────────────────────────────────────────

/**
 * Compute the rolling-window savings report for a single user.
 *
 * `windowHours` defaults to one week (168h). `now` lets tests pin
 * the cutoff deterministically. Never throws — DB errors degrade
 * to an all-zero breakdown.
 */
export async function computeAiSavingsForUser(
  userId: string,
  opts: { windowHours?: number; now?: Date; deps?: AiSavingsDeps } = {}
): Promise<AiSavingsReport> {
  const windowHours = opts.windowHours ?? 168;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowHours * 3600 * 1000);
  const deps = opts.deps ?? DEFAULT_DEPS;

  try {
    const repoIds = await deps.getRepoIds(userId);
    const [
      prsAutoMerged,
      issuesBuiltByAi,
      aiReviewsPosted,
      aiTriagesPosted,
      aiCommitMsgs,
      secretsAutoRepaired,
      gateAutoRepairs,
    ] = await Promise.all([
      deps.countPrsAutoMerged(repoIds, since),
      deps.countIssuesBuiltByAi(repoIds, since),
      deps.countAiReviewsPosted(repoIds, since),
      deps.countAiTriagesPosted(repoIds, since),
      deps.countAiCommitMsgs(repoIds, since),
      deps.countSecretsAutoRepaired(repoIds, since),
      deps.countGateAutoRepairs(repoIds, since),
    ]);

    const breakdown: AiSavingsBreakdown = {
      prsAutoMerged,
      issuesBuiltByAi,
      aiReviewsPosted,
      aiTriagesPosted,
      aiCommitMsgs,
      secretsAutoRepaired,
      gateAutoRepairs,
    };

    return {
      windowHours,
      breakdown,
      hoursSaved: computeHoursSaved(breakdown),
    };
  } catch (err) {
    console.error("[ai-hours-saved] degraded to zeros:", err);
    return {
      windowHours,
      breakdown: emptyBreakdown(),
      hoursSaved: 0,
    };
  }
}

/**
 * Compute the lifetime savings report for a single user — same shape
 * as the windowed version but the cutoff is the user's `created_at`.
 * Falls back to "30 days ago" if the user row can't be fetched.
 */
export async function computeLifetimeAiSavingsForUser(
  userId: string,
  opts: { deps?: AiSavingsDeps; now?: Date } = {}
): Promise<AiSavingsLifetimeReport> {
  const deps = opts.deps ?? DEFAULT_DEPS;
  const now = opts.now ?? new Date();
  try {
    const createdAt =
      (await deps.getUserCreatedAt(userId)) ??
      new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const windowHours = Math.max(
      1,
      Math.ceil((now.getTime() - createdAt.getTime()) / (3600 * 1000))
    );
    const report = await computeAiSavingsForUser(userId, {
      windowHours,
      now,
      deps,
    });
    return {
      hoursSaved: report.hoursSaved,
      breakdown: report.breakdown,
      sinceCreatedAt: createdAt,
    };
  } catch (err) {
    console.error("[ai-hours-saved] lifetime degraded to zeros:", err);
    return {
      hoursSaved: 0,
      breakdown: emptyBreakdown(),
      sinceCreatedAt: now,
    };
  }
}

// ───────────────────────────────────────────────────────────────────
// Test-only seam
// ───────────────────────────────────────────────────────────────────

export const __test = {
  DEFAULT_DEPS,
  PR_TRIAGE_MARKER_FRAGMENT,
  ISSUE_TRIAGE_MARKER_FRAGMENT,
};

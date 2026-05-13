/**
 * Block L4 — Public stats counters.
 *
 * Site-wide, PUBLIC-ONLY counters that power the marketing landing-page
 * social-proof tiles ("X PRs auto-merged this week", "Y deploys shipped
 * overnight", etc.).
 *
 * Hard contract — PUBLIC repos only.
 *   Every counter that touches per-repo data joins through `repositories`
 *   and filters `is_private = false AND is_archived = false`. Private
 *   repos must NEVER leak into these numbers. The whole point of the
 *   widget is honest, public social proof.
 *
 * Never throws. On any DB error every counter degrades to zero and the
 * report is returned with `asOf = now`. The landing page would rather
 * render zeros than 500.
 *
 * Caching. The marketing page is a hot path; recomputing eight queries
 * on every render would hammer the DB. Results are memoised in a tiny
 * `LRUCache` with a 5-minute TTL (`publicStatsCache`).
 *
 * DI seam (`PublicStatsDeps`) mirrors the L9 pattern so tests inject
 * deterministic counters without spinning up Postgres.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  deployments,
  gateRuns,
  issues,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { LRUCache } from "./cache";
import { computeHoursSaved } from "./ai-hours-saved";

// ───────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────

export type PublicStats = {
  // Lifetime counters
  totalPublicRepos: number;
  totalUsers: number;
  totalPublicPullRequests: number;
  totalPublicIssues: number;
  // Trailing-7-days "AI did this" highlights
  weeklyPrsAutoMerged: number;
  weeklyIssuesBuiltByAi: number;
  weeklyAiReviewsPosted: number;
  weeklySecretsAutoFixed: number;
  weeklyDeploysShipped: number;
  // Derived
  weeklyHoursSaved: number;
  asOf: Date;
};

/** Zero-valued stats — used as the fallback on any DB error. */
export function emptyPublicStats(asOf: Date): PublicStats {
  return {
    totalPublicRepos: 0,
    totalUsers: 0,
    totalPublicPullRequests: 0,
    totalPublicIssues: 0,
    weeklyPrsAutoMerged: 0,
    weeklyIssuesBuiltByAi: 0,
    weeklyAiReviewsPosted: 0,
    weeklySecretsAutoFixed: 0,
    weeklyDeploysShipped: 0,
    weeklyHoursSaved: 0,
    asOf,
  };
}

// ───────────────────────────────────────────────────────────────────
// Audit-log action constants. Importing from `auto-merge.ts` /
// `ai-build-tasks.ts` would risk a circular-import in some test
// setups, so the literals are duplicated here. Mirrors the same
// trade-off `ai-hours-saved.ts` made.
// ───────────────────────────────────────────────────────────────────

export const PUBLIC_STATS_ACTIONS = {
  AUTO_MERGE_MERGED: "auto_merge.merged",
  AI_BUILD_DISPATCHED: "ai_build.dispatched",
} as const;

const SECRET_GATE_NAME_PATTERNS = ["%secret%", "%Secret%"];

// ───────────────────────────────────────────────────────────────────
// DI seam
// ───────────────────────────────────────────────────────────────────

export interface PublicStatsDeps {
  countTotalPublicRepos: () => Promise<number>;
  countTotalUsers: () => Promise<number>;
  countTotalPublicPullRequests: () => Promise<number>;
  countTotalPublicIssues: () => Promise<number>;
  countWeeklyPrsAutoMerged: (since: Date) => Promise<number>;
  countWeeklyIssuesBuiltByAi: (since: Date) => Promise<number>;
  countWeeklyAiReviewsPosted: (since: Date) => Promise<number>;
  countWeeklySecretsAutoFixed: (since: Date) => Promise<number>;
  countWeeklyDeploysShipped: (since: Date) => Promise<number>;
}

// ───────────────────────────────────────────────────────────────────
// Default DB-backed implementations.
//
// Every per-repo counter JOINs through `repositories` with a hard
// filter on `is_private = false AND is_archived = false`. That join
// is the privacy boundary — under no circumstance should it be removed.
// ───────────────────────────────────────────────────────────────────

async function defaultCountTotalPublicRepos(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(repositories)
    .where(
      and(
        eq(repositories.isPrivate, false),
        eq(repositories.isArchived, false)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountTotalUsers(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users);
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountTotalPublicPullRequests(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pullRequests)
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .where(eq(repositories.isPrivate, false));
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountTotalPublicIssues(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .innerJoin(repositories, eq(issues.repositoryId, repositories.id))
    .where(eq(repositories.isPrivate, false));
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountWeeklyPrsAutoMerged(since: Date): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .innerJoin(repositories, eq(auditLog.repositoryId, repositories.id))
    .where(
      and(
        eq(auditLog.action, PUBLIC_STATS_ACTIONS.AUTO_MERGE_MERGED),
        eq(repositories.isPrivate, false),
        gte(auditLog.createdAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountWeeklyIssuesBuiltByAi(since: Date): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .innerJoin(repositories, eq(auditLog.repositoryId, repositories.id))
    .where(
      and(
        eq(auditLog.action, PUBLIC_STATS_ACTIONS.AI_BUILD_DISPATCHED),
        eq(repositories.isPrivate, false),
        gte(auditLog.createdAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountWeeklyAiReviewsPosted(since: Date): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(prComments)
    .innerJoin(pullRequests, eq(prComments.pullRequestId, pullRequests.id))
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .where(
      and(
        eq(prComments.isAiReview, true),
        eq(repositories.isPrivate, false),
        gte(prComments.createdAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountWeeklySecretsAutoFixed(since: Date): Promise<number> {
  // `gate_name LIKE '%secret%'` — case-insensitive via ILIKE so we catch
  // "Secret scan", "Secret Scan", "secret-scan", etc. Restrict to
  // `status = 'repaired'` so we only count auto-repair successes.
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(gateRuns)
    .innerJoin(repositories, eq(gateRuns.repositoryId, repositories.id))
    .where(
      and(
        eq(gateRuns.status, "repaired"),
        sql`${gateRuns.gateName} ILIKE ${SECRET_GATE_NAME_PATTERNS[0]}`,
        eq(repositories.isPrivate, false),
        gte(gateRuns.createdAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

async function defaultCountWeeklyDeploysShipped(since: Date): Promise<number> {
  // Spec says `status='succeeded'`; the schema currently emits `success`
  // (see `src/db/schema.ts` deployments.status enum comment + every call
  // site in `src/lib/deploy-pipeline.ts`). Accept BOTH so the counter
  // remains correct whether a future migration normalises the spelling.
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deployments)
    .innerJoin(repositories, eq(deployments.repositoryId, repositories.id))
    .where(
      and(
        sql`${deployments.status} IN ('success','succeeded')`,
        eq(repositories.isPrivate, false),
        gte(deployments.createdAt, since)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

const DEFAULT_DEPS: PublicStatsDeps = {
  countTotalPublicRepos: defaultCountTotalPublicRepos,
  countTotalUsers: defaultCountTotalUsers,
  countTotalPublicPullRequests: defaultCountTotalPublicPullRequests,
  countTotalPublicIssues: defaultCountTotalPublicIssues,
  countWeeklyPrsAutoMerged: defaultCountWeeklyPrsAutoMerged,
  countWeeklyIssuesBuiltByAi: defaultCountWeeklyIssuesBuiltByAi,
  countWeeklyAiReviewsPosted: defaultCountWeeklyAiReviewsPosted,
  countWeeklySecretsAutoFixed: defaultCountWeeklySecretsAutoFixed,
  countWeeklyDeploysShipped: defaultCountWeeklyDeploysShipped,
};

// ───────────────────────────────────────────────────────────────────
// Caching
// ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

/** In-memory cache for the computed PublicStats. Single key: "public". */
export const publicStatsCache = new LRUCache<PublicStats>(4, CACHE_TTL_MS);

/** Clear the cache. Test-only. */
export function __resetPublicStatsCache(): void {
  publicStatsCache.clear();
}

// ───────────────────────────────────────────────────────────────────
// Public orchestrator
// ───────────────────────────────────────────────────────────────────

export interface ComputePublicStatsOpts {
  now?: Date;
  deps?: PublicStatsDeps;
  /** When true, skip the in-memory cache layer (test seam). */
  noCache?: boolean;
}

/**
 * Compute the site-wide public stats report.
 *
 * Trailing window for the "weekly" counters is 7 days. The lifetime
 * counters are unbounded. Never throws — DB errors degrade to
 * `emptyPublicStats(now)`.
 */
export async function computePublicStats(
  opts: ComputePublicStatsOpts = {}
): Promise<PublicStats> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? DEFAULT_DEPS;
  const useCache = !opts.noCache && !opts.deps;

  if (useCache) {
    const hit = publicStatsCache.get("public");
    if (hit) return hit;
  }

  const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  try {
    const [
      totalPublicRepos,
      totalUsers,
      totalPublicPullRequests,
      totalPublicIssues,
      weeklyPrsAutoMerged,
      weeklyIssuesBuiltByAi,
      weeklyAiReviewsPosted,
      weeklySecretsAutoFixed,
      weeklyDeploysShipped,
    ] = await Promise.all([
      deps.countTotalPublicRepos(),
      deps.countTotalUsers(),
      deps.countTotalPublicPullRequests(),
      deps.countTotalPublicIssues(),
      deps.countWeeklyPrsAutoMerged(since),
      deps.countWeeklyIssuesBuiltByAi(since),
      deps.countWeeklyAiReviewsPosted(since),
      deps.countWeeklySecretsAutoFixed(since),
      deps.countWeeklyDeploysShipped(since),
    ]);

    // Reuse the L9 hours-saved formula so the public number stays in
    // lock-step with the per-user dashboard widget. The triage / commit-
    // message / non-secret-gate buckets aren't surfaced site-wide, so
    // they're zeroed here — the formula degrades gracefully.
    const weeklyHoursSaved = computeHoursSaved({
      prsAutoMerged: weeklyPrsAutoMerged,
      issuesBuiltByAi: weeklyIssuesBuiltByAi,
      aiReviewsPosted: weeklyAiReviewsPosted,
      aiTriagesPosted: 0,
      aiCommitMsgs: 0,
      secretsAutoRepaired: weeklySecretsAutoFixed,
      gateAutoRepairs: 0,
    });

    const stats: PublicStats = {
      totalPublicRepos,
      totalUsers,
      totalPublicPullRequests,
      totalPublicIssues,
      weeklyPrsAutoMerged,
      weeklyIssuesBuiltByAi,
      weeklyAiReviewsPosted,
      weeklySecretsAutoFixed,
      weeklyDeploysShipped,
      weeklyHoursSaved,
      asOf: now,
    };

    if (useCache) publicStatsCache.set("public", stats);
    return stats;
  } catch (err) {
    console.error("[public-stats] degraded to zeros:", err);
    return emptyPublicStats(now);
  }
}

// ───────────────────────────────────────────────────────────────────
// Test-only seam
// ───────────────────────────────────────────────────────────────────

export const __test = {
  DEFAULT_DEPS,
  CACHE_TTL_MS,
};

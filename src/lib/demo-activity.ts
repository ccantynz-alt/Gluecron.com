/**
 * Block L3 — Demo activity helpers.
 *
 * Read-only feed helpers used by the public `/demo` landing page and its
 * companion `/api/v2/demo/*` JSON endpoints. All helpers are scoped to
 * repositories owned by the seeded `demo` user (`DEMO_USERNAME` from
 * `src/lib/demo-seed.ts`).
 *
 * Defensive on every public function:
 *   - Never throws. On any DB hiccup or unexpected shape, returns `[]` (or 0).
 *   - Results are cached in-process for 30 seconds via `LRUCache` from
 *     `src/lib/cache.ts`. Cache key includes the helper name and limit so
 *     two callers asking for different page sizes don't poison each other.
 *
 * Intentionally pure-where-possible: only DB reads, no writes, no spawns,
 * no side effects.
 */

import { and, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  issueLabels,
  issues,
  labels,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { LRUCache } from "./cache";
import { DEMO_USERNAME } from "./demo-seed";
import { AI_BUILD_MARKER } from "./ai-build-tasks";

const DEFAULT_LIMIT = 5;
const DEFAULT_FEED_LIMIT = 20;
const DEFAULT_SINCE_HOURS = 24;

const CACHE_TTL_MS = 30 * 1000;
const demoActivityCache = new LRUCache<unknown>(64, CACHE_TTL_MS);

export interface QueuedAiBuildIssue {
  repo: string;
  number: number;
  title: string;
  createdAt: Date;
}

export interface RecentAutoMerge {
  repo: string;
  number: number;
  title: string;
  mergedAt: Date;
}

export interface RecentAiReview {
  repo: string;
  prNumber: number;
  commentSnippet: string;
  createdAt: Date;
}

export type DemoActivityKind =
  | "auto_merge.merged"
  | "ai_build.dispatched"
  | "ai_review.posted";

export interface DemoActivityEntry {
  kind: DemoActivityKind;
  repo: string;
  ref: { type: "issue" | "pr"; number: number };
  at: Date;
}

interface DemoRepoRow {
  id: string;
  name: string;
}

/**
 * Look up the demo user + their repos. Returns `null` on any DB failure or
 * if the demo user doesn't exist yet (boot-time race or no seed run).
 */
async function loadDemoRepos(): Promise<{
  userId: string;
  repos: DemoRepoRow[];
} | null> {
  try {
    const [demo] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, DEMO_USERNAME))
      .limit(1);
    if (!demo) return null;

    const repos = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(eq(repositories.ownerId, demo.id));

    return { userId: demo.id, repos };
  } catch {
    return null;
  }
}

function cacheKey(name: string, ...parts: (string | number)[]): string {
  return [name, ...parts.map((p) => String(p))].join("|");
}

async function memo<T>(
  key: string,
  factory: () => Promise<T>,
  fallback: T
): Promise<T> {
  const existing = demoActivityCache.get(key) as T | undefined;
  if (existing !== undefined) return existing;
  try {
    const value = await factory();
    demoActivityCache.set(key, value as unknown);
    return value;
  } catch {
    return fallback;
  }
}

/**
 * Open issues across demo repos labelled `ai:build` that haven't yet been
 * dispatched (no comment carrying the `AI_BUILD_MARKER`). Newest first.
 */
export async function listQueuedAiBuildIssues(
  limit: number = DEFAULT_LIMIT
): Promise<QueuedAiBuildIssue[]> {
  const lim = Math.max(1, Math.min(50, limit | 0 || DEFAULT_LIMIT));
  return memo(
    cacheKey("queued", lim),
    async () => {
      const ctx = await loadDemoRepos();
      if (!ctx || ctx.repos.length === 0) return [];
      const repoIds = ctx.repos.map((r) => r.id);
      const nameById = new Map(ctx.repos.map((r) => [r.id, r.name] as const));

      // Find issues labelled "ai:build" (case-insensitive). The label is
      // per-repo, so we filter via the join across the demo repo set.
      const rows = await db
        .select({
          id: issues.id,
          repositoryId: issues.repositoryId,
          number: issues.number,
          title: issues.title,
          body: issues.body,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .innerJoin(issueLabels, eq(issueLabels.issueId, issues.id))
        .innerJoin(labels, eq(labels.id, issueLabels.labelId))
        .where(
          and(
            inArray(issues.repositoryId, repoIds),
            eq(issues.state, "open"),
            sql`lower(${labels.name}) = 'ai:build'`
          )
        )
        .orderBy(desc(issues.createdAt))
        .limit(lim * 4); // over-fetch to allow for marker filtering

      // Filter out issues whose body already carries the marker (the
      // marker can also be in a comment but the conservative "body or any
      // comment" check needs another roundtrip; doing the body check here
      // mirrors the dispatch sentinel and is sufficient for the demo).
      const filtered: QueuedAiBuildIssue[] = [];
      for (const r of rows) {
        if (r.body && r.body.includes(AI_BUILD_MARKER)) continue;
        const repo = nameById.get(r.repositoryId);
        if (!repo) continue;
        filtered.push({
          repo,
          number: r.number,
          title: r.title,
          createdAt: r.createdAt,
        });
        if (filtered.length >= lim) break;
      }
      return filtered;
    },
    []
  );
}

/**
 * Recent `auto_merge.merged` audit rows scoped to demo repos. Pulls the PR
 * title via the targetId (which is the pull_request UUID).
 */
export async function listRecentAutoMerges(
  limit: number = DEFAULT_LIMIT,
  sinceHours: number = DEFAULT_SINCE_HOURS
): Promise<RecentAutoMerge[]> {
  const lim = Math.max(1, Math.min(50, limit | 0 || DEFAULT_LIMIT));
  const hrs = Math.max(1, Math.min(720, sinceHours | 0 || DEFAULT_SINCE_HOURS));
  return memo(
    cacheKey("merges", lim, hrs),
    async () => {
      const ctx = await loadDemoRepos();
      if (!ctx || ctx.repos.length === 0) return [];
      const repoIds = ctx.repos.map((r) => r.id);
      const nameById = new Map(ctx.repos.map((r) => [r.id, r.name] as const));
      const since = new Date(Date.now() - hrs * 60 * 60 * 1000);

      const rows = await db
        .select({
          repositoryId: auditLog.repositoryId,
          targetId: auditLog.targetId,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "auto_merge.merged"),
            inArray(auditLog.repositoryId, repoIds),
            gte(auditLog.createdAt, since)
          )
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(lim);

      if (rows.length === 0) return [];

      const prIds = rows
        .map((r) => r.targetId)
        .filter((id): id is string => !!id);
      const prRows = prIds.length
        ? await db
            .select({
              id: pullRequests.id,
              number: pullRequests.number,
              title: pullRequests.title,
            })
            .from(pullRequests)
            .where(inArray(pullRequests.id, prIds))
        : [];
      const prById = new Map(prRows.map((p) => [p.id, p] as const));

      const result: RecentAutoMerge[] = [];
      for (const r of rows) {
        const repo = r.repositoryId ? nameById.get(r.repositoryId) : undefined;
        const pr = r.targetId ? prById.get(r.targetId) : undefined;
        if (!repo || !pr) continue;
        result.push({
          repo,
          number: pr.number,
          title: pr.title,
          mergedAt: r.createdAt,
        });
      }
      return result;
    },
    []
  );
}

/**
 * Recent AI-review PR comments (is_ai_review=true) on demo repos. Returns
 * a short snippet of the comment body for the tile.
 */
export async function listRecentAiReviews(
  limit: number = DEFAULT_LIMIT,
  sinceHours: number = DEFAULT_SINCE_HOURS
): Promise<RecentAiReview[]> {
  const lim = Math.max(1, Math.min(50, limit | 0 || DEFAULT_LIMIT));
  const hrs = Math.max(1, Math.min(720, sinceHours | 0 || DEFAULT_SINCE_HOURS));
  return memo(
    cacheKey("reviews", lim, hrs),
    async () => {
      const ctx = await loadDemoRepos();
      if (!ctx || ctx.repos.length === 0) return [];
      const repoIds = ctx.repos.map((r) => r.id);
      const nameById = new Map(ctx.repos.map((r) => [r.id, r.name] as const));
      const since = new Date(Date.now() - hrs * 60 * 60 * 1000);

      const rows = await db
        .select({
          repositoryId: pullRequests.repositoryId,
          prNumber: pullRequests.number,
          body: prComments.body,
          createdAt: prComments.createdAt,
        })
        .from(prComments)
        .innerJoin(
          pullRequests,
          eq(pullRequests.id, prComments.pullRequestId)
        )
        .where(
          and(
            eq(prComments.isAiReview, true),
            inArray(pullRequests.repositoryId, repoIds),
            gte(prComments.createdAt, since)
          )
        )
        .orderBy(desc(prComments.createdAt))
        .limit(lim);

      const result: RecentAiReview[] = [];
      for (const r of rows) {
        const repo = nameById.get(r.repositoryId);
        if (!repo) continue;
        const stripped = (r.body ?? "")
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const snippet =
          stripped.length > 120
            ? stripped.slice(0, 117).trimEnd() + "..."
            : stripped;
        result.push({
          repo,
          prNumber: r.prNumber,
          commentSnippet: snippet,
          createdAt: r.createdAt,
        });
      }
      return result;
    },
    []
  );
}

/**
 * Count AI reviews posted in the last `sinceHours` hours across demo repos.
 * Pure summary — used by the small counter tile.
 */
export async function countAiReviewsSince(
  sinceHours: number = DEFAULT_SINCE_HOURS
): Promise<number> {
  const hrs = Math.max(1, Math.min(720, sinceHours | 0 || DEFAULT_SINCE_HOURS));
  return memo(
    cacheKey("review-count", hrs),
    async () => {
      const ctx = await loadDemoRepos();
      if (!ctx || ctx.repos.length === 0) return 0;
      const repoIds = ctx.repos.map((r) => r.id);
      const since = new Date(Date.now() - hrs * 60 * 60 * 1000);

      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(prComments)
        .innerJoin(
          pullRequests,
          eq(pullRequests.id, prComments.pullRequestId)
        )
        .where(
          and(
            eq(prComments.isAiReview, true),
            inArray(pullRequests.repositoryId, repoIds),
            gte(prComments.createdAt, since)
          )
        );
      return Number(rows[0]?.n ?? 0);
    },
    0
  );
}

/**
 * Combined activity feed: auto_merge.merged + ai_build.dispatched audit
 * rows interleaved with recent AI-review PR comments (synthesised as
 * `ai_review.posted` entries since there's no dedicated audit action).
 * Most-recent first, capped at `limit`.
 */
export async function listDemoActivityFeed(
  limit: number = DEFAULT_FEED_LIMIT
): Promise<DemoActivityEntry[]> {
  const lim = Math.max(1, Math.min(100, limit | 0 || DEFAULT_FEED_LIMIT));
  return memo(
    cacheKey("feed", lim),
    async () => {
      const ctx = await loadDemoRepos();
      if (!ctx || ctx.repos.length === 0) return [];
      const repoIds = ctx.repos.map((r) => r.id);
      const nameById = new Map(ctx.repos.map((r) => [r.id, r.name] as const));

      // Audit rows: auto_merge.merged + ai_build.dispatched.
      const auditRows = await db
        .select({
          action: auditLog.action,
          repositoryId: auditLog.repositoryId,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(
          and(
            inArray(auditLog.action, [
              "auto_merge.merged",
              "ai_build.dispatched",
            ]),
            inArray(auditLog.repositoryId, repoIds)
          )
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(lim);

      // PR comments flagged as AI reviews — used to synthesise
      // `ai_review.posted` entries.
      const aiReviewRows = await db
        .select({
          repositoryId: pullRequests.repositoryId,
          prNumber: pullRequests.number,
          createdAt: prComments.createdAt,
        })
        .from(prComments)
        .innerJoin(
          pullRequests,
          eq(pullRequests.id, prComments.pullRequestId)
        )
        .where(
          and(
            eq(prComments.isAiReview, true),
            inArray(pullRequests.repositoryId, repoIds)
          )
        )
        .orderBy(desc(prComments.createdAt))
        .limit(lim);

      const entries: DemoActivityEntry[] = [];

      // Resolve PR/issue number from targetId for auto_merge.merged /
      // ai_build.dispatched rows. Cheap: collect ids, hit the table once.
      const prTargetIds = auditRows
        .filter((r) => r.action === "auto_merge.merged" && !!r.targetId)
        .map((r) => r.targetId as string);
      const issueTargetIds = auditRows
        .filter((r) => r.action === "ai_build.dispatched" && !!r.targetId)
        .map((r) => r.targetId as string);

      const prById = prTargetIds.length
        ? new Map(
            (
              await db
                .select({
                  id: pullRequests.id,
                  number: pullRequests.number,
                })
                .from(pullRequests)
                .where(inArray(pullRequests.id, prTargetIds))
            ).map((p) => [p.id, p.number] as const)
          )
        : new Map<string, number>();

      const issueById = issueTargetIds.length
        ? new Map(
            (
              await db
                .select({
                  id: issues.id,
                  number: issues.number,
                })
                .from(issues)
                .where(inArray(issues.id, issueTargetIds))
            ).map((i) => [i.id, i.number] as const)
          )
        : new Map<string, number>();

      for (const r of auditRows) {
        const repo = r.repositoryId ? nameById.get(r.repositoryId) : undefined;
        if (!repo) continue;
        if (r.action === "auto_merge.merged") {
          const n = r.targetId ? prById.get(r.targetId) : undefined;
          if (n === undefined) continue;
          entries.push({
            kind: "auto_merge.merged",
            repo,
            ref: { type: "pr", number: n },
            at: r.createdAt,
          });
        } else if (r.action === "ai_build.dispatched") {
          const n = r.targetId ? issueById.get(r.targetId) : undefined;
          if (n === undefined) continue;
          entries.push({
            kind: "ai_build.dispatched",
            repo,
            ref: { type: "issue", number: n },
            at: r.createdAt,
          });
        }
      }

      for (const r of aiReviewRows) {
        const repo = nameById.get(r.repositoryId);
        if (!repo) continue;
        entries.push({
          kind: "ai_review.posted",
          repo,
          ref: { type: "pr", number: r.prNumber },
          at: r.createdAt,
        });
      }

      entries.sort((a, b) => b.at.getTime() - a.at.getTime());
      return entries.slice(0, lim);
    },
    []
  );
}

/** Test-only export — exposed for unit tests, not part of the public surface. */
export const __test = {
  loadDemoRepos,
  demoActivityCache,
};

/**
 * Block F1 — Traffic analytics helpers.
 *
 * Records + rolls up per-repo visit / clone / API hits. We record a row per
 * event (cheap) and aggregate in-memory for the chart. `trackView` and
 * `trackClone` are fire-and-forget — they never throw and never slow the
 * user-facing request.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db";
import { repoTrafficEvents, repositories, users } from "../db/schema";

export type TrafficKind = "view" | "clone" | "api" | "ui";

export interface TrackArgs {
  repositoryId: string;
  kind: TrafficKind;
  path?: string | null;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  referer?: string | null;
}

function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256")
    .update(ip)
    .digest("hex")
    .slice(0, 16); // 64 bits is plenty for uniqueness within a day
}

/**
 * Record a traffic event. Never throws. Returns quickly — callers don't need
 * to await, but may if they want backpressure.
 */
export async function track(args: TrackArgs): Promise<void> {
  try {
    await db.insert(repoTrafficEvents).values({
      repositoryId: args.repositoryId,
      kind: args.kind,
      path: args.path ? args.path.slice(0, 256) : null,
      userId: args.userId || null,
      ipHash: hashIp(args.ip),
      userAgent: args.userAgent ? args.userAgent.slice(0, 128) : null,
      referer: args.referer ? args.referer.slice(0, 256) : null,
    });
  } catch {
    // swallow
  }
}

/**
 * Convenience wrappers. Kept separate so call sites read semantically.
 */
export async function trackView(
  args: Omit<TrackArgs, "kind">
): Promise<void> {
  return track({ ...args, kind: "view" });
}

export async function trackClone(
  args: Omit<TrackArgs, "kind">
): Promise<void> {
  return track({ ...args, kind: "clone" });
}

/**
 * Look up `(owner, repo)` and record a traffic event. Safe to fire-and-forget
 * from request handlers; never throws. Returns void.
 */
export async function trackByName(
  owner: string,
  repo: string,
  kind: TrafficKind,
  meta: Omit<TrackArgs, "kind" | "repositoryId"> = {}
): Promise<void> {
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    if (!row) return;
    await track({ ...meta, kind, repositoryId: row.id });
  } catch {
    // swallow
  }
}

export interface TrafficSummary {
  totalViews: number;
  totalClones: number;
  uniqueVisitorsApprox: number;
  daily: Array<{ day: string; views: number; clones: number }>;
  topReferers: Array<{ referer: string; n: number }>;
  topPaths: Array<{ path: string; n: number }>;
}

/**
 * Build a 14-day traffic summary for a repo. Approximation for
 * uniqueVisitorsApprox: distinct `ip_hash` over the window.
 */
export async function summarise(
  repositoryId: string,
  windowDays = 14
): Promise<TrafficSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const empty: TrafficSummary = {
    totalViews: 0,
    totalClones: 0,
    uniqueVisitorsApprox: 0,
    daily: [],
    topReferers: [],
    topPaths: [],
  };

  try {
    const rows = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${repoTrafficEvents.createdAt}), 'YYYY-MM-DD')`,
        kind: repoTrafficEvents.kind,
        n: sql<number>`count(*)::int`,
      })
      .from(repoTrafficEvents)
      .where(
        and(
          eq(repoTrafficEvents.repositoryId, repositoryId),
          gte(repoTrafficEvents.createdAt, since)
        )
      )
      .groupBy(
        sql`date_trunc('day', ${repoTrafficEvents.createdAt})`,
        repoTrafficEvents.kind
      );

    const dayMap = new Map<string, { views: number; clones: number }>();
    let totalViews = 0;
    let totalClones = 0;
    for (const r of rows) {
      const day = r.day;
      const bucket = dayMap.get(day) || { views: 0, clones: 0 };
      if (r.kind === "view" || r.kind === "ui") {
        bucket.views += Number(r.n);
        totalViews += Number(r.n);
      } else if (r.kind === "clone") {
        bucket.clones += Number(r.n);
        totalClones += Number(r.n);
      }
      dayMap.set(day, bucket);
    }

    const daily = Array.from(dayMap.entries())
      .map(([day, v]) => ({ day, views: v.views, clones: v.clones }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const [uv] = await db
      .select({
        n: sql<number>`count(distinct ${repoTrafficEvents.ipHash})::int`,
      })
      .from(repoTrafficEvents)
      .where(
        and(
          eq(repoTrafficEvents.repositoryId, repositoryId),
          gte(repoTrafficEvents.createdAt, since)
        )
      );

    const refRows = await db
      .select({
        referer: repoTrafficEvents.referer,
        n: sql<number>`count(*)::int`,
      })
      .from(repoTrafficEvents)
      .where(
        and(
          eq(repoTrafficEvents.repositoryId, repositoryId),
          gte(repoTrafficEvents.createdAt, since),
          sql`${repoTrafficEvents.referer} IS NOT NULL AND ${repoTrafficEvents.referer} <> ''`
        )
      )
      .groupBy(repoTrafficEvents.referer)
      .orderBy(sql`count(*) desc`)
      .limit(8);

    const pathRows = await db
      .select({
        path: repoTrafficEvents.path,
        n: sql<number>`count(*)::int`,
      })
      .from(repoTrafficEvents)
      .where(
        and(
          eq(repoTrafficEvents.repositoryId, repositoryId),
          gte(repoTrafficEvents.createdAt, since),
          sql`${repoTrafficEvents.path} IS NOT NULL`
        )
      )
      .groupBy(repoTrafficEvents.path)
      .orderBy(sql`count(*) desc`)
      .limit(8);

    return {
      totalViews,
      totalClones,
      uniqueVisitorsApprox: Number(uv?.n || 0),
      daily,
      topReferers: refRows
        .filter((r) => !!r.referer)
        .map((r) => ({ referer: r.referer as string, n: Number(r.n) })),
      topPaths: pathRows
        .filter((r) => !!r.path)
        .map((r) => ({ path: r.path as string, n: Number(r.n) })),
    };
  } catch {
    return empty;
  }
}

/**
 * Pure helper for unit tests — turn a list of events into the same daily
 * bucket structure as `summarise` without needing a DB.
 */
export function bucketDaily(
  events: Array<{ createdAt: Date | string; kind: string }>
): Array<{ day: string; views: number; clones: number }> {
  const dayMap = new Map<string, { views: number; clones: number }>();
  for (const e of events) {
    const t = typeof e.createdAt === "string" ? new Date(e.createdAt) : e.createdAt;
    const day = t.toISOString().slice(0, 10);
    const bucket = dayMap.get(day) || { views: 0, clones: 0 };
    if (e.kind === "view" || e.kind === "ui") bucket.views++;
    else if (e.kind === "clone") bucket.clones++;
    dayMap.set(day, bucket);
  }
  return Array.from(dayMap.entries())
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

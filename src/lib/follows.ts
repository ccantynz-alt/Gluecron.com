/**
 * Block J4 — User following + personalised feed.
 *
 * Core graph ops and a personalised feed built on top of `activity_feed`.
 * No caches / materialised views — the follow set is small (tens to low
 * hundreds) and the activity_feed already carries the indexes we need.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  activityFeed,
  repositories,
  userFollows,
  users,
  type ActivityEntry,
  type User,
} from "../db/schema";

// ----------------------------------------------------------------------------
// Graph mutations
// ----------------------------------------------------------------------------

export async function followUser(
  followerId: string,
  followingId: string
): Promise<"ok" | "self" | "already" | "error"> {
  if (followerId === followingId) return "self";
  try {
    const rows = await db
      .insert(userFollows)
      .values({ followerId, followingId })
      .onConflictDoNothing()
      .returning();
    return rows.length > 0 ? "ok" : "already";
  } catch {
    return "error";
  }
}

export async function unfollowUser(
  followerId: string,
  followingId: string
): Promise<boolean> {
  const rows = await db
    .delete(userFollows)
    .where(
      and(
        eq(userFollows.followerId, followerId),
        eq(userFollows.followingId, followingId)
      )
    )
    .returning();
  return rows.length > 0;
}

export async function isFollowing(
  followerId: string,
  followingId: string
): Promise<boolean> {
  if (followerId === followingId) return false;
  const [row] = await db
    .select({ f: userFollows.followerId })
    .from(userFollows)
    .where(
      and(
        eq(userFollows.followerId, followerId),
        eq(userFollows.followingId, followingId)
      )
    )
    .limit(1);
  return !!row;
}

// ----------------------------------------------------------------------------
// Lists
// ----------------------------------------------------------------------------

export async function listFollowers(userId: string): Promise<User[]> {
  return db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      avatarUrl: users.avatarUrl,
      bio: users.bio,
      notifyEmailOnMention: users.notifyEmailOnMention,
      notifyEmailOnAssign: users.notifyEmailOnAssign,
      notifyEmailOnGateFail: users.notifyEmailOnGateFail,
      notifyEmailDigestWeekly: users.notifyEmailDigestWeekly,
      lastDigestSentAt: users.lastDigestSentAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(userFollows)
    .innerJoin(users, eq(userFollows.followerId, users.id))
    .where(eq(userFollows.followingId, userId))
    .orderBy(desc(userFollows.createdAt));
}

export async function listFollowing(userId: string): Promise<User[]> {
  return db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      avatarUrl: users.avatarUrl,
      bio: users.bio,
      notifyEmailOnMention: users.notifyEmailOnMention,
      notifyEmailOnAssign: users.notifyEmailOnAssign,
      notifyEmailOnGateFail: users.notifyEmailOnGateFail,
      notifyEmailDigestWeekly: users.notifyEmailDigestWeekly,
      lastDigestSentAt: users.lastDigestSentAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(userFollows)
    .innerJoin(users, eq(userFollows.followingId, users.id))
    .where(eq(userFollows.followerId, userId))
    .orderBy(desc(userFollows.createdAt));
}

export async function followCounts(userId: string): Promise<{
  followers: number;
  following: number;
}> {
  const [followers, following] = await Promise.all([
    db
      .select({ uid: userFollows.followerId })
      .from(userFollows)
      .where(eq(userFollows.followingId, userId)),
    db
      .select({ uid: userFollows.followingId })
      .from(userFollows)
      .where(eq(userFollows.followerId, userId)),
  ]);
  return { followers: followers.length, following: following.length };
}

// ----------------------------------------------------------------------------
// Feed
// ----------------------------------------------------------------------------

export interface FeedEntry {
  activity: ActivityEntry;
  actor: { id: string; username: string; displayName: string | null };
  repository: { id: string; name: string; ownerId: string; isPrivate: boolean };
  ownerUsername: string;
}

/**
 * Activity feed filtered to the users the viewer follows. We cap at 200
 * following edges to bound the IN list. Private repos are excluded unless
 * the viewer owns them.
 */
export async function feedForUser(
  userId: string,
  limit = 50
): Promise<FeedEntry[]> {
  const following = await db
    .select({ id: userFollows.followingId })
    .from(userFollows)
    .where(eq(userFollows.followerId, userId))
    .limit(200);
  const ids = following.map((f) => f.id);
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      activity: activityFeed,
      actor: users,
      repository: repositories,
    })
    .from(activityFeed)
    .innerJoin(users, eq(activityFeed.userId, users.id))
    .innerJoin(repositories, eq(activityFeed.repositoryId, repositories.id))
    .where(inArray(activityFeed.userId, ids))
    .orderBy(desc(activityFeed.createdAt))
    .limit(limit);

  // Resolve owner usernames for repo links.
  const ownerIds = Array.from(new Set(rows.map((r) => r.repository.ownerId)));
  let ownerMap: Record<string, string> = {};
  if (ownerIds.length) {
    const owners = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, ownerIds));
    for (const o of owners) ownerMap[o.id] = o.username;
  }

  return rows
    .filter(
      (r) => !r.repository.isPrivate || r.repository.ownerId === userId
    )
    .map((r) => ({
      activity: r.activity,
      actor: {
        id: r.actor.id,
        username: r.actor.username,
        displayName: r.actor.displayName,
      },
      repository: {
        id: r.repository.id,
        name: r.repository.name,
        ownerId: r.repository.ownerId,
        isPrivate: r.repository.isPrivate,
      },
      ownerUsername: ownerMap[r.repository.ownerId] || "",
    }));
}

/** Human-readable verb for an activity_feed `action` token. */
export function describeAction(action: string): string {
  switch (action) {
    case "push":
      return "pushed to";
    case "issue_open":
      return "opened an issue in";
    case "issue_close":
      return "closed an issue in";
    case "pr_open":
      return "opened a pull request in";
    case "pr_merge":
      return "merged a pull request in";
    case "pr_close":
      return "closed a pull request in";
    case "star":
      return "starred";
    case "comment":
      return "commented in";
    default:
      return action.replace(/_/g, " ");
  }
}

/** Resolve a username → user ID or null. */
export async function resolveUserByName(
  username: string
): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return row ?? null;
}

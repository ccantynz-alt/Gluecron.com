/**
 * Block E7 — Protected tags helpers.
 *
 * Owners can mark tag patterns (e.g. `v*`, `release-*`) as protected so that
 * only owners can create, update, or delete matching tags. We enforce this
 * inside the git push flow (post-receive + route-level) by calling
 * `isProtectedTag`.
 *
 * Patterns support the same glob syntax as branch protection via `matchGlob`.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { protectedTags, repositories, users } from "../db/schema";
import type { ProtectedTag } from "../db/schema";
import { matchGlob } from "./environments";

/**
 * Return the most specific matching protected-tag pattern for `tagName`.
 * Exact string matches win over globs. Returns null when unprotected.
 */
export async function matchProtectedTag(
  repositoryId: string,
  tagName: string
): Promise<ProtectedTag | null> {
  const name = stripRefsTags(tagName);
  let rows: ProtectedTag[];
  try {
    rows = await db
      .select()
      .from(protectedTags)
      .where(eq(protectedTags.repositoryId, repositoryId));
  } catch {
    return null;
  }
  if (!rows || rows.length === 0) return null;

  const exact = rows.find((r) => stripRefsTags(r.pattern) === name);
  if (exact) return exact;

  const globs = rows
    .filter((r) => r.pattern.includes("*"))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
  for (const rule of globs) {
    if (matchGlob(name, rule.pattern)) return rule;
  }
  return null;
}

export async function isProtectedTag(
  repositoryId: string,
  tagName: string
): Promise<boolean> {
  return (await matchProtectedTag(repositoryId, tagName)) !== null;
}

/**
 * True when the given user is authorised to bypass a protected-tag rule for
 * this repo. Currently that means "is the repo owner". A richer
 * implementation would check org-level tag admins.
 */
export async function canBypassProtectedTag(
  repositoryId: string,
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId) return false;
  try {
    const [row] = await db
      .select({ ownerId: repositories.ownerId })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    return !!row && row.ownerId === userId;
  } catch {
    return false;
  }
}

export async function listProtectedTags(
  repositoryId: string
): Promise<ProtectedTag[]> {
  try {
    return await db
      .select()
      .from(protectedTags)
      .where(eq(protectedTags.repositoryId, repositoryId));
  } catch {
    return [];
  }
}

export async function addProtectedTag(args: {
  repositoryId: string;
  pattern: string;
  createdBy?: string | null;
}): Promise<ProtectedTag | null> {
  try {
    const [row] = await db
      .insert(protectedTags)
      .values({
        repositoryId: args.repositoryId,
        pattern: args.pattern,
        createdBy: args.createdBy || null,
      })
      .returning();
    return row || null;
  } catch (err) {
    console.error("[protected-tags] add:", err);
    return null;
  }
}

export async function removeProtectedTag(
  repositoryId: string,
  id: string
): Promise<boolean> {
  try {
    const res = await db
      .delete(protectedTags)
      .where(
        and(
          eq(protectedTags.id, id),
          eq(protectedTags.repositoryId, repositoryId)
        )
      )
      .returning({ id: protectedTags.id });
    return res.length > 0;
  } catch {
    return false;
  }
}

function stripRefsTags(s: string): string {
  return s.startsWith("refs/tags/") ? s.slice("refs/tags/".length) : s;
}

/**
 * Resolve a username → user id. Used by enforcement points that only have
 * the pusher's username (e.g. the git smart-HTTP route).
 */
export async function userIdFromUsername(
  username: string | null | undefined
): Promise<string | null> {
  if (!username) return null;
  try {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return u?.id || null;
  } catch {
    return null;
  }
}

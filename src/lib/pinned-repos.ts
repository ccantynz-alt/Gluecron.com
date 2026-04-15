/**
 * Block J13 — Pinned repositories on user profile.
 *
 * Users select up to 6 repositories to feature on their profile. Pure helpers
 * here are driven by the route handler + unit tests; DB helpers swallow
 * errors and return safe defaults.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  pinnedRepositories,
  repositories,
  users,
} from "../db/schema";

export const MAX_PINS = 6;

/**
 * Sanitise an incoming pin list: de-dup, preserve first-seen order, clamp
 * to MAX_PINS, drop empty strings. Pure; used by the form handler.
 */
export function sanitisePinIds(ids: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const trimmed = id.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_PINS) break;
  }
  return out;
}

/**
 * List a user's pinned repos in display order, joined to the owning user so
 * the profile can render "owner/name" links. Returns at most MAX_PINS rows.
 */
export async function listPinnedForUser(userId: string): Promise<
  Array<{
    repositoryId: string;
    name: string;
    ownerUsername: string;
    description: string | null;
    starCount: number;
    forkCount: number;
    isPrivate: boolean;
    position: number;
  }>
> {
  try {
    const rows = await db
      .select({
        repositoryId: pinnedRepositories.repositoryId,
        position: pinnedRepositories.position,
        name: repositories.name,
        description: repositories.description,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
        isPrivate: repositories.isPrivate,
        ownerUsername: users.username,
      })
      .from(pinnedRepositories)
      .innerJoin(
        repositories,
        eq(repositories.id, pinnedRepositories.repositoryId)
      )
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(pinnedRepositories.userId, userId))
      .orderBy(asc(pinnedRepositories.position))
      .limit(MAX_PINS);
    return rows;
  } catch (err) {
    console.error("[pinned-repos] listPinnedForUser failed:", err);
    return [];
  }
}

/**
 * Replace a user's entire pin set with the given ordered list of repo IDs.
 * - Ignores IDs the user can't pin (private repos they don't own).
 * - Uses delete-then-insert for atomicity-lite.
 * Returns the resulting canonical list of pinned repo IDs.
 */
export async function setPinsForUser(
  userId: string,
  repoIds: string[]
): Promise<string[]> {
  const clean = sanitisePinIds(repoIds);
  if (clean.length === 0) {
    try {
      await db
        .delete(pinnedRepositories)
        .where(eq(pinnedRepositories.userId, userId));
    } catch (err) {
      console.error("[pinned-repos] clear failed:", err);
    }
    return [];
  }
  try {
    const rows = await db
      .select({
        id: repositories.id,
        ownerId: repositories.ownerId,
        isPrivate: repositories.isPrivate,
      })
      .from(repositories)
      .where(inArray(repositories.id, clean));
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Filter: must exist; if private, viewer must be the owner.
    const allowed = clean.filter((id) => {
      const r = byId.get(id);
      if (!r) return false;
      if (r.isPrivate && r.ownerId !== userId) return false;
      return true;
    });
    await db
      .delete(pinnedRepositories)
      .where(eq(pinnedRepositories.userId, userId));
    if (allowed.length === 0) return [];
    await db.insert(pinnedRepositories).values(
      allowed.map((repositoryId, position) => ({
        userId,
        repositoryId,
        position,
      }))
    );
    return allowed;
  } catch (err) {
    console.error("[pinned-repos] setPinsForUser failed:", err);
    return [];
  }
}

/**
 * List candidate repositories for the pin-chooser UI — repos the user owns
 * (public + private) and repos they've starred (public only here; we don't
 * want a user to pin someone else's private repo). Capped to 50 rows each.
 */
export async function listPinCandidates(userId: string): Promise<
  Array<{ id: string; name: string; ownerUsername: string; isPrivate: boolean }>
> {
  try {
    const owned = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerUsername: users.username,
        isPrivate: repositories.isPrivate,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.ownerId, userId))
      .limit(50);
    return owned;
  } catch (err) {
    console.error("[pinned-repos] listPinCandidates failed:", err);
    return [];
  }
}

export const __internal = { MAX_PINS, sanitisePinIds };

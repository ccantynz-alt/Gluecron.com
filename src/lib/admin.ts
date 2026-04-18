/**
 * Block F3 — Site admin helpers.
 *
 * A site admin is a user with a row in `site_admins`. If the table is empty,
 * the very first registered user is the bootstrap admin. This mirrors how
 * many self-hosted apps handle the first-install case without requiring
 * `env`-based provisioning.
 *
 * Writes to system flags go through `setFlag` which records the writer.
 */

import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { siteAdmins, systemFlags, users } from "../db/schema";

/**
 * Is this user a site admin? Returns true if any of:
 *  - they have a row in `site_admins`, OR
 *  - no rows exist in `site_admins` and they are the oldest-created user
 *    (bootstrap rule).
 */
export async function isSiteAdmin(
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId) return false;
  try {
    const [row] = await db
      .select({ userId: siteAdmins.userId })
      .from(siteAdmins)
      .where(eq(siteAdmins.userId, userId))
      .limit(1);
    if (row) return true;
    // Bootstrap: empty site_admins → oldest user is admin.
    const [anyAdmin] = await db.select().from(siteAdmins).limit(1);
    if (anyAdmin) return false;
    const [first] = await db
      .select({ id: users.id })
      .from(users)
      .orderBy(asc(users.createdAt))
      .limit(1);
    return !!first && first.id === userId;
  } catch {
    return false;
  }
}

export async function listSiteAdmins() {
  try {
    return await db
      .select({
        userId: siteAdmins.userId,
        username: users.username,
        grantedAt: siteAdmins.grantedAt,
        grantedBy: siteAdmins.grantedBy,
      })
      .from(siteAdmins)
      .innerJoin(users, eq(siteAdmins.userId, users.id));
  } catch {
    return [];
  }
}

export async function grantSiteAdmin(
  userId: string,
  grantedBy: string | null
): Promise<boolean> {
  try {
    await db
      .insert(siteAdmins)
      .values({ userId, grantedBy: grantedBy || null })
      .onConflictDoNothing();
    return true;
  } catch {
    return false;
  }
}

export async function revokeSiteAdmin(userId: string): Promise<boolean> {
  try {
    const res = await db
      .delete(siteAdmins)
      .where(eq(siteAdmins.userId, userId))
      .returning({ userId: siteAdmins.userId });
    return res.length > 0;
  } catch {
    return false;
  }
}

export async function getFlag(key: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ value: systemFlags.value })
      .from(systemFlags)
      .where(eq(systemFlags.key, key))
      .limit(1);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setFlag(
  key: string,
  value: string,
  updatedBy: string | null
): Promise<boolean> {
  try {
    await db
      .insert(systemFlags)
      .values({ key, value, updatedBy: updatedBy || null })
      .onConflictDoUpdate({
        target: systemFlags.key,
        set: { value, updatedBy: updatedBy || null, updatedAt: new Date() },
      });
    return true;
  } catch (err) {
    console.error("[admin] setFlag:", err);
    return false;
  }
}

export async function listFlags() {
  try {
    return await db.select().from(systemFlags);
  } catch {
    return [];
  }
}

/** Known flag keys with defaults (used by callers + UI rendering). */
export const KNOWN_FLAGS = {
  registration_locked: "0", // "1" to block new sign-ups
  site_banner_text: "", // non-empty → show a banner at the top
  site_banner_level: "info", // info | warn | error
  read_only_mode: "0",
} as const;

export type FlagKey = keyof typeof KNOWN_FLAGS;

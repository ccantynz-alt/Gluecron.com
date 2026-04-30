/**
 * Site-admin bootstrap from env. On every boot we check whether
 * `SITE_ADMIN_USERNAME` is set and, if so, ensure that user has a row in
 * `site_admins`. Idempotent — re-running is a cheap no-op once granted.
 *
 * The user must already exist in `users` for the grant to apply. If they
 * haven't registered yet, the function logs and returns; the next boot
 * (or the register flow, which calls `ensureEnvAdminOnRegister()`) will
 * pick them up.
 *
 * This complements the bootstrap rule in `isSiteAdmin()` (oldest user is
 * implicit admin while site_admins is empty). The env-based grant makes
 * it deterministic across re-deploys and team handoffs.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { siteAdmins, users } from "../db/schema";
import { grantSiteAdmin } from "./admin";

/** Read SITE_ADMIN_USERNAME (lower-cased to match users.username). Returns
 *  null if unset or empty. */
export function getEnvAdminUsername(): string | null {
  const raw = process.env.SITE_ADMIN_USERNAME?.trim();
  if (!raw) return null;
  return raw.toLowerCase();
}

/** Ensure the env-named user is a site admin. Safe to call every boot. */
export async function ensureEnvSiteAdmin(): Promise<void> {
  const username = getEnvAdminUsername();
  if (!username) return;
  try {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!user) {
      console.log(
        `[admin-bootstrap] SITE_ADMIN_USERNAME=${username} but no such user yet — will retry next boot or on register`
      );
      return;
    }
    const [existing] = await db
      .select({ userId: siteAdmins.userId })
      .from(siteAdmins)
      .where(eq(siteAdmins.userId, user.id))
      .limit(1);
    if (existing) {
      console.log(`[admin-bootstrap] ${username} already has admin`);
      return;
    }
    const granted = await grantSiteAdmin(user.id, null);
    if (granted) {
      console.log(`[admin-bootstrap] granted site admin to ${username}`);
    } else {
      console.warn(`[admin-bootstrap] failed to grant admin to ${username}`);
    }
  } catch (err) {
    console.error("[admin-bootstrap] error:", err);
  }
}

/** Hook for the registration flow — if the just-registered user matches
 *  SITE_ADMIN_USERNAME, grant admin immediately so they don't have to
 *  wait for the next boot. */
export async function ensureEnvAdminOnRegister(args: {
  userId: string;
  username: string;
}): Promise<void> {
  const target = getEnvAdminUsername();
  if (!target) return;
  if (args.username.toLowerCase() !== target) return;
  await grantSiteAdmin(args.userId, null);
  console.log(
    `[admin-bootstrap] auto-granted admin to ${args.username} on register`
  );
}

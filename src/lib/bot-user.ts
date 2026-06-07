/**
 * Bot-user helper — resolves the UUID for the synthetic `gluecron[bot]`
 * account so autopilot / AI-review actions are credited to it rather than
 * to the PR / issue author.
 *
 * The row is seeded by drizzle/0078_bot_user.sql.  If the migration has not
 * run yet (e.g. a freshly-cloned dev environment) the helper returns `null`
 * and callers must fall back to a real user id — the same behaviour as before
 * this feature shipped.
 *
 * The result is module-level cached so every autopilot tick after the first
 * one pays zero DB overhead.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

export const BOT_USERNAME = "gluecron[bot]";

let _botUserId: string | null | undefined = undefined; // undefined = not yet fetched

/**
 * Lazily resolve and cache the `gluecron[bot]` user's UUID.
 *
 * Returns `null` when the row does not exist (migration not yet applied).
 * Callers should fall back to `authorId` from the related PR/issue.
 */
export async function getBotUserId(): Promise<string | null> {
  if (_botUserId !== undefined) return _botUserId;
  try {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, BOT_USERNAME))
      .limit(1);
    _botUserId = row?.id ?? null;
  } catch {
    // DB unavailable — leave undefined so next call retries.
    return null;
  }
  return _botUserId;
}

/**
 * Resolve the bot user ID, falling back to `fallbackId` if the bot row
 * does not exist yet.  The fallback keeps every call site backward-
 * compatible with pre-migration environments.
 */
export async function getBotUserIdOrFallback(
  fallbackId: string
): Promise<string> {
  const botId = await getBotUserId();
  return botId ?? fallbackId;
}

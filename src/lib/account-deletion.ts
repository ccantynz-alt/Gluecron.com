/**
 * Block P5 — Account deletion with a 30-day grace period.
 *
 * The privacy policy (src/routes/legal/privacy.tsx §5) promises:
 *   "Account data: retained while your account is active and for thirty
 *   (30) days after account deletion, after which we intend to purge it."
 *
 * Flow:
 *   1. User clicks "Delete my account" in /settings.
 *      → `scheduleAccountDeletion()` marks `users.deleted_at = now()`,
 *        `users.deletion_scheduled_for = now() + 30 days`, deletes all
 *        sessions, audits `account.deletion.scheduled`, sends a
 *        confirmation email.
 *   2. During the grace period the user can sign back in. The /login
 *      handler calls `cancelAccountDeletion()` which clears both columns,
 *      audits, and sends a "welcome back" email.
 *   3. The autopilot `account-purge` task hard-deletes any rows whose
 *      `deletion_scheduled_for` is in the past. Capped at 50 users per
 *      tick. Per-user errors are logged + skipped — never thrown — so a
 *      single FK violation can't stall the queue.
 *
 * Nothing here throws. All DB / email failures are logged and swallowed.
 */

import { eq, lt } from "drizzle-orm";
import { db } from "../db";
import { sessions, users } from "../db/schema";
import { sendEmail, absoluteUrl } from "./email";
import { audit } from "./notify";

/** Grace period before a scheduled deletion becomes a hard purge. */
export const GRACE_PERIOD_DAYS = 30;
/** Default per-tick cap for `purgeScheduledAccounts`. */
export const DEFAULT_PURGE_CAP = 50;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function scheduleAccountDeletion(
  userId: string,
  opts: { now?: Date } = {}
): Promise<{ ok: boolean; scheduledFor: Date }> {
  const now = opts.now ?? new Date();
  const scheduledFor = new Date(now.getTime() + GRACE_PERIOD_DAYS * MS_PER_DAY);

  let user: { id: string; username: string; email: string } | null = null;
  try {
    const rows = await db
      .update(users)
      .set({
        deletedAt: now,
        deletionScheduledFor: scheduledFor,
        updatedAt: now,
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        username: users.username,
        email: users.email,
      });
    user = rows[0] ?? null;
  } catch (err) {
    console.error("[account-deletion] schedule update failed:", err);
    return { ok: false, scheduledFor };
  }

  if (!user) return { ok: false, scheduledFor };

  try {
    await db.delete(sessions).where(eq(sessions.userId, userId));
  } catch (err) {
    console.error("[account-deletion] session purge failed:", err);
  }

  await audit({
    userId,
    action: "account.deletion.scheduled",
    targetType: "user",
    targetId: userId,
    metadata: { scheduledFor: scheduledFor.toISOString() },
  });

  const tpl = renderScheduledEmail({ username: user.username, scheduledFor });
  await sendEmail({ to: user.email, subject: tpl.subject, text: tpl.text });

  return { ok: true, scheduledFor };
}

export async function cancelAccountDeletion(
  userId: string
): Promise<{ ok: boolean }> {
  let user: { id: string; username: string; email: string } | null = null;
  try {
    const rows = await db
      .update(users)
      .set({
        deletedAt: null,
        deletionScheduledFor: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        username: users.username,
        email: users.email,
      });
    user = rows[0] ?? null;
  } catch (err) {
    console.error("[account-deletion] cancel update failed:", err);
    return { ok: false };
  }

  if (!user) return { ok: false };

  await audit({
    userId,
    action: "account.deletion.cancelled",
    targetType: "user",
    targetId: userId,
  });

  const tpl = renderRestoredEmail({ username: user.username });
  await sendEmail({ to: user.email, subject: tpl.subject, text: tpl.text });

  return { ok: true };
}

export async function purgeScheduledAccounts(
  opts: { now?: Date; cap?: number } = {}
): Promise<{ purged: number; errors: number }> {
  const now = opts.now ?? new Date();
  const cap = Math.max(1, opts.cap ?? DEFAULT_PURGE_CAP);

  let candidates: Array<{ id: string; username: string; email: string }> = [];
  try {
    candidates = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
      })
      .from(users)
      .where(lt(users.deletionScheduledFor, now))
      .limit(cap);
  } catch (err) {
    console.error("[account-deletion] purge candidate query failed:", err);
    return { purged: 0, errors: 1 };
  }

  let purged = 0;
  let errors = 0;
  for (const c of candidates) {
    try {
      const deleted = await db
        .delete(users)
        .where(eq(users.id, c.id))
        .returning({ id: users.id });
      if (deleted.length > 0) {
        purged += 1;
        await audit({
          userId: null,
          action: "account.purged",
          targetType: "user",
          targetId: c.id,
          metadata: { username: c.username },
        });
      }
    } catch (err) {
      errors += 1;
      console.error(
        `[account-deletion] purge failed for user=${c.id} (${c.username}):`,
        err
      );
    }
  }

  return { purged, errors };
}

export function daysUntilPurge(
  user: { deletionScheduledFor: Date | null },
  now: Date = new Date()
): number | null {
  if (!user.deletionScheduledFor) return null;
  const ms = user.deletionScheduledFor.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / MS_PER_DAY);
}

export function renderScheduledEmail(input: {
  username: string;
  scheduledFor: Date;
}): { subject: string; text: string } {
  const when = input.scheduledFor.toUTCString();
  const subject = "Your Gluecron account is scheduled for deletion";
  const text = [
    `Hi ${input.username},`,
    "",
    `Your Gluecron account will be permanently deleted on ${when}.`,
    "",
    "All of your repos, issues, PRs, and settings will be purged after that",
    "date. If you change your mind, just sign in any time before then and we",
    "will cancel the deletion automatically.",
    "",
    `Cancel deletion: ${absoluteUrl("/login")}`,
    "",
    "— gluecron",
  ].join("\n");
  return { subject, text };
}

export function renderRestoredEmail(input: { username: string }): {
  subject: string;
  text: string;
} {
  const subject = "Welcome back — your Gluecron account has been restored";
  const text = [
    `${input.username},`,
    "",
    "Your account is no longer scheduled for deletion. Everything's right",
    "where you left it.",
    "",
    `Visit your dashboard: ${absoluteUrl("/dashboard")}`,
    "",
    "— gluecron",
  ].join("\n");
  return { subject, text };
}

export const __test = {
  GRACE_PERIOD_DAYS,
  DEFAULT_PURGE_CAP,
  MS_PER_DAY,
};

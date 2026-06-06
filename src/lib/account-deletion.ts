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
 * Cascade executed by `purgeScheduledAccounts` for each user:
 *   - Cancel any active Stripe subscription (if STRIPE_SECRET_KEY is set).
 *   - Delete bare git repo directories from disk (GIT_REPOS_PATH/<username>/).
 *   - Hard-delete the `users` row; FK ON DELETE CASCADE handles:
 *       sessions, ssh_keys, api_tokens, notifications, stars, reactions,
 *       ai_chats, push_subscriptions, oauth_access_tokens, gists, etc.
 *   - audit_log.user_id is already set to ON DELETE SET NULL at the DB level,
 *     so audit rows are automatically anonymised when the user row is removed.
 *
 * Nothing here throws. All DB / email failures are logged and swallowed.
 */

import { eq, lt } from "drizzle-orm";
import { rm } from "fs/promises";
import { join } from "path";
import { db } from "../db";
import { repositories, sessions, userQuotas, users } from "../db/schema";
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

/**
 * Cancel a Stripe subscription at period end for GDPR purge.
 * Silently swallows all errors — a Stripe outage must never block deletion.
 */
async function cancelStripeSubscription(subscriptionId: string): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.length < 10) return;
  try {
    await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
  } catch (err) {
    console.error(`[account-deletion] stripe cancel failed for sub=${subscriptionId}:`, err);
  }
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
      // 1. Cancel any active Stripe subscription before removing the user row.
      try {
        const quotaRows = await db
          .select({ stripeSubscriptionId: userQuotas.stripeSubscriptionId })
          .from(userQuotas)
          .where(eq(userQuotas.userId, c.id))
          .limit(1);
        const subId = quotaRows[0]?.stripeSubscriptionId;
        if (subId) {
          await cancelStripeSubscription(subId);
        }
      } catch (err) {
        console.error(`[account-deletion] quota lookup failed for user=${c.id}:`, err);
      }

      // 2. Delete bare git repo directories from disk (GIT_REPOS_PATH/<username>/).
      //    We collect all repo diskPaths owned by this user and remove each one.
      try {
        const repoRows = await db
          .select({ diskPath: repositories.diskPath })
          .from(repositories)
          .where(eq(repositories.ownerId, c.id));
        for (const r of repoRows) {
          const absPath = r.diskPath.startsWith("/")
            ? r.diskPath
            : join(process.env.GIT_REPOS_PATH || "./repos", r.diskPath);
          await rm(absPath, { recursive: true, force: true });
        }
        // Also remove the per-user directory if it exists (may be empty or already gone).
        const userDir = join(process.env.GIT_REPOS_PATH || "./repos", c.username);
        await rm(userDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`[account-deletion] disk cleanup failed for user=${c.id}:`, err);
      }

      // 3. Hard-delete the users row.
      //    FK ON DELETE CASCADE handles: sessions, ssh_keys, api_tokens,
      //    notifications, stars, reactions, ai_chats, push_subscriptions,
      //    oauth_access_tokens, gists, user_quotas, user_totp, user_passkeys, etc.
      //    FK ON DELETE SET NULL handles: audit_log.user_id (anonymises entries).
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

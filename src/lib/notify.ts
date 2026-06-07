/**
 * Notifications + audit log helpers.
 * Swallows DB failures so notifications never break the primary request path.
 *
 * Email fan-out (Block A8):
 *   For certain kinds (mention / assigned / gate_failed / review_requested)
 *   we ALSO send an email, if the recipient has opted in via their profile
 *   preferences. Email failures are logged and swallowed.
 */

import { inArray, eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { notifications as notificationsMain, auditLog, users } from "../db/schema";
import { notifications as notificationsExt } from "../db/schema-extensions";
import { sendEmail, absoluteUrl } from "./email";

// ─── Public helpers (schema-extensions notifications table) ─────────────────
// These operate on the schema-extensions `notifications` table (which has
// `type`, `isRead`, `actorId` columns) — the same table the inbox page uses.

/** Create a single in-app notification. Fire-and-forget safe: swallows errors. */
export async function createNotification(params: {
  userId: string;
  type: string;
  title: string;
  body?: string;
  url?: string;
  repoId?: string;
}): Promise<void> {
  try {
    await db.insert(notificationsExt).values({
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body,
      url: params.url,
      repositoryId: params.repoId,
    });
  } catch (err) {
    console.error("[createNotification] failed:", err);
  }
}

/** Return the count of unread notifications for a user. Returns 0 on error. */
export async function getUnreadCount(userId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notificationsExt)
      .where(and(eq(notificationsExt.userId, userId), eq(notificationsExt.isRead, false)));
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

/** Return notifications for a user (most recent first). Returns [] on error. */
export async function getNotifications(
  userId: string,
  limit = 50
): Promise<typeof notificationsExt.$inferSelect[]> {
  try {
    return await db
      .select()
      .from(notificationsExt)
      .where(eq(notificationsExt.userId, userId))
      .orderBy(desc(notificationsExt.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/** Mark a single notification as read (only if it belongs to userId). */
export async function markRead(notificationId: string, userId: string): Promise<void> {
  try {
    await db
      .update(notificationsExt)
      .set({ isRead: true })
      .where(and(eq(notificationsExt.id, notificationId), eq(notificationsExt.userId, userId)));
  } catch (err) {
    console.error("[markRead] failed:", err);
  }
}

/** Mark all of a user's notifications as read. */
export async function markAllRead(userId: string): Promise<void> {
  try {
    await db
      .update(notificationsExt)
      .set({ isRead: true })
      .where(and(eq(notificationsExt.userId, userId), eq(notificationsExt.isRead, false)));
  } catch (err) {
    console.error("[markAllRead] failed:", err);
  }
}

export type NotificationKind =
  | "mention"
  | "review_requested"
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "issue_opened"
  | "issue_closed"
  | "assigned"
  | "ai_review"
  | "gate_failed"
  | "gate_repaired"
  | "gate_passed"
  | "security_alert"
  | "deploy_success"
  | "deploy_failed"
  | "deployment_approval"
  | "release_published"
  | "repo_archived"
  | "pr_stale"
  | "issue_stale";

/** Kinds that can trigger email delivery. Keep this list conservative — any
 *  kind here must map to a user preference column on the users table. */
const EMAIL_ELIGIBLE: ReadonlySet<NotificationKind> = new Set([
  "mention",
  "review_requested",
  "assigned",
  "gate_failed",
]);

/** Map notification kind → user preference column name. */
function prefFor(kind: NotificationKind):
  | "notifyEmailOnMention"
  | "notifyEmailOnAssign"
  | "notifyEmailOnGateFail"
  | null {
  switch (kind) {
    case "mention":
    case "review_requested":
      return "notifyEmailOnMention";
    case "assigned":
      return "notifyEmailOnAssign";
    case "gate_failed":
      return "notifyEmailOnGateFail";
    default:
      return null;
  }
}

function subjectFor(kind: NotificationKind, title: string): string {
  const tag =
    kind === "gate_failed"
      ? "[gate failed]"
      : kind === "assigned"
      ? "[assigned]"
      : kind === "review_requested"
      ? "[review requested]"
      : kind === "mention"
      ? "[mention]"
      : `[${kind}]`;
  return `${tag} ${title}`.slice(0, 180);
}

function bodyFor(title: string, body: string | undefined, url: string | undefined): string {
  const lines = [title];
  if (body) lines.push("", body);
  if (url) lines.push("", absoluteUrl(url));
  lines.push("", "—", "You can opt out of these emails at /settings.");
  return lines.join("\n");
}

async function maybeEmail(
  userIds: string[],
  kind: NotificationKind,
  opts: { title: string; body?: string; url?: string }
): Promise<void> {
  if (!EMAIL_ELIGIBLE.has(kind)) return;
  const prefCol = prefFor(kind);
  if (!prefCol) return;
  if (userIds.length === 0) return;

  let recipients: Array<{ email: string; pref: boolean }> = [];
  try {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        mention: users.notifyEmailOnMention,
        assign: users.notifyEmailOnAssign,
        gate: users.notifyEmailOnGateFail,
      })
      .from(users)
      .where(inArray(users.id, userIds));
    recipients = rows.map((r) => ({
      email: r.email,
      pref:
        prefCol === "notifyEmailOnMention"
          ? r.mention
          : prefCol === "notifyEmailOnAssign"
          ? r.assign
          : r.gate,
    }));
  } catch (err) {
    console.error("[notify] email recipient lookup failed:", err);
    return;
  }

  const subject = subjectFor(kind, opts.title);
  const text = bodyFor(opts.title, opts.body, opts.url);

  // Fire in parallel; each call swallows its own errors.
  await Promise.all(
    recipients
      .filter((r) => r.pref && r.email)
      .map((r) =>
        sendEmail({ to: r.email, subject, text }).catch((err) => {
          console.error("[notify] sendEmail threw:", err);
          return { ok: false as const, provider: "none" as const };
        })
      )
  );
}

export async function notify(
  userId: string,
  opts: {
    kind: NotificationKind;
    title: string;
    body?: string;
    url?: string;
    repositoryId?: string;
  }
): Promise<void> {
  try {
    await db.insert(notificationsMain).values({
      userId,
      kind: opts.kind,
      title: opts.title,
      body: opts.body,
      url: opts.url,
      repositoryId: opts.repositoryId,
    });
  } catch (err) {
    console.error("[notify] failed:", err);
  }
  await maybeEmail([userId], opts.kind, opts);
}

export async function notifyMany(
  userIds: string[],
  opts: {
    kind: NotificationKind;
    title: string;
    body?: string;
    url?: string;
    repositoryId?: string;
  }
): Promise<void> {
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return;
  try {
    await db.insert(notificationsMain).values(
      unique.map((userId) => ({
        userId,
        kind: opts.kind,
        title: opts.title,
        body: opts.body,
        url: opts.url,
        repositoryId: opts.repositoryId,
      }))
    );
  } catch (err) {
    console.error("[notify] batch failed:", err);
  }
  await maybeEmail(unique, opts.kind, opts);
}

export async function audit(opts: {
  userId?: string | null;
  repositoryId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId: opts.userId ?? null,
      repositoryId: opts.repositoryId ?? null,
      action: opts.action,
      targetType: opts.targetType,
      targetId: opts.targetId,
      ip: opts.ip,
      userAgent: opts.userAgent,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    });
  } catch (err) {
    // Audit must never break the primary flow
    console.error("[audit] failed:", err);
  }
}

/** Test-only hook so unit tests can assert the kind→pref mapping. */
export const __internal = {
  EMAIL_ELIGIBLE,
  prefFor,
  subjectFor,
  bodyFor,
};

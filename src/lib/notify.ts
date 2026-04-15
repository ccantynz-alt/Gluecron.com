/**
 * Notifications + audit log helpers.
 * Swallows DB failures so notifications never break the primary request path.
 *
 * Email fan-out (Block A8):
 *   For certain kinds (mention / assigned / gate_failed / review_requested)
 *   we ALSO send an email, if the recipient has opted in via their profile
 *   preferences. Email failures are logged and swallowed.
 */

import { inArray, eq } from "drizzle-orm";
import { db } from "../db";
import { notifications, auditLog, users } from "../db/schema";
import { sendEmail, absoluteUrl } from "./email";

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
  | "repo_archived";

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
    await db.insert(notifications).values({
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
    await db.insert(notifications).values(
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

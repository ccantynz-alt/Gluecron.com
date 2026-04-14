/**
 * Notifications + audit log helpers.
 * Swallows DB failures so notifications never break the primary request path.
 */

import { db } from "../db";
import { notifications, auditLog } from "../db/schema";

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
  | "release_published"
  | "repo_archived";

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

/**
 * push-notify.ts — Block M2 addendum.
 *
 * Higher-level push notification helpers for the four developer-facing events:
 *   deploy_success, gate_failed, pr_merged, ai_review
 *
 * This module re-exports the lower-level subscription CRUD from src/lib/push.ts
 * under a clean, event-oriented surface so route handlers and post-receive hooks
 * can call a single function without importing from two places.
 *
 * The Drizzle table definition is declared inline here (schema.ts is locked)
 * and mirrors the table already created by drizzle/0076_push_subscriptions.sql.
 * Both definitions share the same underlying table name so the DB only sees one
 * physical table.
 *
 * VAPID is handled transparently by push.ts (env-first, process-cached fallback).
 * No `web-push` npm package is required — the implementation uses pure Web Crypto
 * (RFC 8291 / RFC 8188 / RFC 8292) via Bun's built-in crypto.subtle.
 */

import { eq } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { db } from "../db";
import {
  subscribeUser as _subscribeUser,
  unsubscribeUser as _unsubscribeUser,
  sendPushToUser,
} from "./push";

// ---------------------------------------------------------------------------
// Inline table definition (mirrors schema.ts — locked)
// ---------------------------------------------------------------------------

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [
    uniqueIndex("push_subs_endpoint_uq").on(t.endpoint),
    index("push_subs_user_idx").on(t.userId),
  ]
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
};

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Persist a push subscription for a user.  Safe to call repeatedly — the
 * underlying insert uses ON CONFLICT DO UPDATE so keys are refreshed on
 * browser-side rotation.
 */
export async function savePushSubscription(
  userId: string,
  subscription: PushSubscriptionInput,
  userAgent?: string
): Promise<void> {
  return _subscribeUser(userId, subscription, userAgent);
}

/**
 * Remove a push subscription by endpoint.  No-ops gracefully when the
 * endpoint is not found.
 */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  try {
    await db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
  } catch (err) {
    console.error("[push-notify] deletePushSubscription failed:", err);
  }
}

/**
 * List all push subscriptions for a user, newest first.
 */
export async function listPushSubscriptions(
  userId: string
): Promise<PushSubscriptionRow[]> {
  try {
    return await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(pushSubscriptions.createdAt);
  } catch (err) {
    console.error("[push-notify] listPushSubscriptions failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// High-level fan-out
// ---------------------------------------------------------------------------

/**
 * Send a push notification to every subscription owned by a user.
 * Stale endpoints (HTTP 410/404) are cleaned up automatically by the
 * underlying sendPushToUser transport layer.
 *
 * Returns { sent, failed } counts; never throws.
 */
export async function sendPushNotification(
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  return sendPushToUser(userId, {
    title: payload.title,
    body: payload.body,
    url: payload.url,
  });
}

// ---------------------------------------------------------------------------
// Typed event helpers — thin wrappers for the four tracked developer events
// ---------------------------------------------------------------------------

/** Notify a developer that their push deployed successfully. */
export async function notifyDeploySuccess(
  userId: string,
  opts: { repoFullName: string; sha: string; url?: string }
): Promise<{ sent: number; failed: number }> {
  return sendPushNotification(userId, {
    title: "Deploy succeeded",
    body: `${opts.repoFullName} @ ${opts.sha.slice(0, 7)} is live.`,
    url: opts.url,
  });
}

/** Notify a developer that a gate check failed on their push. */
export async function notifyGateFailed(
  userId: string,
  opts: { repoFullName: string; sha: string; gate: string; url?: string }
): Promise<{ sent: number; failed: number }> {
  return sendPushNotification(userId, {
    title: `Gate failed: ${opts.gate}`,
    body: `${opts.repoFullName} @ ${opts.sha.slice(0, 7)}`,
    url: opts.url,
  });
}

/** Notify a developer that their PR was merged. */
export async function notifyPrMerged(
  userId: string,
  opts: { repoFullName: string; prNumber: number; title: string; url?: string }
): Promise<{ sent: number; failed: number }> {
  return sendPushNotification(userId, {
    title: `PR #${opts.prNumber} merged`,
    body: `${opts.repoFullName}: ${opts.title}`,
    url: opts.url,
  });
}

/** Notify a developer that an AI review was posted on their PR. */
export async function notifyAiReview(
  userId: string,
  opts: { repoFullName: string; prNumber: number; url?: string }
): Promise<{ sent: number; failed: number }> {
  return sendPushNotification(userId, {
    title: "AI review posted",
    body: `New AI review on ${opts.repoFullName} PR #${opts.prNumber}`,
    url: opts.url,
  });
}

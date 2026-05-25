/**
 * Outbound chat notifications — pipes PR / issue / AI-review events into
 * Slack, Discord, and Teams via the existing `webhook_deliveries` retry
 * queue (NO parallel queue).
 *
 * How it reuses the existing queue:
 *   - The retry queue (`src/lib/webhook-delivery.ts`) requires a `webhooks`
 *     row to point at. We therefore lazily create one synthetic "shadow"
 *     webhook per (repo, integration) on first use, with
 *     `events='chat-bridge'` so the user-facing /settings/webhooks UI can
 *     filter it out (`routes/webhooks.tsx` already does).
 *   - Subsequent events for the same (repo, integration) reuse the same
 *     shadow row. `enqueueWebhookDelivery` then schedules retries with
 *     the standard exponential backoff (30s → 6h → dead after 6 attempts).
 *
 * Why a shadow row rather than a separate table:
 *   - One source of truth for retries, signatures, and the worker.
 *   - Slack/Discord don't actually consume the `X-Gluecron-Signature`
 *     header, but having it set costs nothing and is harmless.
 *
 * Public API:
 *   - notifyChatChannels(ownerUserId, repositoryId, repoLabel, event)
 *   - Fire-and-forget; errors are swallowed/logged so a notification
 *     outage can never block a PR merge or issue create.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  chatIntegrations,
  webhooks,
  type ChatIntegration,
} from "../db/schema";
import {
  enqueueWebhookDelivery,
  drainPendingDeliveries,
} from "./webhook-delivery";
import { formatOutboundEvent, type ChatKind, type OutboundEvent } from "./chat-bot";

const SHADOW_EVENT = "chat-bridge";

/**
 * Fan out a single event to every enabled chat integration owned by
 * `ownerUserId`. The event is rendered per-kind (Slack blocks vs Discord
 * embeds) and queued via the shared `webhook_deliveries` table.
 *
 * Never throws — failures are logged but swallowed.
 */
export async function notifyChatChannels(opts: {
  ownerUserId: string;
  repositoryId: string;
  event: OutboundEvent;
}): Promise<void> {
  try {
    const integrations = await db
      .select()
      .from(chatIntegrations)
      .where(
        and(
          eq(chatIntegrations.ownerUserId, opts.ownerUserId),
          eq(chatIntegrations.enabled, true)
        )
      );

    if (integrations.length === 0) return;

    let enqueued = 0;
    for (const integ of integrations) {
      if (!integ.webhookUrl) continue;
      const kind = integ.kind as ChatKind;
      if (kind !== "slack" && kind !== "discord" && kind !== "teams") continue;

      const payload = formatOutboundEvent(kind, opts.event);
      const shadowId = await ensureShadowWebhook(
        opts.repositoryId,
        integ
      );
      if (!shadowId) continue;

      const id = await enqueueWebhookDelivery({
        webhookId: shadowId,
        secret: integ.signingSecret,
        event: opts.event.event,
        payload,
      });
      if (id) {
        enqueued++;
        // Touch last_used_at — best-effort.
        db.update(chatIntegrations)
          .set({ lastUsedAt: new Date() })
          .where(eq(chatIntegrations.id, integ.id))
          .catch(() => {});
      }
    }

    if (enqueued > 0) {
      void drainPendingDeliveries().catch((err) => {
        console.error("[chat-notifier] kick drain failed:", err);
      });
    }
  } catch (err) {
    console.error("[chat-notifier] notify failed:", err);
  }
}

/**
 * Find-or-create the synthetic webhook row that pipes events for a given
 * (repo, integration) pair through the retry queue. Returns the row id, or
 * null on insert failure.
 *
 * We key on URL+repository — if a user re-installs the bot with the same
 * webhook URL the existing shadow row is reused so retry stats don't reset.
 */
async function ensureShadowWebhook(
  repositoryId: string,
  integ: ChatIntegration
): Promise<string | null> {
  if (!integ.webhookUrl) return null;
  try {
    const existing = await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.repositoryId, repositoryId),
          eq(webhooks.url, integ.webhookUrl),
          eq(webhooks.events, SHADOW_EVENT)
        )
      )
      .limit(1);
    if (existing[0]) return existing[0].id;

    const [row] = await db
      .insert(webhooks)
      .values({
        repositoryId,
        url: integ.webhookUrl,
        secret: integ.signingSecret,
        events: SHADOW_EVENT,
        isActive: true,
      })
      .returning({ id: webhooks.id });
    return row?.id ?? null;
  } catch (err) {
    console.error("[chat-notifier] ensure shadow webhook failed:", err);
    return null;
  }
}

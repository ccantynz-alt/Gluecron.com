/**
 * Minimal Stripe webhook endpoint — verifies signature + returns 200.
 *
 * v1 scope: authentic, logged, ignored. Full handling (auto-assign plan
 * on subscription.created, downgrade on subscription.deleted, grace
 * period on invoice.payment_failed) ships in the Stripe integration
 * sprint. This stub exists so the Stripe dashboard's "Send test webhook"
 * succeeds (returns 200) and so live webhook deliveries during the gap
 * don't fail-retry-fail forever.
 *
 * Signature verification follows Stripe's documented scheme:
 *   Header: Stripe-Signature: t=<ts>,v1=<hmac>
 *   Signed payload: <ts> . <raw body>
 *   HMAC: SHA-256 with STRIPE_WEBHOOK_SECRET as key
 *
 * We use the Web Crypto API (available in Bun + workers) — no Node
 * crypto, no @stripe/sdk dependency.
 */

import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { userQuotas } from "../db/schema";
import { reportError } from "../lib/observability";
import { getSubscription, planSlugFromSubscription } from "../lib/stripe";

const stripeWebhook = new Hono();

const TOLERANCE_SECONDS = 300; // 5 minutes — matches Stripe's own default

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseSigHeader(header: string): { t?: string; v1?: string } {
  const out: { t?: string; v1?: string } = {};
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") out.t = v;
    else if (k === "v1" && !out.v1) out.v1 = v;
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

stripeWebhook.post("/api/webhooks/stripe", async (c) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — returning 503");
    return c.json({ error: "webhook not configured" }, 503);
  }

  const sigHeader = c.req.header("stripe-signature");
  if (!sigHeader) return c.json({ error: "missing stripe-signature header" }, 400);

  const raw = await c.req.text();

  const { t, v1 } = parseSigHeader(sigHeader);
  if (!t || !v1) return c.json({ error: "malformed stripe-signature" }, 400);

  // Replay window check
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return c.json({ error: "bad timestamp" }, 400);
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > TOLERANCE_SECONDS) {
    return c.json({ error: "timestamp outside tolerance window" }, 400);
  }

  // HMAC check
  const expected = await hmacSha256Hex(secret, `${t}.${raw}`);
  if (!constantTimeEqual(expected, v1)) {
    return c.json({ error: "signature mismatch" }, 400);
  }

  let event: { id?: string; type?: string } = {};
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  console.log(
    `[stripe-webhook] authentic event id=${event.id} type=${event.type}`
  );

  // Handle subscription lifecycle. Every handler swallows errors and returns
  // 200 so Stripe doesn't retry-storm on transient DB issues — we log and
  // rely on the next event (Stripe fires subscription.updated periodically).
  try {
    await handleStripeEvent(event as StripeEvent);
  } catch (err) {
    reportError(err as Error, {
      path: "/api/webhooks/stripe",
      stripeEventType: (event as StripeEvent).type,
      stripeEventId: (event as StripeEvent).id,
    });
  }

  return c.json({ received: true });
});

// Defensive error handler local to this route — never leak exception details
// back to Stripe; always prefer 200 for malformed-but-authenticated payloads
// to avoid retry storms.
stripeWebhook.onError((err, c) => {
  reportError(err, { path: c.req.path, scope: "stripe-webhook" });
  return c.json({ error: "internal error" }, 500);
});

// ---------------------------------------------------------------------------
// Event handlers — each is defensive (never throws). Called from the main
// route handler after signature verification.
// ---------------------------------------------------------------------------

type StripeEvent = {
  id: string;
  type: string;
  data?: { object?: Record<string, unknown> };
};

async function handleStripeEvent(event: StripeEvent): Promise<void> {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed": {
      const userId = String(obj.client_reference_id ?? "");
      const customerId = String(obj.customer ?? "");
      const subscriptionId = obj.subscription ? String(obj.subscription) : null;
      if (!userId || !customerId) {
        console.warn(
          `[stripe-webhook] checkout.session.completed missing userId/customerId — skipping`
        );
        return;
      }
      await upsertQuotaRow(userId, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
      });
      // Enrich from the subscription object to set the actual plan slug
      if (subscriptionId) await reconcileSubscription(subscriptionId, userId);
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subId = String(obj.id ?? "");
      if (!subId) return;
      const userId = String(
        (obj.metadata as Record<string, string> | undefined)?.gluecron_user_id ?? ""
      );
      await reconcileSubscription(subId, userId || null);
      return;
    }
    case "customer.subscription.deleted": {
      const customerId = String(obj.customer ?? "");
      if (!customerId) return;
      await db
        .update(userQuotas)
        .set({
          planSlug: "free",
          stripeSubscriptionId: null,
          stripeSubscriptionStatus: "canceled",
          currentPeriodEnd: null,
          updatedAt: new Date(),
        })
        .where(eq(userQuotas.stripeCustomerId, customerId));
      console.log(`[stripe-webhook] downgraded customer=${customerId} to free`);
      return;
    }
    case "invoice.payment_failed": {
      const customerId = String(obj.customer ?? "");
      if (!customerId) return;
      // Mark status — don't downgrade immediately (Stripe retries billing
      // over a grace window; a future subscription.updated with status=
      // past_due/unpaid/canceled will do the actual plan move).
      await db
        .update(userQuotas)
        .set({
          stripeSubscriptionStatus: "past_due",
          updatedAt: new Date(),
        })
        .where(eq(userQuotas.stripeCustomerId, customerId));
      return;
    }
    default:
      // All other events (invoice.payment_succeeded etc.) — accept silently.
      return;
  }
}

async function reconcileSubscription(
  subscriptionId: string,
  fallbackUserId: string | null
): Promise<void> {
  const res = await getSubscription(subscriptionId);
  if (!res.ok) {
    console.warn(
      `[stripe-webhook] getSubscription(${subscriptionId}) failed: ${res.error}`
    );
    return;
  }
  const sub = res.subscription;
  const slug = planSlugFromSubscription(sub);
  const customerId = sub.customer;
  const status = sub.status;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;

  // Prefer locating by customer id (set during checkout.session.completed).
  // Fall back to metadata gluecron_user_id if present.
  const userId =
    (sub.metadata?.gluecron_user_id as string | undefined) ?? fallbackUserId ?? null;

  if (status !== "active" && status !== "trialing") {
    // Non-active subscriptions don't grant a paid plan. We still record
    // their state so the user can see "past_due" in /settings/billing.
    if (customerId) {
      await db
        .update(userQuotas)
        .set({
          stripeSubscriptionId: sub.id,
          stripeSubscriptionStatus: status,
          currentPeriodEnd: periodEnd,
          updatedAt: new Date(),
        })
        .where(eq(userQuotas.stripeCustomerId, customerId));
    }
    return;
  }

  if (!slug) {
    console.warn(
      `[stripe-webhook] subscription ${sub.id} active but no plan slug resolvable — leaving plan unchanged`
    );
    return;
  }

  if (userId) {
    await upsertQuotaRow(userId, {
      planSlug: slug,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      stripeSubscriptionStatus: status,
      currentPeriodEnd: periodEnd,
    });
    console.log(
      `[stripe-webhook] user=${userId} → plan=${slug} (status=${status})`
    );
    return;
  }

  // Last resort: locate by customer id and update in place
  if (customerId) {
    await db
      .update(userQuotas)
      .set({
        planSlug: slug,
        stripeSubscriptionId: sub.id,
        stripeSubscriptionStatus: status,
        currentPeriodEnd: periodEnd,
        updatedAt: new Date(),
      })
      .where(eq(userQuotas.stripeCustomerId, customerId));
  }
}

async function upsertQuotaRow(
  userId: string,
  patch: {
    planSlug?: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionStatus?: string | null;
    currentPeriodEnd?: Date | null;
  }
): Promise<void> {
  // Try update first; if no row exists, insert.
  const res = await db
    .update(userQuotas)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(userQuotas.userId, userId))
    .returning({ userId: userQuotas.userId });
  if (res.length === 0) {
    await db
      .insert(userQuotas)
      .values({
        userId,
        planSlug: patch.planSlug ?? "free",
        stripeCustomerId: patch.stripeCustomerId ?? null,
        stripeSubscriptionId: patch.stripeSubscriptionId ?? null,
        stripeSubscriptionStatus: patch.stripeSubscriptionStatus ?? null,
        currentPeriodEnd: patch.currentPeriodEnd ?? null,
      })
      .onConflictDoUpdate({
        target: userQuotas.userId,
        set: { ...patch, updatedAt: new Date() },
      });
  }
}

export default stripeWebhook;

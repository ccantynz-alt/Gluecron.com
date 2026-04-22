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
import { reportError } from "../lib/observability";

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

  // v1: accept-and-log only. Full handling ships with the billing integration
  // sprint. Stripe retries non-200s — returning 200 here prevents that.
  return c.json({ received: true });
});

// Defensive error handler local to this route — never leak exception details
// back to Stripe; always prefer 200 for malformed-but-authenticated payloads
// to avoid retry storms.
stripeWebhook.onError((err, c) => {
  reportError(err, { path: c.req.path, scope: "stripe-webhook" });
  return c.json({ error: "internal error" }, 500);
});

export default stripeWebhook;

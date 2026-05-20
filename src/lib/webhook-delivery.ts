/**
 * Reliable webhook delivery (migration 0056).
 *
 * Replaces the inline single-shot fetch in src/routes/webhooks.tsx with a
 * durable pending-row queue. `enqueueWebhookDelivery()` precomputes the HMAC
 * signature, inserts one row per (hook, event) into `webhook_deliveries`
 * with `status='pending'` and `next_attempt_at=now()`, then kicks the
 * worker. The worker picks claims rows whose `next_attempt_at <= now()` and
 * attempts each POST.
 *
 * Retry schedule (after attempt #1 fires immediately):
 *   attempt 2 → +30s
 *   attempt 3 → +2m
 *   attempt 4 → +10m
 *   attempt 5 → +1h
 *   attempt 6 → +6h
 *   after attempt 6 → status='dead' (no further retries; row kept for ops)
 *
 * 2xx response → status='succeeded' + succeeded_at + last_status_code.
 * Anything else (including network errors and timeouts) → counted as a
 * failed attempt and rescheduled.
 *
 * Public surface:
 *   - enqueueWebhookDelivery({...})  — fire-and-forget queue insert
 *   - attemptDelivery(deliveryId)    — single attempt (exported for tests)
 *   - drainPendingDeliveries()       — drain a batch (exported for tests)
 *   - startWebhookDeliveryWorker()   — background poll loop
 *   - MAX_ATTEMPTS, BACKOFF_MS       — exported for tests
 */

import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { webhookDeliveries, webhooks } from "../db/schema";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** How many attempts in total before a row goes to status='dead'. */
export const MAX_ATTEMPTS = 6;

/**
 * Backoff schedule, indexed by the *next* attempt number we're scheduling.
 * After attemptCount=N fails, we schedule attempt N+1 at now() + BACKOFF_MS[N].
 * Index 0 is unused (attempt 1 is queued at now() by enqueue, not by retry).
 */
export const BACKOFF_MS: number[] = [
  0, // [0] unused
  30_000, // after attempt 1 fails → +30s for attempt 2
  120_000, // after attempt 2 fails → +2m for attempt 3
  600_000, // after attempt 3 fails → +10m for attempt 4
  3_600_000, // after attempt 4 fails → +1h for attempt 5
  21_600_000, // after attempt 5 fails → +6h for attempt 6
];

/** How often the worker scans for due pending rows. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Cap on rows pulled in a single tick. */
const BATCH_SIZE = 10;

/** Per-delivery HTTP timeout. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Cap on stored last_error string. */
const ERROR_CAP = 2_000;

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Compute the `sha256=<hex>` HMAC signature for a payload. Returns the empty
 * string when the hook has no secret — caller should still POST but skip the
 * `X-Gluecron-Signature` header.
 */
export async function computeSignature(
  secret: string | null,
  payloadJson: string
): Promise<string> {
  if (!secret) return "";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadJson)
  );
  return (
    "sha256=" +
    Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Insert one pending delivery row. Caller passes hook + event + payload; we
 * snapshot the signature now so future schedule-time secret rotation can't
 * silently invalidate in-flight retries. Returns the new row id, or null on
 * insert failure (logged; never throws).
 */
export async function enqueueWebhookDelivery(input: {
  webhookId: string;
  secret: string | null;
  event: string;
  payload: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const payloadJson = JSON.stringify(input.payload);
    const signature = await computeSignature(input.secret, payloadJson);

    const [row] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId: input.webhookId,
        event: input.event,
        payload: payloadJson,
        signature,
        attemptCount: 0,
        nextAttemptAt: new Date(),
        status: "pending",
      })
      .returning({ id: webhookDeliveries.id });

    return row?.id ?? null;
  } catch (err) {
    console.error("[webhook-delivery] enqueue failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

/**
 * Run a single delivery attempt against the given row. Looks up the hook URL
 * fresh (so a deleted hook short-circuits), POSTs, then updates the row to
 * succeeded / pending (with new next_attempt_at) / dead based on the result.
 *
 * Returns 'succeeded' | 'retry' | 'dead' | 'gone' (hook was deleted).
 */
export async function attemptDelivery(
  deliveryId: string
): Promise<"succeeded" | "retry" | "dead" | "gone"> {
  // Pull the delivery row + the hook URL in one shot.
  const rows = await db
    .select({
      delivery: webhookDeliveries,
      url: webhooks.url,
      isActive: webhooks.isActive,
    })
    .from(webhookDeliveries)
    .leftJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);

  const row = rows[0];
  if (!row) return "gone";
  if (!row.url || row.isActive === false) {
    // Hook deleted or disabled between enqueue and attempt — mark dead so
    // we don't keep polling it.
    await db
      .update(webhookDeliveries)
      .set({
        status: "dead",
        lastError: "hook deleted or disabled",
        lastAttemptedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    return "gone";
  }

  const d = row.delivery;
  const attemptNumber = d.attemptCount + 1;

  // Perform the POST.
  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  let success = false;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Gluecron-Event": d.event,
      "X-Gluecron-Delivery": d.id,
    };
    if (d.signature) headers["X-Gluecron-Signature"] = d.signature;

    const res = await fetch(row.url, {
      method: "POST",
      headers,
      body: d.payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    statusCode = res.status;
    success = res.status >= 200 && res.status < 300;
    if (!success) {
      errorMessage = `HTTP ${res.status}`;
    }
  } catch (err) {
    errorMessage =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    if (errorMessage.length > ERROR_CAP) {
      errorMessage = errorMessage.slice(0, ERROR_CAP);
    }
  }

  const now = new Date();

  if (success) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "succeeded",
        attemptCount: attemptNumber,
        lastAttemptedAt: now,
        lastStatusCode: statusCode,
        lastError: null,
        succeededAt: now,
        nextAttemptAt: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    // Best-effort sync of the parent hook row for the legacy "last status"
    // surface in /settings/webhooks. Never throws out.
    try {
      await db
        .update(webhooks)
        .set({ lastDeliveredAt: now, lastStatus: statusCode ?? 0 })
        .where(eq(webhooks.id, d.webhookId));
    } catch {
      /* swallow */
    }

    return "succeeded";
  }

  // Failure path.
  if (attemptNumber >= MAX_ATTEMPTS) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "dead",
        attemptCount: attemptNumber,
        lastAttemptedAt: now,
        lastStatusCode: statusCode,
        lastError: errorMessage,
        nextAttemptAt: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    try {
      await db
        .update(webhooks)
        .set({ lastDeliveredAt: now, lastStatus: statusCode ?? 0 })
        .where(eq(webhooks.id, d.webhookId));
    } catch {
      /* swallow */
    }

    return "dead";
  }

  // Schedule the next attempt.
  const backoff = BACKOFF_MS[attemptNumber] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  const nextAt = new Date(now.getTime() + backoff);

  await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attemptCount: attemptNumber,
      lastAttemptedAt: now,
      lastStatusCode: statusCode,
      lastError: errorMessage,
      nextAttemptAt: nextAt,
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  try {
    await db
      .update(webhooks)
      .set({ lastDeliveredAt: now, lastStatus: statusCode ?? 0 })
      .where(eq(webhooks.id, d.webhookId));
  } catch {
    /* swallow */
  }

  return "retry";
}

// ---------------------------------------------------------------------------
// Drain — claim up to BATCH_SIZE due rows and attempt them.
// ---------------------------------------------------------------------------

/** Claim and attempt up to BATCH_SIZE due rows. Returns count attempted. */
export async function drainPendingDeliveries(): Promise<number> {
  const now = new Date();
  let due: { id: string }[] = [];
  try {
    due = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, "pending"),
          lte(webhookDeliveries.nextAttemptAt, now)
        )
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(BATCH_SIZE);
  } catch (err) {
    console.error("[webhook-delivery] poll failed:", err);
    return 0;
  }

  if (due.length === 0) return 0;

  // Run attempts in parallel — they're IO-bound and target different URLs.
  await Promise.all(
    due.map((row) =>
      attemptDelivery(row.id).catch((err) => {
        console.error(
          `[webhook-delivery] attempt for ${row.id} threw:`,
          err
        );
      })
    )
  );

  return due.length;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

let workerStarted = false;

/**
 * Background poll loop. Idempotent — calling twice is a no-op. Returns a
 * stop function (used in tests; production never stops).
 */
export function startWebhookDeliveryWorker(opts?: {
  intervalMs?: number;
}): () => void {
  if (workerStarted) return () => {};
  workerStarted = true;

  const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let active = false;

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    try {
      // Keep draining while there's work — many due rows can pile up
      // after an outage of the downstream service.
      let n = await drainPendingDeliveries();
      while (n >= BATCH_SIZE && !stopped) {
        n = await drainPendingDeliveries();
      }
    } catch (err) {
      console.error("[webhook-delivery] worker tick:", err);
    } finally {
      active = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  // Best-effort: don't keep the process alive in tests/CLIs.
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref?: () => void }).unref?.();
  }

  return () => {
    stopped = true;
    workerStarted = false;
    clearInterval(handle);
  };
}

// Silence unused-import warnings for `sql` (kept in case future schedule
// migrations want raw expressions — drizzle's lte/eq cover all current uses).
void sql;

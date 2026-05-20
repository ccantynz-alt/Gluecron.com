-- Reliable webhook delivery — retry queue + dead-letter.
--
-- Replaces the single-shot fire-and-forget loop in src/routes/webhooks.tsx
-- with a durable pending-row pattern. `fireWebhooks()` now inserts one row
-- per (hook, event) into `webhook_deliveries` with status='pending' and
-- next_attempt_at=now(); the background worker in
-- src/lib/webhook-delivery.ts claims rows, attempts the POST, and on
-- failure reschedules with exponential backoff (30s, 2m, 10m, 1h, 6h).
-- After 6 attempts a row transitions to status='dead' and stays for
-- observability — operators can re-queue manually or purge.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload text NOT NULL,
  signature text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  status text NOT NULL DEFAULT 'pending',  -- pending | succeeded | failed | dead
  last_status_code integer,
  last_error text,
  last_attempted_at timestamptz,
  succeeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next_attempt
  ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id
  ON webhook_deliveries (webhook_id, created_at DESC);

-- Block M2 — Mobile-class PWA: Web Push subscriptions.
--
-- Persists a Web Push subscription per user / per device. The `endpoint`
-- is unique per browser instance and acts as the identifier we POST to when
-- delivering a notification. `p256dh` + `auth` are the standard W3C keys
-- needed to encrypt the payload for the recipient. `user_agent` is stored
-- for the "Subscribed on this device" UI string.
--
-- Strictly additive. No existing table touched. Per-event push preference
-- columns are appended to `users` so the same `notify` call site can decide
-- whether to fan out a push based on the user's choices.

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  UNIQUE ("user_id", "endpoint")
);

CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_user"
  ON "push_subscriptions" ("user_id");

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "notify_push_on_mention" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_push_on_assign" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_push_on_review_request" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_push_on_deploy_failed" boolean NOT NULL DEFAULT true;

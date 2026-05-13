-- Block L1 — Sleep Mode.
--
-- Per-user toggle that, when on, bumps the email digest from weekly to
-- DAILY and reframes it as "what Claude shipped while you slept".
-- See `src/lib/sleep-mode.ts` for the composer and
-- `src/lib/autopilot.ts sleep-mode-digest` task for the dispatcher.
--
-- Strictly additive. The existing `notify_email_digest_weekly` +
-- `last_digest_sent_at` columns (migration 0024) are reused; we only add
-- the two new toggle columns below.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "sleep_mode_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sleep_mode_digest_hour_utc" integer NOT NULL DEFAULT 9;

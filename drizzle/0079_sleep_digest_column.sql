-- Migration 0077 — L1 Sleep-mode digest column split.
-- Splits the shared `last_digest_sent_at` anchor into two independent
-- columns so the sleep-mode daily digest and the weekly digest maintain
-- their own cooldown timers and no longer reset each other.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sleep_digest_sent_at timestamptz;

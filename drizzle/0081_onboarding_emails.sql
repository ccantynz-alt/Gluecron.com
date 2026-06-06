-- Onboarding email drip sequence — tracks which drip emails each user has
-- already received so they are never sent twice. The `emails_sent` jsonb
-- column is a set of string keys (e.g. "welcome", "day1", "day3").
--
-- Strictly additive — no existing table or column is touched.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "onboarding_emails_sent" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Gluecron migration 0024: Weekly email digest preference.
--
-- I7 — Opt-in weekly digest. Adds a single boolean column to `users` + a
-- companion `last_digest_sent_at` timestamp so the cron job can skip users
-- who've already received this week's digest (idempotent re-runs).

--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "notify_email_digest_weekly" boolean NOT NULL DEFAULT false;

--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_digest_sent_at" timestamp;

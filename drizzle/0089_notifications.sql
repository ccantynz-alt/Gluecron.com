-- Notification Center (Block A7 follow-up).
--
-- The initial 0001 migration created the `notifications` table with the
-- `kind` / `read_at` column set used by src/lib/notify.ts.  The inbox
-- UI (src/routes/notifications.tsx) was later built against the
-- schema-extensions variant which uses `type` / `is_read` / `actor_id`.
-- This migration adds the missing columns so both surfaces operate on the
-- same physical table without a breaking rename.
--
-- All columns are additive (IF NOT EXISTS) so this migration is idempotent
-- and safe to run against databases that already have these columns.

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "type" text,
  ADD COLUMN IF NOT EXISTS "is_read" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

-- Index used by the inbox page to find unread notifications quickly.
CREATE INDEX IF NOT EXISTS "notifications_user_unread_is_read"
  ON "notifications" ("user_id", "is_read", "created_at" DESC);

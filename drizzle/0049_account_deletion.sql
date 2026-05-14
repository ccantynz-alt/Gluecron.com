-- Block P5 — Account deletion with 30-day grace period.
-- Strictly additive. Soft-delete via `deleted_at` (sessions are cleared at
-- schedule time, so the column alone is enough to keep the user out). The
-- autopilot `account-purge` task hard-deletes rows whose
-- `deletion_scheduled_for` is in the past.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_for timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_deletion_scheduled
  ON users (deletion_scheduled_for)
  WHERE deletion_scheduled_for IS NOT NULL;

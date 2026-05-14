-- Block Q3 — Anonymous playground accounts.
--
-- Strictly additive. Two nullable columns on `users`:
--   * is_playground          — discriminator. Default false.
--   * playground_expires_at  — TTL. Default null. NOT NULL only when
--                              is_playground = true (enforced in lib code,
--                              not in SQL, so the column stays nullable for
--                              the 99.9% of real users that never play).
--
-- A partial index keeps the autopilot purge sweep cheap: only playground
-- rows are indexed, and the index is ordered by expiry so the
-- `expires_at < now()` scan is a small left-prefix range read.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_playground boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS playground_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_playground_expires
  ON users (playground_expires_at)
  WHERE is_playground = true;

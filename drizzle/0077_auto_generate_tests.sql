-- AI test generator — per-repo opt-in flag.
-- Additive only. Defaults to `false` so the new autopilot task is opt-in:
-- repo owners must explicitly enable it via /:owner/:repo/settings.
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS auto_generate_tests boolean NOT NULL DEFAULT false;

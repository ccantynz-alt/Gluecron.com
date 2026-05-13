-- Block M5: Stale PR/issue sweeper — per-repo opt-out flags.
-- Additive only. Defaults to `true` so the autopilot two-stage close
-- runs on every existing repo unless the owner explicitly disables it.
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS auto_close_stale_prs boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_close_stale_issues boolean NOT NULL DEFAULT true;

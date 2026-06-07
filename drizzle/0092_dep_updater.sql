-- Migration 0077: AI dependency auto-updater
-- Adds dep_updater_enabled flag to repositories.
-- dep_update_runs table already exists (from Block D2).

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS dep_updater_enabled boolean NOT NULL DEFAULT false;

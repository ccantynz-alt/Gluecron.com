-- Migration 0077 — per-repo data region selector.
-- Allows repository owners to opt into EU data residency (Frankfurt).
-- Default is 'us'; 'eu' requires a Pro plan or higher (enforced in the
-- repo-creation and repo-settings routes — the DB column itself is
-- unconstrained so future regions (e.g. 'apac') can be added without
-- a schema change).
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS data_region text NOT NULL DEFAULT 'us';

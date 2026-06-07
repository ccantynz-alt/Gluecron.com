-- Migration 0077 — PR preview builder.
--
-- Adds per-repo preview build configuration to the repositories table.
-- When preview_build_command is set, every PR push triggers a build (clone +
-- run command + serve output). The resulting static files are served from
-- /previews/:owner/:repo/:branch/* by the preview route handler.
--
-- Also creates pr_previews, a PR-scoped sibling to the existing branch_previews
-- table (migration 0062). branch_previews tracks one row per branch (upserted on
-- every push); pr_previews tracks one row per PR with richer build metadata
-- (log, build time, command used) and a status that is updated after each build.

-- ── Per-repo preview build config ──────────────────────────────────────────
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS preview_build_command text;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS preview_output_dir text DEFAULT 'dist';

-- ── pr_previews ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pr_previews (
  id serial PRIMARY KEY,
  repo_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_id text NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  branch_name text NOT NULL,
  head_sha text NOT NULL,
  status text NOT NULL DEFAULT 'building', -- building | ready | failed
  build_log text,
  preview_url text,
  build_command text,
  output_dir text DEFAULT 'dist',
  build_duration_ms integer,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pr_previews_pr_id_idx ON pr_previews(pr_id);
CREATE INDEX IF NOT EXISTS pr_previews_repo_id_idx ON pr_previews(repo_id);

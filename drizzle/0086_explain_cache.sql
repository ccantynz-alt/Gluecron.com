-- Migration 0077: repo_explain_cache table
-- Stores the structured AI analysis result (JSON) for the "Explain This Repo"
-- feature. Keyed per-repo; replaced on regeneration.
CREATE TABLE IF NOT EXISTS repo_explain_cache (
  id serial PRIMARY KEY,
  repo_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  result jsonb NOT NULL,
  created_at timestamp DEFAULT now(),
  UNIQUE(repo_id)
);

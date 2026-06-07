-- Migration 0088: Smart empty states — repo onboarding data + flag
-- Adds onboarding_shown column to repositories and a new repo_onboarding_data
-- table. Generated on first push to a repo; displayed as a dismissible card
-- on the repo home page.

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS onboarding_shown BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS repo_onboarding_data (
  repository_id UUID PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  detected_language TEXT,
  detected_framework TEXT,
  suggested_readme TEXT,
  suggested_labels JSONB NOT NULL DEFAULT '[]',
  suggested_gates_config TEXT,
  first_commit_suggestions JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

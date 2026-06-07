CREATE TABLE IF NOT EXISTS recurring_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  commit_shas JSONB NOT NULL DEFAULT '[]',
  root_cause_hypothesis TEXT,
  suggested_file TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);
CREATE INDEX IF NOT EXISTS idx_recurring_patterns_repo ON recurring_patterns(repository_id);
CREATE INDEX IF NOT EXISTS idx_recurring_patterns_expires ON recurring_patterns(expires_at);

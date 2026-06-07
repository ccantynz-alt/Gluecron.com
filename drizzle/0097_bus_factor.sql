CREATE TABLE IF NOT EXISTS bus_factor_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  at_risk_files JSONB NOT NULL DEFAULT '[]',
  total_files_analyzed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(repository_id)
);

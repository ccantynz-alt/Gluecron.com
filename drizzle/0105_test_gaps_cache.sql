CREATE TABLE IF NOT EXISTS test_gap_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  report jsonb NOT NULL,
  analyzed_at timestamp DEFAULT now(),
  expires_at timestamp NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_gap_cache_repo ON test_gap_cache(repo_id);

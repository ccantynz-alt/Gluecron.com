-- Cross-repo impact cache (15min TTL, cleared on new PR push)
CREATE TABLE IF NOT EXISTS cross_repo_impact_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  report jsonb NOT NULL,
  analyzed_at timestamp DEFAULT now(),
  cached_until timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cross_repo_impact_pr ON cross_repo_impact_cache(pr_id);

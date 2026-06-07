CREATE TABLE IF NOT EXISTS repo_health_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  score int NOT NULL,
  breakdown jsonb NOT NULL,
  computed_at timestamp DEFAULT now(),
  expires_at timestamp NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_health_cache_repo ON repo_health_cache(repo_id);

CREATE TABLE IF NOT EXISTS repo_health_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,                    -- 0–100
  grade TEXT NOT NULL,                       -- "A" | "B" | "C" | "D" | "F"
  security_score INTEGER NOT NULL,           -- 0–30
  gates_score INTEGER NOT NULL,              -- 0–25
  ai_review_score INTEGER NOT NULL,          -- 0–20
  dependencies_score INTEGER NOT NULL,       -- 0–15
  code_quality_score INTEGER NOT NULL,       -- 0–10
  recommendations JSONB NOT NULL DEFAULT '[]',  -- array of {category, message, priority: "high"|"medium"|"low"}
  issues_found JSONB NOT NULL DEFAULT '[]',     -- array of {category, message, severity: "critical"|"high"|"medium"|"low"}
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS repo_health_scores_repo ON repo_health_scores(repository_id);
CREATE INDEX IF NOT EXISTS repo_health_scores_computed ON repo_health_scores(computed_at DESC);

-- Block M3 — AI pre-merge risk score.
--
-- Cache of computed PR risk scores keyed on (pull_request_id, commit_sha).
-- The score formula is documented in src/lib/pr-risk.ts and runs over a
-- transparent set of signals; the AI summary is the only LLM-produced
-- field. Storing both fields lets us re-render the badge cheaply on every
-- PR detail view, while still letting reviewers re-trigger recomputation
-- when a new push arrives.
--
-- Strictly additive: no existing tables touched.

CREATE TABLE IF NOT EXISTS "pr_risk_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pull_request_id" uuid NOT NULL REFERENCES "pull_requests"("id") ON DELETE CASCADE,
  "commit_sha" text NOT NULL,
  "score" integer NOT NULL,
  "band" text NOT NULL,
  "signals" jsonb NOT NULL,
  "ai_summary" text,
  "generated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("pull_request_id", "commit_sha")
);

CREATE INDEX IF NOT EXISTS "pr_risk_scores_pr_idx" ON "pr_risk_scores" ("pull_request_id");

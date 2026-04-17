-- Block K1 — Autonomous agent runtime + sandbox.
--
-- The substrate every other Block K agent (triage, fix, review_response,
-- deploy_watcher, heal_bot) runs on top of. A single row records one
-- invocation: its kind + trigger (what fired it), its status lifecycle
-- (queued → running → succeeded/failed/killed/timeout), a short summary,
-- a size-capped append-only log (256 KB), cost accounting (input/output
-- tokens + cents), and optional error_message on failure.

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "kind" text NOT NULL, -- 'triage' | 'fix' | 'review_response' | 'deploy_watcher' | 'heal_bot' | 'custom'
  "trigger" text NOT NULL, -- 'issue.opened' | 'pr.opened' | 'pr.review_comment' | 'deploy.failed' | 'manual' | 'scheduled'
  "trigger_ref" text, -- e.g. issue number, PR number, commit sha
  "status" text NOT NULL DEFAULT 'queued', -- 'queued' | 'running' | 'succeeded' | 'failed' | 'killed' | 'timeout'
  "summary" text,
  "log" text NOT NULL DEFAULT '',
  "cost_input_tokens" integer NOT NULL DEFAULT 0,
  "cost_output_tokens" integer NOT NULL DEFAULT 0,
  "cost_cents" integer NOT NULL DEFAULT 0,
  "started_at" timestamp,
  "finished_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "error_message" text
);

CREATE INDEX IF NOT EXISTS "agent_runs_repo_created_idx"
  ON "agent_runs" ("repository_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "agent_runs_status_idx"
  ON "agent_runs" ("status");

CREATE INDEX IF NOT EXISTS "agent_runs_kind_status_idx"
  ON "agent_runs" ("kind", "status");

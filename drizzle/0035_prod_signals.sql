-- Block K9 — Production + test signal ingestion. Crontech, Gatetest, Sentry,
-- and manual sources feed per-commit signals back into Gluecron for
-- attribution, PR annotation, and agent fix loops.

CREATE TABLE IF NOT EXISTS "prod_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "commit_sha" text NOT NULL,
  "error_hash" text NOT NULL, -- truncated sha-256 of normalised error msg + top frame
  "source" text NOT NULL, -- 'crontech' | 'gatetest' | 'sentry' | 'manual'
  "kind" text NOT NULL, -- 'runtime_error' | 'test_failure' | 'deploy_failure' | 'performance' | 'security'
  "severity" text NOT NULL DEFAULT 'error', -- 'info' | 'warning' | 'error' | 'critical'
  "status" text NOT NULL DEFAULT 'open', -- 'open' | 'dismissed' | 'resolved'
  "message" text NOT NULL DEFAULT '',
  "stack_trace" text,
  "deploy_id" text,
  "environment" text, -- 'production' | 'staging' | etc.
  "sample_payload" text, -- JSON string, optional
  "count" integer NOT NULL DEFAULT 1,
  "first_seen" timestamp NOT NULL DEFAULT now(),
  "last_seen" timestamp NOT NULL DEFAULT now(),
  "resolved_at" timestamp,
  "resolved_by_commit" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "prod_signals_repo_hash_unique"
  ON "prod_signals" ("repository_id", "error_hash");

CREATE INDEX IF NOT EXISTS "prod_signals_repo_sha_idx"
  ON "prod_signals" ("repository_id", "commit_sha");

CREATE INDEX IF NOT EXISTS "prod_signals_repo_status_seen_idx"
  ON "prod_signals" ("repository_id", "status", "last_seen" DESC);

CREATE INDEX IF NOT EXISTS "prod_signals_source_kind_idx"
  ON "prod_signals" ("source", "kind");

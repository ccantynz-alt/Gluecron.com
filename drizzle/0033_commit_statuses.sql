-- Block J8 — Commit statuses (GitHub-parity external CI signal).
--
-- External systems post per-commit (sha, context) statuses that appear on
-- commit detail views and fuel future merge-gating. Per (repo, sha, context)
-- upsert semantics — a repost with the same context replaces the prior row.

CREATE TABLE IF NOT EXISTS "commit_statuses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "commit_sha" text NOT NULL,
  "state" text NOT NULL, -- 'pending' | 'success' | 'failure' | 'error'
  "context" text NOT NULL DEFAULT 'default',
  "description" text,
  "target_url" text,
  "creator_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "commit_statuses_repo_sha_context_unique"
  ON "commit_statuses" ("repository_id", "commit_sha", "context");

CREATE INDEX IF NOT EXISTS "commit_statuses_repo_sha_idx"
  ON "commit_statuses" ("repository_id", "commit_sha");

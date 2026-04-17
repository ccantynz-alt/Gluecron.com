-- Block L — GitHub importer job ledger.
--
-- Tracks a single "import from GitHub" attempt. One row per POST /new/import.
-- stats JSON holds per-endpoint counts (labels/issues/pulls/comments/releases/stars).
-- status progresses: pending → cloning → walking → ok|error.

CREATE TABLE IF NOT EXISTS "github_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid REFERENCES "repositories"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "source_owner" text NOT NULL,
  "source_repo" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending', -- pending|cloning|walking|ok|error
  "stats" text NOT NULL DEFAULT '{}',
  "error" text,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "finished_at" timestamp
);

CREATE INDEX IF NOT EXISTS "github_imports_user_idx"
  ON "github_imports" ("user_id", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "github_imports_repo_idx"
  ON "github_imports" ("repository_id");

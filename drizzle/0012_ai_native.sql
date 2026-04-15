-- Gluecron migration 0012: Block D — AI-native differentiation.
--
-- Tables:
--   codebase_explanations  — D6: per-commit cached "explain this codebase" markdown
--   dep_update_runs        — D2: AI dependency bumper run history
--   code_chunks            — D1: per-repo code chunks with (optional) embeddings

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "codebase_explanations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "commit_sha" text NOT NULL,
  "summary" text NOT NULL,
  "markdown" text NOT NULL,
  "model" text NOT NULL,
  "generated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "codebase_explanations_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "codebase_explanations_repo_sha" ON "codebase_explanations" ("repository_id", "commit_sha");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dep_update_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "ecosystem" text NOT NULL,
  "manifest_path" text NOT NULL,
  "attempted_bumps" text NOT NULL DEFAULT '[]',
  "applied_bumps" text NOT NULL DEFAULT '[]',
  "branch_name" text,
  "pr_number" integer,
  "error_message" text,
  "triggered_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "dep_update_runs_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "dep_update_runs_user_fk" FOREIGN KEY ("triggered_by") REFERENCES "users"("id") ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dep_update_runs_repo" ON "dep_update_runs" ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dep_update_runs_created" ON "dep_update_runs" ("created_at");

--> statement-breakpoint
-- D1: code chunks for semantic search. Embedding stored as JSON-encoded
-- number array in text to avoid requiring pgvector; helper lib does cosine
-- similarity in JS. Upgrade path: ALTER COLUMN embedding TYPE vector(1024).
CREATE TABLE IF NOT EXISTS "code_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "commit_sha" text NOT NULL,
  "path" text NOT NULL,
  "start_line" integer NOT NULL,
  "end_line" integer NOT NULL,
  "content" text NOT NULL,
  "embedding" text,
  "embedding_model" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "code_chunks_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_chunks_repo" ON "code_chunks" ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_chunks_repo_path" ON "code_chunks" ("repository_id", "path");

-- Gluecron migration 0025: Code symbol index.
--
-- I8 — Symbol / xref navigation. Stores top-level symbol definitions
-- (functions, classes, interfaces, types, consts) extracted from a
-- repository's HEAD via a regex-based parser. References are found at
-- lookup-time by grepping content, so we only persist definitions.
--
-- On-demand index: owner clicks "Reindex" on /:owner/:repo/symbols. We
-- keep only the most recent commit's symbols — older rows are overwritten
-- by deleting the prior set before inserting the new one.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "code_symbols" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "commit_sha" text NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "path" text NOT NULL,
  "line" integer NOT NULL,
  "signature" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_symbols_repo_name_idx"
  ON "code_symbols" ("repository_id", "name");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_symbols_repo_path_idx"
  ON "code_symbols" ("repository_id", "path");

-- Gluecron migration 0019: Block E7 — Protected tags.
--
-- Lets owners mark tag patterns (e.g. `v*`, `release-*`) as protected so
-- that non-owners cannot create, update, or delete matching tags.
-- Enforcement happens in the git push flow: see post-receive hook for
-- advisory notifications; the actual block is implemented at the route
-- level or service layer (for v1 we just record + surface the policy).
--
-- Tables:
--   protected_tags   — per-repo tag patterns with glob support

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "protected_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "pattern" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "created_by" uuid,
  CONSTRAINT "protected_tags_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "protected_tags_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "protected_tags_repo" ON "protected_tags" ("repository_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "protected_tags_repo_pattern" ON "protected_tags" ("repository_id", "pattern");

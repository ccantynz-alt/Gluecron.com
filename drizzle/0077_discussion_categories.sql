-- Gluecron migration 0077: Discussion categories table.
--
-- Adds per-repo discussion_categories so discussions can be organised into
-- named buckets (General, Q&A, Announcements, Ideas) rather than relying on
-- a bare text enum. The existing discussions.category text column is kept for
-- backwards-compatibility; new code reads categories from this table.
--
-- is_answerable = true means the category surfaces a "Mark as answer" button
-- (GitHub's Q&A category behaviour).

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discussion_categories" (
  "id" serial PRIMARY KEY NOT NULL,
  "repository_id" uuid NOT NULL,
  "name" text NOT NULL,
  "emoji" text NOT NULL DEFAULT '💬',
  "description" text,
  "is_answerable" boolean NOT NULL DEFAULT false,
  CONSTRAINT "discussion_categories_repo_fk" FOREIGN KEY ("repository_id")
    REFERENCES "repositories"("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discussion_categories_repo"
  ON "discussion_categories" ("repository_id");

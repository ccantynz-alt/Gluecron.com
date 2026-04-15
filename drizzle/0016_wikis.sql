-- Gluecron migration 0016: Block E3 — Wikis.
--
-- DB-backed wiki for v1 (git-backed mirror is a future upgrade). Each repo
-- owns a collection of wiki_pages keyed on slug, with revisions stored
-- incrementally for history/diff/revert.
--
-- Tables:
--   wiki_pages      — current content per slug
--   wiki_revisions  — append-only history (body + message + author)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wiki_pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "wiki_pages_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "wiki_pages_author_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_pages_repo" ON "wiki_pages" ("repository_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_pages_repo_slug" ON "wiki_pages" ("repository_id", "slug");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wiki_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "page_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "message" text,
  "author_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "wiki_revisions_page_fk" FOREIGN KEY ("page_id") REFERENCES "wiki_pages"("id") ON DELETE cascade,
  CONSTRAINT "wiki_revisions_author_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_revisions_page" ON "wiki_revisions" ("page_id", "revision");

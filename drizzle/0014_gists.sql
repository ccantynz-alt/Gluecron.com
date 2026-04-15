-- Gluecron migration 0014: Block E4 — Gists.
--
-- User-owned small snippets/files that behave like tiny repos. DB-backed
-- (no git bare repo for v1): each gist owns a collection of gist_files, and
-- every edit appends a gist_revisions row containing a JSON snapshot of the
-- full file set at that revision.
--
-- Tables:
--   gists           — top-level gist row (owner, slug, title, description)
--   gist_files      — individual files on a gist (filename, language, content)
--   gist_revisions  — per-edit snapshots (JSON {filename: content})
--   gist_stars      — per-user stars

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "title" text NOT NULL DEFAULT '',
  "description" text NOT NULL DEFAULT '',
  "is_public" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "gists_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gists_owner" ON "gists" ("owner_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gist_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gist_id" uuid NOT NULL,
  "filename" text NOT NULL,
  "language" text,
  "content" text NOT NULL DEFAULT '',
  "size_bytes" integer NOT NULL DEFAULT 0,
  CONSTRAINT "gist_files_gist_fk" FOREIGN KEY ("gist_id") REFERENCES "gists"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gist_files_gist" ON "gist_files" ("gist_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gist_files_gist_filename" ON "gist_files" ("gist_id", "filename");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gist_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gist_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "snapshot" text NOT NULL DEFAULT '{}',
  "author_id" uuid NOT NULL,
  "message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "gist_revisions_gist_fk" FOREIGN KEY ("gist_id") REFERENCES "gists"("id") ON DELETE cascade,
  CONSTRAINT "gist_revisions_author_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gist_revisions_gist_rev" ON "gist_revisions" ("gist_id", "revision");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gist_stars" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gist_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "gist_stars_gist_fk" FOREIGN KEY ("gist_id") REFERENCES "gists"("id") ON DELETE cascade,
  CONSTRAINT "gist_stars_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gist_stars_gist_user" ON "gist_stars" ("gist_id", "user_id");

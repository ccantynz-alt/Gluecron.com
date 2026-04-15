-- Gluecron migration 0013: Block E2 — Discussions.
--
-- Tables:
--   discussions          — forum-style threaded conversations attached to a repo
--   discussion_comments  — comments (optionally nested 1 level via parent_comment_id)
--
-- Discussions mirror GitHub Discussions: pinned + categorised threads that live
-- alongside issues/PRs but are conversational rather than work-tracking.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discussions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "number" serial NOT NULL,
  "repository_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "category" text NOT NULL DEFAULT 'general',
  "title" text NOT NULL,
  "body" text,
  "state" text NOT NULL DEFAULT 'open',
  "locked" boolean NOT NULL DEFAULT false,
  "answer_comment_id" uuid,
  "pinned" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "discussions_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "discussions_author_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discussions_repo" ON "discussions" ("repository_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discussions_repo_number" ON "discussions" ("repository_id", "number");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discussion_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "discussion_id" uuid NOT NULL,
  "parent_comment_id" uuid,
  "author_id" uuid NOT NULL,
  "body" text NOT NULL,
  "is_answer" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "discussion_comments_discussion_fk" FOREIGN KEY ("discussion_id") REFERENCES "discussions"("id") ON DELETE cascade,
  CONSTRAINT "discussion_comments_parent_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "discussion_comments"("id") ON DELETE cascade,
  CONSTRAINT "discussion_comments_author_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discussion_comments_discussion" ON "discussion_comments" ("discussion_id");

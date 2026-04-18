-- Gluecron migration 0017: Block E5 — Merge queues.
--
-- Serialised merge: instead of merging a PR immediately, it's appended to
-- a queue scoped on (repository_id, base_branch). A worker (or manual
-- process-next button for v1) pops the head, re-runs gates against the
-- latest base, and if green actually merges. If red, kicks the PR back
-- with a failure comment.
--
-- Tables:
--   merge_queue_entries   — one row per PR currently queued / processed

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merge_queue_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "pull_request_id" uuid NOT NULL,
  "base_branch" text NOT NULL,
  "state" text NOT NULL DEFAULT 'queued',   -- queued | running | merged | failed | dequeued
  "position" integer NOT NULL DEFAULT 0,
  "enqueued_by" uuid,
  "enqueued_at" timestamp DEFAULT now() NOT NULL,
  "started_at" timestamp,
  "finished_at" timestamp,
  "error_message" text,
  CONSTRAINT "merge_queue_entries_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "merge_queue_entries_pr_fk" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE cascade,
  CONSTRAINT "merge_queue_entries_enqueuer_fk" FOREIGN KEY ("enqueued_by") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merge_queue_repo_branch" ON "merge_queue_entries" ("repository_id", "base_branch", "state");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merge_queue_pr_active" ON "merge_queue_entries" ("pull_request_id") WHERE state IN ('queued', 'running');

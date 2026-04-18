-- Gluecron migration 0008: Block C1 — Actions-equivalent workflow runner.
--
-- Tables:
--   workflows         — parsed workflow YAML files discovered in a repo
--   workflow_runs     — one execution of a workflow, triggered by an event
--   workflow_jobs     — jobs within a run (each is a sequence of steps)
--   workflow_artifacts — files uploaded by a run (stored in bytea for v1)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "name" text NOT NULL,
  "path" text NOT NULL,
  "yaml" text NOT NULL,
  "parsed" text NOT NULL,
  "on_events" text NOT NULL DEFAULT '[]',
  "disabled" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workflows_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_repo" ON "workflows" ("repository_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflows_repo_path" ON "workflows" ("repository_id", "path");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "run_number" integer NOT NULL,
  "event" text NOT NULL,
  "ref" text,
  "commit_sha" text,
  "triggered_by" uuid,
  "status" text NOT NULL DEFAULT 'queued',
  "conclusion" text,
  "queued_at" timestamp DEFAULT now() NOT NULL,
  "started_at" timestamp,
  "finished_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_runs_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade,
  CONSTRAINT "workflow_runs_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "workflow_runs_user_fk" FOREIGN KEY ("triggered_by") REFERENCES "users"("id") ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_repo" ON "workflow_runs" ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_status" ON "workflow_runs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_workflow" ON "workflow_runs" ("workflow_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "name" text NOT NULL,
  "job_order" integer NOT NULL DEFAULT 0,
  "runs_on" text NOT NULL DEFAULT 'default',
  "status" text NOT NULL DEFAULT 'queued',
  "conclusion" text,
  "exit_code" integer,
  "steps" text NOT NULL DEFAULT '[]',
  "logs" text NOT NULL DEFAULT '',
  "started_at" timestamp,
  "finished_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_jobs_run_fk" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_jobs_run" ON "workflow_jobs" ("run_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "job_id" uuid,
  "name" text NOT NULL,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "content_type" text DEFAULT 'application/octet-stream' NOT NULL,
  "content" bytea,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_artifacts_run_fk" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE cascade,
  CONSTRAINT "workflow_artifacts_job_fk" FOREIGN KEY ("job_id") REFERENCES "workflow_jobs"("id") ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_artifacts_run" ON "workflow_artifacts" ("run_id");

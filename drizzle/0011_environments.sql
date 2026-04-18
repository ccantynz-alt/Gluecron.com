-- Gluecron migration 0011: Block C4 — Environments with protected approvals.
--
-- Tables:
--   environments          — per-repo named environments (production, staging, preview)
--   deployment_approvals  — approve/reject decisions on a pending deployment

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "environments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "name" text NOT NULL,
  "require_approval" boolean NOT NULL DEFAULT false,
  "reviewers" text NOT NULL DEFAULT '[]',
  "wait_timer_minutes" integer NOT NULL DEFAULT 0,
  "allowed_branches" text NOT NULL DEFAULT '[]',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "environments_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_repo_name" ON "environments" ("repository_id", "name");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployment_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deployment_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "decision" text NOT NULL,
  "comment" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "deployment_approvals_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE cascade,
  CONSTRAINT "deployment_approvals_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_approvals_deployment" ON "deployment_approvals" ("deployment_id");

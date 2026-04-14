-- Gluecron migration 0001: green ecosystem — advanced platform features
-- Adds: repo_settings, branch_protection, gate_runs, notifications, releases,
--       milestones, reactions, pr_reviews, code_owners, ai_chats, audit_log,
--       deployments, rate_limit_buckets, plus new columns on existing tables.

--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "is_archived" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "is_draft" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "merge_strategy" text DEFAULT 'merge' NOT NULL;

--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "milestone_id" uuid;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL UNIQUE,
  "gate_test_enabled" boolean DEFAULT true NOT NULL,
  "ai_review_enabled" boolean DEFAULT true NOT NULL,
  "secret_scan_enabled" boolean DEFAULT true NOT NULL,
  "security_scan_enabled" boolean DEFAULT true NOT NULL,
  "dependency_scan_enabled" boolean DEFAULT true NOT NULL,
  "lint_enabled" boolean DEFAULT true NOT NULL,
  "type_check_enabled" boolean DEFAULT true NOT NULL,
  "test_enabled" boolean DEFAULT true NOT NULL,
  "auto_fix_enabled" boolean DEFAULT true NOT NULL,
  "auto_merge_resolve_enabled" boolean DEFAULT true NOT NULL,
  "auto_format_enabled" boolean DEFAULT true NOT NULL,
  "ai_commit_messages_enabled" boolean DEFAULT true NOT NULL,
  "ai_pr_summary_enabled" boolean DEFAULT true NOT NULL,
  "ai_changelog_enabled" boolean DEFAULT true NOT NULL,
  "auto_deploy_enabled" boolean DEFAULT true NOT NULL,
  "deploy_require_all_green" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "repo_settings_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branch_protection" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "pattern" text NOT NULL,
  "require_pull_request" boolean DEFAULT true NOT NULL,
  "require_green_gates" boolean DEFAULT true NOT NULL,
  "require_ai_approval" boolean DEFAULT true NOT NULL,
  "require_human_review" boolean DEFAULT false NOT NULL,
  "required_approvals" integer DEFAULT 0 NOT NULL,
  "allow_force_push" boolean DEFAULT false NOT NULL,
  "allow_deletion" boolean DEFAULT false NOT NULL,
  "dismiss_stale_reviews" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "branch_protection_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branch_protection_repo_pattern" ON "branch_protection" ("repository_id", "pattern");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gate_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "pull_request_id" uuid,
  "commit_sha" text NOT NULL,
  "ref" text NOT NULL,
  "gate_name" text NOT NULL,
  "status" text NOT NULL,
  "summary" text,
  "details" text,
  "repair_attempted" boolean DEFAULT false NOT NULL,
  "repair_succeeded" boolean DEFAULT false NOT NULL,
  "repair_commit_sha" text,
  "duration_ms" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "gate_runs_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE,
  CONSTRAINT "gate_runs_pr_fk" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_runs_repo_sha" ON "gate_runs" ("repository_id", "commit_sha");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_runs_pr" ON "gate_runs" ("pull_request_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_runs_created" ON "gate_runs" ("created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "repository_id" uuid,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "url" text,
  "read_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "notifications_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
  CONSTRAINT "notifications_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_unread" ON "notifications" ("user_id", "read_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_created" ON "notifications" ("user_id", "created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "tag" text NOT NULL,
  "name" text NOT NULL,
  "body" text,
  "target_commit" text NOT NULL,
  "is_draft" boolean DEFAULT false NOT NULL,
  "is_prerelease" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "published_at" timestamp,
  CONSTRAINT "releases_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE,
  CONSTRAINT "releases_author_fk" FOREIGN KEY ("author_id") REFERENCES "users" ("id")
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "releases_repo_tag" ON "releases" ("repository_id", "tag");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "state" text DEFAULT 'open' NOT NULL,
  "due_date" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "closed_at" timestamp,
  CONSTRAINT "milestones_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestones_repo_state" ON "milestones" ("repository_id", "state");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "emoji" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "reactions_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reactions_unique" ON "reactions" ("user_id", "target_type", "target_id", "emoji");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reactions_target" ON "reactions" ("target_type", "target_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pr_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pull_request_id" uuid NOT NULL,
  "reviewer_id" uuid NOT NULL,
  "state" text NOT NULL,
  "body" text,
  "is_ai" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pr_reviews_pr_fk" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests" ("id") ON DELETE CASCADE,
  CONSTRAINT "pr_reviews_reviewer_fk" FOREIGN KEY ("reviewer_id") REFERENCES "users" ("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_reviews_pr" ON "pr_reviews" ("pull_request_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "code_owners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "path_pattern" text NOT NULL,
  "owner_usernames" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "code_owners_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_owners_repo" ON "code_owners" ("repository_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_chats" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "repository_id" uuid,
  "title" text,
  "messages" text DEFAULT '[]' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ai_chats_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
  CONSTRAINT "ai_chats_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_chats_user" ON "ai_chats" ("user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_chats_repo" ON "ai_chats" ("repository_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "repository_id" uuid,
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "ip" text,
  "user_agent" text,
  "metadata" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "audit_log_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL,
  CONSTRAINT "audit_log_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE SET NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_user" ON "audit_log" ("user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_repo" ON "audit_log" ("repository_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created" ON "audit_log" ("created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "environment" text DEFAULT 'production' NOT NULL,
  "commit_sha" text NOT NULL,
  "ref" text NOT NULL,
  "status" text NOT NULL,
  "blocked_reason" text,
  "target" text,
  "triggered_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "deployments_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE,
  CONSTRAINT "deployments_user_fk" FOREIGN KEY ("triggered_by") REFERENCES "users" ("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_repo" ON "deployments" ("repository_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_created" ON "deployments" ("created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bucket_key" text NOT NULL UNIQUE,
  "count" integer DEFAULT 0 NOT NULL,
  "window_start" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp NOT NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_expires" ON "rate_limit_buckets" ("expires_at");

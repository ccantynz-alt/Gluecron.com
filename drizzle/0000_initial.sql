-- Gluecron initial migration
-- Generated manually to match src/db/schema.ts

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "email" text NOT NULL,
  "display_name" text,
  "password_hash" text NOT NULL,
  "avatar_url" text,
  "bio" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "users_username_unique" UNIQUE ("username"),
  CONSTRAINT "users_email_unique" UNIQUE ("email")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "sessions_token_unique" UNIQUE ("token"),
  CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "owner_id" uuid NOT NULL,
  "description" text,
  "is_private" boolean DEFAULT false NOT NULL,
  "default_branch" text DEFAULT 'main' NOT NULL,
  "disk_path" text NOT NULL,
  "forked_from_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "pushed_at" timestamp,
  "star_count" integer DEFAULT 0 NOT NULL,
  "fork_count" integer DEFAULT 0 NOT NULL,
  "issue_count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "repositories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users" ("id"),
  CONSTRAINT "repositories_forked_from_id_repositories_id_fk" FOREIGN KEY ("forked_from_id") REFERENCES "repositories" ("id") ON DELETE SET NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repos_owner_name" ON "repositories" ("owner_id", "name");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stars" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
  CONSTRAINT "stars_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stars_user_repo" ON "stars" ("user_id", "repository_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "number" serial NOT NULL,
  "repository_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "state" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "closed_at" timestamp,
  CONSTRAINT "issues_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE,
  CONSTRAINT "issues_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users" ("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_repo_state" ON "issues" ("repository_id", "state");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_repo_number" ON "issues" ("repository_id", "number");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "issue_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues" ("id") ON DELETE CASCADE,
  CONSTRAINT "issue_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users" ("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_issue" ON "issue_comments" ("issue_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "name" text NOT NULL,
  "color" text DEFAULT '#8b949e' NOT NULL,
  "description" text,
  CONSTRAINT "labels_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "labels_repo_name" ON "labels" ("repository_id", "name");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "issue_id" uuid NOT NULL,
  "label_id" uuid NOT NULL,
  CONSTRAINT "issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues" ("id") ON DELETE CASCADE,
  CONSTRAINT "issue_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "labels" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_labels_unique" ON "issue_labels" ("issue_id", "label_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pull_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "number" serial NOT NULL,
  "repository_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "state" text DEFAULT 'open' NOT NULL,
  "base_branch" text NOT NULL,
  "head_branch" text NOT NULL,
  "merged_at" timestamp,
  "merged_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "closed_at" timestamp,
  CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE,
  CONSTRAINT "pull_requests_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users" ("id"),
  CONSTRAINT "pull_requests_merged_by_users_id_fk" FOREIGN KEY ("merged_by") REFERENCES "users" ("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prs_repo_state" ON "pull_requests" ("repository_id", "state");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prs_repo_number" ON "pull_requests" ("repository_id", "number");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pr_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pull_request_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "body" text NOT NULL,
  "is_ai_review" boolean DEFAULT false NOT NULL,
  "file_path" text,
  "line_number" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pr_comments_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests" ("id") ON DELETE CASCADE,
  CONSTRAINT "pr_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users" ("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_comments_pr" ON "pr_comments" ("pull_request_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_feed" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "user_id" uuid,
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "metadata" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "activity_feed_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE,
  CONSTRAINT "activity_feed_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_repo" ON "activity_feed" ("repository_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_user" ON "activity_feed" ("user_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "url" text NOT NULL,
  "secret" text,
  "events" text DEFAULT 'push' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_delivered_at" timestamp,
  "last_status" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "webhooks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhooks_repo" ON "webhooks" ("repository_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_prefix" text NOT NULL,
  "scopes" text DEFAULT 'repo' NOT NULL,
  "last_used_at" timestamp,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_topics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "topic" text NOT NULL,
  CONSTRAINT "repo_topics_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories" ("id") ON DELETE CASCADE
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repo_topics_unique" ON "repo_topics" ("repository_id", "topic");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_name" ON "repo_topics" ("topic");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ssh_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "title" text NOT NULL,
  "fingerprint" text NOT NULL,
  "public_key" text NOT NULL,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ssh_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

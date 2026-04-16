-- Flywheel / Learning System tables
-- Tracks AI review outcomes, extracts patterns, and aggregates gate metrics
-- so every future review gets smarter based on historical data.

CREATE TABLE IF NOT EXISTS "review_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "pull_request_id" uuid NOT NULL REFERENCES "pull_requests"("id") ON DELETE CASCADE,
  "comment_id" uuid NOT NULL REFERENCES "pr_comments"("id") ON DELETE CASCADE,
  "outcome" text NOT NULL,
  "category" text NOT NULL,
  "file_path" text,
  "language" text,
  "was_useful" boolean,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_outcomes_repo" ON "review_outcomes" ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_outcomes_category" ON "review_outcomes" ("category", "outcome");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "review_patterns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid REFERENCES "repositories"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "language" text,
  "category" text NOT NULL,
  "pattern" text NOT NULL,
  "confidence" integer NOT NULL DEFAULT 50,
  "evidence_count" integer NOT NULL DEFAULT 1,
  "last_seen_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_patterns_scope" ON "review_patterns" ("scope", "active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_patterns_repo" ON "review_patterns" ("repository_id", "active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_patterns_lang" ON "review_patterns" ("language", "active");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "gate_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "gate_name" text NOT NULL,
  "period" text NOT NULL,
  "total_runs" integer NOT NULL DEFAULT 0,
  "passed" integer NOT NULL DEFAULT 0,
  "failed" integer NOT NULL DEFAULT 0,
  "repaired" integer NOT NULL DEFAULT 0,
  "skipped" integer NOT NULL DEFAULT 0,
  "avg_duration_ms" integer,
  "false_positives" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gate_metrics_repo_gate_period" ON "gate_metrics" ("repository_id", "gate_name", "period");

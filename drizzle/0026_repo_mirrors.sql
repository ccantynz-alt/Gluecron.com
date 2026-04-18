-- Gluecron migration 0026: Repository mirroring.
--
-- I9 — Pull-style mirroring. A mirrored repository has an upstream URL
-- that we periodically `git fetch` from (via admin-trigger or cron). We
-- keep a single row per repo (one mirror per mirrored repo) plus an
-- append-only log of sync attempts for audit.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_mirrors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL UNIQUE
    REFERENCES "repositories"("id") ON DELETE CASCADE,
  "upstream_url" text NOT NULL,
  "interval_minutes" integer NOT NULL DEFAULT 1440,
  "last_synced_at" timestamp,
  "last_status" text, -- "ok" | "error" | null (never synced)
  "last_error" text,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_mirror_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mirror_id" uuid NOT NULL REFERENCES "repo_mirrors"("id") ON DELETE CASCADE,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "finished_at" timestamp,
  "status" text NOT NULL DEFAULT 'running', -- running | ok | error
  "message" text,
  "exit_code" integer
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_mirror_runs_mirror_id_idx"
  ON "repo_mirror_runs" ("mirror_id", "started_at" DESC);

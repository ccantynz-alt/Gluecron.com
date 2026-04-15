-- Gluecron migration 0010: Block C3 — Pages / static hosting.
--
-- Tables:
--   pages_deployments — recorded every time the source branch advances
--   pages_settings    — per-repo pages config (enabled, source branch/dir, custom domain)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages_deployments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "ref" text NOT NULL DEFAULT 'refs/heads/gh-pages',
  "commit_sha" text NOT NULL,
  "status" text NOT NULL DEFAULT 'success',
  "triggered_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pages_deployments_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "pages_deployments_user_fk" FOREIGN KEY ("triggered_by") REFERENCES "users"("id") ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_deployments_repo" ON "pages_deployments" ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_deployments_created" ON "pages_deployments" ("created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages_settings" (
  "repository_id" uuid PRIMARY KEY NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "source_branch" text NOT NULL DEFAULT 'gh-pages',
  "source_dir" text NOT NULL DEFAULT '/',
  "custom_domain" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pages_settings_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade
);

-- Gluecron migration 0072: per-(repo, user) cloud dev environments.
--
-- Hosted VS Code in the browser. Push a repo, hit /:owner/:repo/dev, get a
-- full-screen IDE backed by a cold-start sandbox container. Microsoft
-- Codespaces costs them a fortune in Azure VM time — we go cheaper by
-- spinning environments down after `idle_minutes` of no traffic and
-- re-warming on demand.
--
-- One environment per (repository_id, owner_user_id) — re-starting the
-- same repo as the same user upserts onto the existing row so the URL
-- stays stable.
--
-- Wrapped in DO blocks so re-runs are safe and partial-replay friendly.
-- Per repo opt-in lives on `repositories.dev_envs_enabled` (added below);
-- the whole feature is graceful — when either the table or the column
-- is missing every helper in src/lib/dev-env.ts returns null and the
-- route renders a "disabled" notice instead of throwing.

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "dev_envs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
    "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "status" text NOT NULL DEFAULT 'cold',
    "preview_url" text,
    "container_id" text,
    "machine_size" text NOT NULL DEFAULT 'small',
    "idle_minutes" integer NOT NULL DEFAULT 30,
    "dev_yml" text,
    "error_message" text,
    "last_active_at" timestamptz NOT NULL DEFAULT now(),
    "expires_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'dev_envs create failed (%); dev environments will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "dev_envs_repo_owner"
    ON "dev_envs" ("repository_id", "owner_user_id");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'dev_envs_repo_owner index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "dev_envs_status_active"
    ON "dev_envs" ("status", "last_active_at");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'dev_envs_status_active index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "repositories"
    ADD COLUMN IF NOT EXISTS "dev_envs_enabled" boolean NOT NULL DEFAULT false;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'repositories.dev_envs_enabled add failed (%)', SQLERRM;
END $$;

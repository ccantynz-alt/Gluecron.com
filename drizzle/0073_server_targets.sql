-- Gluecron migration 0073: server targets (Block ST).
--
-- Admin-only first-class concept for "boxes Gluecron can push deploys to".
-- A target owns:
--   - SSH connection info (host, user, port, encrypted private key)
--   - A host-key fingerprint pinned on first successful connection (TOFU)
--   - A deploy_script that runs on the box when a watched branch is pushed
--   - A set of env vars (server_target_env) materialised as a .env file
--     uploaded before each deploy and sourced by the script
--
-- Customer-facing rollout (Block 2) reuses these tables with the addition
-- of owner_user_id scoping + an `auth_method` enum. v1 is admin-only:
-- created_by tracks the operator who registered the target.
--
-- Wrapped in DO blocks so partial replays are safe.

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "server_targets" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "host" text NOT NULL,
    "port" integer NOT NULL DEFAULT 22,
    "ssh_user" text NOT NULL,
    "encrypted_private_key" text NOT NULL,
    "host_fingerprint" text,
    "deploy_path" text NOT NULL DEFAULT '/var/www/app',
    "deploy_script" text NOT NULL DEFAULT 'bash deploy.sh',
    "watched_repository_id" uuid REFERENCES "repositories"("id") ON DELETE SET NULL,
    "watched_branch" text,
    "status" text NOT NULL DEFAULT 'unverified',
    "last_seen_at" timestamptz,
    "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "server_targets_name_uq" ON "server_targets"("name");
  CREATE INDEX IF NOT EXISTS "server_targets_watch_idx"
    ON "server_targets"("watched_repository_id", "watched_branch")
    WHERE "watched_repository_id" IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'server_targets create failed (%); feature will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "server_target_env" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "target_id" uuid NOT NULL REFERENCES "server_targets"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "encrypted_value" text NOT NULL,
    "is_secret" boolean NOT NULL DEFAULT true,
    "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "server_target_env_uq"
    ON "server_target_env"("target_id", "name");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'server_target_env create failed (%);', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "server_target_deployments" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "target_id" uuid NOT NULL REFERENCES "server_targets"("id") ON DELETE CASCADE,
    "commit_sha" text,
    "ref" text,
    "status" text NOT NULL DEFAULT 'pending',
    "exit_code" integer,
    "stdout" text,
    "stderr" text,
    "triggered_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "trigger_source" text NOT NULL DEFAULT 'push',
    "started_at" timestamptz NOT NULL DEFAULT now(),
    "finished_at" timestamptz
  );
  CREATE INDEX IF NOT EXISTS "server_target_deployments_target_idx"
    ON "server_target_deployments"("target_id", "started_at" DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'server_target_deployments create failed (%);', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "server_target_audit" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "target_id" uuid REFERENCES "server_targets"("id") ON DELETE SET NULL,
    "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "action" text NOT NULL,
    "detail" text,
    "ip" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS "server_target_audit_target_idx"
    ON "server_target_audit"("target_id", "created_at" DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'server_target_audit create failed (%);', SQLERRM;
END $$;

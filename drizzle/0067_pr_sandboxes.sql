-- Gluecron migration 0067: per-PR runnable sandboxes.
--
-- Every PR gets an ephemeral, *executable* sandbox that reviewers can poke
-- live before merging. Goes beyond per-branch preview URLs (migration 0062):
-- those are read-only previews. This row owns:
--   - a deterministic sandbox URL on a separate subdomain root
--     (default `sandbox.gluecron.com`) so it never collides with previews
--   - a lifecycle (provisioning → ready / failed / destroyed) so the PR
--     detail page can render a status pill + retry button
--   - an `expires_at` defaulting to now + 4h so we don't leak compute
--   - the resolved `playground_yml` blob (either committed by the repo
--     or AI-generated on first provision) for future reference / diff
--
-- Wrapped in DO blocks so re-runs are safe and partial-replay friendly.
-- The whole feature is graceful — when the table is missing every helper
-- in src/lib/pr-sandbox.ts returns null and the UI hides the button.

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "pr_sandboxes" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "pr_id" uuid NOT NULL REFERENCES "pull_requests"("id") ON DELETE CASCADE,
    "status" text NOT NULL DEFAULT 'provisioning',
    "sandbox_url" text NOT NULL,
    "container_id" text,
    "playground_yml" text,
    "provisioned_at" timestamptz NOT NULL DEFAULT now(),
    "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '4 hours'),
    "destroyed_at" timestamptz,
    "error_message" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pr_sandboxes create failed (%); PR sandboxes will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "pr_sandboxes_pr_id"
    ON "pr_sandboxes" ("pr_id");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pr_sandboxes_pr_id index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "pr_sandboxes_status_expires"
    ON "pr_sandboxes" ("status", "expires_at")
    WHERE "status" IN ('provisioning', 'ready');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pr_sandboxes_status_expires index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "repositories"
    ADD COLUMN IF NOT EXISTS "auto_pr_sandbox" boolean NOT NULL DEFAULT false;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'repositories.auto_pr_sandbox add failed (%)', SQLERRM;
END $$;

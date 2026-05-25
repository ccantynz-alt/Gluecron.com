-- Gluecron migration 0062: per-branch preview URLs.
--
-- Every push to a non-default branch enqueues a build row that, once
-- finished, holds the canonical "preview URL" that links to a fresh
-- copy of the branch. The row is the unit of dedupe (one row per
-- repo/branch pair) — pushing the branch again replaces commit_sha,
-- bumps build_started_at, and resets status to 'building'.
--
-- TTL: previews automatically transition to status='expired' 24h after
-- the last push to that branch. The autopilot expireOldPreviews() task
-- sweeps the table hourly.
--
-- Wrapped in DO blocks so the migration is safe to re-run and gracefully
-- ignores duplicates / missing parents on partial replays. The whole
-- feature degrades to "no rows" when the table is missing, which is
-- exactly what we want for environments without preview hosting.

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "branch_previews" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
    "branch_name" text NOT NULL,
    "commit_sha" text NOT NULL,
    "preview_url" text NOT NULL,
    "status" text NOT NULL DEFAULT 'building',
    "build_started_at" timestamptz NOT NULL DEFAULT now(),
    "build_completed_at" timestamptz,
    "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    "error_message" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'branch_previews create failed (%); preview URLs will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "branch_previews_repo_branch"
    ON "branch_previews" ("repository_id", "branch_name");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'branch_previews_repo_branch index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "branch_previews_repo_status"
    ON "branch_previews" ("repository_id", "status");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'branch_previews_repo_status index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "branch_previews_expires"
    ON "branch_previews" ("expires_at")
    WHERE "status" IN ('building', 'ready');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'branch_previews_expires index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "repositories"
    ADD COLUMN IF NOT EXISTS "preview_builds_enabled" boolean NOT NULL DEFAULT true;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'repositories.preview_builds_enabled add failed (%)', SQLERRM;
END $$;

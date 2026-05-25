-- Gluecron migration 0068: AI-tracked documentation sections.
--
-- A markdown file (typically README.md) can contain regions delimited by
-- HTML-comment markers like:
--
--   <!-- gluecron:doc-track src=src/lib/auth.ts -->
--   This module exports `signIn` and `signUp` — see the source for details.
--   <!-- /gluecron:doc-track -->
--
-- Each region tracks the live hash of the referenced source file. When the
-- hash drifts, src/lib/ai-doc-updater.ts asks Claude to refresh the prose
-- and opens a PR tagged `ai:doc-update`.
--
-- This table stores the *currently claimed* hash so we can detect drift
-- without re-reading every region on every push. The unique constraint on
-- (repo, doc_path, section_marker) keeps one row per region; pushes UPSERT
-- the latest content hash through it.
--
-- Wrapped in DO blocks so the migration is safe to re-run and gracefully
-- ignores missing parents on partial replays. The whole feature degrades
-- to "no rows" when the table is missing, which is exactly what we want
-- for environments that haven't migrated yet.

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "doc_tracking" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
    "doc_path" text NOT NULL,
    "section_marker" text NOT NULL,
    "src_path" text NOT NULL,
    "claimed_hash" text NOT NULL,
    "last_checked_at" timestamptz NOT NULL DEFAULT now(),
    "last_pr_id" uuid REFERENCES "pull_requests"("id") ON DELETE SET NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'doc_tracking create failed (%); ai-doc-updater will degrade to no-op', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "doc_tracking_repo_doc_marker"
    ON "doc_tracking" ("repository_id", "doc_path", "section_marker");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'doc_tracking_repo_doc_marker index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "doc_tracking_repo"
    ON "doc_tracking" ("repository_id");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'doc_tracking_repo index failed (%)', SQLERRM;
END $$;

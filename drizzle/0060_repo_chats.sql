-- Gluecron migration 0060: AI repo rubber-duck chat tables.
--
-- Per-repo, per-user conversational threads grounded in the semantic
-- index (see src/lib/semantic-index.ts). Distinct from the older
-- `ai_chats` table, which is a JSON-blob single-row design that pre-
-- dates streaming. The new model stores one row per message so we
-- can stream partials, attach per-message citations, and track token
-- cost without rewriting the whole blob on each turn.
--
-- Wrapped in DO blocks so the migration is safe to re-run and
-- gracefully ignores duplicates / missing parents on partial replays.

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "repo_chats" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
    "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "title" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'repo_chats create failed (%); repo chat will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "repo_chats_owner_updated"
    ON "repo_chats" ("owner_user_id", "updated_at" DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'repo_chats_owner_updated index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "repo_chats_repo"
    ON "repo_chats" ("repository_id");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'repo_chats_repo index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "repo_chat_messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "chat_id" uuid NOT NULL REFERENCES "repo_chats"("id") ON DELETE CASCADE,
    "role" text NOT NULL,
    "content" text NOT NULL,
    "citations" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "token_cost" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'repo_chat_messages create failed (%); repo chat will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "repo_chat_messages_chat_created"
    ON "repo_chat_messages" ("chat_id", "created_at" ASC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'repo_chat_messages_chat_created index failed (%)', SQLERRM;
END $$;

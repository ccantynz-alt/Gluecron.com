-- Gluecron migration 0071: Personal cross-repo semantic index opt-in.
--
-- Today the semantic index (drizzle/0057) is per-repo: searchSemantic()
-- only ranks rows where code_embeddings.repository_id matches one repo.
-- This migration adds:
--
--   1. users.personal_semantic_index_enabled — opt-in flag. Off by
--      default. The personal cross-repo search refuses to run until the
--      user explicitly enables it via /settings/personal-semantic-toggle.
--   2. personal_chats — user-scoped chat threads (no repository_id).
--      Same shape as repo_chats but owner_user_id is the only scope key.
--   3. personal_chat_messages — mirrors repo_chat_messages exactly so
--      the streaming + citations contract is shared.
--
-- All statements wrapped in DO blocks so the migration is idempotent and
-- degrades cleanly on partial replays.

--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "personal_semantic_index_enabled" boolean NOT NULL DEFAULT false;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'users.personal_semantic_index_enabled add failed (%); cross-repo chat will be disabled', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "personal_chats" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "title" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'personal_chats create failed (%); personal chat will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "personal_chats_owner_updated"
    ON "personal_chats" ("owner_user_id", "updated_at" DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'personal_chats_owner_updated index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "personal_chat_messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "chat_id" uuid NOT NULL REFERENCES "personal_chats"("id") ON DELETE CASCADE,
    "role" text NOT NULL,
    "content" text NOT NULL,
    "citations" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "token_cost" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'personal_chat_messages create failed (%); personal chat will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "personal_chat_messages_chat_created"
    ON "personal_chat_messages" ("chat_id", "created_at" ASC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'personal_chat_messages_chat_created index failed (%)', SQLERRM;
END $$;

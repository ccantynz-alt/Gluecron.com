-- Gluecron migration 0074: Claude-on-the-web sessions (Block CW).
--
-- Per-repo interactive Claude Code sessions runnable from any browser
-- (including iPad). Each session owns:
--   - A working directory on the gluecron web server (cloned from the
--     repo's bare git store) where Claude can read + edit files.
--   - A persistent transcript of user/assistant messages.
--   - The Claude CLI session UUID so subsequent turns `--resume` it and
--     keep full prior-turn context without us re-sending the transcript.
--
-- Admin-only in v1 (the route gates on isSiteAdmin). Customer-facing
-- rollout will scope by owner_user_id and run in real containers — for
-- v1 every session shares the web server's compute.
--
-- All DDL wrapped in DO blocks so partial replays are safe.

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "claude_web_sessions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
    "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "title" text NOT NULL DEFAULT 'New session',
    "branch" text NOT NULL DEFAULT 'main',
    "workdir_path" text NOT NULL,
    "claude_session_id" text,
    "status" text NOT NULL DEFAULT 'cold',
    "last_active_at" timestamptz NOT NULL DEFAULT now(),
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS "claude_web_sessions_repo_idx"
    ON "claude_web_sessions"("repository_id", "last_active_at" DESC);
  CREATE INDEX IF NOT EXISTS "claude_web_sessions_owner_idx"
    ON "claude_web_sessions"("owner_user_id", "last_active_at" DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'claude_web_sessions create failed (%); feature will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "claude_web_messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "session_id" uuid NOT NULL REFERENCES "claude_web_sessions"("id") ON DELETE CASCADE,
    "role" text NOT NULL,
    "body" text NOT NULL,
    "exit_code" integer,
    "duration_ms" integer,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS "claude_web_messages_session_idx"
    ON "claude_web_messages"("session_id", "created_at");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'claude_web_messages create failed (%);', SQLERRM;
END $$;

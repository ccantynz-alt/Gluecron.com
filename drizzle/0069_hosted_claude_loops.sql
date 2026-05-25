-- Gluecron migration 0069: hosted Claude tool-use loops.
--
-- Users paste a Claude-flavoured tool-use loop at /connect/claude/deploy,
-- pick a budget cap, and get back a hosted endpoint that runs the code in
-- a sandboxed Bun subprocess on demand. Each loop is paired to an
-- agent_sessions row so it inherits multiplayer namespacing + the daily
-- budget mutex from src/lib/agent-multiplayer.ts.
--
--   hosted_claude_loops      — one row per deployed loop
--   hosted_claude_loop_runs  — one row per invocation
--
-- Wrapped in DO blocks so the migration is safe to re-run and degrades
-- gracefully when (e.g.) the agent_sessions table is missing on a partial
-- replay. Helpers in src/lib/hosted-claude-loop.ts already return null /
-- empty when these tables are absent.

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "hosted_claude_loops" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "source_code" text NOT NULL,
    "endpoint_path" text NOT NULL UNIQUE,
    "agent_session_id" uuid REFERENCES "agent_sessions"("id") ON DELETE SET NULL,
    "status" text NOT NULL DEFAULT 'paused',
    "is_public" boolean NOT NULL DEFAULT false,
    "monthly_budget_cents" integer NOT NULL DEFAULT 500,
    "last_run_at" timestamptz,
    "total_invocations" integer NOT NULL DEFAULT 0,
    "total_cents_spent" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'hosted_claude_loops create failed (%); /connect/claude/deploy will degrade to empty', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "hosted_claude_loops_owner"
    ON "hosted_claude_loops" ("owner_user_id", "updated_at" DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'hosted_claude_loops_owner index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "hosted_claude_loops_status"
    ON "hosted_claude_loops" ("status");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'hosted_claude_loops_status index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "hosted_claude_loop_runs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "loop_id" uuid NOT NULL REFERENCES "hosted_claude_loops"("id") ON DELETE CASCADE,
    "input_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "output_payload" jsonb,
    "stdout" text,
    "stderr" text,
    "started_at" timestamptz NOT NULL DEFAULT now(),
    "finished_at" timestamptz,
    "status" text NOT NULL DEFAULT 'running',
    "cents_estimate" integer NOT NULL DEFAULT 0,
    "claude_input_tokens" integer NOT NULL DEFAULT 0,
    "claude_output_tokens" integer NOT NULL DEFAULT 0,
    "exit_code" integer,
    "error_message" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'hosted_claude_loop_runs create failed (%); run history will be unavailable', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "hosted_claude_loop_runs_loop_time"
    ON "hosted_claude_loop_runs" ("loop_id", "started_at" DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'hosted_claude_loop_runs_loop_time index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "hosted_claude_loop_runs_status"
    ON "hosted_claude_loop_runs" ("status", "started_at" DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'hosted_claude_loop_runs_status index failed (%)', SQLERRM;
END $$;

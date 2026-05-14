-- Block R2 — Live deploy log streaming.
--
-- Extends Block N3's `platform_deploys` timeline with per-step state so the
-- /admin/deploys modal can show "git pull → bun install → build → restart →
-- smoke test" in real time via SSE.
--
-- Strictly additive (drop the new column + table to remove). N3's table is
-- listed in BUILD_BIBLE.md §4.6 as locked; we add columns + a sibling child
-- table without renaming or repurposing any existing columns.
--
-- Wire contract:
--   POST /api/events/deploy/step
--     Authorization: Bearer ${DEPLOY_EVENT_TOKEN}
--     Body: {
--       run_id, sha, step_name,
--       status: "in_progress" | "succeeded" | "failed",
--       output?, duration_ms?
--     }
--
-- Idempotency is on (deploy_id, step_name, status) — replaying the same
-- transition is a no-op. The endpoint also publishes an SSE event on
--   topic = `platform:deploys:<run_id>`
-- which the modal subscribes to via /live-events/:topic.

ALTER TABLE platform_deploys
  ADD COLUMN IF NOT EXISTS last_step text,
  ADD COLUMN IF NOT EXISTS step_count integer NOT NULL DEFAULT 0;

--> statement-breakpoint

-- Per-step audit trail. Optional; we publish via SSE for live consumption
-- but persist a record so refreshing the page during a deploy still shows
-- the latest known state.
CREATE TABLE IF NOT EXISTS platform_deploy_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deploy_id uuid NOT NULL REFERENCES platform_deploys(id) ON DELETE CASCADE,
  step_name text NOT NULL,
  status text NOT NULL,                    -- in_progress | succeeded | failed
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  output text,                              -- stdout/stderr first 8KB
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_platform_deploy_steps_deploy
  ON platform_deploy_steps (deploy_id, started_at);

--> statement-breakpoint

-- Idempotency key — POSTing the same (deploy_id, step_name, status) twice
-- short-circuits at the application layer (defensive); the partial index
-- makes the dedupe path index-only.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_platform_deploy_steps_transition
  ON platform_deploy_steps (deploy_id, step_name, status);

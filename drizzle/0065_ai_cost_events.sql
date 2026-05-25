-- Per-call AI cost tracking. Every successful Claude API call inserts one
-- row here so the /billing/usage dashboard can attribute cents/tokens back
-- to a user, repo, agent session, and feature category. Strictly additive —
-- nothing else reads or writes this table (yet); the tracker is best-effort
-- and the recordAiCost call site is wrapped in try/catch.
--
-- Columns:
--   id                 — primary key, gen_random_uuid()
--   occurred_at        — when the model returned. UTC.
--   owner_user_id      — nullable; the user the cost belongs to (PAT owner,
--                        session user, etc.). Nullable for system/cron calls
--                        with no human attribution (e.g. autopilot tasks
--                        running before a user is associated).
--   repository_id      — nullable; the repo the call relates to (PR review,
--                        repo chat, CI healer, etc.). Nullable for global
--                        spend (e.g. proactive monitor).
--   agent_session_id   — nullable; the agent session that initiated the call
--                        (for /settings/agents budget enforcement).
--   model              — Claude model id, e.g. "claude-sonnet-4-20250514".
--   input_tokens       — Anthropic .usage.input_tokens for this call.
--   output_tokens      — Anthropic .usage.output_tokens for this call.
--   cents_estimate     — derived from the in-process pricing table at the
--                        time of insert. Stored so historical aggregates
--                        stay stable even when pricing changes.
--   category           — feature classification: ai_review | ai_patch |
--                        ci_healer | spec_to_pr | standup | chat | voice |
--                        test_gen | refactor | other
--   source_id          — opaque correlation id (PR id, chat id, run id…).
--   source_kind        — optional sub-category (e.g. "pull_request",
--                        "workflow_run") for the table-level grouping in
--                        the UI breakdown.
--   created_at         — row insert time (independent of occurred_at).

CREATE TABLE IF NOT EXISTS ai_cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  repository_id uuid REFERENCES repositories(id) ON DELETE SET NULL,
  agent_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cents_estimate integer NOT NULL DEFAULT 0,
  category text NOT NULL DEFAULT 'other',
  source_id text,
  source_kind text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "show me this user's spend for the last 30 days bucketed by day".
-- A composite (owner_user_id, occurred_at) index covers the most-common
-- WHERE + ORDER BY combination on the dashboard.
CREATE INDEX IF NOT EXISTS ai_cost_events_owner_time
  ON ai_cost_events (owner_user_id, occurred_at DESC);

-- Per-repo breakdown ("which repo is burning the most $?")
CREATE INDEX IF NOT EXISTS ai_cost_events_repo_time
  ON ai_cost_events (repository_id, occurred_at DESC);

-- Per-agent breakdown (drives the agents budget surface).
CREATE INDEX IF NOT EXISTS ai_cost_events_agent_time
  ON ai_cost_events (agent_session_id, occurred_at DESC);

-- Optional: category-rollup queries on big windows.
CREATE INDEX IF NOT EXISTS ai_cost_events_category_time
  ON ai_cost_events (category, occurred_at DESC);

-- ai_budgets — per-user monthly budget cap (cents). One row per user.
-- Used by /billing/usage to draw the "exceeded" warning banner when
-- projected month-end spend exceeds the cap. Hard enforcement is out of
-- scope for this migration; the dashboard is observational + advisory.
CREATE TABLE IF NOT EXISTS ai_budgets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_cents integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

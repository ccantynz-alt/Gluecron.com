-- Live co-editing on PRs — presence + cursor + content sync.
--
-- A `pr_live_sessions` row represents a single browser tab (or agent
-- runtime) actively editing a PR's description, comments, or inline
-- diff annotations. The SSE endpoint at /api/v2/pulls/:prId/live
-- fans presence + cursor + content patches out to every subscriber
-- on the same PR.
--
-- Either `user_id` OR `agent_session_id` is non-null (XOR-ish at the
-- app layer; the DB just keeps both nullable so the same table can
-- represent humans and AI agents in one stream). `color` is a stable
-- per-user hue picked deterministically by the lib so concurrent tabs
-- of the same user share a colour and the cursor ribbon stays steady.
--
-- `cursor_position` is JSON shaped like:
--   { "field": "description" | "comment_<uuid>" | "line_<path>:<n>",
--     "range": { "start": number, "end": number } }
-- We keep this opaque at the DB layer so future field types (e.g. a
-- new "review_summary" textarea) don't require a migration.
--
-- Lifecycle:
--   joined_at      — when the session was first registered.
--   last_seen_at   — touched by every heartbeat (15s cadence from the
--                    client) and every cursor/edit broadcast.
--   status         — 'active' | 'idle' (>60s no heartbeat) | 'left'
--                    (>5m no heartbeat or explicit leave).
-- The autopilot pr-live-cleanup task transitions stale rows; the SSE
-- subscriber also lazily updates status when it notices a stale peer.

CREATE TABLE IF NOT EXISTS pr_live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  agent_session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE,
  cursor_position jsonb,
  color text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active'
);

-- Active-presence lookup: "who is here on PR X right now?" — answered
-- in O(1) by this partial index. Status transitions to 'left' drop the
-- row from the index automatically.
CREATE INDEX IF NOT EXISTS pr_live_sessions_active_pr
  ON pr_live_sessions (pr_id, last_seen_at)
  WHERE status <> 'left';

-- Stale-sweep lookup: the autopilot cleanup task scans rows whose
-- last_seen_at is older than the idle/left thresholds.
CREATE INDEX IF NOT EXISTS pr_live_sessions_status_seen
  ON pr_live_sessions (status, last_seen_at);

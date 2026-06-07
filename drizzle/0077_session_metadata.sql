-- Migration 0077: Add IP address, user-agent, and last-seen timestamp to sessions.
-- Powers the /settings/sessions management page (SOC 2 session visibility).

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS ip         text,
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamp;

-- Chat integrations — Slack, Discord, Teams.
--
-- One row per (owner, kind, team, channel) triple. The same Gluecron user can
-- bind multiple workspaces (e.g. their personal Slack + their company Slack)
-- and multiple channels per workspace; uniqueness across all four columns
-- prevents accidental duplicates on a re-install.
--
-- Columns of note:
--   * `kind`            — 'slack' | 'discord' | 'teams'. Validation lives in
--                         src/lib/chat-bot.ts; we keep the DB column free-form
--                         so adding a fourth provider only needs a code change.
--   * `team_id`         — Slack team_id / Discord guild_id / Teams tenant_id.
--                         Nullable for bot installs that don't expose one.
--   * `channel_id`      — Per-channel pinning. Nullable for "post to default".
--   * `webhook_url`     — Outbound Incoming-Webhook URL (Slack, Discord).
--                         For Teams this stores the connector URL.
--   * `signing_secret`  — Inbound signature verification key. Slack uses HMAC
--                         SHA-256; Discord uses Ed25519 (the public key goes
--                         here). Nullable for installs that only push out.
--
-- The unique index uses COALESCE so NULL slots collapse to the empty string,
-- which keeps "one default-channel binding per workspace" enforceable while
-- still letting an admin re-install cleanly.

CREATE TABLE IF NOT EXISTS chat_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  team_id text,
  channel_id text,
  webhook_url text,
  signing_secret text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  last_used_at timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_integrations_unique
  ON chat_integrations (
    owner_user_id,
    kind,
    COALESCE(team_id, ''),
    COALESCE(channel_id, '')
  );

CREATE INDEX IF NOT EXISTS chat_integrations_owner
  ON chat_integrations (owner_user_id, kind);

CREATE INDEX IF NOT EXISTS chat_integrations_enabled
  ON chat_integrations (enabled)
  WHERE enabled = true;

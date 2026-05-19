-- /admin/integrations — DB-stored platform integration secrets.
--
-- Replaces the SSH-into-the-box workflow for runtime-changeable keys
-- (ANTHROPIC_API_KEY, RESEND_API_KEY, GITHUB_TOKEN, etc.). The boot
-- hook in src/index.ts loads every row into process.env BEFORE any
-- module reads it, so existing synchronous `config.X` getters keep
-- working unchanged.
--
-- Strictly additive: nothing else reads or writes this table.

CREATE TABLE IF NOT EXISTS system_config (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_system_config_updated_at
  ON system_config (updated_at DESC);

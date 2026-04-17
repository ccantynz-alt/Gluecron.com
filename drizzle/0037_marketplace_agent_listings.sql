-- Block K10 — Agent marketplace listings.
-- Publisher-curated directory of installable K-agents. Each listing references
-- an existing agent app/bot (from Block H/K2) so installs reuse the mature
-- agent-identity flow (`installAgentForRepo`, `issueAgentToken`, `uninstallAgent`).

CREATE TABLE IF NOT EXISTS marketplace_agent_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  tagline text NOT NULL,
  description text NOT NULL DEFAULT '',
  publisher_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  app_bot_id uuid NOT NULL REFERENCES app_bots(id) ON DELETE CASCADE,
  kind text NOT NULL,  -- one of: triage, fix, review, heal_bot, deploy_watch, custom
  homepage_url text,
  icon_url text,
  pricing_cents_per_month integer NOT NULL DEFAULT 0,
  published boolean NOT NULL DEFAULT false,
  install_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_agent_listings_published_idx
  ON marketplace_agent_listings (published, install_count DESC);

CREATE INDEX IF NOT EXISTS marketplace_agent_listings_publisher_idx
  ON marketplace_agent_listings (publisher_user_id);

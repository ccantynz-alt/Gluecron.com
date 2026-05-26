-- Agent Marketplace — third-party AI agents that users one-click-install per
-- repo. Builds on `agent_sessions` (0058): every install provisions a
-- fresh agent_session whose `branch_namespace` and `budget_cents_per_day`
-- are seeded from the listing's `agent_template`. We take a 30% cut on
-- paid invocations (`price_cents`, charged through ai_cost_events).
--
-- Three tables:
--   agent_marketplace_listings — the catalog row a publisher creates.
--   agent_marketplace_installs — link table: which listing is wired to
--                                which repo (+ which agent_session it
--                                provisioned). UNIQUE on (listing_id,
--                                repository_id) so we can't double-install.
--   agent_marketplace_reviews  — 1-5 star ratings + body.

CREATE TABLE IF NOT EXISTS agent_marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The user who published this listing and is paid out (after our 30%).
  publisher_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- URL-safe slug. Globally unique so /marketplace/agents/<slug> is stable.
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  -- One-line teaser shown in the catalog grid.
  tagline text NOT NULL DEFAULT '',
  -- Markdown description shown on the detail page.
  description text NOT NULL DEFAULT '',
  -- Closed vocabulary, validated in the lib:
  --   reviewer | tester | migrator | security | docs | custom
  category text NOT NULL DEFAULT 'custom',
  -- Closed vocabulary:
  --   per_invocation  — charge once per agent action (price_cents)
  --   per_repo_per_month — flat monthly subscription per install
  --   free            — price_cents is ignored
  pricing_model text NOT NULL DEFAULT 'free',
  price_cents integer NOT NULL DEFAULT 0,
  -- Defaults the install flow seeds into the new agent_session.
  -- Recognised keys: branchNamespace, budgetCentsPerDay, capabilities[].
  agent_template jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_url text,
  -- Moderation state: draft | pending_review | approved | rejected.
  status text NOT NULL DEFAULT 'draft',
  install_count integer NOT NULL DEFAULT 0,
  -- Aggregated rating. Updated after every review insert.
  rating_avg numeric(3, 2) NOT NULL DEFAULT 0,
  rating_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_marketplace_listings_category
  ON agent_marketplace_listings (category, status);

CREATE INDEX IF NOT EXISTS agent_marketplace_listings_rating
  ON agent_marketplace_listings (rating_avg DESC, rating_count DESC);

CREATE INDEX IF NOT EXISTS agent_marketplace_listings_installs
  ON agent_marketplace_listings (install_count DESC);

CREATE INDEX IF NOT EXISTS agent_marketplace_listings_publisher
  ON agent_marketplace_listings (publisher_user_id);

CREATE INDEX IF NOT EXISTS agent_marketplace_listings_status_created
  ON agent_marketplace_listings (status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_marketplace_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL
    REFERENCES agent_marketplace_listings(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL
    REFERENCES repositories(id) ON DELETE CASCADE,
  installed_by_user_id uuid NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  -- The agent_session provisioned at install time. Killed when the install
  -- flips to 'uninstalled'.
  agent_session_id uuid
    REFERENCES agent_sessions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',  -- active | paused | uninstalled
  installed_at timestamptz NOT NULL DEFAULT now(),
  last_invoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Can't install the same listing on the same repo twice.
CREATE UNIQUE INDEX IF NOT EXISTS agent_marketplace_installs_listing_repo
  ON agent_marketplace_installs (listing_id, repository_id);

CREATE INDEX IF NOT EXISTS agent_marketplace_installs_repo
  ON agent_marketplace_installs (repository_id, status);

CREATE INDEX IF NOT EXISTS agent_marketplace_installs_installer
  ON agent_marketplace_installs (installed_by_user_id);

CREATE TABLE IF NOT EXISTS agent_marketplace_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL
    REFERENCES agent_marketplace_listings(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  rating integer NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_marketplace_reviews_listing_created
  ON agent_marketplace_reviews (listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_marketplace_reviews_reviewer
  ON agent_marketplace_reviews (reviewer_user_id);

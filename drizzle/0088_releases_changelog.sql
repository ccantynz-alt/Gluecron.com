-- Migration 0077: ensure the releases table and its index exist.
-- The table was first created in 0001_green_ecosystem.sql; this migration
-- is a no-op guard so the AI Changelog Generator feature can declare its
-- own dependency cleanly, and so fresh deploys from a stripped-down seed
-- always get the table even if 0001 is re-run in a different order.

CREATE TABLE IF NOT EXISTS releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  tag text NOT NULL,
  name text NOT NULL,
  body text,
  target_commit text NOT NULL,
  is_draft boolean DEFAULT false NOT NULL,
  is_prerelease boolean DEFAULT false NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  published_at timestamp,
  UNIQUE(repository_id, tag)
);

CREATE INDEX IF NOT EXISTS releases_repo ON releases(repository_id, created_at DESC);

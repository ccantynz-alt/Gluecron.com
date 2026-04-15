-- Block J13 — Pinned repositories on user profile.
--
-- Users can pin up to 6 repositories that appear at the top of their
-- profile page. Ordering is explicit via `position` (0-indexed).

CREATE TABLE IF NOT EXISTS "pinned_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "position" integer NOT NULL DEFAULT 0,
  "pinned_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "pinned_repositories_user_repo_unique"
  ON "pinned_repositories" ("user_id", "repository_id");

CREATE INDEX IF NOT EXISTS "pinned_repositories_user_position_idx"
  ON "pinned_repositories" ("user_id", "position");

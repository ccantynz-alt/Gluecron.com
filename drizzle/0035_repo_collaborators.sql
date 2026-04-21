-- Collaborators — per-repo role grants (read / write / admin).
--
-- A user granted access to a repository beyond ownership. Roles are
-- hierarchical: admin implies write, write implies read. `invited_by` tracks
-- who added them (nulled once that user is deleted); `accepted_at` is null
-- until the invitee explicitly accepts. Unique per (repo, user) so a given
-- user has at most one role per repo.

CREATE TABLE IF NOT EXISTS "repo_collaborators" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'read' CHECK (role IN ('read', 'write', 'admin')),
  "invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "invited_at" timestamp NOT NULL DEFAULT now(),
  "accepted_at" timestamp
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "repo_collaborators_repo_user_uq"
  ON "repo_collaborators" ("repository_id", "user_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "repo_collaborators_repo_idx"
  ON "repo_collaborators" ("repository_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "repo_collaborators_user_idx"
  ON "repo_collaborators" ("user_id");

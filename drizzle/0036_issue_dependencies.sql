-- Block J14 — Issue dependencies / blocked-by relationships.
--
-- One row = "blocker blocks blocked". The dependency is considered resolved
-- when the blocker issue is closed. Both issues must belong to the same repo
-- (enforced at the application layer).

CREATE TABLE IF NOT EXISTS "issue_dependencies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "blocker_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "blocked_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "issue_dep_no_self" CHECK ("blocker_issue_id" <> "blocked_issue_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "issue_deps_blocker_blocked_unique"
  ON "issue_dependencies" ("blocker_issue_id", "blocked_issue_id");

CREATE INDEX IF NOT EXISTS "issue_deps_blocked_idx"
  ON "issue_dependencies" ("blocked_issue_id");

CREATE INDEX IF NOT EXISTS "issue_deps_blocker_idx"
  ON "issue_dependencies" ("blocker_issue_id");

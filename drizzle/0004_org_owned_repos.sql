-- Gluecron migration 0004: Block B2 — repositories can be owned by an org.
-- Adds repositories.org_id (nullable) + partial unique indexes so a user and
-- an org can each have a repo named "web" without collision, but two orgs
-- (or two users) still cannot.

--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "org_id" uuid;

--> statement-breakpoint
ALTER TABLE "repositories"
  DROP CONSTRAINT IF EXISTS "repositories_org_id_fk";

--> statement-breakpoint
ALTER TABLE "repositories"
  ADD CONSTRAINT "repositories_org_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

--> statement-breakpoint
-- Existing unique index was on (owner_id, name) across all rows. That would
-- block the same user from creating a personal "web" AND an org-owned "web"
-- where they happen to be the listed creator. Make it partial so it only
-- enforces uniqueness within the user namespace.
DROP INDEX IF EXISTS "repos_owner_name";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repos_owner_name"
  ON "repositories" ("owner_id", "name")
  WHERE "org_id" IS NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repos_org_name"
  ON "repositories" ("org_id", "name")
  WHERE "org_id" IS NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_org" ON "repositories" ("org_id");

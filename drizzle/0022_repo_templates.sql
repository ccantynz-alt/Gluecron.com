-- Gluecron migration 0022: Template repositories + transfer history.
--
-- I2 — Template repositories. Owners can flag a repo as a "template" via
-- settings; other users can then click "Use this template" to create a new
-- repo seeded from the template's disk state. The seed flow is handled in
-- application code (repositories.ts); this migration just adds the column.
--
-- I3 — Repository transfer history (audit trail of ownership changes). The
-- primary `repositories.owner_id` / `org_id` fields carry the current owner;
-- this table records prior owners so a transferred repo can prove provenance.

--> statement-breakpoint
ALTER TABLE "repositories"
  ADD COLUMN IF NOT EXISTS "is_template" boolean NOT NULL DEFAULT false;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_is_template" ON "repositories" ("is_template") WHERE "is_template" = true;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "from_owner_id" uuid NOT NULL,
  "from_org_id" uuid,
  "to_owner_id" uuid NOT NULL,
  "to_org_id" uuid,
  "initiated_by" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "repo_transfers_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "repo_transfers_init_fk" FOREIGN KEY ("initiated_by") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_transfers_repo" ON "repo_transfers" ("repository_id", "created_at");

-- Gluecron migration 0018: Block E6 — Required status checks matrix.
--
-- The existing `branch_protection.requireGreenGates` flag only says "all
-- gates must pass". This matrix lets owners require SPECIFIC named checks
-- (workflow names or gate_run kinds) to pass for a branch pattern.
--
-- Tables:
--   branch_required_checks   — one row per (rule, check_name) pairing

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branch_required_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "branch_protection_id" uuid NOT NULL,
  "check_name" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "branch_required_checks_rule_fk" FOREIGN KEY ("branch_protection_id") REFERENCES "branch_protection"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_required_checks_rule" ON "branch_required_checks" ("branch_protection_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branch_required_checks_unique" ON "branch_required_checks" ("branch_protection_id", "check_name");

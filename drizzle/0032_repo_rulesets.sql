-- Block J6 — Repository rulesets.
--
-- Extends the legacy branch_protection table with a policy engine that can
-- scope rules at the repo (v1) or org level (future). Each ruleset groups
-- N rules; an evaluator short-circuits on enforcement=active with block=true
-- and merely logs when enforcement=evaluate.

CREATE TABLE IF NOT EXISTS "repo_rulesets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "enforcement" text NOT NULL DEFAULT 'active', -- 'active' | 'evaluate' | 'disabled'
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "repo_rulesets_repo_idx"
  ON "repo_rulesets" ("repository_id");
CREATE UNIQUE INDEX IF NOT EXISTS "repo_rulesets_repo_name_unique"
  ON "repo_rulesets" ("repository_id", "name");

CREATE TABLE IF NOT EXISTS "ruleset_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ruleset_id" uuid NOT NULL REFERENCES "repo_rulesets"("id") ON DELETE CASCADE,
  "rule_type" text NOT NULL,
  "params" text NOT NULL DEFAULT '{}', -- JSON
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ruleset_rules_set_idx"
  ON "ruleset_rules" ("ruleset_id");

-- Block K8 — Per-repo agent enable toggles + budget caps.
--
-- Stores which agent kinds are allowed to run against a repository plus the
-- operator's cost guardrails (daily $, monthly $, max runs/hour) and a global
-- paused flag that acts as a per-repo kill-switch. Enforcement lives in the
-- agent dispatcher; this row is the configuration surface the inbox UI
-- writes to.
--
-- One row per repository — missing rows default to "agents disabled"
-- semantics at the caller level.

CREATE TABLE IF NOT EXISTS "repo_agent_settings" (
  "repository_id" uuid PRIMARY KEY REFERENCES "repositories"("id") ON DELETE CASCADE,
  "enabled_kinds" text NOT NULL DEFAULT '[]', -- JSON array of AgentKind strings
  "daily_budget_cents" integer NOT NULL DEFAULT 100,
  "monthly_budget_cents" integer NOT NULL DEFAULT 2000,
  "max_runs_per_hour" integer NOT NULL DEFAULT 20,
  "paused" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

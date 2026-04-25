-- AI flywheel + third-party integrations registry.
--
-- Two strictly-additive tables:
--
--   ai_activity        Telemetry for every AI invocation in the platform.
--                      Powers the live dashboard at /ai/live, the per-repo
--                      "AI in action" panel, and future learning loops
--                      (cost tracking, prompt regression, repair patterns).
--                      Insert-only; trimmed by retention policy at app level.
--
--   integrations       Third-party product connectors (Slack / Linear /
--                      Vercel / Discord / Jira / PagerDuty / Sentry /
--                      Datadog / Figma / Cursor). Repo-scoped for v1.
--                      `config` is a JSON blob with the connector-specific
--                      fields (webhook URL, channel, project key, etc).
--                      Secret components live in dedicated columns so we
--                      can rotate / redact without parsing JSON.

CREATE TABLE IF NOT EXISTS "ai_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "action_type" text NOT NULL,             -- 'review' | 'repair' | 'completion' | 'incident' | 'triage' | 'explain' | 'test' | 'changelog' | 'chat' | 'spec' | ...
  "model" text NOT NULL,                   -- model id at invocation time
  "repository_id" uuid REFERENCES "repositories"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "pull_request_id" uuid REFERENCES "pull_requests"("id") ON DELETE SET NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "commit_sha" text,                       -- optional anchor for repair / review
  "summary" text NOT NULL,                 -- short human-readable line
  "input_tokens" integer,                  -- nullable when not reported by SDK
  "output_tokens" integer,
  "latency_ms" integer NOT NULL,
  "success" boolean NOT NULL DEFAULT true,
  "error" text,                            -- redacted message when success=false
  "metadata" jsonb,                        -- free-form (file paths, repair counts, etc.)
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ai_activity_created_idx"
  ON "ai_activity" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "ai_activity_repo_idx"
  ON "ai_activity" ("repository_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "ai_activity_user_idx"
  ON "ai_activity" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "ai_activity_action_idx"
  ON "ai_activity" ("action_type", "created_at" DESC);


CREATE TABLE IF NOT EXISTS "integrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,                    -- 'slack' | 'linear' | 'vercel' | 'discord' | 'jira' | 'pagerduty' | 'sentry' | 'datadog' | 'figma' | 'cursor' | 'generic_webhook'
  "name" text NOT NULL,                    -- user label, e.g. "Eng channel"
  "enabled" boolean NOT NULL DEFAULT true,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "events" jsonb NOT NULL DEFAULT '[]'::jsonb,  -- array of event kinds to forward
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "last_delivery_at" timestamp,
  "last_status" text                        -- 'ok' | 'fail' | NULL (never delivered)
);

CREATE INDEX IF NOT EXISTS "integrations_repo_idx"
  ON "integrations" ("repository_id");

CREATE INDEX IF NOT EXISTS "integrations_kind_idx"
  ON "integrations" ("kind");

CREATE UNIQUE INDEX IF NOT EXISTS "integrations_repo_name_unique"
  ON "integrations" ("repository_id", "name");


CREATE TABLE IF NOT EXISTS "integration_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "integration_id" uuid NOT NULL REFERENCES "integrations"("id") ON DELETE CASCADE,
  "event" text NOT NULL,
  "status" text NOT NULL,                   -- 'ok' | 'fail' | 'skipped'
  "http_status" integer,
  "error" text,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "integration_deliveries_integration_idx"
  ON "integration_deliveries" ("integration_id", "created_at" DESC);

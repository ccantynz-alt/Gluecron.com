-- Migration 0077: Incident hook configs for PagerDuty/Datadog/Opsgenie/generic
CREATE TABLE IF NOT EXISTS incident_hook_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  provider text NOT NULL, -- 'pagerduty' | 'datadog' | 'opsgenie' | 'generic'
  secret_hash text NOT NULL, -- SHA-256 of the webhook secret for HMAC validation
  created_at timestamp DEFAULT now(),
  UNIQUE(repo_id, provider)
);

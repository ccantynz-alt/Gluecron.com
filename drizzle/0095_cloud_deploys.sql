-- Migration 0077: Multi-cloud deploy integration
-- Adds cloud_deploy_configs and cloud_deployments tables for push-triggered
-- deploys to Fly.io, Railway, Render, Vercel, Netlify, and generic webhooks.

CREATE TABLE IF NOT EXISTS cloud_deploy_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  provider text NOT NULL, -- 'fly' | 'railway' | 'render' | 'vercel' | 'netlify' | 'webhook'
  provider_app_id text NOT NULL,  -- Fly app name, Railway service ID, Render service ID, Vercel project ID, webhook URL
  api_token_encrypted text NOT NULL, -- AES-256-GCM encrypted via SERVER_TARGETS_KEY
  trigger_branch text NOT NULL DEFAULT 'main',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES cloud_deploy_configs(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_sha text NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending | running | success | failed | cancelled
  provider_deploy_id text, -- provider's deployment ID for tracking
  log_url text,
  deploy_url text, -- live URL after success
  error_message text,
  started_at timestamp DEFAULT now(),
  completed_at timestamp,
  duration_ms integer
);

CREATE INDEX IF NOT EXISTS cloud_deployments_repo ON cloud_deployments(repo_id, started_at DESC);
CREATE INDEX IF NOT EXISTS cloud_deployments_config ON cloud_deployments(config_id, started_at DESC);

-- Migration 0077: Enterprise SSO (SAML 2.0 + OIDC per-org) and SCIM user provisioning
-- Org-level SSO configs (distinct from site-wide sso_config / Block I10)

CREATE TABLE IF NOT EXISTS org_sso_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'saml', -- 'saml' | 'oidc'
  -- SAML fields
  idp_entity_id text,
  idp_sso_url text,
  idp_certificate text,  -- PEM cert from IdP
  sp_entity_id text,     -- our entity ID (computed)
  -- OIDC fields
  oidc_client_id text,
  oidc_client_secret text,
  oidc_discovery_url text,
  -- Common
  domain_hint text,      -- e.g. "acme.com" — auto-routes users from this domain to SSO
  attribute_mapping jsonb DEFAULT '{"email":"email","name":"name","username":"preferred_username"}',
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  UNIQUE(org_id)
);

CREATE INDEX IF NOT EXISTS org_sso_configs_domain ON org_sso_configs(domain_hint) WHERE domain_hint IS NOT NULL;

CREATE TABLE IF NOT EXISTS scim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,  -- SHA-256 of the token
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamp DEFAULT now(),
  last_used_at timestamp
);

CREATE TABLE IF NOT EXISTS org_sso_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idp_session_id text,
  created_at timestamp DEFAULT now(),
  expires_at timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS org_sso_sessions_user ON org_sso_sessions(user_id);
CREATE INDEX IF NOT EXISTS org_sso_sessions_expires ON org_sso_sessions(expires_at);

-- Gluecron migration 0027: OIDC-based enterprise SSO.
--
-- I10 — A single site-wide OIDC provider (Okta / Azure AD / Auth0 / Google
-- Workspace). Identified by an `id = 'default'` singleton row. Admin fills
-- in issuer + endpoint URLs + client credentials. Users then see a
-- "Sign in with SSO" button on /login.
--
-- `sso_user_links` maps a local user to the provider's `sub` claim, so
-- repeat sign-ins find the existing account.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sso_config" (
  "id" text PRIMARY KEY,
  "enabled" boolean NOT NULL DEFAULT false,
  "provider_name" text NOT NULL DEFAULT 'SSO',
  "issuer" text,
  "authorization_endpoint" text,
  "token_endpoint" text,
  "userinfo_endpoint" text,
  "client_id" text,
  "client_secret" text,
  "scopes" text NOT NULL DEFAULT 'openid profile email',
  "allowed_email_domains" text, -- comma-separated, null = any
  "auto_create_users" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sso_user_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "subject" text NOT NULL UNIQUE,
  "email_at_link" text NOT NULL,
  "linked_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sso_user_links_user_id_idx"
  ON "sso_user_links" ("user_id");

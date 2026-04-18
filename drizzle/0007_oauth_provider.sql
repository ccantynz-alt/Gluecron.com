-- Gluecron migration 0007: Block B6 — OAuth 2.0 provider.
--
-- Tables:
--   oauth_apps          — third-party apps registered by developers
--   oauth_authorizations — short-lived authorization codes (single-use)
--   oauth_access_tokens  — long-lived bearer tokens + refresh tokens
--
-- All secrets / code / token values are stored as SHA-256 hex hashes.
-- Only the plaintext `clientSecret` is shown to the developer once at
-- creation; the plaintext auth code and tokens are returned to the client
-- in the OAuth response and never persisted.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "name" text NOT NULL,
  "client_id" text NOT NULL UNIQUE,
  "client_secret_hash" text NOT NULL,
  "client_secret_prefix" text NOT NULL,
  "redirect_uris" text NOT NULL,
  "homepage_url" text,
  "description" text,
  "confidential" boolean DEFAULT true NOT NULL,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_apps_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_apps_owner" ON "oauth_apps" ("owner_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "code_hash" text NOT NULL UNIQUE,
  "redirect_uri" text NOT NULL,
  "scopes" text NOT NULL DEFAULT '',
  "code_challenge" text,
  "code_challenge_method" text,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_authorizations_app_fk" FOREIGN KEY ("app_id") REFERENCES "oauth_apps"("id") ON DELETE cascade,
  CONSTRAINT "oauth_authorizations_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_authorizations_expires" ON "oauth_authorizations" ("expires_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_access_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "access_token_hash" text NOT NULL UNIQUE,
  "refresh_token_hash" text UNIQUE,
  "scopes" text NOT NULL DEFAULT '',
  "expires_at" timestamp NOT NULL,
  "refresh_expires_at" timestamp,
  "revoked_at" timestamp,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_access_tokens_app_fk" FOREIGN KEY ("app_id") REFERENCES "oauth_apps"("id") ON DELETE cascade,
  CONSTRAINT "oauth_access_tokens_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_user" ON "oauth_access_tokens" ("user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_app" ON "oauth_access_tokens" ("app_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_expires" ON "oauth_access_tokens" ("expires_at");

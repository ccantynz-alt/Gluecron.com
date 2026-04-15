-- Gluecron migration 0021: Block H — Marketplace + GitHub Apps equivalent.
--
-- H1 — App marketplace: creators register apps, users install them against
-- their personal account / org / individual repo. Each install grants a
-- concrete set of scopes (pull-read, issues-write, checks-write, etc.).
--
-- H2 — Bot identities: every marketplace app gets an "app user" that can
-- comment, open PRs, attach checks, etc. Bots authenticate with installation
-- tokens tied to a single installation and a time-window.
--
-- Tables:
--   apps                  — app definitions (slug, description, webhook, permissions)
--   app_installations     — app X (repo | org | user) with granted permissions
--   app_bots              — one bot account per app (username ends with `[bot]`)
--   app_install_tokens    — short-lived bearer tokens scoped to a single install
--   app_events            — audit trail of installs, uninstalls, events delivered

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,              -- url-safe, globally unique
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "icon_url" text,
  "homepage_url" text,
  "webhook_url" text,                       -- where events are delivered
  "webhook_secret" text,                    -- HMAC secret; shown once at create
  "creator_id" uuid NOT NULL,
  "permissions" text NOT NULL DEFAULT '[]', -- JSON array of permission names
  "default_events" text NOT NULL DEFAULT '[]', -- JSON array: push, issues, pulls…
  "is_public" boolean NOT NULL DEFAULT true, -- listed in /marketplace?
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "apps_creator_fk" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apps_public_slug" ON "apps" ("is_public", "slug");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL,
  "installed_by" uuid NOT NULL,             -- user who clicked install
  "target_type" text NOT NULL,              -- user | org | repository
  "target_id" uuid NOT NULL,
  "granted_permissions" text NOT NULL DEFAULT '[]', -- JSON subset of app.permissions
  "suspended_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "uninstalled_at" timestamp,
  CONSTRAINT "app_installations_app_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade,
  CONSTRAINT "app_installations_user_fk" FOREIGN KEY ("installed_by") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_installations_app" ON "app_installations" ("app_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_installations_target" ON "app_installations" ("target_type", "target_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_installations_unique" ON "app_installations" ("app_id", "target_type", "target_id") WHERE "uninstalled_at" IS NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_bots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL UNIQUE,
  "username" text NOT NULL UNIQUE,          -- `${app.slug}[bot]`
  "display_name" text NOT NULL,
  "avatar_url" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "app_bots_app_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_install_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_id" uuid NOT NULL,
  "token_hash" text NOT NULL UNIQUE,        -- sha256 of bearer
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "revoked_at" timestamp,
  CONSTRAINT "app_install_tokens_inst_fk" FOREIGN KEY ("installation_id") REFERENCES "app_installations"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_install_tokens_hash" ON "app_install_tokens" ("token_hash");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL,
  "installation_id" uuid,
  "kind" text NOT NULL,                     -- installed | uninstalled | delivery_ok | delivery_fail
  "payload" text,                           -- JSON, first 2048 chars
  "response_status" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "app_events_app_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_events_app_time" ON "app_events" ("app_id", "created_at");

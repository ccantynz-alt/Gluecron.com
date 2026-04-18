-- Gluecron migration 0020: Block F — Observability + admin.
--
-- Covers F1 (traffic analytics), F3 (admin panel), and F4 (billing/quotas).
-- F2 (org insights) is computed live from existing tables.
--
-- Tables:
--   repo_traffic_events   — view/clone events, 1 row per event. Rolled up via
--                           GROUP BY for daily/weekly charts.
--   system_flags          — simple key/value state for site-admin (e.g.
--                           "site_banner_text", "registration_locked"). Only
--                           site admins can write.
--   site_admins           — explicit list of user ids that are global admins.
--                           Absence of any row means "first user is admin"
--                           bootstrap (handled in code).
--   billing_plans         — plan catalogue (name, limits). Seeded with free.
--   user_quotas           — per-user usage counters + plan assignment. Writes
--                           are bumped from action paths (push bytes, ai tokens).

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_traffic_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "kind" text NOT NULL,                 -- view | clone | api | ui
  "path" text,                          -- path visited (first 256 chars)
  "user_id" uuid,                       -- null for anon
  "ip_hash" text,                       -- sha256(ip) prefix; best-effort uniq
  "user_agent" text,                    -- first 128 chars
  "referer" text,                       -- first 256 chars
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "repo_traffic_events_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "repo_traffic_events_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_traffic_events_repo_time" ON "repo_traffic_events" ("repository_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_traffic_events_kind" ON "repo_traffic_events" ("repository_id", "kind", "created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_flags" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL DEFAULT '',
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "system_flags_updater_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_admins" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "granted_at" timestamp DEFAULT now() NOT NULL,
  "granted_by" uuid,
  CONSTRAINT "site_admins_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "site_admins_granter_fk" FOREIGN KEY ("granted_by") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,          -- free | pro | team | enterprise
  "name" text NOT NULL,
  "price_cents" integer NOT NULL DEFAULT 0,
  "repo_limit" integer NOT NULL DEFAULT 10,
  "storage_mb_limit" integer NOT NULL DEFAULT 1024,
  "ai_tokens_monthly" integer NOT NULL DEFAULT 100000,
  "bandwidth_gb_monthly" integer NOT NULL DEFAULT 10,
  "private_repos" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_quotas" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "plan_slug" text NOT NULL DEFAULT 'free',
  "storage_mb_used" integer NOT NULL DEFAULT 0,
  "ai_tokens_used_this_month" integer NOT NULL DEFAULT 0,
  "bandwidth_gb_used_this_month" integer NOT NULL DEFAULT 0,
  "cycle_start" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_quotas_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
-- Seed the default plans.
INSERT INTO "billing_plans" ("slug","name","price_cents","repo_limit","storage_mb_limit","ai_tokens_monthly","bandwidth_gb_monthly","private_repos")
VALUES
  ('free','Free',0,10,1024,100000,10,false),
  ('pro','Pro',900,200,10240,1000000,100,true),
  ('team','Team',2400,1000,51200,5000000,500,true),
  ('enterprise','Enterprise',9900,10000,512000,50000000,5000,true)
ON CONFLICT (slug) DO NOTHING;

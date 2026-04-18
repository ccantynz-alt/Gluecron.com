-- Gluecron migration 0003: Block B1 — organizations + teams.
-- Schema is additive; does not touch existing tables.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "avatar_url" text,
  "billing_email" text,
  "created_by_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "organizations_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE restrict
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "org_members_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade,
  CONSTRAINT "org_members_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_members_unique" ON "org_members" ("org_id", "user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_user" ON "org_members" ("user_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "parent_team_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "teams_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_org_slug" ON "teams" ("org_id", "slug");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "team_members_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
  CONSTRAINT "team_members_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_members_unique" ON "team_members" ("team_id", "user_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_user" ON "team_members" ("user_id");

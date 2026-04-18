-- Gluecron migration 0005: Block B4 — TOTP 2FA + recovery codes.

--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "requires_2fa" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_totp" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "enabled_at" timestamp,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_totp_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "code_hash" text NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_recovery_codes_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_codes_user" ON "user_recovery_codes" ("user_id");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recovery_codes_user_hash" ON "user_recovery_codes" ("user_id", "code_hash");

-- Gluecron migration 0002:
--   - saved_replies (Block A6)
--   - users.notify_email_on_mention, users.notify_email_on_assign (Block A8)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_replies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "shortcut" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "saved_replies_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "saved_replies_user_shortcut" ON "saved_replies" ("user_id", "shortcut");

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_email_on_mention" boolean DEFAULT true NOT NULL;

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_email_on_assign" boolean DEFAULT true NOT NULL;

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_email_on_gate_fail" boolean DEFAULT true NOT NULL;

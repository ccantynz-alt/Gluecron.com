-- Gluecron migration 0006: Block B5 — WebAuthn passkeys.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_passkeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "credential_id" text NOT NULL UNIQUE,
  "public_key" text NOT NULL,
  "counter" integer DEFAULT 0 NOT NULL,
  "transports" text,
  "name" text NOT NULL DEFAULT 'Passkey',
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_passkeys_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkeys_user" ON "user_passkeys" ("user_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webauthn_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "session_key" text NOT NULL UNIQUE,
  "challenge" text NOT NULL,
  "kind" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "webauthn_challenges_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webauthn_challenges_expires" ON "webauthn_challenges" ("expires_at");

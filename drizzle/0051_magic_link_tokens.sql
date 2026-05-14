-- Block Q2 — Magic-link sign-in tokens.
--
-- One row per outstanding magic-link sign-in request. Mirrors the structure
-- of 0047_password_reset_tokens.sql and 0048_email_verification.sql — short
-- random plaintext mailed to the user, sha256 hash persisted, single-use,
-- time-limited (15-minute TTL enforced at consume time).
--
-- `user_id` is NULLABLE: when a user enters an email that does NOT yet have
-- an account, we still mint a token so consume can create the account on
-- click (autoCreate=true). The link click is the proof the email is owned.
--
-- Strictly additive — drop this table to remove the feature. No changes to
-- `users` are required; account auto-create happens via `users` INSERT in
-- `src/lib/magic-link.ts::consumeMagicLinkToken`.

CREATE TABLE IF NOT EXISTS "magic_link_tokens" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"       text NOT NULL,
  "user_id"     uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"  text NOT NULL UNIQUE,
  "expires_at"  timestamptz NOT NULL,
  "used_at"     timestamptz,
  "request_ip"  text,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_magic_link_tokens_email"
  ON "magic_link_tokens" ("email");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_magic_link_tokens_user"
  ON "magic_link_tokens" ("user_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_magic_link_tokens_expires"
  ON "magic_link_tokens" ("expires_at");

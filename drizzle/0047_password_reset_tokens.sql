-- Block P1 — Password reset flow.
--
-- A forgot-password user has a path back to their account. Without this,
-- every locked-out user is a permanent loss.
--
-- Strictly additive — drop this table to remove the feature. No changes
-- to `users`; password rotation happens via `users.password_hash` update
-- triggered by `src/lib/password-reset.ts::consumeResetToken`.

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"  text NOT NULL UNIQUE,
  "expires_at"  timestamptz NOT NULL,
  "used_at"     timestamptz,
  "request_ip"  text,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_user"
  ON "password_reset_tokens" ("user_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_expires"
  ON "password_reset_tokens" ("expires_at");

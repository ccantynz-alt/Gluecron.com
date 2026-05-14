-- Block P2 — Email verification + welcome email.
-- Strictly additive. Adds an opt-in verification timestamp to `users` and a
-- token table whose rows are SHA-256 hashed (we never persist plaintext).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,                 -- the email being verified (in case of email change)
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verify_tokens_user ON email_verification_tokens (user_id);

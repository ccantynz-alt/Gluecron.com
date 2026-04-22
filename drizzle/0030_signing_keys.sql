-- Block J3 — Commit signature verification (GPG + SSH "Verified" badge)
--
-- Users register GPG or SSH public keys bound to an email identity. When we
-- render a commit we extract the embedded signature, hash the key fingerprint
-- out of the PGP/SSH armored blob, and look it up here. A match paired with
-- an author email that the key declares → "Verified" badge.
--
-- Verifications are memoised in commit_verifications to avoid re-parsing the
-- raw commit object on every page view.

CREATE TABLE IF NOT EXISTS "signing_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key_type" text NOT NULL,                 -- 'gpg' | 'ssh'
  "title" text NOT NULL,
  "fingerprint" text NOT NULL,              -- lowercased hex (GPG) or base64 SHA256 (SSH)
  "public_key" text NOT NULL,               -- armored/authorized_keys form as uploaded
  "email" text,                             -- optional UID/comment email binding
  "expires_at" timestamp,
  "last_used_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "signing_keys_fp_unique"
  ON "signing_keys" ("key_type", "fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signing_keys_user_idx"
  ON "signing_keys" ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commit_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "commit_sha" text NOT NULL,
  "verified" boolean NOT NULL DEFAULT false,
  "reason" text NOT NULL,                   -- 'valid' | 'unsigned' | 'unknown_key' | 'expired' | 'bad_sig' | 'email_mismatch'
  "signature_type" text,                    -- 'gpg' | 'ssh' | null
  "signer_key_id" uuid REFERENCES "signing_keys"("id") ON DELETE SET NULL,
  "signer_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "signer_fingerprint" text,
  "verified_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "commit_verifications_sha_unique"
  ON "commit_verifications" ("repository_id", "commit_sha");

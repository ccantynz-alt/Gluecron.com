-- Org-level secrets: apply to all repos in an org (or a selected subset)
CREATE TABLE "org_secrets" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"         UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"           TEXT NOT NULL,
  "encrypted_value" TEXT NOT NULL,
  "iv"             TEXT NOT NULL,
  "key_hint"       TEXT,                    -- last 4 chars of plaintext for display
  "created_by"     UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "org_secrets_org_name_uq" UNIQUE ("org_id", "name")
);
CREATE INDEX "org_secrets_org_idx" ON "org_secrets"("org_id");

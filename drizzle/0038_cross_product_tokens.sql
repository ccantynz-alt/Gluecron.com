-- Block K11 — Cross-product identity
-- Tracks short-lived JWTs minted by gluecron (IdP) for sibling products
-- (Crontech, Gatetest). Row per mint is used for:
--   * revocation (revoked_at IS NOT NULL => fail verify)
--   * replay audit (jti is the JWT id)
--   * settings UI listing (active per user)

CREATE TABLE IF NOT EXISTS cross_product_tokens (
  jti uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audience text NOT NULL,
  scopes text NOT NULL DEFAULT '[]',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS cross_product_tokens_user_idx
  ON cross_product_tokens (user_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS cross_product_tokens_active_idx
  ON cross_product_tokens (audience, expires_at)
  WHERE revoked_at IS NULL;

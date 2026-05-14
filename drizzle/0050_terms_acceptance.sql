-- Block P3 — Terms acceptance audit trail.
-- New register requires a Terms / Privacy checkbox. Record when the user
-- accepted and the version they accepted. Future Terms changes bump
-- `terms_version`; the UI surfaces an "accept again" prompt when the
-- stored value falls behind the current canonical version.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_version text;

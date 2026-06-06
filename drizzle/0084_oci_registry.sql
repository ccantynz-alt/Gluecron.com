-- OCI / Docker container registry tables (Block OCI-1)
--
-- oci_repositories — image namespaces, one per (owner, name) pair.
--   name is the full "owner/image" string as used in `docker push`.
--
-- oci_tags — mutable tag → manifest-digest pointers, analogous to git refs.
--   Each push that specifies a tag upserts the row so the tag always resolves
--   to the most-recently-pushed manifest digest.
--
-- Blob files live on disk at ${OCI_STORE_PATH}/blobs/sha256/<hex> and are
-- referenced only by digest; no DB row is needed for individual blobs.

CREATE TABLE IF NOT EXISTS oci_repositories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'private',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT oci_repositories_owner_name UNIQUE (owner_id, name)
);

CREATE INDEX IF NOT EXISTS idx_oci_repositories_owner ON oci_repositories (owner_id);

CREATE TABLE IF NOT EXISTS oci_tags (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id    UUID NOT NULL REFERENCES oci_repositories(id) ON DELETE CASCADE,
  tag              TEXT NOT NULL,
  manifest_digest  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT oci_tags_repo_tag UNIQUE (repository_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_oci_tags_repo ON oci_tags (repository_id);

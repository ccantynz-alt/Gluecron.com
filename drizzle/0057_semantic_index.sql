-- Gluecron migration 0057: Continuous semantic index foundation.
--
-- Builds the pgvector-backed `code_embeddings` table that the post-receive
-- hook fills on every push. Layered separately from `code_chunks`
-- (migration 0012/lib/semantic-search.ts) because:
--   * code_chunks: bulk whole-repo reindex, chunked by line range,
--     stores embedding as JSON-text. Survives without pgvector.
--   * code_embeddings: per-file row keyed by (repo, path), refreshed
--     incrementally on push, stores embedding as native vector(1024)
--     so we can ORDER BY embedding <-> $1 in Postgres.
--
-- Best-effort: if pgvector isn't installed (common on self-hosted
-- Postgres without superuser access), every statement here is wrapped
-- in DO blocks that swallow undefined_object/undefined_file/
-- insufficient_privilege/feature_not_supported. The table degrades
-- to a no-op: src/lib/semantic-index.ts probes the table existence
-- and falls back to empty-result behaviour when missing.

--> statement-breakpoint
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector unavailable (%); semantic index will degrade to no-op', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "code_embeddings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
    "file_path" text NOT NULL,
    "blob_sha" text NOT NULL,
    "commit_sha" text NOT NULL,
    "content_snippet" text NOT NULL DEFAULT '',
    "embedding" vector(1024),
    "embedding_model" text,
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'code_embeddings create failed (%); semantic index will degrade to no-op', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "code_embeddings_repo_path_uniq"
    ON "code_embeddings" ("repository_id", "file_path");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'code_embeddings unique index failed (%)', SQLERRM;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "code_embeddings_repo_idx"
    ON "code_embeddings" ("repository_id");
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'code_embeddings repo index failed (%)', SQLERRM;
END $$;

-- ANN-friendly ivfflat index on the embedding column. Only meaningful
-- once a few thousand rows exist; harmless on small data. Wrapped so a
-- missing pgvector type doesn't abort the migration.
--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "code_embeddings_vec_idx"
    ON "code_embeddings" USING ivfflat ("embedding" vector_cosine_ops)
    WITH (lists = 100);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'code_embeddings ivfflat index failed (%); cosine search will fall back to seq scan', SQLERRM;
END $$;

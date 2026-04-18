-- Gluecron migration 0028: dependency graph.
--
-- J1 — Parses manifest files in a repo and stores a per-repo SBOM.
-- `repo_dependencies` is a "last known state" set — each reindex REPLACES the
-- prior rows. `ecosystem` is the package manager (npm, pypi, go, rubygems,
-- cargo, composer). `manifest_path` is the file the dep came from.
--
-- One row per (repository_id, ecosystem, name, manifest_path). We don't
-- de-dup across manifests (the same dep can legitimately appear in multiple
-- manifests, e.g. server + client package.json).

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_dependencies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "ecosystem" text NOT NULL,        -- npm | pypi | go | rubygems | cargo | composer
  "name" text NOT NULL,
  "version_spec" text,              -- "^1.2.3", ">=2.0", "1.2.3"
  "manifest_path" text NOT NULL,    -- "package.json", "frontend/package.json"
  "is_dev" boolean NOT NULL DEFAULT false,
  "commit_sha" text NOT NULL,       -- commit the index was built against
  "indexed_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_dependencies_repo_id_idx"
  ON "repo_dependencies" ("repository_id", "ecosystem");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_dependencies_name_idx"
  ON "repo_dependencies" ("name");

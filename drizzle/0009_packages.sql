-- Gluecron migration 0009: Block C2 — Package registry (npm-compatible).
--
-- Tables:
--   packages         — logical package (one per repo per ecosystem)
--   package_versions — published versions with tarball stored as bytea
--   package_tags     — dist tags (latest, beta, etc.)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "ecosystem" text NOT NULL DEFAULT 'npm',
  "scope" text,
  "name" text NOT NULL,
  "description" text,
  "readme" text,
  "homepage" text,
  "license" text,
  "visibility" text NOT NULL DEFAULT 'public',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "packages_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packages_repo" ON "packages" ("repository_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "packages_eco_scope_name" ON "packages" ("ecosystem", "scope", "name");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "package_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "package_id" uuid NOT NULL,
  "version" text NOT NULL,
  "shasum" text NOT NULL,
  "integrity" text,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "metadata" text NOT NULL DEFAULT '{}',
  "tarball" text,
  "published_by" uuid,
  "yanked" boolean NOT NULL DEFAULT false,
  "yanked_reason" text,
  "published_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "package_versions_pkg_fk" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE cascade,
  CONSTRAINT "package_versions_user_fk" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE set null
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "package_versions_pkg" ON "package_versions" ("package_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "package_versions_pkg_version" ON "package_versions" ("package_id", "version");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "package_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "package_id" uuid NOT NULL,
  "tag" text NOT NULL,
  "version_id" uuid NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "package_tags_pkg_fk" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE cascade,
  CONSTRAINT "package_tags_version_fk" FOREIGN KEY ("version_id") REFERENCES "package_versions"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "package_tags_pkg_tag" ON "package_tags" ("package_id", "tag");

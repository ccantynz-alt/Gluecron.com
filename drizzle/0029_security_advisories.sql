-- Gluecron migration 0029: security advisories + dependency alerts.
--
-- J2 — Per-package CVE-style advisories mapped against J1's `repo_dependencies`.
-- Builds the "Dependabot alerts" / "GitHub security advisory" feature.
--
-- `security_advisories` is the master rule list — populated initially from a
-- seeded set in `src/lib/advisories.ts`, extensible via admin import later.
-- `repo_advisory_alerts` is the per-repo match state: one row per (repo,
-- advisory) when we detect a dependency matches the advisory's affected range.
-- An alert can be dismissed (ignored), auto-closed when the dep goes away, or
-- marked fixed when the dep's version moves past the fixed_version.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_advisories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ghsa_id" text UNIQUE,          -- GitHub Security Advisory ID, e.g. GHSA-xxxx
  "cve_id" text,                  -- CVE-YYYY-NNNN when assigned
  "summary" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'moderate', -- low | moderate | high | critical
  "ecosystem" text NOT NULL,      -- npm | pypi | go | rubygems | cargo | composer
  "package_name" text NOT NULL,
  "affected_range" text NOT NULL, -- "<1.2.3" | ">=2.0.0 <2.5.1"
  "fixed_version" text,           -- "1.2.3" — suggestion to upgrade to
  "reference_url" text,           -- link to upstream advisory / CVE
  "published_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_advisories_pkg_idx"
  ON "security_advisories" ("ecosystem", "package_name");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_advisory_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "advisory_id" uuid NOT NULL REFERENCES "security_advisories"("id") ON DELETE CASCADE,
  "dependency_name" text NOT NULL,
  "dependency_version" text,
  "manifest_path" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',   -- open | dismissed | fixed
  "dismissed_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repo_advisory_alerts_unique_idx"
  ON "repo_advisory_alerts" ("repository_id", "advisory_id", "manifest_path");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_advisory_alerts_status_idx"
  ON "repo_advisory_alerts" ("repository_id", "status");

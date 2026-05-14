-- Block N3 — Platform deploy timeline.
--
-- Records every deploy of THIS site (gluecron.com itself), surfaced by the
-- `.github/workflows/hetzner-deploy.yml` workflow which POSTs to
--   POST /api/events/deploy/started
--   POST /api/events/deploy/finished
-- These rows back the site-admin status pill in `src/views/layout.tsx` and
-- the `/admin/deploys` timeline in `src/routes/admin-deploys.tsx`.
--
-- Strictly additive — drop the table to remove it. No FKs.
--
-- `run_id` is the GitHub Actions run id and is unique so a retried `started`
-- POST short-circuits without inserting a second row. `source` namespaces
-- the deploy target so future Fly/Vultr/Render targets can land here too
-- without a schema change.

CREATE TABLE IF NOT EXISTS "platform_deploys" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id"       text NOT NULL UNIQUE,
  "sha"          text NOT NULL,
  "source"       text NOT NULL,
  "status"       text NOT NULL DEFAULT 'in_progress',
  "started_at"   timestamptz NOT NULL DEFAULT now(),
  "finished_at"  timestamptz,
  "duration_ms"  integer,
  "error"        text,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_platform_deploys_started"
  ON "platform_deploys" ("started_at" DESC);

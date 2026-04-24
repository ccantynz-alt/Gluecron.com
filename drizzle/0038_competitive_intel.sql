-- Competitive Intelligence Engine — weekly competitor monitoring + gap analysis.
--
-- competitor_reports  one row per (competitor, week). Stores raw changelog
--                     content, Claude-extracted features shipped, gaps vs
--                     Gluecron, and a short summary.
-- intel_scan_runs     audit log of every scan job invocation — useful for
--                     showing "last scanned at" in the admin UI.
--
-- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` throughout so
-- reruns are idempotent.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "competitor_reports" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "competitor"       text        NOT NULL,
  "report_date"      date        NOT NULL,
  "raw_content"      text        NOT NULL,
  "features_shipped" jsonb       NOT NULL DEFAULT '[]',
  "gaps_identified"  jsonb       NOT NULL DEFAULT '[]',
  "summary"          text        NOT NULL DEFAULT '',
  "model_used"       text        NOT NULL DEFAULT 'claude-sonnet-4-6',
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_reports_competitor"
  ON "competitor_reports"("competitor");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_reports_date"
  ON "competitor_reports"("report_date" DESC);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "competitor_reports_unique"
  ON "competitor_reports"("competitor", "report_date");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intel_scan_runs" (
  "id"                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "started_at"           timestamptz NOT NULL DEFAULT now(),
  "completed_at"         timestamptz,
  "status"               text        NOT NULL DEFAULT 'running',
  "competitors_scanned"  integer     NOT NULL DEFAULT 0,
  "error"                text
);

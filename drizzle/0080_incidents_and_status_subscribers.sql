-- 0077 — Status page: incident history + subscriber list.
--
-- incidents: manually-filed or autopilot-detected outage records shown on
--   the public /status page. severity: 'minor' | 'major' | 'critical'.
--   status: 'investigating' | 'identified' | 'monitoring' | 'resolved'.
--
-- status_subscribers: email addresses that have opted-in to receive alerts
--   when a new incident is filed. Confirmation token is single-use; once
--   the user clicks the verify link confirmed_at is set.

CREATE TABLE IF NOT EXISTS "incidents" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"        text NOT NULL,
  "severity"     text NOT NULL DEFAULT 'minor',
  "status"       text NOT NULL DEFAULT 'resolved',
  "started_at"   timestamptz NOT NULL DEFAULT now(),
  "resolved_at"  timestamptz,
  "body"         text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_incidents_started_at"
  ON "incidents" ("started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_incidents_status"
  ON "incidents" ("status");

CREATE TABLE IF NOT EXISTS "status_subscribers" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"            text NOT NULL UNIQUE,
  "confirmed_at"     timestamptz,
  "confirm_token"    text UNIQUE,
  "unsubscribe_token" text UNIQUE,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_status_subscribers_email"
  ON "status_subscribers" ("email");

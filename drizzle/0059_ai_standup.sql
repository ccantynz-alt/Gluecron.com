-- AI Standup — daily + weekly Claude-generated team brief.
--
-- Two tables:
--   `user_standup_prefs`  — per-user opt-in flags (daily, weekly, email).
--                           Lives in its own table to avoid editing the
--                           locked `users` schema. Row is created lazily
--                           on first toggle. Fall-back: row missing ==
--                           opted out.
--   `ai_standups`         — every generated standup. Used to render the
--                           /standups feed and to dedupe (one row per
--                           (user_id, scope, day) keeps the scheduler
--                           from firing twice on the same UTC day).
--
-- Strictly additive — drop the two tables to remove the feature.

CREATE TABLE IF NOT EXISTS "user_standup_prefs" (
  "user_id"               uuid PRIMARY KEY,
  "daily_enabled"         boolean NOT NULL DEFAULT false,
  "weekly_enabled"        boolean NOT NULL DEFAULT false,
  "email_enabled"         boolean NOT NULL DEFAULT false,
  "hour_utc"              integer NOT NULL DEFAULT 9,
  "last_daily_sent_at"    timestamptz,
  "last_weekly_sent_at"   timestamptz,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_standups" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        uuid NOT NULL,
  "scope"          text NOT NULL,
  "summary"        text NOT NULL,
  "shipped_items"  text NOT NULL DEFAULT '[]',
  "blocked_items"  text NOT NULL DEFAULT '[]',
  "at_risk_items"  text NOT NULL DEFAULT '[]',
  "window_start"   timestamptz NOT NULL,
  "window_end"     timestamptz NOT NULL,
  "ai_available"   boolean NOT NULL DEFAULT false,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ai_standups_user_created"
  ON "ai_standups" ("user_id", "created_at" DESC);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ai_standups_user_scope_created"
  ON "ai_standups" ("user_id", "scope", "created_at" DESC);

-- Enterprise leads table — captures contact form submissions from /enterprise.
-- Used to route sales conversations to the enterprise team.
-- Strictly additive; no existing tables are touched.

CREATE TABLE IF NOT EXISTS "enterprise_leads" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"       text NOT NULL,
  "company"    text NOT NULL,
  "email"      text NOT NULL,
  "team_size"  text NOT NULL,
  "message"    text,
  "ip"         text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "enterprise_leads_created" ON "enterprise_leads" ("created_at");

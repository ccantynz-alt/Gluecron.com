-- Block J16 — PR auto-merge opt-in.
--
-- One row per PR captures the owner's intent to auto-merge the PR once all
-- commit statuses on the head SHA reach "success". The actual merge is
-- performed by the regular PR merge path; this table just tracks the
-- subscription + the merge strategy the owner wanted.

CREATE TABLE IF NOT EXISTS "pr_auto_merge" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pull_request_id" uuid NOT NULL REFERENCES "pull_requests"("id") ON DELETE CASCADE,
  "enabled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "merge_method" text NOT NULL DEFAULT 'merge',  -- merge | squash | rebase
  "commit_title" text,
  "commit_message" text,
  "enabled_at" timestamp NOT NULL DEFAULT now(),
  "last_checked_at" timestamp,
  "last_status" text,          -- 'pending' | 'success' | 'failure' | 'error'
  "notified_ready" boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS "pr_auto_merge_pr_unique"
  ON "pr_auto_merge" ("pull_request_id");

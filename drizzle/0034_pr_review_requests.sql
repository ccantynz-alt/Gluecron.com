-- Block J11 — PR review requests (auto-assign from CODEOWNERS + manual).
--
-- Each row represents one reviewer who has been asked to review a PR. Rows
-- are idempotent per (pr, reviewer) and track who requested it, the source
-- (codeowners auto-assign, manual, or AI suggestion), and the resolution
-- state once the reviewer submits a review or is dismissed.

CREATE TABLE IF NOT EXISTS "pr_review_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pull_request_id" uuid NOT NULL REFERENCES "pull_requests"("id") ON DELETE CASCADE,
  "reviewer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "source" text NOT NULL DEFAULT 'manual', -- 'codeowners' | 'manual' | 'ai'
  "state" text NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'changes_requested' | 'dismissed'
  "requested_at" timestamp NOT NULL DEFAULT now(),
  "resolved_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "pr_review_requests_pr_reviewer_unique"
  ON "pr_review_requests" ("pull_request_id", "reviewer_id");

CREATE INDEX IF NOT EXISTS "pr_review_requests_reviewer_state_idx"
  ON "pr_review_requests" ("reviewer_id", "state");

-- Migration 0077: CODEOWNERS auto-assign + required reviews before merge
-- Adds pr_review_requests table for tracking requested reviewers per PR.
-- (branch_protection table already exists from an earlier migration.)

CREATE TABLE IF NOT EXISTS pr_review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id),
  created_at timestamp DEFAULT now(),
  UNIQUE(pr_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS pr_review_requests_pr ON pr_review_requests(pr_id);
CREATE INDEX IF NOT EXISTS pr_review_requests_reviewer ON pr_review_requests(reviewer_id);

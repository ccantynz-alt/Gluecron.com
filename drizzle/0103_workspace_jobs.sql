-- Workspace job persistence (hot path is in-memory; this is for auditability)
CREATE TABLE IF NOT EXISTS workspace_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  triggered_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending',
  plan_comment text,
  branch_name text,
  pr_number int,
  error_message text,
  started_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_jobs_repo ON workspace_jobs(repo_id);
CREATE INDEX IF NOT EXISTS idx_workspace_jobs_issue ON workspace_jobs(issue_id);

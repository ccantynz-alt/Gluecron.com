-- Multi-repo refactor agent — one English request fan-outs to coordinated
-- PRs across every affected repo, then merges them in order once all PRs
-- are green + approved.
--
-- The classic example: "rename `getUserById` to `findUser`". A user owns
-- 8 repos that import the helper; the agent walks each of them, opens an
-- AI-authored PR with the rename, and tags every PR with a single
-- `multi-repo:refactor:<id>` label so the UI can group them.
--
-- Two tables:
--   `multi_repo_refactors`     — the parent record. One row per user-issued
--                                 request. Lifecycle: planning → building →
--                                 ready_for_review → merged | failed.
--   `multi_repo_refactor_prs`  — one row per affected repo. Holds the FK to
--                                 the `pull_requests` row (nullable until the
--                                 per-repo PR is actually opened) plus the
--                                 per-repo status (pending|building|opened|
--                                 failed) and an error message if the build
--                                 step bailed for that repo.
--
-- Coordinated merge: when the user (or autopilot) triggers a merge on the
-- parent refactor, the orchestrator walks the child rows in insertion order;
-- if any child fails the rest stay open so the user can intervene. The
-- merge driver lives in `src/lib/multi-repo-refactor.ts`.

CREATE TABLE IF NOT EXISTS multi_repo_refactors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  -- 'planning' | 'building' | 'ready_for_review' | 'merged' | 'failed'
  status text NOT NULL DEFAULT 'planning',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS multi_repo_refactors_owner
  ON multi_repo_refactors (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS multi_repo_refactors_status
  ON multi_repo_refactors (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS multi_repo_refactor_prs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refactor_id uuid NOT NULL REFERENCES multi_repo_refactors(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- Nullable: stays NULL until the per-repo PR is actually opened.
  pull_request_id uuid REFERENCES pull_requests(id) ON DELETE SET NULL,
  -- 'pending' | 'building' | 'opened' | 'failed'
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- One row per (refactor, repo). A refactor never targets the same repo twice.
CREATE UNIQUE INDEX IF NOT EXISTS multi_repo_refactor_prs_unique
  ON multi_repo_refactor_prs (refactor_id, repository_id);

CREATE INDEX IF NOT EXISTS multi_repo_refactor_prs_refactor
  ON multi_repo_refactor_prs (refactor_id, status);

CREATE INDEX IF NOT EXISTS multi_repo_refactor_prs_repo
  ON multi_repo_refactor_prs (repository_id);

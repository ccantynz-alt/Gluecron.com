-- Migration 0106: Per-repo automation settings.
--
-- ONE row per repository controlling every push/PR/issue-time automation
-- with a mode of 'off' | 'suggest' | 'auto'. Absence of a row means the
-- defaults below — which exactly match pre-0106 behavior, so shipping this
-- migration changes nothing until a user touches the settings page.
--
-- Env kill-switches stay supreme: a feature disabled at the environment
-- level (missing ANTHROPIC_API_KEY, AI_LOOP_ENABLED unset, etc.) is off
-- regardless of what this table says.

CREATE TABLE IF NOT EXISTS repo_automation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE CASCADE,

  -- AI code review on PR open. 'suggest' (default) = post advisory review
  -- comments, the pre-0106 behavior. 'off' = skip entirely. ('auto' is
  -- treated as 'suggest' — review comments are inherently advisory.)
  ai_review_mode text NOT NULL DEFAULT 'suggest',

  -- AI triage comment on PR open ('suggest' = current behavior; only
  -- on/off is meaningful, 'auto' treated as on).
  pr_triage_mode text NOT NULL DEFAULT 'suggest',

  -- AI triage comment on issue create (same semantics as pr_triage_mode).
  issue_triage_mode text NOT NULL DEFAULT 'suggest',

  -- AI-gated auto-merge. 'auto' (default) = merge when a branch_protection
  -- rule opts in AND every gate passes — the pre-0106 behavior (still
  -- default-deny without an enable_auto_merge rule). 'suggest' = evaluate
  -- and record the decision in the audit log but never perform the merge.
  -- 'off' = skip evaluation entirely.
  auto_merge_mode text NOT NULL DEFAULT 'auto',

  -- CI auto-fix on failed gate runs. 'suggest' (default) = post the patch
  -- as a PR comment with an Apply Fix button, the pre-0106 behavior.
  -- 'auto' = also apply the patch onto a fix/ branch automatically.
  -- 'off' = skip entirely.
  ci_autofix_mode text NOT NULL DEFAULT 'suggest',

  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_automation_settings_repo
  ON repo_automation_settings(repository_id);

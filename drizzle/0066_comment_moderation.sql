-- Comment moderation (anti-impersonation gate).
--
-- Public-repo abuse vector: non-contributors leaving comments to dress up
-- their activity feed as "I contributed there." Per the platform owner:
--   "Users will not be allowed to comment on another public repo unless
--    they have the permission of the author."
--
-- This migration introduces:
--
--   * `moderation_status` on both `issue_comments` and `pr_comments`,
--     with companion `moderated_at` / `moderated_by_user_id` audit
--     columns. Default 'approved' so every existing row stays visible —
--     only NEW comments from non-collaborators flow into the queue.
--
--   * `repo_commenter_trust` — per-repo allow/deny list. A 'trusted'
--     row makes `shouldRequireApproval` return false (auto-approve);
--     a 'banned' row makes the moderator's "mark as spam" decision
--     sticky, so the next comment from that user on that repo also
--     auto-routes to status='rejected' without bothering the owner.
--
--   * Two filtering indexes — one for the owner-facing pending queue
--     (`/:owner/:repo/comments/pending`) and one for moderator-history
--     queries.
--
-- Strictly additive: no existing rows mutate, every query that hasn't
-- been taught about the new column continues to work because the
-- default backfills 'approved' for the legacy population.

ALTER TABLE issue_comments
  ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'approved';

ALTER TABLE issue_comments
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz;

ALTER TABLE issue_comments
  ADD COLUMN IF NOT EXISTS moderated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE pr_comments
  ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'approved';

ALTER TABLE pr_comments
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz;

ALTER TABLE pr_comments
  ADD COLUMN IF NOT EXISTS moderated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS repo_commenter_trust (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commenter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL,
  granted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS repo_commenter_trust_unique
  ON repo_commenter_trust (repository_id, commenter_user_id);

CREATE INDEX IF NOT EXISTS repo_commenter_trust_repo_status
  ON repo_commenter_trust (repository_id, status);

-- Owner-facing queue: "list every pending comment on issues in MY repo".
-- A partial index on the pending state keeps this fast even when the
-- repo has tens of thousands of approved comments.
CREATE INDEX IF NOT EXISTS issue_comments_pending_status
  ON issue_comments (moderation_status)
  WHERE moderation_status = 'pending';

CREATE INDEX IF NOT EXISTS pr_comments_pending_status
  ON pr_comments (moderation_status)
  WHERE moderation_status = 'pending';

-- Moderator history queries — "everything user X has actioned, newest
-- first". Useful for the audit trail and any future moderator-leaderboard.
CREATE INDEX IF NOT EXISTS issue_comments_moderated_by
  ON issue_comments (moderated_by_user_id, moderated_at DESC);

CREATE INDEX IF NOT EXISTS pr_comments_moderated_by
  ON pr_comments (moderated_by_user_id, moderated_at DESC);

-- /settings/notifications toggle — "Pending comment requests". Defaults
-- ON so a new repo owner doesn't miss queued comments out of the gate.
-- The notification is always written (so it shows up in /inbox); this
-- flag gates email/push fan-out only.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notify_email_on_pending_comment boolean NOT NULL DEFAULT true;

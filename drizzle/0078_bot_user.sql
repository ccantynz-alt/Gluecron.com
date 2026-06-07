-- Migration 0078: Seed the gluecron[bot] synthetic user.
--
-- All autopilot / AI-review comments are credited to this row rather than
-- the PR/issue author. The password_hash is deliberately empty so that no
-- bcrypt comparison can ever succeed, making this account non-loginable.
INSERT INTO users (
  username,
  email,
  password_hash,
  display_name,
  bio,
  is_admin,
  notify_email_on_mention,
  notify_email_on_assign,
  notify_email_on_gate_fail,
  notify_email_digest_weekly,
  notify_email_on_pending_comment,
  sleep_mode_enabled,
  sleep_mode_digest_hour_utc,
  notify_push_on_mention,
  notify_push_on_assign,
  notify_push_on_review_request,
  notify_push_on_deploy_failed,
  is_playground,
  personal_semantic_index_enabled,
  created_at,
  updated_at
) VALUES (
  'gluecron[bot]',
  'bot@gluecron.com',
  '',
  'Gluecron Bot',
  'AI autopilot system',
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  9,
  false,
  false,
  false,
  false,
  false,
  false,
  NOW(),
  NOW()
)
ON CONFLICT (username) DO NOTHING;

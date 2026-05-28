-- Block M2 addendum — extra push-preference columns for the four new
-- notification kinds surfaced by src/routes/push-notifications.tsx:
--   deploy_success  → notify_push_on_deploy_success
--   pr_merged       → notify_push_on_pr_merged
--   ai_review       → notify_push_on_ai_review
--   gate_failed     → notify_push_on_gate_failed
--
-- Strictly additive. No existing table or column is touched.
-- The push_subscriptions table itself already exists (drizzle/0043).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "notify_push_on_deploy_success" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_push_on_pr_merged"      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_push_on_ai_review"      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_push_on_gate_failed"    boolean NOT NULL DEFAULT true;

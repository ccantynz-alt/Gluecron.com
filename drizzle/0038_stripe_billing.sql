-- Stripe billing columns on user_quotas. Adds subscription linkage + lifecycle
-- state so the webhook handler can auto-assign plans and enforce grace periods.

ALTER TABLE user_quotas
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_status TEXT,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS user_quotas_stripe_customer_id_idx
  ON user_quotas (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS user_quotas_stripe_subscription_status_idx
  ON user_quotas (stripe_subscription_status)
  WHERE stripe_subscription_status IS NOT NULL;

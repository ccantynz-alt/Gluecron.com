-- Deployment wait-timer enforcement (Block C4 follow-up).
--
-- Until now `environments.wait_timer_minutes` was stored but never enforced —
-- approved deploys flipped to status="pending" the moment the last approval
-- landed. This column unblocks real wait-timer semantics:
--
--   ready_after  IS NULL  → no wait; deploy may run as soon as it is "pending".
--   ready_after  > now()  → deploy is "waiting_timer"; autopilot flips it to
--                            "pending" once the timer elapses.
--   ready_after <= now()  → deploy is ready (autopilot or any reader can flip).
--
-- Strictly additive — no existing rows touched, default is NULL so legacy
-- deployments behave exactly as before.

ALTER TABLE "deployments"
  ADD COLUMN IF NOT EXISTS "ready_after" timestamptz;

--> statement-breakpoint

-- Partial index covers the autopilot sweep query
-- (status='waiting_timer' AND ready_after <= now()).
CREATE INDEX IF NOT EXISTS "deployments_ready_after"
  ON "deployments" ("ready_after")
  WHERE "ready_after" IS NOT NULL;

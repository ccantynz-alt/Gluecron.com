-- Block K2 — AI-gated auto-merge.
--
-- Adds an opt-in `enable_auto_merge` flag to each branch-protection rule.
-- When true, the K3 autopilot ticker may auto-merge PRs whose base branch
-- matches this rule — provided every other gate the manual-merge path
-- enforces is green. Default-deny on purpose: owners must explicitly turn
-- this on per rule.
--
-- NOTE: this should have been named 0039 per the K2 spec, but the
-- repair-flywheel work landed first and took the 0039 slot, so we ship as
-- 0040 to keep migration ordering monotonic and additive.

ALTER TABLE "branch_protection"
  ADD COLUMN IF NOT EXISTS "enable_auto_merge" boolean NOT NULL DEFAULT false;

-- Repair Flywheel — full-patch storage for Tier-0 cache replay
--
-- Migration 0039 stores only a 400-char patch_summary — enough for the
-- /admin/repair-flywheel dashboard, but not enough to REPLAY a repair on a
-- cache hit. This adds the full unified-diff patch (capped at write-site,
-- ~64KB) so ci-autofix can serve a previously-successful fix without an
-- AI call (BUILD_BIBLE §7 finding 1: close the flywheel loop).
--
-- src/db/schema.ts is locked (§4.1), so this column is intentionally NOT on
-- the drizzle table object — src/lib/repair-flywheel.ts reads/writes it via
-- raw SQL fragments. Strictly additive; nullable so existing rows are fine
-- (they simply can't be replayed and fall through to the AI tier).

ALTER TABLE "repair_flywheel" ADD COLUMN IF NOT EXISTS "patch" TEXT;

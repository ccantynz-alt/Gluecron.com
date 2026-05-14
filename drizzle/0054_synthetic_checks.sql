-- BLOCK S4 — Synthetic monitor history.
--
-- The autopilot ticker hits each row in SYNTHETIC_CHECKS (in
-- src/lib/synthetic-monitor.ts), records the outcome here, and fires a
-- webhook alert on any green->red transition. Strictly additive: nothing
-- else reads or writes this table.

CREATE TABLE IF NOT EXISTS synthetic_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_name text NOT NULL,
  status text NOT NULL,         -- "green" | "red" | "yellow"
  status_code integer,           -- HTTP status if applicable
  duration_ms integer NOT NULL,
  error text,                    -- non-null when red
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_synthetic_checks_checked_at
  ON synthetic_checks (checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_synthetic_checks_name_checked_at
  ON synthetic_checks (check_name, checked_at DESC);

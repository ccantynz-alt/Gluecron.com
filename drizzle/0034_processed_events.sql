-- Signal Bus P1 — Idempotency table for inbound events.
--
-- Records every external event we have successfully processed so that
-- duplicate deliveries (Crontech retry, network replay, at-least-once bus)
-- can be detected and short-circuited without firing side-effects twice.
--
-- `event_id` is the provider-supplied uuid v4 carried on the wire.
-- `source` namespaces event_id in case two providers happen to collide
-- (e.g. 'crontech', 'gatetest', 'github').
--
-- This migration is additive and reversible — drop the table to remove it.

CREATE TABLE IF NOT EXISTS "processed_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id" text NOT NULL UNIQUE,
  "event_type" text NOT NULL,
  "source" text NOT NULL,
  "received_at" timestamp NOT NULL DEFAULT now(),
  "payload" jsonb
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "processed_events_event_id_idx"
  ON "processed_events" ("event_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "processed_events_source_type_idx"
  ON "processed_events" ("source", "event_type");

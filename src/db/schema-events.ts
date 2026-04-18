/**
 * Signal Bus P1 — Drizzle schema for the inbound-event idempotency table.
 *
 * Defined in a SEPARATE module because `src/db/schema.ts` is listed in
 * §4 LOCKED BLOCKS of BUILD_BIBLE.md and must not be edited. New tables are
 * allowed "only via new migration"; this module supplies the matching Drizzle
 * definitions that migration `drizzle/0034_processed_events.sql` creates at
 * the SQL layer. Import `processedEvents` directly from this module.
 *
 * Columns mirror the SQL migration 1:1. Keep them in sync whenever the
 * migration is superseded by a follow-up additive migration.
 */

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const processedEvents = pgTable(
  "processed_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    source: text("source").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    // Raw payload retained for forensics / replay. jsonb column — callers
    // pass a plain object and drizzle serialises it.
    payload: jsonb("payload"),
  },
  (table) => [
    index("processed_events_event_id_idx").on(table.eventId),
    index("processed_events_source_type_idx").on(table.source, table.eventType),
  ]
);

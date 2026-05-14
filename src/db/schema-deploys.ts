/**
 * Block N3 — Drizzle schema for the platform-deploy timeline table.
 *
 * Defined in a SEPARATE module because `src/db/schema.ts` is listed in
 * §4 LOCKED BLOCKS of BUILD_BIBLE.md ("New tables only via new migration").
 * The matching migration is `drizzle/0046_platform_deploys.sql`. Import
 * `platformDeploys` directly from this module.
 *
 * Columns mirror the SQL migration 1:1 — keep in sync when superseded by a
 * follow-up additive migration.
 */

import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const platformDeploys = pgTable(
  "platform_deploys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: text("run_id").notNull().unique(),
    sha: text("sha").notNull(),
    source: text("source").notNull(),
    // 'in_progress' | 'succeeded' | 'failed'
    status: text("status").notNull().default("in_progress"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_platform_deploys_started").on(table.startedAt)]
);

export type PlatformDeployRow = typeof platformDeploys.$inferSelect;
export type NewPlatformDeployRow = typeof platformDeploys.$inferInsert;

/**
 * AI Standup — Drizzle schema for the daily/weekly Claude-generated
 * team-brief feature.
 *
 * Defined in a SEPARATE module because `src/db/schema.ts` is listed in
 * §4 LOCKED BLOCKS of BUILD_BIBLE.md and must not be edited. The matching
 * migration is `drizzle/0057_ai_standup.sql`.
 *
 * Two tables:
 *   - `user_standup_prefs` — per-user opt-in flags. Row missing == opted
 *     out (the lazy-create-on-toggle pattern keeps the legacy user table
 *     untouched).
 *   - `ai_standups` — generated standup records, surfaced at /standups
 *     and used for same-day dedupe.
 */

import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const userStandupPrefs = pgTable("user_standup_prefs", {
  userId: uuid("user_id").primaryKey(),
  dailyEnabled: boolean("daily_enabled").default(false).notNull(),
  weeklyEnabled: boolean("weekly_enabled").default(false).notNull(),
  emailEnabled: boolean("email_enabled").default(false).notNull(),
  hourUtc: integer("hour_utc").default(9).notNull(),
  lastDailySentAt: timestamp("last_daily_sent_at", { withTimezone: true }),
  lastWeeklySentAt: timestamp("last_weekly_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserStandupPrefsRow = typeof userStandupPrefs.$inferSelect;
export type NewUserStandupPrefsRow = typeof userStandupPrefs.$inferInsert;

export const aiStandups = pgTable(
  "ai_standups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    // 'daily' | 'weekly'
    scope: text("scope").notNull(),
    summary: text("summary").notNull(),
    // JSON-serialized string arrays so we don't depend on jsonb features.
    shippedItems: text("shipped_items").default("[]").notNull(),
    blockedItems: text("blocked_items").default("[]").notNull(),
    atRiskItems: text("at_risk_items").default("[]").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    aiAvailable: boolean("ai_available").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_ai_standups_user_created").on(table.userId, table.createdAt),
    index("idx_ai_standups_user_scope_created").on(
      table.userId,
      table.scope,
      table.createdAt
    ),
  ]
);

export type AiStandupRow = typeof aiStandups.$inferSelect;
export type NewAiStandupRow = typeof aiStandups.$inferInsert;

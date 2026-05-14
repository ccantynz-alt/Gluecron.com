/**
 * Block N3 + R2 — Drizzle schema for the platform-deploy timeline.
 *
 * Defined in a SEPARATE module because `src/db/schema.ts` is listed in
 * §4 LOCKED BLOCKS of BUILD_BIBLE.md ("New tables only via new migration").
 * The matching migrations are
 *   - `drizzle/0046_platform_deploys.sql` (Block N3)
 *   - `drizzle/0053_deploy_steps.sql`     (Block R2 — `last_step`, `step_count`,
 *                                          `platform_deploy_steps`)
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
    // R2 — latest step the deploy reached + running count. Both populated by
    // POST /api/events/deploy/step so a page refresh mid-deploy still shows
    // the last known position even before SSE re-attaches.
    lastStep: text("last_step"),
    stepCount: integer("step_count").notNull().default(0),
  },
  (table) => [index("idx_platform_deploys_started").on(table.startedAt)]
);

export type PlatformDeployRow = typeof platformDeploys.$inferSelect;
export type NewPlatformDeployRow = typeof platformDeploys.$inferInsert;

// R2 — per-step audit trail. Optional surface; SSE is the live channel but
// rows here let `/admin/deploys` reconstruct an in-progress deploy on
// reload. The (deploy_id, step_name, status) tuple is uniquely indexed (see
// migration 0053) so re-POSTing a step is a no-op.
export const platformDeploySteps = pgTable(
  "platform_deploy_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deployId: uuid("deploy_id").notNull(),
    stepName: text("step_name").notNull(),
    // 'in_progress' | 'succeeded' | 'failed'
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    output: text("output"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_platform_deploy_steps_deploy").on(
      table.deployId,
      table.startedAt
    ),
  ]
);

export type PlatformDeployStepRow = typeof platformDeploySteps.$inferSelect;
export type NewPlatformDeployStepRow =
  typeof platformDeploySteps.$inferInsert;

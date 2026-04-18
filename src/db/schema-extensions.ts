/**
 * Extended database schema — branch protection, status checks,
 * notifications, organizations, and teams.
 *
 * These extend the base schema to add enterprise-grade features.
 */

import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  uniqueIndex,
  index,
  serial,
  jsonb,
} from "drizzle-orm/pg-core";
import { users, repositories } from "./schema";

// ─── Branch Protection Rules ────────────────────────────────────────────────

export const branchProtection = pgTable(
  "branch_protection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(), // e.g. "main", "release/*"
    requireStatusChecks: boolean("require_status_checks").default(false).notNull(),
    requiredChecks: text("required_checks").default(""), // comma-separated check names
    requireReviews: boolean("require_reviews").default(false).notNull(),
    requiredReviewCount: integer("required_review_count").default(1).notNull(),
    requireUpToDate: boolean("require_up_to_date").default(false).notNull(),
    dismissStaleReviews: boolean("dismiss_stale_reviews").default(false).notNull(),
    restrictPush: boolean("restrict_push").default(false).notNull(),
    allowForcePush: boolean("allow_force_push").default(false).notNull(),
    allowDeletion: boolean("allow_deletion").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("branch_protection_repo").on(table.repositoryId),
    uniqueIndex("branch_protection_repo_pattern").on(
      table.repositoryId,
      table.pattern
    ),
  ]
);

// ─── Status Checks (CI Integration) ────────────────────────────────────────

export const statusChecks = pgTable(
  "status_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    context: text("context").notNull(), // e.g. "ci/build", "gatetest/scan"
    state: text("state").notNull().default("pending"), // pending, success, failure, error
    description: text("description"),
    targetUrl: text("target_url"), // link to CI build
    createdBy: text("created_by"), // token name or integration name
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("status_checks_repo_sha").on(table.repositoryId, table.commitSha),
    index("status_checks_repo_context").on(table.repositoryId, table.context),
  ]
);

// ─── Notifications ──────────────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // issue_comment, pr_review, mention, star, ci_status
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"), // link to the relevant page
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    actorId: uuid("actor_id").references(() => users.id),
    isRead: boolean("is_read").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("notifications_user_read").on(table.userId, table.isRead),
    index("notifications_user_created").on(table.userId, table.createdAt),
  ]
);

// ─── Organizations ──────────────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  displayName: text("display_name"),
  description: text("description"),
  avatarUrl: text("avatar_url"),
  website: text("website"),
  location: text("location"),
  isVerified: boolean("is_verified").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner, admin, member
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("org_members_unique").on(table.orgId, table.userId),
    index("org_members_user").on(table.userId),
  ]
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    permission: text("permission").notNull().default("read"), // read, write, admin
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("teams_org_name").on(table.orgId, table.name),
  ]
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("team_members_unique").on(table.teamId, table.userId),
  ]
);

export const teamRepos = pgTable(
  "team_repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    permission: text("permission").notNull().default("read"), // read, write, admin
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("team_repos_unique").on(table.teamId, table.repositoryId),
  ]
);

// ─── Type Exports ───────────────────────────────────────────────────────────

export type BranchProtectionRule = typeof branchProtection.$inferSelect;
export type StatusCheck = typeof statusChecks.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;

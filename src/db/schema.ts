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
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  passwordHash: text("password_hash").notNull(),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    description: text("description"),
    isPrivate: boolean("is_private").default(false).notNull(),
    defaultBranch: text("default_branch").default("main").notNull(),
    diskPath: text("disk_path").notNull(),
    forkedFromId: uuid("forked_from_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    pushedAt: timestamp("pushed_at"),
    starCount: integer("star_count").default(0).notNull(),
    forkCount: integer("fork_count").default(0).notNull(),
    issueCount: integer("issue_count").default(0).notNull(),
  },
  (table) => [uniqueIndex("repos_owner_name").on(table.ownerId, table.name)]
);

export const stars = pgTable(
  "stars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stars_user_repo").on(table.userId, table.repositoryId),
  ]
);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: serial("number"),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull().default("open"), // open, closed
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    closedAt: timestamp("closed_at"),
  },
  (table) => [
    index("issues_repo_state").on(table.repositoryId, table.state),
    index("issues_repo_number").on(table.repositoryId, table.number),
  ]
);

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("comments_issue").on(table.issueId)]
);

export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#8b949e"),
    description: text("description"),
  },
  (table) => [
    uniqueIndex("labels_repo_name").on(table.repositoryId, table.name),
  ]
);

export const issueLabels = pgTable(
  "issue_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("issue_labels_unique").on(table.issueId, table.labelId),
  ]
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: serial("number"),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull().default("open"), // open, closed, merged
    baseBranch: text("base_branch").notNull(),
    headBranch: text("head_branch").notNull(),
    mergedAt: timestamp("merged_at"),
    mergedBy: uuid("merged_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    closedAt: timestamp("closed_at"),
  },
  (table) => [
    index("prs_repo_state").on(table.repositoryId, table.state),
    index("prs_repo_number").on(table.repositoryId, table.number),
  ]
);

export const prComments = pgTable(
  "pr_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    isAiReview: boolean("is_ai_review").default(false).notNull(),
    filePath: text("file_path"),
    lineNumber: integer("line_number"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("pr_comments_pr").on(table.pullRequestId)]
);

export const activityFeed = pgTable(
  "activity_feed",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    action: text("action").notNull(), // push, issue_open, issue_close, pr_open, pr_merge, star, comment
    targetType: text("target_type"), // issue, pr, commit
    targetId: text("target_id"),
    metadata: text("metadata"), // JSON string for extra data
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("activity_repo").on(table.repositoryId),
    index("activity_user").on(table.userId),
  ]
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret"),
    events: text("events").notNull().default("push"), // comma-separated: push,issue,pr
    isActive: boolean("is_active").default(true).notNull(),
    lastDeliveredAt: timestamp("last_delivered_at"),
    lastStatus: integer("last_status"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("webhooks_repo").on(table.repositoryId)]
);

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(), // first 8 chars for display
  scopes: text("scopes").notNull().default("repo"), // comma-separated
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const repoTopics = pgTable(
  "repo_topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
  },
  (table) => [
    uniqueIndex("repo_topics_unique").on(table.repositoryId, table.topic),
    index("topics_name").on(table.topic),
  ]
);

export const sshKeys = pgTable("ssh_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  fingerprint: text("fingerprint").notNull(),
  publicKey: text("public_key").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Star = typeof stars.$inferSelect;
export type SshKey = typeof sshKeys.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type IssueComment = typeof issueComments.$inferSelect;
export type Label = typeof labels.$inferSelect;
export type PullRequest = typeof pullRequests.$inferSelect;
export type PrComment = typeof prComments.$inferSelect;
export type ActivityEntry = typeof activityFeed.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type RepoTopic = typeof repoTopics.$inferSelect;

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
  // Email notification preferences (Block A8). Default on; opt-out via /settings.
  notifyEmailOnMention: boolean("notify_email_on_mention").default(true).notNull(),
  notifyEmailOnAssign: boolean("notify_email_on_assign").default(true).notNull(),
  notifyEmailOnGateFail: boolean("notify_email_on_gate_fail").default(true).notNull(),
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
    isArchived: boolean("is_archived").default(false).notNull(),
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

/**
 * Per-repository gate + auto-repair configuration.
 * Every new repo is created with all gates ENABLED by default —
 * the "full green ecosystem" default. Owners can manually opt-out per setting.
 */
export const repoSettings = pgTable("repo_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .unique()
    .references(() => repositories.id, { onDelete: "cascade" }),
  // Gates
  gateTestEnabled: boolean("gate_test_enabled").default(true).notNull(),
  aiReviewEnabled: boolean("ai_review_enabled").default(true).notNull(),
  secretScanEnabled: boolean("secret_scan_enabled").default(true).notNull(),
  securityScanEnabled: boolean("security_scan_enabled").default(true).notNull(),
  dependencyScanEnabled: boolean("dependency_scan_enabled").default(true).notNull(),
  lintEnabled: boolean("lint_enabled").default(true).notNull(),
  typeCheckEnabled: boolean("type_check_enabled").default(true).notNull(),
  testEnabled: boolean("test_enabled").default(true).notNull(),
  // Auto-repair
  autoFixEnabled: boolean("auto_fix_enabled").default(true).notNull(),
  autoMergeResolveEnabled: boolean("auto_merge_resolve_enabled").default(true).notNull(),
  autoFormatEnabled: boolean("auto_format_enabled").default(true).notNull(),
  // AI features
  aiCommitMessagesEnabled: boolean("ai_commit_messages_enabled").default(true).notNull(),
  aiPrSummaryEnabled: boolean("ai_pr_summary_enabled").default(true).notNull(),
  aiChangelogEnabled: boolean("ai_changelog_enabled").default(true).notNull(),
  // Deploy
  autoDeployEnabled: boolean("auto_deploy_enabled").default(true).notNull(),
  deployRequireAllGreen: boolean("deploy_require_all_green").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Branch protection rules — enforced on push and merge.
 * Every repo's default branch gets a protection rule on creation.
 */
export const branchProtection = pgTable(
  "branch_protection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(), // branch name or glob (e.g. "main", "release/*")
    requirePullRequest: boolean("require_pull_request").default(true).notNull(),
    requireGreenGates: boolean("require_green_gates").default(true).notNull(),
    requireAiApproval: boolean("require_ai_approval").default(true).notNull(),
    requireHumanReview: boolean("require_human_review").default(false).notNull(),
    requiredApprovals: integer("required_approvals").default(0).notNull(),
    allowForcePush: boolean("allow_force_push").default(false).notNull(),
    allowDeletion: boolean("allow_deletion").default(false).notNull(),
    dismissStaleReviews: boolean("dismiss_stale_reviews").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("branch_protection_repo_pattern").on(
      table.repositoryId,
      table.pattern
    ),
  ]
);

/**
 * Gate run history. Every push + every PR creates gate_runs entries —
 * one per configured gate. Serves as the source of truth for "is this green?".
 */
export const gateRuns = pgTable(
  "gate_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pullRequestId: uuid("pull_request_id").references(() => pullRequests.id, {
      onDelete: "cascade",
    }),
    commitSha: text("commit_sha").notNull(),
    ref: text("ref").notNull(),
    gateName: text("gate_name").notNull(), // e.g. "GateTest", "AI Review", "Secret Scan", "Type Check"
    status: text("status").notNull(), // pending, running, passed, failed, skipped, repaired
    summary: text("summary"),
    details: text("details"), // JSON: per-check output, affected files, etc
    repairAttempted: boolean("repair_attempted").default(false).notNull(),
    repairSucceeded: boolean("repair_succeeded").default(false).notNull(),
    repairCommitSha: text("repair_commit_sha"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("gate_runs_repo_sha").on(table.repositoryId, table.commitSha),
    index("gate_runs_pr").on(table.pullRequestId),
    index("gate_runs_created").on(table.createdAt),
  ]
);

/**
 * In-app notifications. Powered by the activity feed + explicit mentions.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(), // mention, review_requested, pr_merged, pr_closed, gate_failed, gate_repaired, ai_review, assigned, security_alert, deploy_success, deploy_failed
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"), // link to the relevant page
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("notifications_user_unread").on(table.userId, table.readAt),
    index("notifications_user_created").on(table.userId, table.createdAt),
  ]
);

/**
 * Releases — named snapshots of a repo at a tag/commit.
 * AI-generated changelogs bundled in notes field.
 */
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    tag: text("tag").notNull(),
    name: text("name").notNull(),
    body: text("body"), // AI-generated release notes + changelog
    targetCommit: text("target_commit").notNull(),
    isDraft: boolean("is_draft").default(false).notNull(),
    isPrerelease: boolean("is_prerelease").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    publishedAt: timestamp("published_at"),
  },
  (table) => [
    uniqueIndex("releases_repo_tag").on(table.repositoryId, table.tag),
  ]
);

/**
 * Milestones — group issues + PRs toward a shared goal.
 */
export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    state: text("state").notNull().default("open"), // open, closed
    dueDate: timestamp("due_date"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    closedAt: timestamp("closed_at"),
  },
  (table) => [index("milestones_repo_state").on(table.repositoryId, table.state)]
);

/**
 * Reactions on issues, PRs, and comments. Universal target pointer.
 */
export const reactions = pgTable(
  "reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // issue, pr, issue_comment, pr_comment
    targetId: uuid("target_id").notNull(),
    emoji: text("emoji").notNull(), // thumbs_up, thumbs_down, rocket, heart, eyes, laugh, hooray, confused
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("reactions_unique").on(
      table.userId,
      table.targetType,
      table.targetId,
      table.emoji
    ),
    index("reactions_target").on(table.targetType, table.targetId),
  ]
);

/**
 * PR reviews (formal approve/request-changes).
 * Separate from inline comments in pr_comments.
 */
export const prReviews = pgTable(
  "pr_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => users.id),
    state: text("state").notNull(), // approved, changes_requested, commented
    body: text("body"),
    isAi: boolean("is_ai").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("pr_reviews_pr").on(table.pullRequestId)]
);

/**
 * Code owners — who owns which paths (auto-request review on PR).
 * Parsed from a CODEOWNERS file at the root of the default branch.
 */
export const codeOwners = pgTable(
  "code_owners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pathPattern: text("path_pattern").notNull(),
    ownerUsernames: text("owner_usernames").notNull(), // comma-separated
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("code_owners_repo").on(table.repositoryId)]
);

/**
 * Per-repo AI chat sessions — conversational repo assistant.
 */
export const aiChats = pgTable(
  "ai_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    title: text("title"),
    messages: text("messages").notNull().default("[]"), // JSON array of {role, content}
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("ai_chats_user").on(table.userId),
    index("ai_chats_repo").on(table.repositoryId),
  ]
);

/**
 * Audit log — every sensitive action. Who did what, when, from where.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(), // repo.create, repo.delete, repo.transfer, token.create, token.revoke, merge, force_push, branch_protection.update, deploy, ...
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: text("metadata"), // JSON for extra context
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_log_user").on(table.userId),
    index("audit_log_repo").on(table.repositoryId),
    index("audit_log_created").on(table.createdAt),
  ]
);

/**
 * Deployments — tracks every deploy to downstream systems (Crontech, etc).
 * Each deploy is gated on ALL green gates passing.
 */
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    environment: text("environment").notNull().default("production"),
    commitSha: text("commit_sha").notNull(),
    ref: text("ref").notNull(),
    status: text("status").notNull(), // pending, running, success, failed, blocked
    blockedReason: text("blocked_reason"),
    target: text("target"), // e.g. "crontech", "fly.io"
    triggeredBy: uuid("triggered_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("deployments_repo").on(table.repositoryId),
    index("deployments_created").on(table.createdAt),
  ]
);

/**
 * Rate-limit buckets — in-memory or persisted counter per IP / token / route.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bucketKey: text("bucket_key").notNull().unique(), // "ip:1.2.3.4:api" or "token:abc:api"
    count: integer("count").default(0).notNull(),
    windowStart: timestamp("window_start").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [index("rate_limit_expires").on(table.expiresAt)]
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
    isDraft: boolean("is_draft").default(false).notNull(),
    mergeStrategy: text("merge_strategy").default("merge").notNull(), // merge, squash, rebase
    milestoneId: uuid("milestone_id"),
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
export type RepoSettings = typeof repoSettings.$inferSelect;
export type BranchProtection = typeof branchProtection.$inferSelect;
export type GateRun = typeof gateRuns.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Release = typeof releases.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type Reaction = typeof reactions.$inferSelect;
export type PrReview = typeof prReviews.$inferSelect;
export type CodeOwner = typeof codeOwners.$inferSelect;
export type AiChat = typeof aiChats.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;

/**
 * Saved replies — per-user canned responses, insertable into any
 * issue / PR comment textarea. Shortcut name must be unique per user.
 */
export const savedReplies = pgTable(
  "saved_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shortcut: text("shortcut").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("saved_replies_user_shortcut").on(table.userId, table.shortcut),
  ]
);

export type SavedReply = typeof savedReplies.$inferSelect;

/**
 * Organizations (Block B1) — multi-user namespaces. Distinct from `users`.
 * An org has members (with org-level roles) and may contain teams.
 * Repos can be owned by an org via `repositories.orgId` (added in Block B2).
 *
 * Slug is globally unique against itself; collision with a username is
 * checked at create time in the route handler (no DB-level cross-table
 * uniqueness in Postgres).
 */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  avatarUrl: text("avatar_url"),
  billingEmail: text("billing_email"),
  createdById: uuid("created_by_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Org membership. Roles: owner (full control, billing), admin (manage
 * members + teams + repos), member (default; can be added to teams).
 */
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
    role: text("role").notNull().default("member"), // owner | admin | member
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("org_members_unique").on(table.orgId, table.userId),
    index("org_members_user").on(table.userId),
  ]
);

/**
 * Teams within an org. Slug is unique within an org.
 * `parentTeamId` allows nesting (GitHub-style child teams). Optional.
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    parentTeamId: uuid("parent_team_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("teams_org_slug").on(table.orgId, table.slug)]
);

/**
 * Team membership. Roles: maintainer (can edit team), member (default).
 * A user can belong to many teams; team membership requires org membership
 * but that invariant is enforced at the route layer, not the DB layer.
 */
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
    role: text("role").notNull().default("member"), // maintainer | member
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("team_members_unique").on(table.teamId, table.userId),
    index("team_members_user").on(table.userId),
  ]
);

export type Organization = typeof organizations.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;
export type OrgRole = "owner" | "admin" | "member";
export type TeamRole = "maintainer" | "member";

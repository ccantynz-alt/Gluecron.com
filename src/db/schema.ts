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
  // Block I7 — weekly digest opt-in.
  notifyEmailDigestWeekly: boolean("notify_email_digest_weekly").default(false).notNull(),
  lastDigestSentAt: timestamp("last_digest_sent_at"),
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
  // B4: true when the user has entered their password but not yet their TOTP
  // code. softAuth/requireAuth treat such sessions as anonymous; only
  // /login/2fa can consume them. Flips to false on successful 2FA.
  requires2fa: boolean("requires_2fa").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // ownerId = creator / user-owner. Always set (for attribution + user
    // namespace uniqueness). For org-owned repos, also represents "created by".
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    // Block B2: nullable org owner. When set, the repo lives in the org
    // namespace and URL resolution routes `/:orgSlug/:repo` to it.
    orgId: uuid("org_id"),
    description: text("description"),
    isPrivate: boolean("is_private").default(false).notNull(),
    isArchived: boolean("is_archived").default(false).notNull(),
    isTemplate: boolean("is_template").default(false).notNull(),
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
  (table) => [
    // Partial: uniqueness only in the user namespace (org-owned rows exempt).
    // Matches the partial index in migration 0004.
    uniqueIndex("repos_owner_name").on(table.ownerId, table.name),
    index("repos_org").on(table.orgId),
  ]
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

/**
 * 2FA / TOTP (Block B4).
 *
 * Secret is stored in plain Base32 for now — the DB has row-level-secure
 * access and the app boundary is the only code that reads it. A follow-up
 * (B4.1) will wrap it with AES-GCM at rest once we standardise the KEK.
 *
 * `enabledAt` is set only after the user has successfully entered their
 * first code (confirming the authenticator was set up correctly). Rows with
 * `enabledAt = NULL` represent pending enrolment.
 */
export const userTotp = pgTable("user_totp", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  enabledAt: timestamp("enabled_at"),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Recovery codes — single-use fallback when the authenticator is lost.
 * Stored as SHA-256 hashes; used rows are marked with `usedAt` rather than
 * deleted so the audit log keeps the full history.
 */
export const userRecoveryCodes = pgTable(
  "user_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("recovery_codes_user").on(table.userId),
    uniqueIndex("recovery_codes_user_hash").on(table.userId, table.codeHash),
  ]
);

export type UserTotp = typeof userTotp.$inferSelect;
export type UserRecoveryCode = typeof userRecoveryCodes.$inferSelect;

/**
 * WebAuthn passkeys (Block B5).
 *
 * Each row is one registered authenticator. The `credentialId` is the
 * globally-unique identifier the browser returns; `publicKey` is the
 * COSE-encoded public key we use to verify signatures. `counter` tracks
 * the authenticator's signature counter for replay-protection.
 *
 * `transports` is a JSON array (stored as text) of the
 * AuthenticatorTransport values ("usb" | "nfc" | "ble" | "internal" | "hybrid").
 */
export const userPasskeys = pgTable(
  "user_passkeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(), // base64url of COSE key
    counter: integer("counter").default(0).notNull(),
    transports: text("transports"), // JSON array string
    name: text("name").notNull().default("Passkey"),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("passkeys_user").on(table.userId)]
);

/**
 * Short-lived WebAuthn challenges. A row is written when we issue options
 * (registration or authentication) and deleted after the verify step or when
 * it expires (5 min). Keeping them in the DB lets us verify without sticky
 * sessions or client-side state.
 */
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    // For passwordless login we don't know the user yet, so userId is nullable
    // and we bind the challenge to a short-lived cookie token instead.
    sessionKey: text("session_key").notNull().unique(),
    challenge: text("challenge").notNull(),
    kind: text("kind").notNull(), // "register" | "authenticate"
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("webauthn_challenges_expires").on(table.expiresAt)]
);

export type UserPasskey = typeof userPasskeys.$inferSelect;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;

/**
 * OAuth 2.0 provider (Block B6).
 *
 * `oauthApps` is a third-party app registered by a developer. Each app has
 * a public `client_id`, a hashed `client_secret`, and one or more allowed
 * `redirect_uris` (newline-separated). The plaintext secret is shown to the
 * developer exactly once at creation and cannot be recovered; they can
 * rotate it instead.
 *
 * `oauthAuthorizations` is a short-lived authorization code issued after
 * the user consents at /oauth/authorize. Single-use: `usedAt` is set on
 * redemption so a replay after-the-fact fails.
 *
 * `oauthAccessTokens` is a long-lived bearer token plus an optional
 * refresh token. Both are stored as SHA-256 hashes; the plaintext values
 * are only returned to the client once in the /oauth/token response.
 */
export const oauthApps = pgTable(
  "oauth_apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clientId: text("client_id").notNull().unique(),
    clientSecretHash: text("client_secret_hash").notNull(),
    clientSecretPrefix: text("client_secret_prefix").notNull(), // first 8 chars for display
    /** Newline-separated list of allowed redirect URIs. */
    redirectUris: text("redirect_uris").notNull(),
    homepageUrl: text("homepage_url"),
    description: text("description"),
    /**
     * If `true`, the app must present its client_secret at /oauth/token.
     * Public SPA/mobile apps should set this to `false` and use PKCE.
     */
    confidential: boolean("confidential").default(true).notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("oauth_apps_owner").on(table.ownerId)]
);

export const oauthAuthorizations = pgTable(
  "oauth_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => oauthApps.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").notNull().default(""),
    codeChallenge: text("code_challenge"),
    codeChallengeMethod: text("code_challenge_method"), // "S256" | "plain"
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("oauth_authorizations_expires").on(table.expiresAt)]
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => oauthApps.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    refreshTokenHash: text("refresh_token_hash").unique(),
    scopes: text("scopes").notNull().default(""),
    expiresAt: timestamp("expires_at").notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at"),
    revokedAt: timestamp("revoked_at"),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("oauth_access_tokens_user").on(table.userId),
    index("oauth_access_tokens_app").on(table.appId),
    index("oauth_access_tokens_expires").on(table.expiresAt),
  ]
);

export type OauthApp = typeof oauthApps.$inferSelect;
export type OauthAuthorization = typeof oauthAuthorizations.$inferSelect;
export type OauthAccessToken = typeof oauthAccessTokens.$inferSelect;

/**
 * Actions-equivalent workflow runner (Block C1).
 *
 * `workflows` rows are the YAML files discovered at `.gluecron/workflows/*.yml`
 * on the repo's default branch. `parsed` is the normalised JSON form used by
 * the runner so we don't re-parse on every trigger.
 *
 * `workflow_runs` is one execution: one row per trigger event. Status
 * progression: queued → running → success|failure|cancelled. `conclusion`
 * stays null until `status` is terminal.
 *
 * `workflow_jobs` is a single job within a run — each has its own steps
 * array and concatenated logs. We keep logs inline for v1 (no streaming)
 * to avoid a fifth table; they're truncated at the runner.
 *
 * `workflow_artifacts` persist files a job uploaded. `content` is a bytea;
 * we'll move this to object storage once we hit size limits.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    path: text("path").notNull(), // e.g. ".gluecron/workflows/ci.yml"
    yaml: text("yaml").notNull(),
    parsed: text("parsed").notNull(), // JSON string
    onEvents: text("on_events").notNull().default("[]"), // JSON array of event names
    disabled: boolean("disabled").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflows_repo").on(table.repositoryId),
    uniqueIndex("workflows_repo_path").on(table.repositoryId, table.path),
  ]
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    runNumber: integer("run_number").notNull(),
    event: text("event").notNull(), // "push" | "pull_request" | "manual" | ...
    ref: text("ref"),
    commitSha: text("commit_sha"),
    triggeredBy: uuid("triggered_by").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("queued"), // queued|running|success|failure|cancelled
    conclusion: text("conclusion"),
    queuedAt: timestamp("queued_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflow_runs_repo").on(table.repositoryId),
    index("workflow_runs_status").on(table.status),
    index("workflow_runs_workflow").on(table.workflowId),
  ]
);

export const workflowJobs = pgTable(
  "workflow_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    jobOrder: integer("job_order").default(0).notNull(),
    runsOn: text("runs_on").notNull().default("default"),
    status: text("status").notNull().default("queued"),
    conclusion: text("conclusion"),
    exitCode: integer("exit_code"),
    steps: text("steps").notNull().default("[]"), // JSON array of step results
    logs: text("logs").notNull().default(""),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("workflow_jobs_run").on(table.runId)]
);

export const workflowArtifacts = pgTable(
  "workflow_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => workflowJobs.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    sizeBytes: integer("size_bytes").default(0).notNull(),
    contentType: text("content_type")
      .default("application/octet-stream")
      .notNull(),
    // bytea — drizzle doesn't have a built-in bytea type at the level we use
    // elsewhere; store as text (base64) for v1. Migration uses real bytea so
    // we can swap the column type later.
    content: text("content"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("workflow_artifacts_run").on(table.runId)]
);

export type Workflow = typeof workflows.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type WorkflowJob = typeof workflowJobs.$inferSelect;
export type WorkflowArtifact = typeof workflowArtifacts.$inferSelect;

// ---------------------------------------------------------------------------
// Block C2 — Package registry (npm-compatible)
// ---------------------------------------------------------------------------

export const packages = pgTable(
  "packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    ecosystem: text("ecosystem").notNull().default("npm"), // "npm" | "container"
    scope: text("scope"), // "@acme" for npm; null for unscoped
    name: text("name").notNull(), // "my-lib" (without scope)
    description: text("description"),
    readme: text("readme"),
    homepage: text("homepage"),
    license: text("license"),
    visibility: text("visibility").notNull().default("public"), // "public" | "private"
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("packages_repo").on(table.repositoryId),
    uniqueIndex("packages_eco_scope_name").on(
      table.ecosystem,
      table.scope,
      table.name
    ),
  ]
);

export const packageVersions = pgTable(
  "package_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: text("version").notNull(), // "1.2.3"
    shasum: text("shasum").notNull(), // sha1 (for npm compat) hex
    integrity: text("integrity"), // "sha512-..." base64
    sizeBytes: integer("size_bytes").default(0).notNull(),
    metadata: text("metadata").notNull().default("{}"), // package.json JSON
    tarball: text("tarball"), // base64-encoded; bytea in migration
    publishedBy: uuid("published_by").references(() => users.id, {
      onDelete: "set null",
    }),
    yanked: boolean("yanked").default(false).notNull(),
    yankedReason: text("yanked_reason"),
    publishedAt: timestamp("published_at").defaultNow().notNull(),
  },
  (table) => [
    index("package_versions_pkg").on(table.packageId),
    uniqueIndex("package_versions_pkg_version").on(table.packageId, table.version),
  ]
);

export const packageTags = pgTable(
  "package_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(), // "latest" | "beta" | ...
    versionId: uuid("version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("package_tags_pkg_tag").on(table.packageId, table.tag),
  ]
);

export type Package = typeof packages.$inferSelect;
export type PackageVersion = typeof packageVersions.$inferSelect;
export type PackageTag = typeof packageTags.$inferSelect;

// ---------------------------------------------------------------------------
// Block C3 — Pages / static hosting
// ---------------------------------------------------------------------------

export const pagesDeployments = pgTable(
  "pages_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    ref: text("ref").notNull().default("refs/heads/gh-pages"),
    commitSha: text("commit_sha").notNull(),
    status: text("status").notNull().default("success"), // "success" | "failed"
    triggeredBy: uuid("triggered_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("pages_deployments_repo").on(table.repositoryId),
    index("pages_deployments_created").on(table.createdAt),
  ]
);

export const pagesSettings = pgTable("pages_settings", {
  repositoryId: uuid("repository_id")
    .primaryKey()
    .references(() => repositories.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").default(true).notNull(),
  sourceBranch: text("source_branch").notNull().default("gh-pages"),
  sourceDir: text("source_dir").notNull().default("/"), // e.g. "/" or "/docs"
  customDomain: text("custom_domain"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PagesDeployment = typeof pagesDeployments.$inferSelect;
export type PagesSettings = typeof pagesSettings.$inferSelect;

// ---------------------------------------------------------------------------
// Block C4 — Environments with protected approvals
// ---------------------------------------------------------------------------

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // "production" | "staging" | "preview"
    requireApproval: boolean("require_approval").default(false).notNull(),
    // JSON array of user IDs that can approve deploys.
    reviewers: text("reviewers").notNull().default("[]"),
    waitTimerMinutes: integer("wait_timer_minutes").default(0).notNull(),
    allowedBranches: text("allowed_branches").notNull().default("[]"), // JSON glob patterns
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("environments_repo_name").on(table.repositoryId, table.name),
  ]
);

export const deploymentApprovals = pgTable(
  "deployment_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(), // "approved" | "rejected"
    comment: text("comment"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("deployment_approvals_deployment").on(table.deploymentId),
  ]
);

export type Environment = typeof environments.$inferSelect;
export type DeploymentApproval = typeof deploymentApprovals.$inferSelect;

// ---------------------------------------------------------------------------
// Block D — AI-native differentiation (migration 0012)
// ---------------------------------------------------------------------------

// D6 — cached "explain this codebase" markdown keyed on commit sha.
export const codebaseExplanations = pgTable(
  "codebase_explanations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    summary: text("summary").notNull(),
    markdown: text("markdown").notNull(),
    model: text("model").notNull(),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("codebase_explanations_repo_sha").on(
      table.repositoryId,
      table.commitSha
    ),
  ]
);

// D2 — AI dependency bumper run history.
export const depUpdateRuns = pgTable(
  "dep_update_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // pending|running|success|failed|no_updates
    ecosystem: text("ecosystem").notNull(), // npm|bun
    manifestPath: text("manifest_path").notNull(),
    attemptedBumps: text("attempted_bumps").notNull().default("[]"), // JSON
    appliedBumps: text("applied_bumps").notNull().default("[]"), // JSON
    branchName: text("branch_name"),
    prNumber: integer("pr_number"),
    errorMessage: text("error_message"),
    triggeredBy: uuid("triggered_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("dep_update_runs_repo").on(table.repositoryId),
    index("dep_update_runs_created").on(table.createdAt),
  ]
);

// D1 — code chunks for semantic search. Embedding stored as JSON-encoded
// number array in text to avoid requiring pgvector; cosine similarity is
// computed in JS. Upgrade path: ALTER COLUMN embedding TYPE vector(1024).
export const codeChunks = pgTable(
  "code_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    path: text("path").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    content: text("content").notNull(),
    embedding: text("embedding"), // JSON number[]
    embeddingModel: text("embedding_model"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("code_chunks_repo").on(table.repositoryId),
    index("code_chunks_repo_path").on(table.repositoryId, table.path),
  ]
);

export type CodebaseExplanation = typeof codebaseExplanations.$inferSelect;
export type DepUpdateRun = typeof depUpdateRuns.$inferSelect;

// ---------------------------------------------------------------------------
// Block E2 — Discussions (migration 0013)
// ---------------------------------------------------------------------------

/**
 * Discussions — forum-style threaded conversations attached to a repo.
 * Similar to GitHub Discussions: categorised + pinnable + answerable.
 */
export const discussions = pgTable(
  "discussions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: serial("number"),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    // one of: "general" | "q-and-a" | "ideas" | "announcements" | "show-and-tell"
    category: text("category").notNull().default("general"),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull().default("open"), // open, closed
    locked: boolean("locked").notNull().default(false),
    answerCommentId: uuid("answer_comment_id"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("discussions_repo").on(table.repositoryId),
    uniqueIndex("discussions_repo_number").on(
      table.repositoryId,
      table.number
    ),
  ]
);

export const discussionComments = pgTable(
  "discussion_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionId: uuid("discussion_id")
      .notNull()
      .references(() => discussions.id, { onDelete: "cascade" }),
    parentCommentId: uuid("parent_comment_id"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    isAnswer: boolean("is_answer").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("discussion_comments_discussion").on(table.discussionId),
  ]
);

export type Discussion = typeof discussions.$inferSelect;
export type DiscussionComment = typeof discussionComments.$inferSelect;
export type CodeChunk = typeof codeChunks.$inferSelect;

// ---------------------------------------------------------------------------
// Block E4 — Gists (migration 0014)
// ---------------------------------------------------------------------------
//
// User-owned small snippets/files that behave like tiny repos. DB-backed
// for v1 (no bare git repo): each gist owns a collection of gist_files and
// every edit appends a gist_revisions row with a JSON snapshot.

export const gists = pgTable(
  "gists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 8-char hex slug used in pretty URLs (e.g. /gists/a1b2c3d4).
    slug: text("slug").notNull().unique(),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    isPublic: boolean("is_public").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("gists_owner").on(table.ownerId)]
);

export const gistFiles = pgTable(
  "gist_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gistId: uuid("gist_id")
      .notNull()
      .references(() => gists.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    // Optional explicit language override; falls back to filename detection.
    language: text("language"),
    content: text("content").notNull().default(""),
    sizeBytes: integer("size_bytes").default(0).notNull(),
  },
  (table) => [
    index("gist_files_gist").on(table.gistId),
    uniqueIndex("gist_files_gist_filename").on(table.gistId, table.filename),
  ]
);

export const gistRevisions = pgTable(
  "gist_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gistId: uuid("gist_id")
      .notNull()
      .references(() => gists.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    // JSON-encoded {filename: content} map capturing the full snapshot at
    // this revision. Stored as text to avoid requiring jsonb.
    snapshot: text("snapshot").notNull().default("{}"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("gist_revisions_gist_rev").on(table.gistId, table.revision),
  ]
);

export const gistStars = pgTable(
  "gist_stars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gistId: uuid("gist_id")
      .notNull()
      .references(() => gists.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("gist_stars_gist_user").on(table.gistId, table.userId)]
);

export type Gist = typeof gists.$inferSelect;
export type GistFile = typeof gistFiles.$inferSelect;
export type GistRevision = typeof gistRevisions.$inferSelect;
export type GistStar = typeof gistStars.$inferSelect;

// ---------------------------------------------------------------------------
// Block E1 — Projects / kanban (migration 0015)
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: serial("number"),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    state: text("state").notNull().default("open"), // open | closed
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("projects_repo").on(table.repositoryId),
    uniqueIndex("projects_repo_number").on(table.repositoryId, table.number),
  ]
);

export const projectColumns = pgTable(
  "project_columns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("project_columns_project").on(table.projectId)]
);

export const projectItems = pgTable(
  "project_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    columnId: uuid("column_id")
      .notNull()
      .references(() => projectColumns.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    // "note" | "issue" | "pr" — application-level FK on itemId by type
    itemType: text("item_type").notNull().default("note"),
    itemId: uuid("item_id"),
    title: text("title").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("project_items_project").on(table.projectId),
    index("project_items_column").on(table.columnId, table.position),
  ]
);

export type Project = typeof projects.$inferSelect;
export type ProjectColumn = typeof projectColumns.$inferSelect;
export type ProjectItem = typeof projectItems.$inferSelect;

// ---------------------------------------------------------------------------
// Block E3 — Wikis (migration 0016)
// ---------------------------------------------------------------------------
// DB-backed for v1; git-backed mirror is a future upgrade.

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: uuid("updated_by").references(() => users.id),
  },
  (table) => [
    index("wiki_pages_repo").on(table.repositoryId),
    uniqueIndex("wiki_pages_repo_slug").on(table.repositoryId, table.slug),
  ]
);

export const wikiRevisions = pgTable(
  "wiki_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    message: text("message"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("wiki_revisions_page").on(table.pageId, table.revision)]
);

export type WikiPage = typeof wikiPages.$inferSelect;
export type WikiRevision = typeof wikiRevisions.$inferSelect;

// ---------------------------------------------------------------------------
// Block E5 — Merge queues (migration 0017)
// ---------------------------------------------------------------------------

export const mergeQueueEntries = pgTable(
  "merge_queue_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    baseBranch: text("base_branch").notNull(),
    // queued | running | merged | failed | dequeued
    state: text("state").notNull().default("queued"),
    position: integer("position").notNull().default(0),
    enqueuedBy: uuid("enqueued_by").references(() => users.id),
    enqueuedAt: timestamp("enqueued_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("merge_queue_repo_branch").on(
      table.repositoryId,
      table.baseBranch,
      table.state
    ),
  ]
);

export type MergeQueueEntry = typeof mergeQueueEntries.$inferSelect;

// ---------------------------------------------------------------------------
// Block E6 — Required status checks matrix (migration 0018)
// ---------------------------------------------------------------------------

export const branchRequiredChecks = pgTable(
  "branch_required_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchProtectionId: uuid("branch_protection_id")
      .notNull()
      .references(() => branchProtection.id, { onDelete: "cascade" }),
    checkName: text("check_name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("branch_required_checks_rule").on(table.branchProtectionId),
    uniqueIndex("branch_required_checks_unique").on(
      table.branchProtectionId,
      table.checkName
    ),
  ]
);

export type BranchRequiredCheck = typeof branchRequiredChecks.$inferSelect;

// ---------------------------------------------------------------------------
// Block E7 — Protected tags (migration 0019)
// ---------------------------------------------------------------------------

export const protectedTags = pgTable(
  "protected_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (table) => [
    index("protected_tags_repo").on(table.repositoryId),
    uniqueIndex("protected_tags_repo_pattern").on(
      table.repositoryId,
      table.pattern
    ),
  ]
);

export type ProtectedTag = typeof protectedTags.$inferSelect;

// ---------------------------------------------------------------------------
// Block F — Observability + admin (migration 0020)
// ---------------------------------------------------------------------------

// F1 — Traffic analytics per repo
export const repoTrafficEvents = pgTable(
  "repo_traffic_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // view | clone | api | ui
    path: text("path"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    referer: text("referer"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("repo_traffic_events_repo_time").on(
      table.repositoryId,
      table.createdAt
    ),
    index("repo_traffic_events_kind").on(
      table.repositoryId,
      table.kind,
      table.createdAt
    ),
  ]
);

export type RepoTrafficEvent = typeof repoTrafficEvents.$inferSelect;

// F3 — Admin panel (site admins + toggleable flags)
export const systemFlags = pgTable("system_flags", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
});

export type SystemFlag = typeof systemFlags.$inferSelect;

export const siteAdmins = pgTable("site_admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedAt: timestamp("granted_at").defaultNow().notNull(),
  grantedBy: uuid("granted_by").references(() => users.id),
});

export type SiteAdmin = typeof siteAdmins.$inferSelect;

// F4 — Billing + quotas
export const billingPlans = pgTable("billing_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull().default(0),
  repoLimit: integer("repo_limit").notNull().default(10),
  storageMbLimit: integer("storage_mb_limit").notNull().default(1024),
  aiTokensMonthly: integer("ai_tokens_monthly").notNull().default(100000),
  bandwidthGbMonthly: integer("bandwidth_gb_monthly").notNull().default(10),
  privateRepos: boolean("private_repos").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type BillingPlan = typeof billingPlans.$inferSelect;

export const userQuotas = pgTable("user_quotas", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  planSlug: text("plan_slug").notNull().default("free"),
  storageMbUsed: integer("storage_mb_used").notNull().default(0),
  aiTokensUsedThisMonth: integer("ai_tokens_used_this_month")
    .notNull()
    .default(0),
  bandwidthGbUsedThisMonth: integer("bandwidth_gb_used_this_month")
    .notNull()
    .default(0),
  cycleStart: timestamp("cycle_start").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserQuota = typeof userQuotas.$inferSelect;

// Block H — App marketplace + bot identities (GitHub Apps equivalent)

export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    iconUrl: text("icon_url"),
    homepageUrl: text("homepage_url"),
    webhookUrl: text("webhook_url"),
    webhookSecret: text("webhook_secret"),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissions: text("permissions").notNull().default("[]"), // JSON array
    defaultEvents: text("default_events").notNull().default("[]"), // JSON array
    isPublic: boolean("is_public").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("apps_public_slug").on(table.isPublic, table.slug)]
);

export type App = typeof apps.$inferSelect;

export const appInstallations = pgTable(
  "app_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    installedBy: uuid("installed_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // user | org | repository
    targetId: uuid("target_id").notNull(),
    grantedPermissions: text("granted_permissions").notNull().default("[]"),
    suspendedAt: timestamp("suspended_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    uninstalledAt: timestamp("uninstalled_at"),
  },
  (table) => [
    index("app_installations_app").on(table.appId),
    index("app_installations_target").on(table.targetType, table.targetId),
  ]
);

export type AppInstallation = typeof appInstallations.$inferSelect;

export const appBots = pgTable("app_bots", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: uuid("app_id")
    .notNull()
    .unique()
    .references(() => apps.id, { onDelete: "cascade" }),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AppBot = typeof appBots.$inferSelect;

export const appInstallTokens = pgTable(
  "app_install_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => appInstallations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [index("app_install_tokens_hash").on(table.tokenHash)]
);

export type AppInstallToken = typeof appInstallTokens.$inferSelect;

export const appEvents = pgTable(
  "app_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id"),
    kind: text("kind").notNull(), // installed | uninstalled | delivery_ok | delivery_fail
    payload: text("payload"),
    responseStatus: integer("response_status"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("app_events_app_time").on(table.appId, table.createdAt)]
);

export type AppEvent = typeof appEvents.$inferSelect;

// ---------- Block I3 — Repository transfer history ----------

export const repoTransfers = pgTable(
  "repo_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    fromOwnerId: uuid("from_owner_id").notNull(),
    fromOrgId: uuid("from_org_id"),
    toOwnerId: uuid("to_owner_id").notNull(),
    toOrgId: uuid("to_org_id"),
    initiatedBy: uuid("initiated_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("repo_transfers_repo").on(table.repositoryId, table.createdAt),
  ]
);

export type RepoTransfer = typeof repoTransfers.$inferSelect;

// ---------- Block I6 — Sponsors ----------

export const sponsorshipTiers = pgTable(
  "sponsorship_tiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    maintainerId: uuid("maintainer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    monthlyCents: integer("monthly_cents").notNull(),
    oneTimeAllowed: boolean("one_time_allowed").default(true).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("sponsor_tiers_maintainer").on(table.maintainerId, table.isActive),
  ]
);

export type SponsorshipTier = typeof sponsorshipTiers.$inferSelect;

export const sponsorships = pgTable(
  "sponsorships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sponsorId: uuid("sponsor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    maintainerId: uuid("maintainer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tierId: uuid("tier_id"),
    amountCents: integer("amount_cents").notNull(),
    kind: text("kind").notNull(), // one_time | monthly
    note: text("note"),
    isPublic: boolean("is_public").default(true).notNull(),
    externalRef: text("external_ref"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("sponsorships_maintainer").on(
      table.maintainerId,
      table.createdAt
    ),
    index("sponsorships_sponsor").on(table.sponsorId, table.createdAt),
  ]
);

export type Sponsorship = typeof sponsorships.$inferSelect;

// Block I8 — Code symbol index for xref navigation.
export const codeSymbols = pgTable(
  "code_symbols",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // function | class | interface | type | const | variable
    path: text("path").notNull(),
    line: integer("line").notNull(),
    signature: text("signature"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("code_symbols_repo_name_idx").on(table.repositoryId, table.name),
    index("code_symbols_repo_path_idx").on(table.repositoryId, table.path),
  ]
);

export type CodeSymbol = typeof codeSymbols.$inferSelect;

// Block I9 — Repository mirroring. One row per mirrored repo + an
// append-only log of sync attempts.
export const repoMirrors = pgTable("repo_mirrors", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .unique()
    .references(() => repositories.id, { onDelete: "cascade" }),
  upstreamUrl: text("upstream_url").notNull(),
  intervalMinutes: integer("interval_minutes").default(1440).notNull(),
  lastSyncedAt: timestamp("last_synced_at"),
  lastStatus: text("last_status"), // "ok" | "error"
  lastError: text("last_error"),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type RepoMirror = typeof repoMirrors.$inferSelect;

export const repoMirrorRuns = pgTable(
  "repo_mirror_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mirrorId: uuid("mirror_id")
      .notNull()
      .references(() => repoMirrors.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    status: text("status").default("running").notNull(),
    message: text("message"),
    exitCode: integer("exit_code"),
  },
  (table) => [
    index("repo_mirror_runs_mirror_id_idx").on(table.mirrorId, table.startedAt),
  ]
);

export type RepoMirrorRun = typeof repoMirrorRuns.$inferSelect;

// ----------------------------------------------------------------------------
// Block I10 — Enterprise SSO (OIDC)
// ----------------------------------------------------------------------------

/** Site-wide SSO provider. Singleton row with id = 'default'. */
export const ssoConfig = pgTable("sso_config", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").default(false).notNull(),
  providerName: text("provider_name").default("SSO").notNull(),
  issuer: text("issuer"),
  authorizationEndpoint: text("authorization_endpoint"),
  tokenEndpoint: text("token_endpoint"),
  userinfoEndpoint: text("userinfo_endpoint"),
  clientId: text("client_id"),
  clientSecret: text("client_secret"),
  scopes: text("scopes").default("openid profile email").notNull(),
  allowedEmailDomains: text("allowed_email_domains"),
  autoCreateUsers: boolean("auto_create_users").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type SsoConfig = typeof ssoConfig.$inferSelect;

/** Maps a local user to an IdP `sub` claim. */
export const ssoUserLinks = pgTable(
  "sso_user_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subject: text("subject").notNull().unique(),
    emailAtLink: text("email_at_link").notNull(),
    linkedAt: timestamp("linked_at").defaultNow().notNull(),
  },
  (table) => [index("sso_user_links_user_id_idx").on(table.userId)]
);

export type SsoUserLink = typeof ssoUserLinks.$inferSelect;

// ----------------------------------------------------------------------------
// Block J1 — Dependency graph
// ----------------------------------------------------------------------------

/**
 * Last known set of dependencies parsed from manifest files. Each reindex
 * replaces the prior rows for that repo. One row per (ecosystem, name,
 * manifest_path) — same name in multiple manifests is kept.
 */
export const repoDependencies = pgTable(
  "repo_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    versionSpec: text("version_spec"),
    manifestPath: text("manifest_path").notNull(),
    isDev: boolean("is_dev").default(false).notNull(),
    commitSha: text("commit_sha").notNull(),
    indexedAt: timestamp("indexed_at").defaultNow().notNull(),
  },
  (table) => [
    index("repo_dependencies_repo_id_idx").on(
      table.repositoryId,
      table.ecosystem
    ),
    index("repo_dependencies_name_idx").on(table.name),
  ]
);

export type RepoDependency = typeof repoDependencies.$inferSelect;

// ----------------------------------------------------------------------------
// Block J2 — Security advisories + alerts
// ----------------------------------------------------------------------------

/** CVE-style package advisories. Populated via seed + admin import. */
export const securityAdvisories = pgTable(
  "security_advisories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ghsaId: text("ghsa_id").unique(),
    cveId: text("cve_id"),
    summary: text("summary").notNull(),
    severity: text("severity").default("moderate").notNull(),
    ecosystem: text("ecosystem").notNull(),
    packageName: text("package_name").notNull(),
    affectedRange: text("affected_range").notNull(),
    fixedVersion: text("fixed_version"),
    referenceUrl: text("reference_url"),
    publishedAt: timestamp("published_at").defaultNow().notNull(),
  },
  (table) => [
    index("security_advisories_pkg_idx").on(
      table.ecosystem,
      table.packageName
    ),
  ]
);

export type SecurityAdvisory = typeof securityAdvisories.$inferSelect;

/** Per-repo match state. One row per (repo, advisory, manifest_path). */
export const repoAdvisoryAlerts = pgTable(
  "repo_advisory_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    advisoryId: uuid("advisory_id")
      .notNull()
      .references(() => securityAdvisories.id, { onDelete: "cascade" }),
    dependencyName: text("dependency_name").notNull(),
    dependencyVersion: text("dependency_version"),
    manifestPath: text("manifest_path").notNull(),
    status: text("status").default("open").notNull(),
    dismissedReason: text("dismissed_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("repo_advisory_alerts_status_idx").on(
      table.repositoryId,
      table.status
    ),
  ]
);

export type RepoAdvisoryAlert = typeof repoAdvisoryAlerts.$inferSelect;

// ----------------------------------------------------------------------------
// Block J3 — Commit signature verification (GPG + SSH)
// ----------------------------------------------------------------------------

/** Per-user GPG/SSH public keys for commit signing. */
export const signingKeys = pgTable(
  "signing_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    keyType: text("key_type").notNull(), // 'gpg' | 'ssh'
    title: text("title").notNull(),
    fingerprint: text("fingerprint").notNull(),
    publicKey: text("public_key").notNull(),
    email: text("email"),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("signing_keys_fp_unique").on(table.keyType, table.fingerprint),
    index("signing_keys_user_idx").on(table.userId),
  ]
);

export type SigningKey = typeof signingKeys.$inferSelect;

/**
 * Cached verification result for a (repo, commit) pair. Repopulated on demand;
 * rows are invalidated implicitly by CASCADE when either side is removed.
 */
export const commitVerifications = pgTable(
  "commit_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    verified: boolean("verified").default(false).notNull(),
    reason: text("reason").notNull(),
    signatureType: text("signature_type"),
    signerKeyId: uuid("signer_key_id").references(() => signingKeys.id, {
      onDelete: "set null",
    }),
    signerUserId: uuid("signer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    signerFingerprint: text("signer_fingerprint"),
    verifiedAt: timestamp("verified_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commit_verifications_sha_unique").on(
      table.repositoryId,
      table.commitSha
    ),
  ]
);

export type CommitVerification = typeof commitVerifications.$inferSelect;

// ----------------------------------------------------------------------------
// Block J4 — User following
// ----------------------------------------------------------------------------

/**
 * Directed user→user follow edges. Primary key is the composite
 * (follower_id, following_id) at the SQL level; drizzle sees it as a
 * regular table with a unique index plus a secondary index on the
 * reverse-lookup column.
 */
export const userFollows = pgTable(
  "user_follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followingId: uuid("following_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_follows_pair_unique").on(
      table.followerId,
      table.followingId
    ),
    index("user_follows_following_idx").on(table.followingId),
  ]
);

export type UserFollow = typeof userFollows.$inferSelect;

// ----------------------------------------------------------------------------
// Block J6 — Repository rulesets
// ----------------------------------------------------------------------------

/**
 * A ruleset groups N rules under a named policy at enforcement level active /
 * evaluate / disabled. Unique per (repo, name) so a repo can carry multiple
 * overlapping rulesets (e.g. "release branches" vs "everywhere").
 */
export const repoRulesets = pgTable(
  "repo_rulesets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enforcement: text("enforcement").default("active").notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("repo_rulesets_repo_idx").on(table.repositoryId),
    uniqueIndex("repo_rulesets_repo_name_unique").on(
      table.repositoryId,
      table.name
    ),
  ]
);

export type RepoRuleset = typeof repoRulesets.$inferSelect;

/** Individual rule — type tag plus JSON params. */
export const rulesetRules = pgTable(
  "ruleset_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rulesetId: uuid("ruleset_id")
      .notNull()
      .references(() => repoRulesets.id, { onDelete: "cascade" }),
    ruleType: text("rule_type").notNull(),
    params: text("params").default("{}").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("ruleset_rules_set_idx").on(table.rulesetId)]
);

export type RulesetRule = typeof rulesetRules.$inferSelect;

// ---------------------------------------------------------------------------
// Block J8 — Commit statuses.
// ---------------------------------------------------------------------------

/**
 * External CI / automation posts per-commit (sha, context) statuses. Upsert
 * semantics keyed on (repository, commit_sha, context). State vocabulary:
 * pending | success | failure | error. Combined rollup logic lives in
 * `src/lib/commit-statuses.ts`.
 */
export const commitStatuses = pgTable(
  "commit_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    state: text("state").notNull(),
    context: text("context").default("default").notNull(),
    description: text("description"),
    targetUrl: text("target_url"),
    creatorId: uuid("creator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commit_statuses_repo_sha_context_unique").on(
      table.repositoryId,
      table.commitSha,
      table.context
    ),
    index("commit_statuses_repo_sha_idx").on(
      table.repositoryId,
      table.commitSha
    ),
  ]
);

export type CommitStatus = typeof commitStatuses.$inferSelect;

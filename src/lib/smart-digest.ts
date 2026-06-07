/**
 * Smart Morning Digest — AI-curated daily developer notification queue.
 *
 * Replaces notification spam with a single, prioritised digest delivered
 * once per day via the in-app notification system AND surfaced on /digest.
 *
 * Data sources (last 48h / 24h where noted):
 *   1. Unread notifications (48h)
 *   2. Open PRs where the user is a requested reviewer
 *   3. Open PRs authored by the user with unread comments
 *   4. Failed gate runs for repos the user owns (24h)
 *   5. Dependency-update PRs on user's repos
 *
 * Claude Sonnet 4.6 prioritises the items and writes the headline + insight.
 * Never throws — every path is wrapped in try/catch.
 */

import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import {
  gateRuns,
  issues,
  notifications,
  prComments,
  prReviews,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import {
  getAnthropic,
  isAiAvailable,
  MODEL_SONNET,
  extractText,
  parseJsonResponse,
} from "./ai-client";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DigestItem {
  priority: "blocking" | "important" | "fyi";
  type:
    | "pr_review"
    | "pr_comment"
    | "ci_failure"
    | "mention"
    | "dep_update"
    | "new_issue";
  title: string;
  /** e.g. "waiting 2 days · 3 files changed" */
  subtitle: string;
  url: string;
  repoName: string;
}

export interface SmartDigest {
  userId: string;
  generatedAt: string;
  headline: string;
  queue: DigestItem[];
  stats: {
    prsReviewed: number;
    issuesClosed: number;
    commitsThisWeek: number;
  };
  insight?: string;
}

// ---------------------------------------------------------------------------
// Internal data loader
// ---------------------------------------------------------------------------

interface RawItem {
  type: DigestItem["type"];
  title: string;
  subtitle: string;
  url: string;
  repoName: string;
  createdAt: Date;
}

async function loadRawItems(
  userId: string,
  now: Date
): Promise<RawItem[]> {
  const base = config.appBaseUrl || "https://gluecron.com";
  const items: RawItem[] = [];

  // --- 1. Unread notifications (last 48h) ---
  const since48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  try {
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          gte(notifications.createdAt, since48h),
          sql`${notifications.readAt} IS NULL`
        )
      )
      .orderBy(desc(notifications.createdAt))
      .limit(20);

    for (const n of notifs) {
      const ageH = Math.round(
        (now.getTime() - new Date(n.createdAt).getTime()) / 3_600_000
      );
      items.push({
        type: n.kind === "mention" ? "mention" : n.kind === "gate_failed" ? "ci_failure" : "pr_review",
        title: n.title || "(untitled)",
        subtitle: `${n.kind} · ${ageH}h ago`,
        url: n.url ? (n.url.startsWith("http") ? n.url : `${base}${n.url}`) : `${base}/inbox`,
        repoName: "—",
        createdAt: new Date(n.createdAt),
      });
    }
  } catch (err) {
    console.error("[smart-digest] notifications query failed:", err);
  }

  // --- 2. PRs where user is requested reviewer (open) ---
  try {
    // We use pr_reviews to detect review requests: look for PRs where user
    // has a review_requested state and the PR is still open.
    const reviewRows = await db
      .select({
        pr: pullRequests,
        repoName: repositories.name,
        ownerUsername: users.username,
      })
      .from(prReviews)
      .innerJoin(pullRequests, eq(pullRequests.id, prReviews.pullRequestId))
      .innerJoin(
        repositories,
        eq(repositories.id, pullRequests.repositoryId)
      )
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(
        and(
          eq(prReviews.reviewerId, userId),
          eq(pullRequests.state, "open"),
          // Only include PRs they haven't reviewed yet (no approved/changes_requested)
          sql`${prReviews.state} NOT IN ('approved','changes_requested')`
        )
      )
      .orderBy(desc(pullRequests.createdAt))
      .limit(10);

    for (const row of reviewRows) {
      const ageH = Math.round(
        (now.getTime() - new Date(row.pr.createdAt).getTime()) / 3_600_000
      );
      const ageDays = Math.floor(ageH / 24);
      const ageLabel = ageDays >= 1 ? `waiting ${ageDays}d` : `waiting ${ageH}h`;
      items.push({
        type: "pr_review",
        title: `Review requested: ${row.pr.title}`,
        subtitle: `${ageLabel} · ${row.repoName}`,
        url: `${base}/${row.ownerUsername}/${row.repoName}/pulls/${row.pr.number}`,
        repoName: row.repoName,
        createdAt: new Date(row.pr.createdAt),
      });
    }
  } catch (err) {
    console.error("[smart-digest] review-requested query failed:", err);
  }

  // --- 3. Open PRs authored by user with unread comments ---
  try {
    const authoredPrs = await db
      .select({
        pr: pullRequests,
        repoName: repositories.name,
        ownerUsername: users.username,
        commentCount: sql<number>`count(${prComments.id})::int`,
      })
      .from(pullRequests)
      .innerJoin(
        repositories,
        eq(repositories.id, pullRequests.repositoryId)
      )
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .innerJoin(prComments, eq(prComments.pullRequestId, pullRequests.id))
      .where(
        and(
          eq(pullRequests.authorId, userId),
          eq(pullRequests.state, "open"),
          ne(prComments.authorId, userId),
          gte(prComments.createdAt, since48h)
        )
      )
      .groupBy(pullRequests.id, repositories.name, users.username)
      .orderBy(desc(pullRequests.updatedAt))
      .limit(10);

    for (const row of authoredPrs) {
      const count = row.commentCount || 0;
      if (count === 0) continue;
      items.push({
        type: "pr_comment",
        title: `New comments on your PR: ${row.pr.title}`,
        subtitle: `${count} new comment${count === 1 ? "" : "s"} · ${row.repoName}`,
        url: `${base}/${row.ownerUsername}/${row.repoName}/pulls/${row.pr.number}`,
        repoName: row.repoName,
        createdAt: new Date(row.pr.updatedAt),
      });
    }
  } catch (err) {
    console.error("[smart-digest] pr-comments query failed:", err);
  }

  // --- 4. Failed gate runs for repos the user owns (last 24h) ---
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  try {
    const ownedRepos = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(eq(repositories.ownerId, userId));

    if (ownedRepos.length > 0) {
      const repoIds = ownedRepos.map((r) => r.id);
      const repoById = new Map(ownedRepos.map((r) => [r.id, r.name]));

      const failedGates = await db
        .select()
        .from(gateRuns)
        .where(
          and(
            inArray(gateRuns.repositoryId, repoIds),
            eq(gateRuns.status, "failed"),
            gte(gateRuns.createdAt, since24h)
          )
        )
        .orderBy(desc(gateRuns.createdAt))
        .limit(10);

      for (const gate of failedGates) {
        const repoName = repoById.get(gate.repositoryId) || "?";
        items.push({
          type: "ci_failure",
          title: `Gate failed: ${gate.gateName} in ${repoName}`,
          subtitle: `commit ${gate.commitSha.slice(0, 7)} · ${repoName}`,
          url: `${base}/${userId}/${repoName}/pulls`,
          repoName,
          createdAt: new Date(gate.createdAt),
        });
      }

      // --- 5. Dependency update PRs ---
      if (repoIds.length > 0) {
        const depPrs = await db
          .select({
            pr: pullRequests,
            repoName: repositories.name,
          })
          .from(pullRequests)
          .innerJoin(
            repositories,
            eq(repositories.id, pullRequests.repositoryId)
          )
          .where(
            and(
              inArray(pullRequests.repositoryId, repoIds),
              eq(pullRequests.state, "open"),
              sql`${pullRequests.headBranch} LIKE 'gluecron/dep-update%'`
            )
          )
          .orderBy(desc(pullRequests.createdAt))
          .limit(5);

        for (const row of depPrs) {
          items.push({
            type: "dep_update",
            title: `Dependency update ready: ${row.pr.title}`,
            subtitle: `auto-PR · ${row.repoName}`,
            url: `${base}/${userId}/${row.repoName}/pulls/${row.pr.number}`,
            repoName: row.repoName,
            createdAt: new Date(row.pr.createdAt),
          });
        }
      }
    }
  } catch (err) {
    console.error("[smart-digest] gate/dep-update query failed:", err);
  }

  return items;
}

// ---------------------------------------------------------------------------
// Stats loader
// ---------------------------------------------------------------------------

async function loadStats(
  userId: string,
  now: Date
): Promise<SmartDigest["stats"]> {
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  let prsReviewed = 0;
  let issuesClosed = 0;
  const commitsThisWeek = 0; // Git log not easily queryable via SQL; default 0

  try {
    const [reviewCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(prReviews)
      .where(
        and(
          eq(prReviews.reviewerId, userId),
          gte(prReviews.createdAt, since7d),
          sql`${prReviews.state} IN ('approved','changes_requested')`
        )
      );
    prsReviewed = reviewCountRow?.count || 0;
  } catch {
    /* swallow */
  }

  try {
    const [issueCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          gte(issues.updatedAt, since7d),
          eq(issues.state, "closed")
        )
      );
    issuesClosed = issueCountRow?.count || 0;
  } catch {
    /* swallow */
  }

  return { prsReviewed, issuesClosed, commitsThisWeek };
}

// ---------------------------------------------------------------------------
// Claude call
// ---------------------------------------------------------------------------

interface ClaudeDigestResponse {
  headline: string;
  queue: Array<{
    priority: "blocking" | "important" | "fyi";
    type: DigestItem["type"];
    title: string;
    subtitle: string;
    url: string;
    repoName: string;
  }>;
  insight?: string;
}

async function callClaude(
  rawItems: RawItem[],
  stats: SmartDigest["stats"],
  username: string
): Promise<ClaudeDigestResponse | null> {
  if (!isAiAvailable()) return null;
  try {
    const client = getAnthropic();
    const itemsJson = JSON.stringify(
      rawItems.map((i) => ({
        type: i.type,
        title: i.title,
        subtitle: i.subtitle,
        url: i.url,
        repoName: i.repoName,
      })),
      null,
      2
    );
    const statsJson = JSON.stringify(stats, null, 2);

    const prompt = `You are a developer productivity assistant for ${username}. Create a morning digest.

Their pending items:
${itemsJson}

Their recent stats (last 7 days):
${statsJson}

Return JSON only (no markdown wrapper):
{
  "headline": "...",
  "queue": [{"priority": "blocking"|"important"|"fyi", "type": "pr_review"|"pr_comment"|"ci_failure"|"mention"|"dep_update"|"new_issue", "title": "...", "subtitle": "...", "url": "...", "repoName": "..."}, ...],
  "insight": "..."
}

Rules:
- Max 8 items in queue
- blocking = someone explicitly waiting on this person, or a CI failure blocking a deploy
- important = needs action today
- fyi = nice to know
- headline should be specific and human ("PR #45 is blocking a deploy" not "You have notifications")
- insight should be personal and brief (skip if nothing interesting)
- If no items, headline = "All caught up — nothing needs your attention right now"
- Return valid JSON only, no commentary`;

    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractText(msg);
    const parsed = parseJsonResponse<ClaudeDigestResponse>(text);
    return parsed;
  } catch (err) {
    console.error("[smart-digest] Claude call failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback (no AI)
// ---------------------------------------------------------------------------

function buildFallbackDigest(
  rawItems: RawItem[],
  stats: SmartDigest["stats"],
  userId: string
): Omit<SmartDigest, "userId" | "generatedAt" | "stats"> {
  const queue: DigestItem[] = rawItems.slice(0, 8).map((item) => ({
    priority:
      item.type === "ci_failure"
        ? "blocking"
        : item.type === "pr_review"
        ? "important"
        : "fyi",
    type: item.type,
    title: item.title,
    subtitle: item.subtitle,
    url: item.url,
    repoName: item.repoName,
  }));

  const blockingCount = queue.filter((i) => i.priority === "blocking").length;
  const importantCount = queue.filter((i) => i.priority === "important").length;
  let headline = "All caught up — nothing needs your attention right now";
  if (queue.length > 0) {
    if (blockingCount > 0) {
      headline = `${blockingCount} blocking item${blockingCount === 1 ? "" : "s"} need${blockingCount === 1 ? "s" : ""} your attention`;
    } else if (importantCount > 0) {
      headline = `${importantCount} item${importantCount === 1 ? "" : "s"} to action today`;
    } else {
      headline = `${queue.length} item${queue.length === 1 ? "" : "s"} in your queue`;
    }
  }

  return { headline, queue };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose a smart digest for the given user. Never throws.
 * Returns null if the user is not found or any fatal error occurs.
 */
export async function composeSmartDigest(
  userId: string
): Promise<SmartDigest | null> {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return null;

    const now = new Date();
    const [rawItems, stats] = await Promise.all([
      loadRawItems(userId, now),
      loadStats(userId, now),
    ]);

    let headline = "All caught up — nothing needs your attention right now";
    let queue: DigestItem[] = [];
    let insight: string | undefined;

    const claudeResult = await callClaude(rawItems, stats, user.username);
    if (claudeResult) {
      headline = claudeResult.headline || headline;
      queue = (claudeResult.queue || []).slice(0, 8) as DigestItem[];
      insight = claudeResult.insight || undefined;
    } else {
      const fallback = buildFallbackDigest(rawItems, stats, userId);
      headline = fallback.headline;
      queue = fallback.queue;
    }

    return {
      userId,
      generatedAt: now.toISOString(),
      headline,
      queue,
      stats,
      insight,
    };
  } catch (err) {
    console.error("[smart-digest] composeSmartDigest error:", err);
    return null;
  }
}

/** Minimum hours between digests. */
const SMART_DIGEST_COOLDOWN_HOURS = 20;

/**
 * Compose + store a single notification for the user.
 * Updates `last_smart_digest_sent_at`. Respects the 20h cooldown.
 * Never throws.
 */
export async function sendSmartDigest(userId: string): Promise<void> {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return;

    // Cooldown check — skip if sent recently
    const lastSent = user.lastSmartDigestSentAt as Date | null;
    if (lastSent) {
      const hoursSince =
        (Date.now() - new Date(lastSent).getTime()) / 3_600_000;
      if (hoursSince < SMART_DIGEST_COOLDOWN_HOURS) {
        return;
      }
    }

    const digest = await composeSmartDigest(userId);
    if (!digest) return;

    // Insert a single 'digest' notification with full JSON in body
    await db.insert(notifications).values({
      userId,
      kind: "digest",
      title: digest.headline,
      body: JSON.stringify(digest),
      url: "/digest",
    });

    // Update timestamp
    await db
      .update(users)
      .set({ lastSmartDigestSentAt: new Date() })
      .where(eq(users.id, userId));
  } catch (err) {
    console.error("[smart-digest] sendSmartDigest error:", err);
  }
}

/**
 * Send smart digests to all opted-in users. Called from the autopilot loop.
 * Never throws.
 */
export async function sendSmartDigestsToAll(): Promise<void> {
  try {
    const candidates = await db
      .select({ id: users.id })
      .from(users)
      .where(
        sql`(${users.notifyEmailDigestWeekly} = true OR ${users.notifySmartDigest} = true)`
      )
      .limit(200);

    for (const candidate of candidates) {
      try {
        await sendSmartDigest(candidate.id);
      } catch (err) {
        console.error(
          `[smart-digest] per-user error for user=${candidate.id}:`,
          err
        );
      }
    }
  } catch (err) {
    console.error("[smart-digest] sendSmartDigestsToAll error:", err);
  }
}

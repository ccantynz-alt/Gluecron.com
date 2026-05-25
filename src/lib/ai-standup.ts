/**
 * AI Standup — daily / weekly Claude-generated team brief.
 *
 * Goal: every developer wakes up to a single "here's what your team shipped,
 * what's blocked, what's at risk" summary — the morning routine that keeps
 * gluecron sticky.
 *
 * Entry point: `generateStandup({ userId, scope })`. Pulls PRs / issues /
 * (site-admin only) platform deploys updated in the window, hands the
 * material to Sonnet 4 with a strict structured-output contract, and
 * returns `{ summary, shippedItems, blockedItems, atRiskItems }`.
 *
 * `deliverStandup` is the autopilot-facing helper: it generates the
 * standup, dedupes against the most recent same-day row, inserts an
 * inbox notification (kind="ai-standup"), and optionally emails the user
 * when they have email standup enabled.
 *
 * Degrades gracefully:
 *   - `ANTHROPIC_API_KEY` missing → returns a deterministic
 *     fallback summary (raw bullet lists) so the autopilot still ships
 *     a brief.
 *   - Any DB/network error is caught and surfaced as `aiAvailable: false`
 *     with a non-empty `summary`. Functions never throw.
 */

import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  pullRequests,
  repoCollaborators,
  repositories,
  siteAdmins,
  users,
} from "../db/schema";
import { platformDeploys } from "../db/schema-deploys";
import { aiStandups, userStandupPrefs } from "../db/schema-standup";
import {
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
  parseJsonResponse,
} from "./ai-client";
import { notify, type NotificationKind } from "./notify";
import { sendEmail, absoluteUrl } from "./email";

export type StandupScope = "daily" | "weekly";

export interface StandupResult {
  /** 200-300 word markdown brief, sectioned by Shipped / In flight / At risk. */
  summary: string;
  /** Concise bullet list of what shipped (closed PRs, merged PRs, closed issues). */
  shippedItems: string[];
  /** What's still open / awaiting review. */
  blockedItems: string[];
  /** Items older than 3 days with no movement. */
  atRiskItems: string[];
  /** Window bounds (UTC) the standup covers. */
  windowStart: Date;
  windowEnd: Date;
  /** Did Claude actually run, or did we fall back to a deterministic body? */
  aiAvailable: boolean;
}

export interface GenerateStandupArgs {
  userId: string;
  scope: StandupScope;
  /** Override the wall clock (tests). */
  now?: Date;
}

interface PrSlice {
  id: string;
  number: number;
  title: string;
  state: string;
  isAiBuilt: boolean;
  mergedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
  repo: string;
}

interface IssueSlice {
  id: string;
  number: number;
  title: string;
  state: string;
  closedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
  repo: string;
}

interface DeploySlice {
  runId: string;
  sha: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
}

const DAILY_WINDOW_HOURS = 24;
const WEEKLY_WINDOW_HOURS = 24 * 7;
const STALE_HOURS = 24 * 3;
const MAX_PRS = 40;
const MAX_ISSUES = 40;
const MAX_DEPLOYS = 20;
const AI_TITLE_HINTS = ["ai:build", "[ai]", "ai-build"];

/** UTC-day key (YYYY-MM-DD) for cheap dedupe. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

/**
 * Resolve the set of repository ids the user owns or collaborates on.
 * Returns an empty array when the DB lookup fails so callers can degrade
 * gracefully rather than throwing.
 */
async function listUserRepoIds(userId: string): Promise<string[]> {
  try {
    const owned = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.ownerId, userId));
    const collabs = await db
      .select({ id: repoCollaborators.repositoryId })
      .from(repoCollaborators)
      .where(eq(repoCollaborators.userId, userId));
    const all = new Set<string>();
    for (const r of owned) all.add(r.id);
    for (const r of collabs) all.add(r.id);
    return Array.from(all);
  } catch (err) {
    console.error("[ai-standup] listUserRepoIds failed:", err);
    return [];
  }
}

async function isUserSiteAdmin(userId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ userId: siteAdmins.userId })
      .from(siteAdmins)
      .where(eq(siteAdmins.userId, userId))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function loadRepoNames(repoIds: string[]): Promise<Record<string, string>> {
  if (repoIds.length === 0) return {};
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .where(inArray(repositories.id, repoIds));
    const owners = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(
        inArray(
          users.id,
          Array.from(new Set(rows.map((r) => r.ownerId)))
        )
      );
    const ownerById = new Map(owners.map((o) => [o.id, o.username]));
    const out: Record<string, string> = {};
    for (const r of rows) {
      const owner = ownerById.get(r.ownerId) || "unknown";
      out[r.id] = `${owner}/${r.name}`;
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchPrSlice(
  repoIds: string[],
  windowStart: Date,
  repoNames: Record<string, string>
): Promise<PrSlice[]> {
  if (repoIds.length === 0) return [];
  try {
    const rows = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        state: pullRequests.state,
        mergedAt: pullRequests.mergedAt,
        updatedAt: pullRequests.updatedAt,
        createdAt: pullRequests.createdAt,
        repositoryId: pullRequests.repositoryId,
        headBranch: pullRequests.headBranch,
      })
      .from(pullRequests)
      .where(
        and(
          inArray(pullRequests.repositoryId, repoIds),
          or(
            gte(pullRequests.updatedAt, windowStart),
            gte(pullRequests.mergedAt, windowStart)
          )
        )
      )
      .orderBy(desc(pullRequests.updatedAt))
      .limit(MAX_PRS);
    return rows.map((r) => {
      const haystack = `${r.title} ${r.headBranch}`.toLowerCase();
      const isAiBuilt = AI_TITLE_HINTS.some((h) => haystack.includes(h));
      return {
        id: r.id,
        number: r.number,
        title: r.title,
        state: r.state,
        isAiBuilt,
        mergedAt: r.mergedAt,
        updatedAt: r.updatedAt,
        createdAt: r.createdAt,
        repo: repoNames[r.repositoryId] || "repo",
      };
    });
  } catch (err) {
    console.error("[ai-standup] fetchPrSlice failed:", err);
    return [];
  }
}

async function fetchIssueSlice(
  repoIds: string[],
  windowStart: Date,
  repoNames: Record<string, string>
): Promise<IssueSlice[]> {
  if (repoIds.length === 0) return [];
  try {
    const rows = await db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        state: issues.state,
        closedAt: issues.closedAt,
        updatedAt: issues.updatedAt,
        createdAt: issues.createdAt,
        repositoryId: issues.repositoryId,
      })
      .from(issues)
      .where(
        and(
          inArray(issues.repositoryId, repoIds),
          or(
            gte(issues.updatedAt, windowStart),
            gte(issues.createdAt, windowStart),
            gte(issues.closedAt, windowStart)
          )
        )
      )
      .orderBy(desc(issues.updatedAt))
      .limit(MAX_ISSUES);
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      state: r.state,
      closedAt: r.closedAt,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
      repo: repoNames[r.repositoryId] || "repo",
    }));
  } catch (err) {
    console.error("[ai-standup] fetchIssueSlice failed:", err);
    return [];
  }
}

async function fetchDeploySlice(windowStart: Date): Promise<DeploySlice[]> {
  try {
    const rows = await db
      .select({
        runId: platformDeploys.runId,
        sha: platformDeploys.sha,
        status: platformDeploys.status,
        startedAt: platformDeploys.startedAt,
        finishedAt: platformDeploys.finishedAt,
      })
      .from(platformDeploys)
      .where(gte(platformDeploys.startedAt, windowStart))
      .orderBy(desc(platformDeploys.startedAt))
      .limit(MAX_DEPLOYS);
    return rows;
  } catch (err) {
    console.error("[ai-standup] fetchDeploySlice failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — split material into shipped / in-flight / at-risk and render
// the deterministic fallback summary. Exposed via __test for unit coverage.
// ---------------------------------------------------------------------------

export interface ClassifiedItems {
  shipped: string[];
  inFlight: string[];
  atRisk: string[];
  aiHighlights: string[];
}

export function classifyMaterial(args: {
  prs: PrSlice[];
  issues: IssueSlice[];
  deploys: DeploySlice[];
  now: Date;
}): ClassifiedItems {
  const { prs, issues: issueRows, deploys, now } = args;
  const staleCutoff = hoursAgo(now, STALE_HOURS);

  const shipped: string[] = [];
  const inFlight: string[] = [];
  const atRisk: string[] = [];
  const aiHighlights: string[] = [];

  for (const pr of prs) {
    const line = `PR #${pr.number} ${pr.title} (${pr.repo})`;
    if (pr.state === "merged" || pr.mergedAt) {
      shipped.push(`Merged ${line}`);
      if (pr.isAiBuilt) aiHighlights.push(`AI-merged ${line}`);
    } else if (pr.state === "closed") {
      shipped.push(`Closed ${line}`);
    } else {
      // open
      if (pr.updatedAt < staleCutoff) {
        atRisk.push(`Stale ${line} — no movement in 3+ days`);
      } else {
        inFlight.push(`Open ${line}`);
      }
      if (pr.isAiBuilt) aiHighlights.push(`AI-authored ${line}`);
    }
  }

  for (const issue of issueRows) {
    const line = `Issue #${issue.number} ${issue.title} (${issue.repo})`;
    if (issue.state === "closed" || issue.closedAt) {
      shipped.push(`Closed ${line}`);
    } else if (issue.updatedAt < staleCutoff) {
      atRisk.push(`Stale ${line} — no movement in 3+ days`);
    } else {
      inFlight.push(`Open ${line}`);
    }
  }

  for (const dep of deploys) {
    const shortSha = (dep.sha || "").slice(0, 7);
    if (dep.status === "succeeded") {
      shipped.push(`Deploy ${shortSha} succeeded`);
    } else if (dep.status === "failed") {
      atRisk.push(`Deploy ${shortSha} failed`);
    } else {
      inFlight.push(`Deploy ${shortSha} in progress`);
    }
  }

  return { shipped, inFlight, atRisk, aiHighlights };
}

function renderFallbackSummary(
  scope: StandupScope,
  classified: ClassifiedItems
): string {
  const header =
    scope === "daily"
      ? "Daily standup (last 24 hours)"
      : "Weekly standup (last 7 days)";
  const lines: string[] = [`# ${header}`, ""];
  lines.push("AI summary unavailable — raw activity below.", "");
  lines.push("## 🚀 Shipped");
  if (classified.shipped.length === 0) lines.push("- (nothing this window)");
  else for (const s of classified.shipped.slice(0, 10)) lines.push(`- ${s}`);
  lines.push("", "## 🚧 In flight");
  if (classified.inFlight.length === 0) lines.push("- (nothing in flight)");
  else for (const s of classified.inFlight.slice(0, 10)) lines.push(`- ${s}`);
  lines.push("", "## ⚠️ At risk or blocked");
  if (classified.atRisk.length === 0) lines.push("- (nothing at risk)");
  else for (const s of classified.atRisk.slice(0, 10)) lines.push(`- ${s}`);
  if (classified.aiHighlights.length > 0) {
    lines.push("", "## 🤖 AI-driven changes");
    for (const s of classified.aiHighlights.slice(0, 10)) lines.push(`- ${s}`);
  }
  return lines.join("\n");
}

function buildPrompt(
  scope: StandupScope,
  classified: ClassifiedItems
): string {
  const scopeLabel =
    scope === "daily" ? "the last 24 hours" : "the last 7 days";
  return [
    "You are Gluecron's standup writer. Generate a 200-300 word standup brief for a developer.",
    `Window: ${scopeLabel}.`,
    "",
    "Required sections (in order):",
    "  🚀 Shipped — concise list of merged/closed/deployed items",
    "  🚧 In flight — open PRs / issues with recent activity",
    "  ⚠️ At risk or blocked — anything older than 3 days with no movement",
    "  🤖 AI-driven changes — highlight separately if any (omit section if none)",
    "",
    "Tone: factual, terse, developer-friendly. No filler. No 'great work team' fluff.",
    "Output: plain markdown, sections as headings (##). Word count 200-300.",
    "",
    "Material:",
    "Shipped (raw):",
    classified.shipped.slice(0, 20).map((s) => `- ${s}`).join("\n") ||
      "- (none)",
    "",
    "In-flight (raw):",
    classified.inFlight.slice(0, 20).map((s) => `- ${s}`).join("\n") ||
      "- (none)",
    "",
    "At-risk (raw):",
    classified.atRisk.slice(0, 20).map((s) => `- ${s}`).join("\n") ||
      "- (none)",
    "",
    "AI highlights (raw):",
    classified.aiHighlights.slice(0, 20).map((s) => `- ${s}`).join("\n") ||
      "- (none)",
    "",
    "Respond with JSON ONLY (no prose around it) of the shape:",
    '{"summary": "<markdown body>", "shippedItems": ["..."], "blockedItems": ["..."], "atRiskItems": ["..."]}',
  ].join("\n");
}

async function askClaudeForStandup(
  scope: StandupScope,
  classified: ClassifiedItems
): Promise<Pick<
  StandupResult,
  "summary" | "shippedItems" | "blockedItems" | "atRiskItems"
> | null> {
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1500,
      messages: [{ role: "user", content: buildPrompt(scope, classified) }],
    });
    try {
      const { recordAiCost, extractUsage } = await import("./ai-cost-tracker");
      const usage = extractUsage(message);
      await recordAiCost({
        model: MODEL_SONNET,
        inputTokens: usage.input,
        outputTokens: usage.output,
        category: "standup",
        sourceKind: "standup",
      });
    } catch {
      /* swallow — best-effort */
    }
    const parsed = parseJsonResponse<{
      summary?: string;
      shippedItems?: unknown;
      blockedItems?: unknown;
      atRiskItems?: unknown;
    }>(extractText(message));
    if (!parsed) return null;
    const arrify = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x) => typeof x === "string") as string[] : [];
    return {
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : renderFallbackSummary(scope, classified),
      shippedItems: arrify(parsed.shippedItems),
      blockedItems: arrify(parsed.blockedItems),
      atRiskItems: arrify(parsed.atRiskItems),
    };
  } catch (err) {
    console.error("[ai-standup] askClaudeForStandup failed:", err);
    return null;
  }
}

/**
 * Generate a standup for a single user. Never throws. When the AI key is
 * absent the returned `summary` falls back to a deterministic body so
 * callers can still display + email something meaningful.
 */
export async function generateStandup(
  args: GenerateStandupArgs
): Promise<StandupResult> {
  const now = args.now ?? new Date();
  const windowHours =
    args.scope === "weekly" ? WEEKLY_WINDOW_HOURS : DAILY_WINDOW_HOURS;
  const windowStart = hoursAgo(now, windowHours);

  const repoIds = await listUserRepoIds(args.userId);
  const repoNames = await loadRepoNames(repoIds);

  const [prs, issueRows, isAdmin] = await Promise.all([
    fetchPrSlice(repoIds, windowStart, repoNames),
    fetchIssueSlice(repoIds, windowStart, repoNames),
    isUserSiteAdmin(args.userId),
  ]);
  const deploys = isAdmin ? await fetchDeploySlice(windowStart) : [];

  const classified = classifyMaterial({
    prs,
    issues: issueRows,
    deploys,
    now,
  });

  const fallback = {
    summary: renderFallbackSummary(args.scope, classified),
    shippedItems: classified.shipped.slice(0, 12),
    blockedItems: classified.inFlight.slice(0, 12),
    atRiskItems: classified.atRisk.slice(0, 12),
  };

  let aiAvailable = false;
  let chosen = fallback;
  if (isAiAvailable()) {
    const ai = await askClaudeForStandup(args.scope, classified);
    if (ai) {
      aiAvailable = true;
      chosen = {
        summary: ai.summary,
        shippedItems:
          ai.shippedItems.length > 0
            ? ai.shippedItems
            : fallback.shippedItems,
        blockedItems:
          ai.blockedItems.length > 0
            ? ai.blockedItems
            : fallback.blockedItems,
        atRiskItems:
          ai.atRiskItems.length > 0
            ? ai.atRiskItems
            : fallback.atRiskItems,
      };
    }
  }

  return {
    summary: chosen.summary,
    shippedItems: chosen.shippedItems,
    blockedItems: chosen.blockedItems,
    atRiskItems: chosen.atRiskItems,
    windowStart,
    windowEnd: now,
    aiAvailable,
  };
}

// ---------------------------------------------------------------------------
// Persistence + delivery
// ---------------------------------------------------------------------------

export interface DeliverStandupResult {
  ok: boolean;
  /** New `ai_standups.id` when one was inserted, null otherwise. */
  standupId: string | null;
  reason?: string;
  emailed: boolean;
  notified: boolean;
}

/**
 * Look up the user's standup pref row, returning null when none exists
 * (i.e. they've never toggled anything → treated as opted-out).
 */
export async function getStandupPrefs(
  userId: string
): Promise<{
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  emailEnabled: boolean;
  hourUtc: number;
  lastDailySentAt: Date | null;
  lastWeeklySentAt: Date | null;
} | null> {
  try {
    const [row] = await db
      .select()
      .from(userStandupPrefs)
      .where(eq(userStandupPrefs.userId, userId))
      .limit(1);
    if (!row) return null;
    return {
      dailyEnabled: row.dailyEnabled,
      weeklyEnabled: row.weeklyEnabled,
      emailEnabled: row.emailEnabled,
      hourUtc: row.hourUtc,
      lastDailySentAt: row.lastDailySentAt,
      lastWeeklySentAt: row.lastWeeklySentAt,
    };
  } catch (err) {
    console.error("[ai-standup] getStandupPrefs failed:", err);
    return null;
  }
}

/**
 * Upsert the standup preferences for a user. Used by /settings.
 */
export async function setStandupPrefs(
  userId: string,
  prefs: {
    dailyEnabled: boolean;
    weeklyEnabled: boolean;
    emailEnabled: boolean;
    hourUtc?: number;
  }
): Promise<void> {
  const hour = (() => {
    if (typeof prefs.hourUtc !== "number" || !Number.isFinite(prefs.hourUtc))
      return 9;
    const h = Math.floor(prefs.hourUtc);
    if (h < 0) return 0;
    if (h > 23) return 23;
    return h;
  })();
  try {
    const existing = await db
      .select({ userId: userStandupPrefs.userId })
      .from(userStandupPrefs)
      .where(eq(userStandupPrefs.userId, userId))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(userStandupPrefs).values({
        userId,
        dailyEnabled: prefs.dailyEnabled,
        weeklyEnabled: prefs.weeklyEnabled,
        emailEnabled: prefs.emailEnabled,
        hourUtc: hour,
      });
    } else {
      await db
        .update(userStandupPrefs)
        .set({
          dailyEnabled: prefs.dailyEnabled,
          weeklyEnabled: prefs.weeklyEnabled,
          emailEnabled: prefs.emailEnabled,
          hourUtc: hour,
          updatedAt: new Date(),
        })
        .where(eq(userStandupPrefs.userId, userId));
    }
  } catch (err) {
    console.error("[ai-standup] setStandupPrefs failed:", err);
  }
}

/**
 * List recent standups for a user (for the /standups feed).
 */
export async function listRecentStandups(
  userId: string,
  limit = 30
): Promise<
  Array<{
    id: string;
    scope: string;
    summary: string;
    shippedItems: string[];
    blockedItems: string[];
    atRiskItems: string[];
    windowStart: Date;
    windowEnd: Date;
    aiAvailable: boolean;
    createdAt: Date;
  }>
> {
  try {
    const rows = await db
      .select()
      .from(aiStandups)
      .where(eq(aiStandups.userId, userId))
      .orderBy(desc(aiStandups.createdAt))
      .limit(limit);
    const parseArr = (raw: string): string[] => {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v)
          ? (v.filter((x) => typeof x === "string") as string[])
          : [];
      } catch {
        return [];
      }
    };
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      summary: r.summary,
      shippedItems: parseArr(r.shippedItems),
      blockedItems: parseArr(r.blockedItems),
      atRiskItems: parseArr(r.atRiskItems),
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      aiAvailable: r.aiAvailable,
      createdAt: r.createdAt,
    }));
  } catch (err) {
    console.error("[ai-standup] listRecentStandups failed:", err);
    return [];
  }
}

/**
 * Has the user already received a standup for this (scope, UTC day)?
 * Used to dedupe so the autopilot doesn't double-fire on a tight tick loop.
 */
export async function hasStandupForToday(
  userId: string,
  scope: StandupScope,
  now: Date
): Promise<boolean> {
  const key = utcDayKey(now);
  try {
    // We pull the most recent row for this user+scope; matching by UTC day
    // happens in JS so this stays portable across drizzle backends.
    const rows = await db
      .select({ createdAt: aiStandups.createdAt })
      .from(aiStandups)
      .where(
        and(eq(aiStandups.userId, userId), eq(aiStandups.scope, scope))
      )
      .orderBy(desc(aiStandups.createdAt))
      .limit(1);
    if (rows.length === 0) return false;
    const latest = rows[0].createdAt;
    return utcDayKey(new Date(latest)) === key;
  } catch (err) {
    console.error("[ai-standup] hasStandupForToday failed:", err);
    // Fail-open: if we can't tell, assume not (better to send than dedupe-block).
    return false;
  }
}

/** Notification kind for standups. */
export const STANDUP_NOTIFICATION_KIND: NotificationKind =
  "ai_review" as NotificationKind;
// Note: NotificationKind is closed today; we re-use 'ai_review' for now —
// the inbox surface treats anything with kind != mention/assign/gate_failed
// as a generic info card, so this lights up correctly.
// The user-facing title still says "Standup" so the recipient isn't confused.

export interface DeliverStandupArgs {
  userId: string;
  scope: StandupScope;
  /** Override the wall clock (tests). */
  now?: Date;
  /** Inject a generator (tests). */
  generate?: (args: GenerateStandupArgs) => Promise<StandupResult>;
  /** Inject the dedupe check (tests). */
  alreadyDelivered?: (
    userId: string,
    scope: StandupScope,
    now: Date
  ) => Promise<boolean>;
  /** Force-skip the dedupe gate (tests). */
  bypassDedupe?: boolean;
}

/**
 * Generate + deliver a standup. Used by the autopilot tasks. Never throws.
 */
export async function deliverStandup(
  args: DeliverStandupArgs
): Promise<DeliverStandupResult> {
  const now = args.now ?? new Date();
  const generate = args.generate ?? generateStandup;
  const dedupeFn = args.alreadyDelivered ?? hasStandupForToday;

  try {
    if (!args.bypassDedupe) {
      const already = await dedupeFn(args.userId, args.scope, now);
      if (already) {
        return {
          ok: false,
          standupId: null,
          reason: "already delivered today",
          emailed: false,
          notified: false,
        };
      }
    }

    const result = await generate({
      userId: args.userId,
      scope: args.scope,
      now,
    });

    let standupId: string | null = null;
    try {
      const [row] = await db
        .insert(aiStandups)
        .values({
          userId: args.userId,
          scope: args.scope,
          summary: result.summary,
          shippedItems: JSON.stringify(result.shippedItems),
          blockedItems: JSON.stringify(result.blockedItems),
          atRiskItems: JSON.stringify(result.atRiskItems),
          windowStart: result.windowStart,
          windowEnd: result.windowEnd,
          aiAvailable: result.aiAvailable,
        })
        .returning();
      standupId = row?.id ?? null;
    } catch (err) {
      console.error("[ai-standup] insert failed:", err);
    }

    const scopeLabel = args.scope === "daily" ? "Daily" : "Weekly";
    const title = `${scopeLabel} standup — ${result.shippedItems.length} shipped, ${result.atRiskItems.length} at risk`;

    let notified = false;
    try {
      await notify(args.userId, {
        kind: STANDUP_NOTIFICATION_KIND,
        title,
        body: result.summary,
        url: standupId ? `/standups#${standupId}` : "/standups",
      });
      notified = true;
    } catch (err) {
      console.error("[ai-standup] notify failed:", err);
    }

    // Email — only when the user has emailEnabled.
    let emailed = false;
    try {
      const prefs = await getStandupPrefs(args.userId);
      if (prefs?.emailEnabled) {
        const [u] = await db
          .select({ email: users.email, username: users.username })
          .from(users)
          .where(eq(users.id, args.userId))
          .limit(1);
        if (u?.email) {
          const subject = `[gluecron] ${scopeLabel} standup`;
          const link = absoluteUrl("/standups");
          const text = [
            `Hi ${u.username || "there"},`,
            "",
            result.summary,
            "",
            "—",
            `Full feed: ${link}`,
            "Opt out at /settings.",
          ].join("\n");
          const res = await sendEmail({
            to: u.email,
            subject,
            text,
          });
          emailed = !!res.ok;
        }
      }
    } catch (err) {
      console.error("[ai-standup] email failed:", err);
    }

    // Stamp the last-sent timestamp so the autopilot hour gate behaves.
    try {
      const column =
        args.scope === "daily"
          ? userStandupPrefs.lastDailySentAt
          : userStandupPrefs.lastWeeklySentAt;
      const set =
        args.scope === "daily"
          ? { lastDailySentAt: now, updatedAt: now }
          : { lastWeeklySentAt: now, updatedAt: now };
      // best-effort update — no-op if the pref row doesn't exist.
      void column;
      await db
        .update(userStandupPrefs)
        .set(set)
        .where(eq(userStandupPrefs.userId, args.userId));
    } catch {
      /* best-effort */
    }

    return {
      ok: true,
      standupId,
      emailed,
      notified,
    };
  } catch (err) {
    console.error("[ai-standup] deliverStandup error:", err);
    return {
      ok: false,
      standupId: null,
      reason: (err as Error).message || "error",
      emailed: false,
      notified: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Autopilot tick helpers
// ---------------------------------------------------------------------------

export interface StandupTickSummary {
  scope: StandupScope;
  sent: number;
  skipped: number;
  errors: number;
}

export interface StandupTickDeps {
  /** Inject the candidate finder (tests). */
  findCandidates?: () => Promise<
    Array<{
      userId: string;
      hourUtc: number;
      lastDailySentAt: Date | null;
      lastWeeklySentAt: Date | null;
    }>
  >;
  /** Inject the delivery side-effect (tests). */
  deliver?: (
    userId: string,
    scope: StandupScope,
    now: Date
  ) => Promise<DeliverStandupResult>;
  /** Inject the wall clock (tests). */
  now?: () => Date;
}

async function defaultFindDailyCandidates(): Promise<
  Array<{
    userId: string;
    hourUtc: number;
    lastDailySentAt: Date | null;
    lastWeeklySentAt: Date | null;
  }>
> {
  try {
    const rows = await db
      .select({
        userId: userStandupPrefs.userId,
        hourUtc: userStandupPrefs.hourUtc,
        lastDailySentAt: userStandupPrefs.lastDailySentAt,
        lastWeeklySentAt: userStandupPrefs.lastWeeklySentAt,
      })
      .from(userStandupPrefs)
      .where(eq(userStandupPrefs.dailyEnabled, true))
      .limit(500);
    return rows;
  } catch (err) {
    console.error("[ai-standup] defaultFindDailyCandidates failed:", err);
    return [];
  }
}

async function defaultFindWeeklyCandidates(): Promise<
  Array<{
    userId: string;
    hourUtc: number;
    lastDailySentAt: Date | null;
    lastWeeklySentAt: Date | null;
  }>
> {
  try {
    const rows = await db
      .select({
        userId: userStandupPrefs.userId,
        hourUtc: userStandupPrefs.hourUtc,
        lastDailySentAt: userStandupPrefs.lastDailySentAt,
        lastWeeklySentAt: userStandupPrefs.lastWeeklySentAt,
      })
      .from(userStandupPrefs)
      .where(eq(userStandupPrefs.weeklyEnabled, true))
      .limit(500);
    return rows;
  } catch (err) {
    console.error("[ai-standup] defaultFindWeeklyCandidates failed:", err);
    return [];
  }
}

/**
 * One iteration of the daily-standup autopilot task. Fires for users whose
 * `hour_utc` matches the current UTC hour. Skipped entirely when the AI key
 * is missing — gracefully degrades to a deterministic body, but only if a
 * user explicitly requested standups.
 */
export async function runDailyStandupTaskOnce(
  deps: StandupTickDeps = {}
): Promise<StandupTickSummary> {
  const now = deps.now ? deps.now() : new Date();
  const findCandidates = deps.findCandidates ?? defaultFindDailyCandidates;
  const deliver =
    deps.deliver ??
    (async (userId, scope, _now) =>
      deliverStandup({ userId, scope, now: _now }));

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  const currentHour = now.getUTCHours();

  let candidates: Awaited<ReturnType<typeof findCandidates>> = [];
  try {
    candidates = await findCandidates();
  } catch {
    return { scope: "daily", sent, skipped, errors: 1 };
  }

  for (const cand of candidates) {
    if (cand.hourUtc !== currentHour) {
      skipped += 1;
      continue;
    }
    try {
      const res = await deliver(cand.userId, "daily", now);
      if (res.ok) sent += 1;
      else skipped += 1;
    } catch {
      errors += 1;
    }
  }

  return { scope: "daily", sent, skipped, errors };
}

/**
 * One iteration of the weekly-standup autopilot task. Fires Mondays only,
 * at the user's configured hour.
 */
export async function runWeeklyStandupTaskOnce(
  deps: StandupTickDeps = {}
): Promise<StandupTickSummary> {
  const now = deps.now ? deps.now() : new Date();
  const findCandidates = deps.findCandidates ?? defaultFindWeeklyCandidates;
  const deliver =
    deps.deliver ??
    (async (userId, scope, _now) =>
      deliverStandup({ userId, scope, now: _now }));

  // getUTCDay: 0=Sun, 1=Mon, ...
  const isMonday = now.getUTCDay() === 1;
  const currentHour = now.getUTCHours();

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  if (!isMonday) {
    return { scope: "weekly", sent, skipped, errors };
  }

  let candidates: Awaited<ReturnType<typeof findCandidates>> = [];
  try {
    candidates = await findCandidates();
  } catch {
    return { scope: "weekly", sent, skipped, errors: 1 };
  }

  for (const cand of candidates) {
    if (cand.hourUtc !== currentHour) {
      skipped += 1;
      continue;
    }
    try {
      const res = await deliver(cand.userId, "weekly", now);
      if (res.ok) sent += 1;
      else skipped += 1;
    } catch {
      errors += 1;
    }
  }

  return { scope: "weekly", sent, skipped, errors };
}

// Suppress unused-import warning when `sql` is dropped by tree-shaking;
// keep the import for forward-compatible queries below.
void sql;

/** Test-only surface. */
export const __test = {
  DAILY_WINDOW_HOURS,
  WEEKLY_WINDOW_HOURS,
  STALE_HOURS,
  classifyMaterial,
  renderFallbackSummary,
  buildPrompt,
  utcDayKey,
};

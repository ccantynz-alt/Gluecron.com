/**
 * `/inbox` — Unified developer inbox.
 *
 * One screen, every signal that needs the user's attention. Replaces
 * what Slack / email do for developers: a single chronological timeline
 * of @mentions, review requests, CI failures, AI findings, and
 * auto-merge events from every repo the user touches.
 *
 * Sources (all best-effort — any one failing returns empty rows rather
 * than 500'ing the whole page):
 *   - mentions:        pr_comments + issue_comments where body matches @username
 *   - review:          open PRs in user's repos with no AI verdict yet
 *   - ci:              workflow_runs status='failure' in user's repos, last 24h
 *   - ai (findings):   repo_advisory_alerts on user's repos (status='open')
 *   - ai (auto-merge): pull_requests merged where mergedAt is set, in user's repos
 *
 * Filter tabs: all | mentions | review | ci | ai
 * Scoped CSS under `.inbox-*`. Cap to 100 rows after merge + sort desc.
 *
 * The pure helpers `mergeAndCapInboxRows` and `filterInboxRows` are
 * exported for unit testing — the route handler itself runs DB I/O and
 * is best-effort by design.
 */

import { Hono } from "hono";
import { eq, and, desc, inArray, sql, isNull, isNotNull, gte } from "drizzle-orm";
import { db } from "../db";
import {
  pullRequests,
  repositories,
  users,
  repoCollaborators,
  prComments,
  issues,
  issueComments,
  repoAdvisoryAlerts,
  securityAdvisories,
  workflowRuns,
  workflows,
} from "../db/schema";
import { notifications as notifTable } from "../db/schema-extensions";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const inboxRoutes = new Hono<AuthEnv>();
inboxRoutes.use("*", softAuth);

// ---------------------------------------------------------------------------
// Types — kept narrow & explicit so the merge step has a single shape.
// ---------------------------------------------------------------------------

export type InboxKind = "mention" | "review" | "ci" | "ai-finding" | "ai-merge";

export interface InboxRow {
  id: string;             // stable per-row id (kind + source row id)
  kind: InboxKind;
  title: string;          // primary text shown on the row
  sourceText: string;     // owner/repo#N or workflow-run-N
  sourceUrl: string;      // where the row opens to
  createdAt: Date;
  body?: string | null;   // optional secondary line (comment snippet, etc)
}

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested.
// ---------------------------------------------------------------------------

/**
 * Merge rows from every source, sort by timestamp desc, cap to `cap`.
 * Defensive against undefined arrays so a missing source becomes [].
 */
export function mergeAndCapInboxRows(
  sources: Array<InboxRow[] | undefined | null>,
  cap = 100
): InboxRow[] {
  const merged: InboxRow[] = [];
  for (const src of sources) {
    if (!src) continue;
    for (const row of src) merged.push(row);
  }
  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return merged.slice(0, cap);
}

/** Tab predicate. `all` returns everything; `ai` covers both AI kinds. */
export function filterInboxRows(rows: InboxRow[], tab: InboxFilter): InboxRow[] {
  if (tab === "all") return rows;
  if (tab === "mentions") return rows.filter((r) => r.kind === "mention");
  if (tab === "review") return rows.filter((r) => r.kind === "review");
  if (tab === "ci") return rows.filter((r) => r.kind === "ci");
  if (tab === "ai")
    return rows.filter((r) => r.kind === "ai-finding" || r.kind === "ai-merge");
  return rows;
}

export type InboxFilter = "all" | "mentions" | "review" | "ci" | "ai";

const VALID_FILTERS: InboxFilter[] = ["all", "mentions", "review", "ci", "ai"];

function relTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// Scoped CSS — all classes prefixed `.inbox-` so nothing leaks. Mirrors the
// pulls-dashboard visual language: gradient hairline + orb + clamp() title.
// ---------------------------------------------------------------------------
const styles = `
  .inbox-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .inbox-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .inbox-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .inbox-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
  }
  .inbox-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .inbox-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .inbox-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .inbox-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .inbox-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .inbox-stats {
    display: flex;
    gap: 24px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .inbox-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .inbox-stat-n {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .inbox-stat-l {
    font-size: 11.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .inbox-tabs {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .inbox-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease;
  }
  .inbox-tab:hover { color: var(--text-strong); text-decoration: none; }
  .inbox-tab.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
  }
  .inbox-tab-count {
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    padding: 1px 7px;
    border-radius: 9999px;
  }
  .inbox-tab.is-active .inbox-tab-count {
    background: rgba(140,109,255,0.22);
    color: var(--text);
  }

  .inbox-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .inbox-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    transition: background 120ms ease;
  }
  .inbox-row:last-child { border-bottom: none; }
  .inbox-row:hover { background: rgba(140,109,255,0.04); }
  .inbox-row-icon {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: var(--bg-secondary, var(--bg));
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: var(--text);
    margin-top: 1px;
  }
  .inbox-row-icon.is-mention { color: #fbbf24; background: rgba(251,191,36,0.10); border-color: rgba(251,191,36,0.25); }
  .inbox-row-icon.is-review  { color: #60a5fa; background: rgba(96,165,250,0.10); border-color: rgba(96,165,250,0.25); }
  .inbox-row-icon.is-ci      { color: #f87171; background: rgba(248,113,113,0.10); border-color: rgba(248,113,113,0.25); }
  .inbox-row-icon.is-ai      {
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 12px rgba(140,109,255,0.40);
  }
  .inbox-row-icon.is-ci .inbox-ci-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: #f87171;
    box-shadow: 0 0 8px rgba(248,113,113,0.55);
  }

  .inbox-row-main { flex: 1; min-width: 0; }
  .inbox-row-title {
    font-family: var(--font-display);
    font-size: 14.5px;
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: -0.012em;
    margin: 0 0 4px;
    color: var(--text-strong);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .inbox-row-title a {
    color: var(--text-strong);
    text-decoration: none;
  }
  .inbox-row-title a:hover { color: var(--accent); }
  .inbox-row-body {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 4px;
  }
  .inbox-row-meta {
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .inbox-row-meta .inbox-sep { opacity: 0.45; }
  .inbox-row-source {
    font-family: var(--font-mono);
    color: var(--text);
  }
  .inbox-row-source:hover { color: var(--accent); text-decoration: none; }

  .inbox-row-kind {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border-radius: 9999px;
  }
  .inbox-row-kind.is-mention { background: rgba(251,191,36,0.13); color: #fbbf24; }
  .inbox-row-kind.is-review  { background: rgba(96,165,250,0.13); color: #93c5fd; }
  .inbox-row-kind.is-ci      { background: rgba(248,113,113,0.13); color: #fca5a5; }
  .inbox-row-kind.is-ai-finding {
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.18));
    color: #d6c7ff;
  }
  .inbox-row-kind.is-ai-merge {
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.18));
    color: #d6c7ff;
  }

  .inbox-row-actions {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .inbox-mark {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 9999px;
    cursor: pointer;
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
  }
  .inbox-mark:hover {
    color: var(--text-strong);
    background: rgba(140,109,255,0.08);
    border-color: rgba(140,109,255,0.30);
    text-decoration: none;
  }

  .inbox-empty {
    padding: 60px 20px;
    text-align: center;
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: var(--bg-elevated);
    position: relative;
    overflow: hidden;
  }
  .inbox-empty::before {
    content: '';
    position: absolute;
    inset: -20% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.10), transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .inbox-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    position: relative;
  }
  .inbox-empty-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0;
    position: relative;
  }

  @media (max-width: 720px) {
    .inbox-hero { padding: 24px 20px; }
    .inbox-row { padding: 12px 14px; flex-direction: column; }
    .inbox-row-actions { align-self: flex-end; }
  }
`;

// ---------------------------------------------------------------------------
// Icon glyphs (inline SVG for a/i/c; emoji-ish glyph for mention).
// ---------------------------------------------------------------------------
function KindIcon({ kind }: { kind: InboxKind }) {
  if (kind === "mention") {
    return (
      <span class="inbox-row-icon is-mention" aria-hidden="true">@</span>
    );
  }
  if (kind === "review") {
    return (
      <span class="inbox-row-icon is-review" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
        </svg>
      </span>
    );
  }
  if (kind === "ci") {
    return (
      <span class="inbox-row-icon is-ci" aria-hidden="true">
        <span class="inbox-ci-dot" />
      </span>
    );
  }
  // ai-finding | ai-merge — gradient sparkle
  return (
    <span class="inbox-row-icon is-ai" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5 6.4 9.1 2 7.5l4.4-1.6L8 1.5z" />
      </svg>
    </span>
  );
}

function KindLabel(kind: InboxKind): string {
  if (kind === "mention") return "Mention";
  if (kind === "review") return "Review";
  if (kind === "ci") return "CI failure";
  if (kind === "ai-finding") return "AI finding";
  return "Auto-merge";
}

// ---------------------------------------------------------------------------
// Best-effort source loaders. Every one swallows errors → returns [].
// ---------------------------------------------------------------------------

/**
 * Compute the set of repos relevant to the user: owned + accepted collab.
 * Returns [] on any error; the page degrades gracefully.
 */
async function getUserRepoIds(userId: string): Promise<string[]> {
  try {
    const owned = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.ownerId, userId));
    const collab = await db
      .select({ id: repoCollaborators.repositoryId })
      .from(repoCollaborators)
      .where(
        and(
          eq(repoCollaborators.userId, userId),
          isNotNull(repoCollaborators.acceptedAt)
        )
      );
    const set = new Set<string>();
    for (const r of owned) set.add(r.id);
    for (const r of collab) set.add(r.id);
    return Array.from(set);
  } catch {
    return [];
  }
}

interface RepoMeta {
  name: string;
  ownerUsername: string;
}

/** Map repo.id → {name, ownerUsername} for source-link rendering. */
async function getRepoMetaMap(
  repoIds: string[]
): Promise<Map<string, RepoMeta>> {
  const map = new Map<string, RepoMeta>();
  if (repoIds.length === 0) return map;
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerUsername: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(inArray(repositories.id, repoIds));
    for (const r of rows) {
      map.set(r.id, { name: r.name, ownerUsername: r.ownerUsername });
    }
  } catch {
    /* skip */
  }
  return map;
}

/**
 * @mentions in pr_comments + issue_comments. We do a case-insensitive
 * `body ILIKE '%@username%'` match against the last 200 comments per
 * source. Cheap and accurate enough — false positives (e.g. "@username"
 * inside a code block) are tolerable for an inbox.
 */
async function loadMentions(
  username: string
): Promise<InboxRow[]> {
  const rows: InboxRow[] = [];
  const needle = `%@${username}%`;
  // PR comments
  try {
    const prRows = await db
      .select({
        id: prComments.id,
        body: prComments.body,
        createdAt: prComments.createdAt,
        prId: prComments.pullRequestId,
        prNumber: pullRequests.number,
        repoId: pullRequests.repositoryId,
      })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.pullRequestId))
      .where(
        and(
          sql`${prComments.body} ILIKE ${needle}`,
          eq(prComments.moderationStatus, "approved")
        )
      )
      .orderBy(desc(prComments.createdAt))
      .limit(50);
    const repoIds = Array.from(new Set(prRows.map((r) => r.repoId)));
    const meta = await getRepoMetaMap(repoIds);
    for (const r of prRows) {
      const m = meta.get(r.repoId);
      if (!m) continue;
      const snippet = (r.body || "").slice(0, 140);
      rows.push({
        id: `mention-pr-${r.id}`,
        kind: "mention",
        title: `Mentioned in ${m.ownerUsername}/${m.name}#${r.prNumber}`,
        body: snippet,
        sourceText: `${m.ownerUsername}/${m.name}#${r.prNumber}`,
        sourceUrl: `/${m.ownerUsername}/${m.name}/pulls/${r.prNumber}`,
        createdAt: r.createdAt,
      });
    }
  } catch {
    /* skip */
  }
  // Issue comments
  try {
    const issueRows = await db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
        issueId: issueComments.issueId,
        issueNumber: issues.number,
        repoId: issues.repositoryId,
      })
      .from(issueComments)
      .innerJoin(issues, eq(issues.id, issueComments.issueId))
      .where(
        and(
          sql`${issueComments.body} ILIKE ${needle}`,
          eq(issueComments.moderationStatus, "approved")
        )
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(50);
    const repoIds = Array.from(new Set(issueRows.map((r) => r.repoId)));
    const meta = await getRepoMetaMap(repoIds);
    for (const r of issueRows) {
      const m = meta.get(r.repoId);
      if (!m) continue;
      const snippet = (r.body || "").slice(0, 140);
      rows.push({
        id: `mention-issue-${r.id}`,
        kind: "mention",
        title: `Mentioned in ${m.ownerUsername}/${m.name}#${r.issueNumber}`,
        body: snippet,
        sourceText: `${m.ownerUsername}/${m.name}#${r.issueNumber}`,
        sourceUrl: `/${m.ownerUsername}/${m.name}/issues/${r.issueNumber}`,
        createdAt: r.createdAt,
      });
    }
  } catch {
    /* skip */
  }
  return rows;
}

/**
 * Review requests = open PRs in user's repos that have NO AI review
 * comment yet (isAiReview=true). Filters out the user's own PRs since
 * you don't review your own work.
 */
async function loadReviewRequests(
  userId: string,
  repoIds: string[]
): Promise<InboxRow[]> {
  if (repoIds.length === 0) return [];
  const rows: InboxRow[] = [];
  try {
    const candidates = await db
      .select({
        prId: pullRequests.id,
        prNumber: pullRequests.number,
        prTitle: pullRequests.title,
        prAuthorId: pullRequests.authorId,
        prUpdatedAt: pullRequests.updatedAt,
        repoId: pullRequests.repositoryId,
      })
      .from(pullRequests)
      .where(
        and(
          inArray(pullRequests.repositoryId, repoIds),
          eq(pullRequests.state, "open"),
          eq(pullRequests.isDraft, false)
        )
      )
      .orderBy(desc(pullRequests.updatedAt))
      .limit(100);
    if (candidates.length === 0) return [];
    const meta = await getRepoMetaMap(
      Array.from(new Set(candidates.map((c) => c.repoId)))
    );
    // Find which PRs already have an AI review.
    const prIds = candidates.map((c) => c.prId);
    let aiSet = new Set<string>();
    try {
      const aiRows = await db
        .select({ prId: prComments.pullRequestId })
        .from(prComments)
        .where(
          and(
            inArray(prComments.pullRequestId, prIds),
            eq(prComments.isAiReview, true)
          )
        );
      aiSet = new Set(aiRows.map((r) => r.prId));
    } catch {
      /* keep empty set — treat all as awaiting */
    }
    for (const c of candidates) {
      if (c.prAuthorId === userId) continue; // don't review your own
      if (aiSet.has(c.prId)) continue;       // already reviewed
      const m = meta.get(c.repoId);
      if (!m) continue;
      rows.push({
        id: `review-${c.prId}`,
        kind: "review",
        title: c.prTitle,
        sourceText: `${m.ownerUsername}/${m.name}#${c.prNumber}`,
        sourceUrl: `/${m.ownerUsername}/${m.name}/pulls/${c.prNumber}`,
        createdAt: c.prUpdatedAt,
      });
    }
  } catch {
    /* skip */
  }
  return rows;
}

/**
 * CI failures = workflow_runs with status='failure' in user's repos
 * over the last 24h. Falls back gracefully if the workflow tables
 * don't exist (e.g. older deployments).
 */
async function loadCiFailures(repoIds: string[]): Promise<InboxRow[]> {
  if (repoIds.length === 0) return [];
  const rows: InboxRow[] = [];
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const runs = await db
      .select({
        id: workflowRuns.id,
        runNumber: workflowRuns.runNumber,
        status: workflowRuns.status,
        conclusion: workflowRuns.conclusion,
        repoId: workflowRuns.repositoryId,
        workflowId: workflowRuns.workflowId,
        createdAt: workflowRuns.createdAt,
        workflowName: workflows.name,
      })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
      .where(
        and(
          inArray(workflowRuns.repositoryId, repoIds),
          eq(workflowRuns.status, "failure"),
          gte(workflowRuns.createdAt, cutoff)
        )
      )
      .orderBy(desc(workflowRuns.createdAt))
      .limit(50);
    const meta = await getRepoMetaMap(
      Array.from(new Set(runs.map((r) => r.repoId)))
    );
    for (const r of runs) {
      const m = meta.get(r.repoId);
      if (!m) continue;
      rows.push({
        id: `ci-${r.id}`,
        kind: "ci",
        title: `${r.workflowName} failed`,
        body: r.conclusion || null,
        sourceText: `${m.ownerUsername}/${m.name} · run #${r.runNumber}`,
        sourceUrl: `/${m.ownerUsername}/${m.name}/actions/runs/${r.id}`,
        createdAt: r.createdAt,
      });
    }
  } catch {
    /* table may not exist — skip */
  }
  return rows;
}

/**
 * AI findings = open security advisory alerts on user's repos. The
 * advisory row carries the human-readable summary + severity.
 */
async function loadAiFindings(repoIds: string[]): Promise<InboxRow[]> {
  if (repoIds.length === 0) return [];
  const rows: InboxRow[] = [];
  try {
    const alerts = await db
      .select({
        id: repoAdvisoryAlerts.id,
        repoId: repoAdvisoryAlerts.repositoryId,
        dependencyName: repoAdvisoryAlerts.dependencyName,
        createdAt: repoAdvisoryAlerts.createdAt,
        summary: securityAdvisories.summary,
        severity: securityAdvisories.severity,
        ghsaId: securityAdvisories.ghsaId,
      })
      .from(repoAdvisoryAlerts)
      .innerJoin(
        securityAdvisories,
        eq(securityAdvisories.id, repoAdvisoryAlerts.advisoryId)
      )
      .where(
        and(
          inArray(repoAdvisoryAlerts.repositoryId, repoIds),
          eq(repoAdvisoryAlerts.status, "open")
        )
      )
      .orderBy(desc(repoAdvisoryAlerts.createdAt))
      .limit(50);
    const meta = await getRepoMetaMap(
      Array.from(new Set(alerts.map((a) => a.repoId)))
    );
    for (const a of alerts) {
      const m = meta.get(a.repoId);
      if (!m) continue;
      rows.push({
        id: `ai-find-${a.id}`,
        kind: "ai-finding",
        title: `${a.severity?.toUpperCase() || "ADVISORY"}: ${a.summary}`,
        body: `${a.dependencyName}${a.ghsaId ? ` · ${a.ghsaId}` : ""}`,
        sourceText: `${m.ownerUsername}/${m.name}`,
        sourceUrl: `/${m.ownerUsername}/${m.name}/security/advisories`,
        createdAt: a.createdAt,
      });
    }
  } catch {
    /* skip */
  }
  return rows;
}

/**
 * Auto-merge events = PRs in user's repos that have been merged
 * (mergedAt is set). We use mergedAt as the timestamp so it sorts
 * correctly into the timeline.
 */
async function loadAutoMergeEvents(repoIds: string[]): Promise<InboxRow[]> {
  if (repoIds.length === 0) return [];
  const rows: InboxRow[] = [];
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  try {
    const merged = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        mergedAt: pullRequests.mergedAt,
        repoId: pullRequests.repositoryId,
      })
      .from(pullRequests)
      .where(
        and(
          inArray(pullRequests.repositoryId, repoIds),
          eq(pullRequests.state, "merged"),
          isNotNull(pullRequests.mergedAt),
          gte(pullRequests.mergedAt, cutoff)
        )
      )
      .orderBy(desc(pullRequests.mergedAt))
      .limit(50);
    const meta = await getRepoMetaMap(
      Array.from(new Set(merged.map((r) => r.repoId)))
    );
    for (const r of merged) {
      const m = meta.get(r.repoId);
      if (!m || !r.mergedAt) continue;
      rows.push({
        id: `ai-merge-${r.id}`,
        kind: "ai-merge",
        title: `Auto-merged: ${r.title}`,
        sourceText: `${m.ownerUsername}/${m.name}#${r.number}`,
        sourceUrl: `/${m.ownerUsername}/${m.name}/pulls/${r.number}`,
        createdAt: r.mergedAt,
      });
    }
  } catch {
    /* skip */
  }
  return rows;
}

/**
 * Unread notification count for the hero / nav badge. Defensive — the
 * table may not exist on older deploys, in which case we report 0.
 */
async function getUnreadNotifCount(userId: string): Promise<number> {
  try {
    const [r] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifTable)
      .where(and(eq(notifTable.userId, userId), eq(notifTable.isRead, false)));
    return r?.count ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// GET /inbox — the unified surface.
// ---------------------------------------------------------------------------
inboxRoutes.get("/inbox", requireAuth, async (c) => {
  const user = c.get("user")!;
  const raw = c.req.query("filter") || "all";
  const filter: InboxFilter = (VALID_FILTERS as string[]).includes(raw)
    ? (raw as InboxFilter)
    : "all";

  const repoIds = await getUserRepoIds(user.id);

  // Load every source in parallel — each is best-effort.
  const [mentionRows, reviewRows, ciRows, aiFindingRows, aiMergeRows] =
    await Promise.all([
      loadMentions(user.username),
      loadReviewRequests(user.id, repoIds),
      loadCiFailures(repoIds),
      loadAiFindings(repoIds),
      loadAutoMergeEvents(repoIds),
    ]);

  const all = mergeAndCapInboxRows(
    [mentionRows, reviewRows, ciRows, aiFindingRows, aiMergeRows],
    100
  );
  const visible = filterInboxRows(all, filter);

  // Counters for the hero + tab strip — derived from the full (pre-filter)
  // dataset so the badges reflect everything, not just the active tab.
  const counts = {
    total: all.length,
    mentions: all.filter((r) => r.kind === "mention").length,
    review: all.filter((r) => r.kind === "review").length,
    ci: all.filter((r) => r.kind === "ci").length,
    ai: all.filter((r) => r.kind === "ai-finding" || r.kind === "ai-merge")
      .length,
  };

  return c.html(
    <Layout
      title="Inbox · Gluecron"
      user={user}
      notificationCount={counts.total}
    >
      <div class="inbox-wrap">
        <section class="inbox-hero">
          <div class="inbox-orb" aria-hidden="true" />
          <div class="inbox-hero-inner">
            <div class="inbox-eyebrow">
              Unified inbox · live ·{" "}
              <span style="color:var(--accent);font-weight:600">
                {user.username}
              </span>
            </div>
            <h1 class="inbox-title">
              <span class="inbox-title-grad">Everything that needs you.</span>
            </h1>
            <p class="inbox-sub">
              One screen for every signal worth your attention. @mentions,
              review requests, CI failures, AI findings, and auto-merge
              events — from every repo you touch, sorted by what just
              happened.
            </p>
            <div class="inbox-stats">
              <div class="inbox-stat">
                <div class="inbox-stat-n">{counts.total}</div>
                <div class="inbox-stat-l">Total</div>
              </div>
              <div class="inbox-stat">
                <div class="inbox-stat-n">{counts.mentions}</div>
                <div class="inbox-stat-l">Mentions</div>
              </div>
              <div class="inbox-stat">
                <div class="inbox-stat-n">{counts.review}</div>
                <div class="inbox-stat-l">Review</div>
              </div>
              <div class="inbox-stat">
                <div class="inbox-stat-n">{counts.ci}</div>
                <div class="inbox-stat-l">CI</div>
              </div>
              <div class="inbox-stat">
                <div class="inbox-stat-n">{counts.ai}</div>
                <div class="inbox-stat-l">AI</div>
              </div>
            </div>
          </div>
        </section>

        <nav class="inbox-tabs" aria-label="Inbox filters">
          <a
            href="/inbox?filter=all"
            class={"inbox-tab " + (filter === "all" ? "is-active" : "")}
          >
            All <span class="inbox-tab-count">{counts.total}</span>
          </a>
          <a
            href="/inbox?filter=mentions"
            class={"inbox-tab " + (filter === "mentions" ? "is-active" : "")}
          >
            Mentions <span class="inbox-tab-count">{counts.mentions}</span>
          </a>
          <a
            href="/inbox?filter=review"
            class={"inbox-tab " + (filter === "review" ? "is-active" : "")}
          >
            Review <span class="inbox-tab-count">{counts.review}</span>
          </a>
          <a
            href="/inbox?filter=ci"
            class={"inbox-tab " + (filter === "ci" ? "is-active" : "")}
          >
            CI <span class="inbox-tab-count">{counts.ci}</span>
          </a>
          <a
            href="/inbox?filter=ai"
            class={"inbox-tab " + (filter === "ai" ? "is-active" : "")}
          >
            AI <span class="inbox-tab-count">{counts.ai}</span>
          </a>
        </nav>

        {visible.length === 0 ? (
          <div class="inbox-empty">
            <h2 class="inbox-empty-title">
              {filter === "all"
                ? "Inbox zero. Nicely done."
                : filter === "mentions"
                  ? "No mentions right now."
                  : filter === "review"
                    ? "Nothing waiting on your review."
                    : filter === "ci"
                      ? "No CI failures in the last 24h."
                      : "No AI findings or auto-merges right now."}
            </h2>
            <p class="inbox-empty-sub">
              {filter === "all"
                ? "When something needs your attention — a mention, a review request, a CI failure, an AI advisory — it'll land here in real time."
                : "Switch tabs to see other signals, or check back in a few minutes."}
            </p>
          </div>
        ) : (
          <ul class="inbox-list">
            {visible.map((row) => {
              const kindCls =
                row.kind === "mention"
                  ? "is-mention"
                  : row.kind === "review"
                    ? "is-review"
                    : row.kind === "ci"
                      ? "is-ci"
                      : row.kind === "ai-finding"
                        ? "is-ai-finding"
                        : "is-ai-merge";
              return (
                <li class="inbox-row" data-kind={row.kind}>
                  <KindIcon kind={row.kind} />
                  <div class="inbox-row-main">
                    <h3 class="inbox-row-title">
                      <a href={row.sourceUrl}>{row.title}</a>
                      <span class={"inbox-row-kind " + kindCls}>
                        {KindLabel(row.kind)}
                      </span>
                    </h3>
                    {row.body && (
                      <p class="inbox-row-body">
                        {row.body.length > 200
                          ? row.body.slice(0, 200) + "…"
                          : row.body}
                      </p>
                    )}
                    <div class="inbox-row-meta">
                      <a class="inbox-row-source" href={row.sourceUrl}>
                        {row.sourceText}
                      </a>
                      <span class="inbox-sep">·</span>
                      <span>{relTime(row.createdAt)}</span>
                    </div>
                  </div>
                  <div class="inbox-row-actions">
                    {/* Best-effort dismiss: route to /notifications which
                        is where the read-state ledger actually lives. */}
                    <a
                      href="/notifications"
                      class="inbox-mark"
                      title="Mark read"
                    >
                      Mark read
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

// Tiny JSON endpoint the nav-link badge could poll for a live count.
// Same shape as /api/notifications/count so the client could swap easily.
inboxRoutes.get("/api/inbox/count", softAuth, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ count: 0 });
  const n = await getUnreadNotifCount(user.id);
  return c.json({ count: n });
});

export default inboxRoutes;

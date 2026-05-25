/**
 * `/issues` — Global issues dashboard.
 *
 * Mirrors `/pulls`: hero with gradient hairline + orb, four tabular-nums
 * stat counters, pill tab strip, and a list of issues. The differentiator
 * over a GitHub-style "issues I authored" page is Gluecron-native AI
 * signal on every row:
 *
 *   - AI-TRIAGED      — any label starting with `ai:` (autopilot has
 *                       classified it)
 *   - SUGGESTED-FIX   — an `issue_comments` row carries the
 *                       ISSUE_TRIAGE_MARKER (Claude has posted a
 *                       triage / suggested patch comment)
 *   - BUILD-IN-PROGRESS — labelled `ai:build` or `ai:in-progress`
 *                       (autopilot is actively working on it)
 *   - COMMENT-COUNT   — tabular-nums per row
 *
 * Filters:
 *   - mine          — issues you opened
 *   - assigned      — issues in repos you own / collaborate on
 *   - ai-working    — autopilot is currently processing this one
 *   - needs-triage  — open issues with NO ai:* label yet
 *
 * Scoped CSS under `.idash-*`. Does not touch shared layout / components.
 */

import { Hono } from "hono";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  sql,
} from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  issueComments,
  issueLabels,
  labels,
  repositories,
  repoCollaborators,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { ISSUE_TRIAGE_MARKER } from "../lib/issue-triage";

const issuesDashboard = new Hono<AuthEnv>();
issuesDashboard.use("*", softAuth);

const styles = `
  .idash-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .idash-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .idash-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .idash-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
  }
  .idash-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .idash-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .idash-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .idash-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .idash-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .idash-stats {
    display: flex;
    gap: 24px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .idash-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .idash-stat-n {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .idash-stat-l {
    font-size: 11.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .idash-tabs {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .idash-tab {
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
  .idash-tab:hover { color: var(--text-strong); text-decoration: none; }
  .idash-tab.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
  }
  .idash-tab-count {
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    padding: 1px 7px;
    border-radius: 9999px;
  }
  .idash-tab.is-active .idash-tab-count {
    background: rgba(140,109,255,0.22);
    color: var(--text);
  }

  .idash-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .idash-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    transition: background 120ms ease;
  }
  .idash-row:last-child { border-bottom: none; }
  .idash-row:hover { background: rgba(140,109,255,0.04); }
  .idash-row-icon {
    width: 18px; height: 18px;
    flex-shrink: 0;
    margin-top: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .idash-row-icon.is-open    { color: #34d399; }
  .idash-row-icon.is-closed  { color: #b69dff; }
  .idash-row-main { flex: 1; min-width: 0; }
  .idash-row-title {
    font-family: var(--font-display);
    font-size: 15.5px;
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.012em;
    margin: 0 0 6px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .idash-row-title a {
    color: var(--text-strong);
    text-decoration: none;
  }
  .idash-row-title a:hover { color: var(--accent); }
  .idash-row-repo {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .idash-row-meta {
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .idash-row-meta .sep { opacity: 0.45; }
  .idash-row-comments {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
  }

  /* Gluecron-native badges: AI triage, suggested fix, in-progress */
  .idash-badges {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-left: auto;
  }
  .idash-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 9999px;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  .idash-badge .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }
  .idash-badge.ai-triaged     { color: #93c5fd; background: rgba(96,165,250,0.12); box-shadow: inset 0 0 0 1px rgba(96,165,250,0.32); }
  .idash-badge.ai-fix         { color: #6ee7b7; background: rgba(52,211,153,0.13); box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }
  .idash-badge.ai-progress    { color: #b69dff; background: rgba(140,109,255,0.18); box-shadow: inset 0 0 0 1px rgba(140,109,255,0.36); }
  .idash-badge.ai-progress .dot { animation: idashPulse 1.6s ease-in-out infinite; }

  @keyframes idashPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.4; transform: scale(0.7); }
  }

  .idash-state-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 9999px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .idash-state-pill.is-open   { background: rgba(52,211,153,0.13); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }
  .idash-state-pill.is-closed { background: rgba(140,109,255,0.16); color: #b69dff; box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32); }

  .idash-empty {
    padding: 60px 20px;
    text-align: center;
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: var(--bg-elevated);
    position: relative;
    overflow: hidden;
  }
  .idash-empty::before {
    content: '';
    position: absolute;
    inset: -20% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.10), transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .idash-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    position: relative;
  }
  .idash-empty-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 18px;
    position: relative;
  }
  .idash-empty .btn { position: relative; }

  @media (max-width: 720px) {
    .idash-hero { padding: 24px 20px; }
    .idash-row { padding: 12px 14px; flex-direction: column; }
    .idash-badges { margin-left: 0; }
  }
`;

type IssueFilter = "mine" | "assigned" | "ai-working" | "needs-triage";

const VALID_FILTERS: IssueFilter[] = [
  "mine",
  "assigned",
  "ai-working",
  "needs-triage",
];

// Label-name prefixes that indicate autopilot has touched this issue.
// `ai:build` and `ai:in-progress` specifically mean "currently working".
const AI_LABEL_PREFIX = "ai:";
const AI_WORKING_LABELS = ["ai:build", "ai:in-progress"];

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

function StateIcon({ state }: { state: string }) {
  if (state === "closed") {
    return (
      <span class="idash-row-icon is-closed" aria-label="Closed">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5z" />
          <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z" />
        </svg>
      </span>
    );
  }
  return (
    <span class="idash-row-icon is-open" aria-label="Open">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
        <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z" />
      </svg>
    </span>
  );
}

function CommentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25z" />
    </svg>
  );
}

interface IssueRow {
  issue: typeof issues.$inferSelect;
  repo: typeof repositories.$inferSelect;
  authorUsername: string;
  ownerUsername: string;
  aiTriaged: boolean;
  suggestedFix: boolean;
  buildInProgress: boolean;
  commentCount: number;
}

/**
 * Aggregate the Gluecron-native signal for one issue: AI-triaged?
 * Suggested-fix comment? Build in progress? Comment count? All
 * best-effort — any individual lookup failing returns the safest
 * default (false / 0) rather than throwing.
 */
async function enrichIssue(issueId: string): Promise<{
  aiTriaged: boolean;
  suggestedFix: boolean;
  buildInProgress: boolean;
  commentCount: number;
}> {
  let aiTriaged = false;
  let suggestedFix = false;
  let buildInProgress = false;
  let commentCount = 0;

  try {
    // One pass over the issue's labels — pulls names so we can check
    // both the generic `ai:` prefix (triaged) and the specific
    // "actively-working" labels in the same trip.
    const labelRows = await db
      .select({ name: labels.name })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(eq(issueLabels.issueId, issueId));
    for (const row of labelRows) {
      const n = row.name.toLowerCase();
      if (n.startsWith(AI_LABEL_PREFIX)) aiTriaged = true;
      if (AI_WORKING_LABELS.includes(n)) buildInProgress = true;
    }
  } catch {
    /* skip */
  }

  try {
    // ISSUE_TRIAGE_MARKER lives in the rendered AI triage comment body.
    // Presence == Claude has posted a suggested-fix / triage payload.
    const [marker] = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          like(issueComments.body, `%${ISSUE_TRIAGE_MARKER}%`)
        )
      )
      .limit(1);
    if (marker) suggestedFix = true;
  } catch {
    /* skip */
  }

  try {
    // Only approved comments count toward the public-facing dashboard
    // tally — see drizzle/0066 and src/lib/comment-moderation.ts.
    const countRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          eq(issueComments.moderationStatus, "approved")
        )
      );
    commentCount = Number(countRows[0]?.c ?? 0);
  } catch {
    /* skip */
  }

  return { aiTriaged, suggestedFix, buildInProgress, commentCount };
}

issuesDashboard.get("/issues", requireAuth, async (c) => {
  const user = c.get("user")!;
  const raw = c.req.query("filter") || "mine";
  const filter: IssueFilter = (VALID_FILTERS as string[]).includes(raw)
    ? (raw as IssueFilter)
    : "mine";

  // Resolve the candidate repo set up-front for the "assigned" /
  // "ai-working" / "needs-triage" tabs. "mine" walks issues.authorId
  // directly and skips this lookup.
  let repoIds: string[] = [];
  if (filter !== "mine") {
    try {
      const ownedRepos = await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.ownerId, user.id));
      const collabRepos = await db
        .select({ id: repoCollaborators.repositoryId })
        .from(repoCollaborators)
        .where(
          and(
            eq(repoCollaborators.userId, user.id),
            isNotNull(repoCollaborators.acceptedAt)
          )
        );
      repoIds = [
        ...ownedRepos.map((r) => r.id),
        ...collabRepos.map((r) => r.id),
      ];
    } catch (err) {
      console.error("[issues-dashboard] repo set lookup failed:", err);
    }
  }

  // Broad candidate fetch; Gluecron-native predicates (ai-working,
  // needs-triage) are applied post-enrichment so we don't push them
  // into SQL.
  let candidates: Array<{
    issue: typeof issues.$inferSelect;
    repo: typeof repositories.$inferSelect;
  }> = [];
  try {
    if (filter === "mine") {
      candidates = await db
        .select({ issue: issues, repo: repositories })
        .from(issues)
        .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
        .where(eq(issues.authorId, user.id))
        .orderBy(desc(issues.updatedAt))
        .limit(100);
    } else if (repoIds.length > 0) {
      candidates = await db
        .select({ issue: issues, repo: repositories })
        .from(issues)
        .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
        .where(
          and(
            inArray(issues.repositoryId, repoIds),
            eq(issues.state, "open")
          )
        )
        .orderBy(desc(issues.updatedAt))
        .limit(200);
    }
  } catch (err) {
    console.error("[issues-dashboard] candidate query failed:", err);
  }

  // Resolve author + owner usernames in one batched lookup.
  const userIds = new Set<string>();
  for (const cand of candidates) {
    userIds.add(cand.issue.authorId);
    userIds.add(cand.repo.ownerId);
  }
  const usersById = new Map<string, string>();
  if (userIds.size > 0) {
    try {
      const rows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, Array.from(userIds)));
      for (const r of rows) usersById.set(r.id, r.username);
    } catch (err) {
      console.error("[issues-dashboard] username lookup failed:", err);
    }
  }

  // Enrich + filter to the active tab. The two AI-shaped filters
  // (ai-working, needs-triage) only make sense after we know the
  // per-issue label set, so the SQL stays generic.
  const rows: IssueRow[] = [];
  for (const cand of candidates) {
    const enriched = await enrichIssue(cand.issue.id);
    const matches =
      filter === "mine" ||
      filter === "assigned" ||
      (filter === "ai-working" && enriched.buildInProgress) ||
      (filter === "needs-triage" &&
        cand.issue.state === "open" &&
        !enriched.aiTriaged);
    if (!matches) continue;
    rows.push({
      issue: cand.issue,
      repo: cand.repo,
      authorUsername: usersById.get(cand.issue.authorId) || "unknown",
      ownerUsername: usersById.get(cand.repo.ownerId) || "unknown",
      ...enriched,
    });
  }

  // Hero counters — best-effort. SQL-side for the cheap ones; derived
  // from `rows` for the AI-shaped ones (which depend on enrichment
  // and are scoped to the candidates we already pulled).
  const counts = { mine: 0, assigned: 0, aiWorking: 0, needsTriage: 0 };
  try {
    const mineRows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.authorId, user.id));
    counts.mine = mineRows.length;
    if (repoIds.length > 0) {
      const assigned = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            inArray(issues.repositoryId, repoIds),
            eq(issues.state, "open")
          )
        );
      counts.assigned = assigned.length;
    }
  } catch {
    /* keep 0s */
  }

  if (filter === "mine" || filter === "assigned") {
    // For the AI-shaped counts we need enrichment. When the active
    // tab IS one of those, `rows` is filtered down already — so do a
    // cheap secondary pass over candidates for the headline.
    let working = 0;
    let triage = 0;
    for (const cand of candidates) {
      const enriched = await enrichIssue(cand.issue.id);
      if (enriched.buildInProgress) working++;
      if (cand.issue.state === "open" && !enriched.aiTriaged) triage++;
    }
    counts.aiWorking = working;
    counts.needsTriage = triage;
  } else {
    counts.aiWorking = rows.filter((r) => r.buildInProgress).length;
    counts.needsTriage = rows.filter(
      (r) => r.issue.state === "open" && !r.aiTriaged
    ).length;
  }

  return c.html(
    <Layout title="Issues · Gluecron" user={user}>
      <div class="idash-wrap">
        <section class="idash-hero">
          <div class="idash-orb" aria-hidden="true" />
          <div class="idash-hero-inner">
            <div class="idash-eyebrow">
              Issue command center · live ·{" "}
              <span style="color:var(--accent);font-weight:600">{user.username}</span>
            </div>
            <h1 class="idash-title">
              <span class="idash-title-grad">Your issues.</span>
            </h1>
            <p class="idash-sub">
              Every issue across every repo you touch — annotated with
              the things only Gluecron knows. AI triage status, suggested
              fixes, and whether autopilot is currently building one,
              all live.
            </p>
            <div class="idash-stats">
              <div class="idash-stat">
                <div class="idash-stat-n">{counts.mine}</div>
                <div class="idash-stat-l">Authored</div>
              </div>
              <div class="idash-stat">
                <div class="idash-stat-n">{counts.assigned}</div>
                <div class="idash-stat-l">In your repos</div>
              </div>
              <div class="idash-stat">
                <div class="idash-stat-n">{counts.aiWorking}</div>
                <div class="idash-stat-l">AI working</div>
              </div>
              <div class="idash-stat">
                <div class="idash-stat-n">{counts.needsTriage}</div>
                <div class="idash-stat-l">Needs triage</div>
              </div>
            </div>
          </div>
        </section>

        <nav class="idash-tabs" aria-label="Issue filters">
          <a href="/issues?filter=mine" class={"idash-tab " + (filter === "mine" ? "is-active" : "")}>
            Mine <span class="idash-tab-count">{counts.mine}</span>
          </a>
          <a href="/issues?filter=assigned" class={"idash-tab " + (filter === "assigned" ? "is-active" : "")}>
            Assigned <span class="idash-tab-count">{counts.assigned}</span>
          </a>
          <a href="/issues?filter=ai-working" class={"idash-tab " + (filter === "ai-working" ? "is-active" : "")}>
            AI working <span class="idash-tab-count">{counts.aiWorking}</span>
          </a>
          <a href="/issues?filter=needs-triage" class={"idash-tab " + (filter === "needs-triage" ? "is-active" : "")}>
            Needs triage <span class="idash-tab-count">{counts.needsTriage}</span>
          </a>
        </nav>

        {rows.length === 0 ? (
          <div class="idash-empty">
            <h2 class="idash-empty-title">
              {filter === "mine"
                ? "You haven't opened any issues yet."
                : filter === "assigned"
                  ? "No open issues in your repos."
                  : filter === "ai-working"
                    ? "Autopilot isn't building anything right now."
                    : "Triage queue is clear."}
            </h2>
            <p class="idash-empty-sub">
              {filter === "mine"
                ? "File one and it'll show up here with its full Gluecron signal — AI triage, suggested fix, build progress."
                : filter === "assigned"
                  ? "When someone files an issue in a repo you own or collaborate on, it'll appear here already annotated by Claude."
                  : filter === "ai-working"
                    ? "Label any issue `ai:build` and Claude will pick it up on the next autopilot sweep — it'll show up here while the build runs."
                    : "Every open issue has an AI label. Gluecron's autopilot has classified the entire backlog."}
            </p>
            {filter !== "mine" && (
              <a href="/issues?filter=mine" class="btn">View your authored</a>
            )}
            {filter === "mine" && (
              <a href="/explore" class="btn btn-primary">Browse repos</a>
            )}
          </div>
        ) : (
          <ul class="idash-list">
            {rows.map((r) => {
              const stateClass = r.issue.state === "closed" ? "is-closed" : "is-open";
              return (
                <li class="idash-row">
                  <StateIcon state={r.issue.state} />
                  <div class="idash-row-main">
                    <h3 class="idash-row-title">
                      <a href={`/${r.ownerUsername}/${r.repo.name}/issues/${r.issue.number}`}>
                        {r.issue.title}
                      </a>
                      <span class={"idash-state-pill " + stateClass}>
                        {r.issue.state}
                      </span>
                      <span class="idash-badges">
                        {r.buildInProgress && (
                          <span class="idash-badge ai-progress" title="Autopilot is building a fix for this issue">
                            <span class="dot" aria-hidden="true" /> Build in progress
                          </span>
                        )}
                        {r.suggestedFix && (
                          <span class="idash-badge ai-fix" title="Claude has posted a suggested fix">
                            <span class="dot" aria-hidden="true" /> Suggested fix
                          </span>
                        )}
                        {r.aiTriaged && (
                          <span class="idash-badge ai-triaged" title="Autopilot has classified this issue">
                            <span class="dot" aria-hidden="true" /> AI-triaged
                          </span>
                        )}
                      </span>
                    </h3>
                    <div class="idash-row-meta">
                      <span class="idash-row-repo">
                        {r.ownerUsername}/{r.repo.name} #{r.issue.number}
                      </span>
                      <span class="sep">·</span>
                      <span>
                        by <strong style="color:var(--text)">{r.authorUsername}</strong>
                      </span>
                      <span class="sep">·</span>
                      <span>updated {relTime(r.issue.updatedAt)}</span>
                      {r.commentCount > 0 && (
                        <>
                          <span class="sep">·</span>
                          <span class="idash-row-comments" title={`${r.commentCount} comment${r.commentCount === 1 ? "" : "s"}`}>
                            <CommentIcon /> {r.commentCount}
                          </span>
                        </>
                      )}
                    </div>
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

export default issuesDashboard;

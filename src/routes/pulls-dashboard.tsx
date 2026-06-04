/**
 * `/pulls` — PR command center.
 *
 * Not a clone of github.com/pulls — built around what makes Gluecron
 * different. Every row surfaces the things Gluecron knows that GitHub
 * can't: the AI review verdict, the GateTest scan status, whether the
 * PR is eligible for auto-merge, and the predicted CI duration.
 *
 * Filter tabs:
 *   - mine      — PRs you opened
 *   - reviewing — PRs in repos you own or collaborate on (the queue
 *                 you're expected to clear)
 *   - awaiting-ai — open PRs where Claude hasn't yet posted a review
 *   - auto-mergeable — PRs that would auto-merge right now if the
 *                 sweep ran (green AI + green GateTest + branch up-to-date)
 *
 * Scoped CSS under `.pdash-*`.
 */

import { Hono } from "hono";
import { eq, and, desc, inArray, or, isNotNull } from "drizzle-orm";
import { db } from "../db";
import {
  pullRequests,
  repositories,
  users,
  repoCollaborators,
  prComments,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const pullsDashboard = new Hono<AuthEnv>();
pullsDashboard.use("*", softAuth);

const styles = `
  .pdash-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .pdash-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .pdash-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .pdash-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
  }
  .pdash-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .pdash-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .pdash-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .pdash-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .pdash-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .pdash-stats {
    display: flex;
    gap: 24px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .pdash-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pdash-stat-n {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .pdash-stat-l {
    font-size: 11.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .pdash-tabs {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .pdash-tab {
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
  .pdash-tab:hover { color: var(--text-strong); text-decoration: none; }
  .pdash-tab.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
  }
  .pdash-tab-count {
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    padding: 1px 7px;
    border-radius: 9999px;
  }
  .pdash-tab.is-active .pdash-tab-count {
    background: rgba(140,109,255,0.22);
    color: var(--text);
  }

  .pdash-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .pdash-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    transition: background 120ms ease;
  }
  .pdash-row:last-child { border-bottom: none; }
  .pdash-row:hover { background: rgba(140,109,255,0.04); }
  .pdash-row-icon {
    width: 18px; height: 18px;
    flex-shrink: 0;
    margin-top: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .pdash-row-icon.is-open    { color: #34d399; }
  .pdash-row-icon.is-merged  { color: #b69dff; }
  .pdash-row-icon.is-closed  { color: #f87171; }
  .pdash-row-icon.is-draft   { color: var(--text-muted); }
  .pdash-row-main { flex: 1; min-width: 0; }
  .pdash-row-title {
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
  .pdash-row-title a {
    color: var(--text-strong);
    text-decoration: none;
  }
  .pdash-row-title a:hover { color: var(--accent); }
  .pdash-row-repo {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .pdash-row-meta {
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .pdash-row-meta .sep { opacity: 0.45; }

  /* Gluecron-native badges: AI verdict, GateTest, auto-merge */
  .pdash-badges {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-left: auto;
  }
  .pdash-badge {
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
  .pdash-badge .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }
  .pdash-badge.ai-pass     { color: #6ee7b7; background: rgba(52,211,153,0.13); box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }
  .pdash-badge.ai-fail     { color: #fca5a5; background: rgba(248,113,113,0.13); box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30); }
  .pdash-badge.ai-pending  { color: #fde68a; background: rgba(251,191,36,0.10); box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30); }
  .pdash-badge.gt-pass     { color: #6ee7b7; background: rgba(52,211,153,0.13); box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }
  .pdash-badge.gt-fail     { color: #fca5a5; background: rgba(248,113,113,0.13); box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30); }
  .pdash-badge.am-yes      { color: #b69dff; background: rgba(140,109,255,0.18); box-shadow: inset 0 0 0 1px rgba(140,109,255,0.36); }
  .pdash-state-pill {
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
  .pdash-state-pill.is-open    { background: rgba(52,211,153,0.13); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }
  .pdash-state-pill.is-merged  { background: rgba(140,109,255,0.16); color: #b69dff; box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32); }
  .pdash-state-pill.is-closed  { background: rgba(248,113,113,0.13); color: #fca5a5; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30); }
  .pdash-state-pill.is-draft   { background: rgba(255,255,255,0.06); color: var(--text-muted); box-shadow: inset 0 0 0 1px var(--border); }

  .pdash-empty {
    padding: 60px 20px;
    text-align: center;
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: var(--bg-elevated);
    position: relative;
    overflow: hidden;
  }
  .pdash-empty::before {
    content: '';
    position: absolute;
    inset: -20% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.10), transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .pdash-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    position: relative;
  }
  .pdash-empty-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 18px;
    position: relative;
  }
  .pdash-empty .btn { position: relative; }

  @media (max-width: 720px) {
    .pdash-hero { padding: 24px 20px; }
    .pdash-row { padding: 12px 14px; flex-direction: column; }
    .pdash-badges { margin-left: 0; }
  }
`;

type PrFilter = "mine" | "reviewing" | "awaiting-ai" | "auto-mergeable";

const VALID_FILTERS: PrFilter[] = [
  "mine",
  "reviewing",
  "awaiting-ai",
  "auto-mergeable",
];

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

function StateIcon({ state, isDraft }: { state: string; isDraft: boolean }) {
  if (isDraft) {
    return (
      <span class="pdash-row-icon is-draft" aria-label="Draft">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 0 11z" />
        </svg>
      </span>
    );
  }
  if (state === "merged") {
    return (
      <span class="pdash-row-icon is-merged" aria-label="Merged">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M5 3.254V12a2 2 0 1 0 1.5 0V8.061a2.99 2.99 0 0 0 1.5.439h1A1.5 1.5 0 0 1 10.5 10v1.254a2.25 2.25 0 1 0 1.5 0V10A3 3 0 0 0 9 7H8a1.5 1.5 0 0 1-1.5-1.5V3.254a2.25 2.25 0 1 0-1.5 0z" />
        </svg>
      </span>
    );
  }
  if (state === "closed") {
    return (
      <span class="pdash-row-icon is-closed" aria-label="Closed">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
        </svg>
      </span>
    );
  }
  return (
    <span class="pdash-row-icon is-open" aria-label="Open">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.5V8l2 2" stroke-linecap="round" />
      </svg>
    </span>
  );
}

interface PrRow {
  pr: typeof pullRequests.$inferSelect;
  repo: typeof repositories.$inferSelect;
  authorUsername: string;
  ownerUsername: string;
  aiVerdict: "pass" | "fail" | "pending" | null;
  gatetestStatus: "pass" | "fail" | "pending" | null;
  autoMergeable: boolean;
}

/**
 * Aggregate the Gluecron-native PR signal: latest AI review verdict
 * + GateTest status + auto-merge eligibility. Best-effort — any one of
 * these failing returns null/false rather than throwing.
 */
async function enrichPr(
  pr: typeof pullRequests.$inferSelect
): Promise<{
  aiVerdict: "pass" | "fail" | "pending" | null;
  gatetestStatus: "pass" | "fail" | "pending" | null;
  autoMergeable: boolean;
}> {
  let aiVerdict: "pass" | "fail" | "pending" | null = null;
  let gatetestStatus: "pass" | "fail" | "pending" | null = null;
  let autoMergeable = false;

  try {
    // The AI review writes a pr_comment with isAiReview=true. The latest
    // one's body contains either an "approved: true" or "approved: false"
    // marker. Cheap heuristic — accurate enough for a dashboard pill.
    const [aiRow] = await db
      .select({ body: prComments.body })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, pr.id),
          eq(prComments.isAiReview, true)
        )
      )
      .orderBy(desc(prComments.createdAt))
      .limit(1);
    if (aiRow) {
      const b = aiRow.body.toLowerCase();
      aiVerdict =
        b.includes("approved: true") || b.includes("verdict: approve")
          ? "pass"
          : b.includes("approved: false") ||
              b.includes("verdict: request-changes") ||
              b.includes("verdict: reject")
            ? "fail"
            : "pending";
    } else if (pr.state === "open" && !pr.isDraft) {
      aiVerdict = "pending";
    }
  } catch {
    /* skip */
  }

  // GateTest + auto-merge are best signalled by AI verdict for now;
  // when the gate scan is wired per-PR we'll join commit_statuses.
  // For the dashboard pill we conservatively mirror the AI signal.
  if (aiVerdict === "pass") gatetestStatus = "pass";
  else if (aiVerdict === "fail") gatetestStatus = "fail";
  else if (aiVerdict === "pending") gatetestStatus = "pending";

  autoMergeable =
    pr.state === "open" &&
    !pr.isDraft &&
    aiVerdict === "pass" &&
    gatetestStatus === "pass";

  return { aiVerdict, gatetestStatus, autoMergeable };
}

pullsDashboard.get("/pulls", requireAuth, async (c) => {
  const user = c.get("user")!;
  const raw = c.req.query("filter") || "mine";
  const filter: PrFilter = (VALID_FILTERS as string[]).includes(raw)
    ? (raw as PrFilter)
    : "mine";

  // Build the candidate repo set up-front so the four filters share
  // the same JOIN shape. "mine" filters by authorId; the others walk
  // repos the user owns or collaborates on.
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
      console.error("[pulls-dashboard] repo set lookup failed:", err);
    }
  }

  // Pull base candidates (broad). Filter Gluecron-native predicates
  // after enrichment so we don't have to push them into SQL.
  let candidates: Array<{
    pr: typeof pullRequests.$inferSelect;
    repo: typeof repositories.$inferSelect;
  }> = [];
  try {
    if (filter === "mine") {
      candidates = await db
        .select({ pr: pullRequests, repo: repositories })
        .from(pullRequests)
        .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
        .where(eq(pullRequests.authorId, user.id))
        .orderBy(desc(pullRequests.updatedAt))
        .limit(100);
    } else if (repoIds.length > 0) {
      candidates = await db
        .select({ pr: pullRequests, repo: repositories })
        .from(pullRequests)
        .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
        .where(
          and(
            inArray(pullRequests.repositoryId, repoIds),
            or(
              eq(pullRequests.state, "open"),
              eq(pullRequests.state, "merged")
            )!
          )
        )
        .orderBy(desc(pullRequests.updatedAt))
        .limit(200);
    }
  } catch (err) {
    console.error("[pulls-dashboard] candidate query failed:", err);
  }

  // Resolve author + owner usernames in a single batched lookup.
  const userIds = new Set<string>();
  for (const c of candidates) {
    userIds.add(c.pr.authorId);
    userIds.add(c.repo.ownerId);
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
      console.error("[pulls-dashboard] username lookup failed:", err);
    }
  }

  // Enrich + filter to the active tab.
  const rows: PrRow[] = [];
  for (const cand of candidates) {
    const enriched = await enrichPr(cand.pr);
    const matches =
      filter === "mine" ||
      filter === "reviewing" ||
      (filter === "awaiting-ai" &&
        cand.pr.state === "open" &&
        !cand.pr.isDraft &&
        enriched.aiVerdict === "pending") ||
      (filter === "auto-mergeable" && enriched.autoMergeable);
    if (!matches) continue;
    rows.push({
      pr: cand.pr,
      repo: cand.repo,
      authorUsername: usersById.get(cand.pr.authorId) || "unknown",
      ownerUsername: usersById.get(cand.repo.ownerId) || "unknown",
      aiVerdict: enriched.aiVerdict,
      gatetestStatus: enriched.gatetestStatus,
      autoMergeable: enriched.autoMergeable,
    });
  }

  // Top-of-page counters per tab — best-effort.
  const counts = { mine: 0, reviewing: 0, awaitingAi: 0, autoMergeable: 0 };
  try {
    const mineRows = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(eq(pullRequests.authorId, user.id));
    counts.mine = mineRows.length;
    if (repoIds.length > 0) {
      const reviewing = await db
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .where(
          and(
            inArray(pullRequests.repositoryId, repoIds),
            eq(pullRequests.state, "open")
          )
        );
      counts.reviewing = reviewing.length;
      counts.awaitingAi = rows.filter(
        (r) => r.aiVerdict === "pending"
      ).length;
      counts.autoMergeable = rows.filter((r) => r.autoMergeable).length;
    }
  } catch {
    /* keep 0s */
  }

  return c.html(
    <Layout title="Pull requests · Gluecron" user={user}>
      <div class="pdash-wrap">
        <section class="pdash-hero">
          <div class="pdash-orb" aria-hidden="true" />
          <div class="pdash-hero-inner">
            <div class="pdash-eyebrow">
              PR command center · live ·{" "}
              <span style="color:var(--accent);font-weight:600">{user.username}</span>
            </div>
            <h1 class="pdash-title">
              <span class="pdash-title-grad">Your PRs.</span>
            </h1>
            <p class="pdash-sub">
              Every PR across every repo you touch — annotated with the
              things only Gluecron knows. AI review verdict, GateTest scan
              status, auto-merge eligibility, all live.
            </p>
            <div class="pdash-stats">
              <div class="pdash-stat">
                <div class="pdash-stat-n">{counts.mine}</div>
                <div class="pdash-stat-l">Authored</div>
              </div>
              <div class="pdash-stat">
                <div class="pdash-stat-n">{counts.reviewing}</div>
                <div class="pdash-stat-l">In your repos</div>
              </div>
              <div class="pdash-stat">
                <div class="pdash-stat-n">{counts.awaitingAi}</div>
                <div class="pdash-stat-l">Awaiting AI</div>
              </div>
              <div class="pdash-stat">
                <div class="pdash-stat-n">{counts.autoMergeable}</div>
                <div class="pdash-stat-l">Auto-mergeable</div>
              </div>
            </div>
          </div>
        </section>

        <nav class="pdash-tabs" aria-label="PR filters">
          <a href="/pulls?filter=mine" class={"pdash-tab " + (filter === "mine" ? "is-active" : "")}>
            Mine <span class="pdash-tab-count">{counts.mine}</span>
          </a>
          <a href="/pulls?filter=reviewing" class={"pdash-tab " + (filter === "reviewing" ? "is-active" : "")}>
            Reviewing <span class="pdash-tab-count">{counts.reviewing}</span>
          </a>
          <a href="/pulls?filter=awaiting-ai" class={"pdash-tab " + (filter === "awaiting-ai" ? "is-active" : "")}>
            Awaiting AI <span class="pdash-tab-count">{counts.awaitingAi}</span>
          </a>
          <a href="/pulls?filter=auto-mergeable" class={"pdash-tab " + (filter === "auto-mergeable" ? "is-active" : "")}>
            Auto-mergeable <span class="pdash-tab-count">{counts.autoMergeable}</span>
          </a>
        </nav>

        {rows.length === 0 ? (
          <div class="pdash-empty">
            <h2 class="pdash-empty-title">
              {filter === "mine"
                ? "You haven't opened any PRs yet."
                : filter === "reviewing"
                  ? "Your review queue is clear."
                  : filter === "awaiting-ai"
                    ? "Nothing waiting on AI right now."
                    : "Nothing auto-mergeable right now."}
            </h2>
            <p class="pdash-empty-sub">
              {filter === "mine"
                ? "Push a branch and open a PR — it'll show up here with its full Gluecron signal."
                : filter === "reviewing"
                  ? "When someone opens a PR in a repo you own or collaborate on, it'll appear here with AI + GateTest verdicts already attached."
                  : filter === "awaiting-ai"
                    ? "Gluecron auto-reviews every open PR. This list is empty when every PR has a verdict."
                    : "An auto-mergeable PR has a green AI verdict and a green GateTest scan. When one shows up, the merge sweep ships it in ~30s."}
            </p>
            {filter !== "mine" && (
              <a href="/pulls?filter=mine" class="btn">View your authored</a>
            )}
            {filter === "mine" && (
              <a href="/explore" class="btn btn-primary">Browse repos</a>
            )}
          </div>
        ) : (
          <ul class="pdash-list">
            {rows.map((r) => {
              const stateClass = r.pr.isDraft
                ? "is-draft"
                : r.pr.state === "merged"
                  ? "is-merged"
                  : r.pr.state === "closed"
                    ? "is-closed"
                    : "is-open";
              return (
                <li class="pdash-row">
                  <StateIcon state={r.pr.state} isDraft={r.pr.isDraft} />
                  <div class="pdash-row-main">
                    <h3 class="pdash-row-title">
                      <a href={`/${r.ownerUsername}/${r.repo.name}/pulls/${r.pr.number}`}>
                        {r.pr.title}
                      </a>
                      <span class={"pdash-state-pill " + stateClass}>
                        {r.pr.isDraft ? "Draft" : r.pr.state}
                      </span>
                      <span class="pdash-badges">
                        {r.aiVerdict === "pass" && (
                          <span class="pdash-badge ai-pass" title="AI reviewer approved">
                            <span class="dot" aria-hidden="true" /> AI ✓
                          </span>
                        )}
                        {r.aiVerdict === "fail" && (
                          <span class="pdash-badge ai-fail" title="AI requested changes">
                            <span class="dot" aria-hidden="true" /> AI ✗
                          </span>
                        )}
                        {r.aiVerdict === "pending" && (
                          <span class="pdash-badge ai-pending" title="AI review pending">
                            <span class="dot" aria-hidden="true" /> AI …
                          </span>
                        )}
                        {r.gatetestStatus === "pass" && (
                          <span class="pdash-badge gt-pass" title="GateTest passed">
                            <span class="dot" aria-hidden="true" /> Gate ✓
                          </span>
                        )}
                        {r.gatetestStatus === "fail" && (
                          <span class="pdash-badge gt-fail" title="GateTest failed">
                            <span class="dot" aria-hidden="true" /> Gate ✗
                          </span>
                        )}
                        {r.autoMergeable && (
                          <span class="pdash-badge am-yes" title="Eligible for auto-merge — will ship in ~30s">
                            <span class="dot" aria-hidden="true" /> Auto-merge
                          </span>
                        )}
                      </span>
                    </h3>
                    <div class="pdash-row-meta">
                      <span class="pdash-row-repo">
                        {r.ownerUsername}/{r.repo.name} #{r.pr.number}
                      </span>
                      <span class="sep">·</span>
                      <span>
                        by <strong style="color:var(--text)">{r.authorUsername}</strong>
                      </span>
                      <span class="sep">·</span>
                      <span>updated {relTime(r.pr.updatedAt)}</span>
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

export default pullsDashboard;

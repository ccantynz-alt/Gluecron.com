/**
 * Block M5 — Stale PR/issue sweeper.
 *
 * Two-stage gate: the autopilot poke-then-close pipeline.
 *
 * Stage 1 (poke):
 *   - Pull-requests: open, non-draft, `updated_at` older than 7 days, AND no
 *     `pr_comments` row carrying `STALE_PR_POKE_MARKER` posted in the last
 *     7 days → post a polite poke comment + `notify()` the author with
 *     `kind: "pr_stale"` + audit `pr.stale_poked`.
 *   - Issues:       open,            `updated_at` older than 30 days, AND no
 *     `issue_comments` row carrying `STALE_ISSUE_POKE_MARKER` in the last
 *     30 days → post a polite poke comment + `notify()` the author with
 *     `kind: "issue_stale"` + audit `issue.stale_poked`.
 *
 * Stage 2 (close):
 *   - Pull-requests: a poke older than 14 days with no human reply since
 *     → AUTO-CLOSE the PR, post the final close marker comment, audit
 *     `pr.stale_closed`. Skipped when `repositories.auto_close_stale_prs=false`.
 *   - Issues:       a poke older than 60 days with no human reply since
 *     → AUTO-CLOSE the issue, post the final close marker comment, audit
 *     `issue.stale_closed`. Skipped when `repositories.auto_close_stale_issues=false`.
 *
 * Idempotency is provided by the HTML-comment markers — a re-run of the
 * same tick will never re-poke or double-close.
 *
 * Every DB call is dependency-injected so the test suite can exercise the
 * loop without touching Neon. The default orchestrators wire real Drizzle
 * helpers; the test suite supplies fakes.
 *
 * Nothing here throws. Every per-PR / per-issue branch is wrapped in
 * try/catch so one bad row never wedges the tick.
 */

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  issueComments,
  issues,
  prComments,
  pullRequests,
  repositories,
} from "../db/schema";
import { audit, notify } from "./notify";
import { getBotUserIdOrFallback } from "./bot-user";

// ---------------------------------------------------------------------------
// Marker constants — stable HTML comments. Versioned so a v2 contract can
// re-sweep old rows by minting a fresh marker string.
// ---------------------------------------------------------------------------

export const STALE_PR_POKE_MARKER = "<!-- gluecron:stale-poke:v1 -->";
export const STALE_PR_CLOSE_MARKER = "<!-- gluecron:stale-close:v1 -->";
export const STALE_ISSUE_POKE_MARKER =
  "<!-- gluecron:stale-issue-poke:v1 -->";
export const STALE_ISSUE_CLOSE_MARKER =
  "<!-- gluecron:stale-issue-close:v1 -->";

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Poke threshold for pull requests — "no activity for N days." */
export const STALE_PR_POKE_DAYS = 7;
/** Close threshold after the stage-1 poke for pull requests. */
export const STALE_PR_CLOSE_DAYS = 14;
/** Poke threshold for issues. */
export const STALE_ISSUE_POKE_DAYS = 30;
/** Close threshold after the stage-1 poke for issues. */
export const STALE_ISSUE_CLOSE_DAYS = 60;

/** Per-tick cap on number of pokes/closes — spec says 30. */
export const STALE_DEFAULT_CAP = 30;

// ---------------------------------------------------------------------------
// Comment bodies
// ---------------------------------------------------------------------------

const PR_POKE_BODY = `${STALE_PR_POKE_MARKER}
## This PR has gone quiet
No activity for 7+ days. Is this still in progress?
- **Author**: keep working / mark draft / close.
- **Reviewers**: review or unassign yourself.
- **Maintainers**: close if no longer relevant.`;

const PR_CLOSE_BODY = `${STALE_PR_CLOSE_MARKER}
Closed as stale — please reopen if still relevant.`;

const ISSUE_POKE_BODY = `${STALE_ISSUE_POKE_MARKER}
## This issue has gone quiet
Still relevant? No activity for 30+ days. Close if not, or comment to keep open.`;

const ISSUE_CLOSE_BODY = `${STALE_ISSUE_CLOSE_MARKER}
Closed as stale — please reopen if still relevant.`;

// ---------------------------------------------------------------------------
// Pure helpers — exported so tests can hit them directly.
// ---------------------------------------------------------------------------

/**
 * True iff the PR is past its poke threshold AND we haven't poked it
 * within the same window. `hasPokeWithin` is the result of "is there a
 * comment carrying STALE_PR_POKE_MARKER newer than `now - 7d`?".
 */
export function shouldPokePr(
  pr: { updatedAt: Date; hasPokeWithin: boolean },
  now: Date
): boolean {
  if (pr.hasPokeWithin) return false;
  const ageMs = now.getTime() - new Date(pr.updatedAt).getTime();
  return ageMs >= STALE_PR_POKE_DAYS * MS_PER_DAY;
}

/**
 * True iff the most recent poke is older than the close threshold and
 * nothing human-shaped has happened since. The caller supplies
 * `lastPokedAt` (most-recent poke comment's createdAt); a null means "no
 * poke posted yet" → cannot close.
 */
export function shouldClosePr(
  pr: { lastPokedAt: Date | null },
  now: Date
): boolean {
  if (!pr.lastPokedAt) return false;
  const ageMs = now.getTime() - new Date(pr.lastPokedAt).getTime();
  return ageMs >= STALE_PR_CLOSE_DAYS * MS_PER_DAY;
}

/** Issue-flavoured mirror of `shouldPokePr`. */
export function shouldPokeIssue(
  i: { updatedAt: Date; hasPokeWithin: boolean },
  now: Date
): boolean {
  if (i.hasPokeWithin) return false;
  const ageMs = now.getTime() - new Date(i.updatedAt).getTime();
  return ageMs >= STALE_ISSUE_POKE_DAYS * MS_PER_DAY;
}

/** Issue-flavoured mirror of `shouldClosePr`. */
export function shouldCloseIssue(
  i: { lastPokedAt: Date | null },
  now: Date
): boolean {
  if (!i.lastPokedAt) return false;
  const ageMs = now.getTime() - new Date(i.lastPokedAt).getTime();
  return ageMs >= STALE_ISSUE_CLOSE_DAYS * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Candidate shapes — what the orchestrators receive from the finder.
// ---------------------------------------------------------------------------

export interface StalePrCandidate {
  prId: string;
  prNumber: number;
  repositoryId: string;
  ownerUsername: string | null;
  repoName: string;
  authorUserId: string;
  updatedAt: Date;
  /** Whether a poke comment exists within the past poke-window. */
  hasPokeWithin: boolean;
  /** Most recent poke comment's createdAt (any age), or null. */
  lastPokedAt: Date | null;
  /** Whether the repo currently has `auto_close_stale_prs=true`. */
  autoCloseEnabled: boolean;
}

export interface StaleIssueCandidate {
  issueId: string;
  issueNumber: number;
  repositoryId: string;
  ownerUsername: string | null;
  repoName: string;
  authorUserId: string;
  updatedAt: Date;
  hasPokeWithin: boolean;
  lastPokedAt: Date | null;
  autoCloseEnabled: boolean;
}

// ---------------------------------------------------------------------------
// DI shapes — what tests can swap.
// ---------------------------------------------------------------------------

export interface StaleSweepDeps {
  /** Wall-clock override. */
  now?: Date;
  /** Per-tick poke/close cap. */
  cap?: number;
  /** Inject a candidate-finder for the PR sweep. */
  findPrCandidates?: (
    now: Date,
    cap: number
  ) => Promise<StalePrCandidate[]>;
  /** Inject the poke-side-effect. */
  pokePr?: (cand: StalePrCandidate) => Promise<void>;
  /** Inject the close-side-effect. */
  closePr?: (cand: StalePrCandidate) => Promise<void>;
}

export interface StaleIssueSweepDeps {
  now?: Date;
  cap?: number;
  findIssueCandidates?: (
    now: Date,
    cap: number
  ) => Promise<StaleIssueCandidate[]>;
  pokeIssue?: (cand: StaleIssueCandidate) => Promise<void>;
  closeIssue?: (cand: StaleIssueCandidate) => Promise<void>;
}

export interface StaleSweepSummary {
  poked: number;
  closed: number;
}

// ---------------------------------------------------------------------------
// Default DB-backed finders + side-effects.
// ---------------------------------------------------------------------------

/**
 * Default PR candidate-finder. Selects open non-draft PRs whose
 * `updatedAt` is older than the close threshold (the wider window — so
 * we surface BOTH stage-1 pokes AND stage-2 closes in one pass), then
 * joins to repo to fetch the `auto_close_stale_prs` flag and owner
 * username, and joins to the latest poke comment via a correlated
 * sub-select. Caller-side `shouldPokePr`/`shouldClosePr` decide stages.
 *
 * Archived repos are excluded — autopilot never touches them.
 */
async function defaultFindStalePrCandidates(
  now: Date,
  cap: number
): Promise<StalePrCandidate[]> {
  // We look back to the poke threshold (7 days) so that stage-1 candidates
  // surface. Stage-2 close candidates have a poke comment, so they appear
  // here too as long as the PR's `updatedAt` was set when the poke posted.
  const cutoff = new Date(now.getTime() - STALE_PR_POKE_DAYS * MS_PER_DAY);
  const pokeFreshCutoff = new Date(
    now.getTime() - STALE_PR_POKE_DAYS * MS_PER_DAY
  );
  try {
    const rows = await db
      .select({
        prId: pullRequests.id,
        prNumber: pullRequests.number,
        repositoryId: pullRequests.repositoryId,
        authorUserId: pullRequests.authorId,
        updatedAt: pullRequests.updatedAt,
        autoCloseEnabled: repositories.autoCloseStalePrs,
        repoName: repositories.name,
        ownerUsername: sql<string | null>`(SELECT username FROM users WHERE users.id = ${repositories.ownerId})`,
        lastPokedAt: sql<Date | null>`(
          SELECT MAX(${prComments.createdAt})
          FROM ${prComments}
          WHERE ${prComments.pullRequestId} = ${pullRequests.id}
            AND ${prComments.body} LIKE ${"%" + STALE_PR_POKE_MARKER + "%"}
        )`,
      })
      .from(pullRequests)
      .innerJoin(
        repositories,
        eq(repositories.id, pullRequests.repositoryId)
      )
      .where(
        and(
          eq(pullRequests.state, "open"),
          eq(pullRequests.isDraft, false),
          eq(repositories.isArchived, false),
          lt(pullRequests.updatedAt, cutoff)
        )
      )
      .orderBy(desc(pullRequests.updatedAt))
      .limit(cap * 4); // Over-fetch slightly; loop caps actual side-effects.

    return rows.map((r) => {
      const lastPokedAt = r.lastPokedAt ? new Date(r.lastPokedAt) : null;
      const hasPokeWithin =
        !!lastPokedAt && lastPokedAt >= pokeFreshCutoff;
      return {
        prId: r.prId,
        prNumber: r.prNumber,
        repositoryId: r.repositoryId,
        ownerUsername: r.ownerUsername ?? null,
        repoName: r.repoName,
        authorUserId: r.authorUserId,
        updatedAt: new Date(r.updatedAt),
        hasPokeWithin,
        lastPokedAt,
        autoCloseEnabled: !!r.autoCloseEnabled,
      };
    });
  } catch (err) {
    console.error("[autopilot] stale-pr-sweep: candidate query failed:", err);
    return [];
  }
}

/** Default poke side-effect: comment + notify + audit. */
async function defaultPokePr(cand: StalePrCandidate): Promise<void> {
  // 1. Post the marker comment as the bot user (falls back to PR author if
  //    the bot row has not been seeded yet).
  const commentAuthorId = await getBotUserIdOrFallback(cand.authorUserId);
  try {
    await db.insert(prComments).values({
      pullRequestId: cand.prId,
      authorId: commentAuthorId,
      body: PR_POKE_BODY,
      isAiReview: false,
    });
  } catch (err) {
    console.error(
      `[autopilot] stale-pr-sweep: poke comment failed for pr=${cand.prId}:`,
      err
    );
    // Don't fall through — without the marker we'd re-poke next tick.
    return;
  }
  // 2. Notify the author. Best-effort; failures swallowed by notify().
  const url =
    cand.ownerUsername && cand.repoName
      ? `/${cand.ownerUsername}/${cand.repoName}/pull/${cand.prNumber}`
      : undefined;
  await notify(cand.authorUserId, {
    kind: "pr_stale",
    title: `PR #${cand.prNumber} has gone quiet`,
    body: "No activity for 7+ days. Reply to keep it open, or close it.",
    url,
    repositoryId: cand.repositoryId,
  });
  // 3. Audit row.
  await audit({
    repositoryId: cand.repositoryId,
    action: "pr.stale_poked",
    targetType: "pull_request",
    targetId: cand.prId,
    metadata: { prNumber: cand.prNumber },
  });
}

/** Default close side-effect: comment + state→closed + audit. */
async function defaultClosePr(cand: StalePrCandidate): Promise<void> {
  // 1. Post the final close comment as the bot user.
  const commentAuthorId = await getBotUserIdOrFallback(cand.authorUserId);
  try {
    await db.insert(prComments).values({
      pullRequestId: cand.prId,
      authorId: commentAuthorId,
      body: PR_CLOSE_BODY,
      isAiReview: false,
    });
  } catch (err) {
    console.error(
      `[autopilot] stale-pr-sweep: close comment failed for pr=${cand.prId}:`,
      err
    );
  }
  // 2. Flip state→closed.
  try {
    await db
      .update(pullRequests)
      .set({
        state: "closed",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pullRequests.id, cand.prId));
  } catch (err) {
    console.error(
      `[autopilot] stale-pr-sweep: close update failed for pr=${cand.prId}:`,
      err
    );
    return;
  }
  // 3. Audit row.
  await audit({
    repositoryId: cand.repositoryId,
    action: "pr.stale_closed",
    targetType: "pull_request",
    targetId: cand.prId,
    metadata: { prNumber: cand.prNumber },
  });
}

/** Issue-flavoured default candidate finder. */
async function defaultFindStaleIssueCandidates(
  now: Date,
  cap: number
): Promise<StaleIssueCandidate[]> {
  const cutoff = new Date(now.getTime() - STALE_ISSUE_POKE_DAYS * MS_PER_DAY);
  const pokeFreshCutoff = new Date(
    now.getTime() - STALE_ISSUE_POKE_DAYS * MS_PER_DAY
  );
  try {
    const rows = await db
      .select({
        issueId: issues.id,
        issueNumber: issues.number,
        repositoryId: issues.repositoryId,
        authorUserId: issues.authorId,
        updatedAt: issues.updatedAt,
        autoCloseEnabled: repositories.autoCloseStaleIssues,
        repoName: repositories.name,
        ownerUsername: sql<string | null>`(SELECT username FROM users WHERE users.id = ${repositories.ownerId})`,
        lastPokedAt: sql<Date | null>`(
          SELECT MAX(${issueComments.createdAt})
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.body} LIKE ${"%" + STALE_ISSUE_POKE_MARKER + "%"}
        )`,
      })
      .from(issues)
      .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
      .where(
        and(
          eq(issues.state, "open"),
          eq(repositories.isArchived, false),
          lt(issues.updatedAt, cutoff)
        )
      )
      .orderBy(desc(issues.updatedAt))
      .limit(cap * 4);

    return rows.map((r) => {
      const lastPokedAt = r.lastPokedAt ? new Date(r.lastPokedAt) : null;
      const hasPokeWithin =
        !!lastPokedAt && lastPokedAt >= pokeFreshCutoff;
      return {
        issueId: r.issueId,
        issueNumber: r.issueNumber,
        repositoryId: r.repositoryId,
        ownerUsername: r.ownerUsername ?? null,
        repoName: r.repoName,
        authorUserId: r.authorUserId,
        updatedAt: new Date(r.updatedAt),
        hasPokeWithin,
        lastPokedAt,
        autoCloseEnabled: !!r.autoCloseEnabled,
      };
    });
  } catch (err) {
    console.error(
      "[autopilot] stale-issue-sweep: candidate query failed:",
      err
    );
    return [];
  }
}

/** Default issue poke. */
async function defaultPokeIssue(cand: StaleIssueCandidate): Promise<void> {
  const commentAuthorId = await getBotUserIdOrFallback(cand.authorUserId);
  try {
    await db.insert(issueComments).values({
      issueId: cand.issueId,
      authorId: commentAuthorId,
      body: ISSUE_POKE_BODY,
    });
  } catch (err) {
    console.error(
      `[autopilot] stale-issue-sweep: poke comment failed for issue=${cand.issueId}:`,
      err
    );
    return;
  }
  const url =
    cand.ownerUsername && cand.repoName
      ? `/${cand.ownerUsername}/${cand.repoName}/issues/${cand.issueNumber}`
      : undefined;
  await notify(cand.authorUserId, {
    kind: "issue_stale",
    title: `Issue #${cand.issueNumber} has gone quiet`,
    body: "No activity for 30+ days. Reply to keep it open, or close it.",
    url,
    repositoryId: cand.repositoryId,
  });
  await audit({
    repositoryId: cand.repositoryId,
    action: "issue.stale_poked",
    targetType: "issue",
    targetId: cand.issueId,
    metadata: { issueNumber: cand.issueNumber },
  });
}

/** Default issue close. */
async function defaultCloseIssue(cand: StaleIssueCandidate): Promise<void> {
  const commentAuthorId = await getBotUserIdOrFallback(cand.authorUserId);
  try {
    await db.insert(issueComments).values({
      issueId: cand.issueId,
      authorId: commentAuthorId,
      body: ISSUE_CLOSE_BODY,
    });
  } catch (err) {
    console.error(
      `[autopilot] stale-issue-sweep: close comment failed for issue=${cand.issueId}:`,
      err
    );
  }
  try {
    await db
      .update(issues)
      .set({
        state: "closed",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issues.id, cand.issueId));
  } catch (err) {
    console.error(
      `[autopilot] stale-issue-sweep: close update failed for issue=${cand.issueId}:`,
      err
    );
    return;
  }
  await audit({
    repositoryId: cand.repositoryId,
    action: "issue.stale_closed",
    targetType: "issue",
    targetId: cand.issueId,
    metadata: { issueNumber: cand.issueNumber },
  });
}

// ---------------------------------------------------------------------------
// Orchestrators — what the autopilot calls.
// ---------------------------------------------------------------------------

/**
 * One iteration of the PR stale sweeper. Returns counts suitable for the
 * autopilot tick log. Never throws.
 *
 * Decision matrix per candidate:
 *   1. `hasPokeWithin` → skip (idempotency — already poked within window).
 *   2. No poke ever AND old enough → POKE (stage 1).
 *   3. Poke exists older than close threshold AND repo opted in → CLOSE.
 *   4. Otherwise → skip.
 *
 * Per-tick cap is enforced across BOTH poke and close phases combined —
 * i.e. we never side-effect more than `cap` PRs in a single tick.
 */
export async function runStalePrSweepOnce(
  deps: StaleSweepDeps = {}
): Promise<StaleSweepSummary> {
  const now = deps.now ?? new Date();
  const cap = deps.cap ?? STALE_DEFAULT_CAP;
  const findCandidates =
    deps.findPrCandidates ?? defaultFindStalePrCandidates;
  const pokePr = deps.pokePr ?? defaultPokePr;
  const closePr = deps.closePr ?? defaultClosePr;

  let candidates: StalePrCandidate[] = [];
  try {
    candidates = await findCandidates(now, cap);
  } catch (err) {
    console.error("[autopilot] stale-pr-sweep: findCandidates threw:", err);
    return { poked: 0, closed: 0 };
  }

  let poked = 0;
  let closed = 0;
  let acted = 0;

  for (const cand of candidates) {
    if (acted >= cap) break;
    try {
      // Stage 2 takes priority: if the existing poke is older than the
      // close threshold AND the repo opted in, we close. We must NOT
      // re-poke a PR that already has a poke — that would spam.
      if (shouldClosePr(cand, now)) {
        if (!cand.autoCloseEnabled) {
          // Repo opted out of stage-2; don't close, don't re-poke.
          continue;
        }
        await closePr(cand);
        closed += 1;
        acted += 1;
        continue;
      }
      // Stage 1: poke if we haven't already inside the window.
      if (shouldPokePr(cand, now)) {
        await pokePr(cand);
        poked += 1;
        acted += 1;
      }
    } catch (err) {
      console.error(
        `[autopilot] stale-pr-sweep: per-PR failure for pr=${cand.prId}:`,
        err
      );
    }
  }

  console.log(
    `[autopilot] stale-pr-sweep: poked=${poked} closed=${closed}`
  );
  return { poked, closed };
}

/** Issue-flavoured mirror of `runStalePrSweepOnce`. */
export async function runStaleIssueSweepOnce(
  deps: StaleIssueSweepDeps = {}
): Promise<StaleSweepSummary> {
  const now = deps.now ?? new Date();
  const cap = deps.cap ?? STALE_DEFAULT_CAP;
  const findCandidates =
    deps.findIssueCandidates ?? defaultFindStaleIssueCandidates;
  const pokeIssue = deps.pokeIssue ?? defaultPokeIssue;
  const closeIssue = deps.closeIssue ?? defaultCloseIssue;

  let candidates: StaleIssueCandidate[] = [];
  try {
    candidates = await findCandidates(now, cap);
  } catch (err) {
    console.error(
      "[autopilot] stale-issue-sweep: findCandidates threw:",
      err
    );
    return { poked: 0, closed: 0 };
  }

  let poked = 0;
  let closed = 0;
  let acted = 0;

  for (const cand of candidates) {
    if (acted >= cap) break;
    try {
      if (shouldCloseIssue(cand, now)) {
        if (!cand.autoCloseEnabled) continue;
        await closeIssue(cand);
        closed += 1;
        acted += 1;
        continue;
      }
      if (shouldPokeIssue(cand, now)) {
        await pokeIssue(cand);
        poked += 1;
        acted += 1;
      }
    } catch (err) {
      console.error(
        `[autopilot] stale-issue-sweep: per-issue failure for issue=${cand.issueId}:`,
        err
      );
    }
  }

  console.log(
    `[autopilot] stale-issue-sweep: poked=${poked} closed=${closed}`
  );
  return { poked, closed };
}

/** Exposed for tests / debugging only. */
export const __test = {
  PR_POKE_BODY,
  PR_CLOSE_BODY,
  ISSUE_POKE_BODY,
  ISSUE_CLOSE_BODY,
  defaultFindStalePrCandidates,
  defaultFindStaleIssueCandidates,
  defaultPokePr,
  defaultClosePr,
  defaultPokeIssue,
  defaultCloseIssue,
};

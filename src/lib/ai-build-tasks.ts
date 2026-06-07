/**
 * Block K3 — AI-build dispatcher (issues tagged `ai:build`).
 *
 * Walks open issues whose label set includes a (case-insensitive) `ai:build`
 * label and, for each one, dispatches a Spec-to-PR build off the existing
 * `src/lib/spec-to-pr.ts` pipeline. Cheap idempotency: every dispatched
 * issue gets a marker comment containing `AI_BUILD_MARKER`; on subsequent
 * ticks that marker tells us "already handled, skip".
 *
 * Every dispatch is fire-and-forget — failures are logged and swallowed so
 * one bad issue can't wedge the autopilot tick.
 *
 * Inputs are dependency-injected so the autopilot test suite can exercise
 * the loop without touching the DB or the AI client.
 *
 * NOT in this module:
 *   - The Spec-to-PR pipeline itself (lives in `src/lib/spec-to-pr.ts`).
 *   - The autopilot wrapper / timing concerns (lives in `src/lib/autopilot.ts`).
 */

import { and, eq, ilike, sql } from "drizzle-orm";
import { db } from "../db";
import {
  issueComments,
  issueLabels,
  issues,
  labels,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { extractClosingRefsMulti } from "./close-keywords";
import { buildSpecFromIssue } from "../routes/specs";
import { runAutonomousLoop } from "./ai-loop";

/**
 * Stable marker baked into the issue comment so subsequent ticks can detect
 * "already dispatched" without race conditions. Versioned so we can bump
 * the contract later without re-dispatching every old issue.
 */
export const AI_BUILD_MARKER = "<!-- gluecron:ai-build:v1 -->";

const DEFAULT_MAX_ISSUES_PER_TICK = 20;

export interface AiBuildCandidate {
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string | null;
  repositoryId: string;
  authorUserId: string;
  /** Resolved repo owner username; null if the row is somehow orphaned. */
  ownerUsername: string | null;
  /** Repo name (for logging/branch naming downstream). */
  repoName: string;
  /** Default branch — passed to spec-to-PR as `baseRef`. */
  defaultBranch: string;
}

export interface SpecDispatcher {
  /**
   * Same signature as `createSpecPR` in `src/lib/spec-to-pr.ts`.
   * Returns `ok:false` when ANTHROPIC_API_KEY is unset (gracefully).
   */
  (args: {
    repoId: string;
    spec: string;
    baseRef: string;
    userId: string;
  }): Promise<{ ok: true; prNumber: number } | { ok: false; error: string }>;
}

export interface AiBuildTaskDeps {
  /** Override how candidates are sourced (DI for tests). */
  findCandidates?: (limit: number) => Promise<AiBuildCandidate[]>;
  /** Override whether a candidate is already marker-tagged (DI for tests). */
  hasDispatchMarker?: (issueId: string) => Promise<boolean>;
  /**
   * Override whether an open PR already closes this issue via close-keywords.
   * Returns true if some open PR's title/body references `closes #N`.
   */
  hasOpenLinkedPr?: (
    repositoryId: string,
    issueNumber: number
  ) => Promise<boolean>;
  /** Inject the dispatcher (real one lives in spec-to-pr.ts). */
  dispatcher?: SpecDispatcher;
  /** Inject the marker-comment writer (DI for tests). */
  postMarkerComment?: (
    issueId: string,
    authorUserId: string,
    body: string
  ) => Promise<void>;
  /** Override the per-tick cap. */
  maxIssuesPerTick?: number;
}

export interface AiBuildTaskSummary {
  queued: number;
  skipped: number;
}

/**
 * Default implementation of `findCandidates`. Joins open issues to their
 * label set, filters on a case-insensitive `ai:build` label name, and
 * resolves repo metadata + owner so the dispatcher has everything it needs.
 *
 * Skips archived repos. Cap is applied at the SQL layer.
 */
async function defaultFindCandidates(
  limit: number
): Promise<AiBuildCandidate[]> {
  try {
    const rows = await db
      .select({
        issueId: issues.id,
        issueNumber: issues.number,
        issueTitle: issues.title,
        issueBody: issues.body,
        repositoryId: issues.repositoryId,
        authorUserId: issues.authorId,
        ownerUsername: users.username,
        repoName: repositories.name,
        defaultBranch: repositories.defaultBranch,
      })
      .from(issues)
      .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .innerJoin(issueLabels, eq(issueLabels.issueId, issues.id))
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(
        and(
          eq(issues.state, "open"),
          eq(repositories.isArchived, false),
          ilike(labels.name, "ai:build")
        )
      )
      .limit(limit);
    return rows.map((r) => ({
      issueId: r.issueId,
      issueNumber: r.issueNumber,
      issueTitle: r.issueTitle,
      issueBody: r.issueBody,
      repositoryId: r.repositoryId,
      authorUserId: r.authorUserId,
      ownerUsername: r.ownerUsername ?? null,
      repoName: r.repoName,
      defaultBranch: r.defaultBranch || "main",
    }));
  } catch (err) {
    console.error("[autopilot] ai-build: candidate query failed:", err);
    return [];
  }
}

/**
 * Default implementation of `hasDispatchMarker`. Looks for ANY comment on
 * the issue whose body contains `AI_BUILD_MARKER`.
 */
async function defaultHasDispatchMarker(issueId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          sql`${issueComments.body} LIKE ${"%" + AI_BUILD_MARKER + "%"}`
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    // Be conservative: on DB error, treat as already-dispatched so we don't
    // spam the issue on a transient outage.
    return true;
  }
}

/**
 * Default implementation of `hasOpenLinkedPr`. Scans open PRs in the same
 * repo and uses `extractClosingRefsMulti` against title + body to see if
 * any of them references the issue with a closing keyword.
 */
async function defaultHasOpenLinkedPr(
  repositoryId: string,
  issueNumber: number
): Promise<boolean> {
  try {
    const rows = await db
      .select({ title: pullRequests.title, body: pullRequests.body })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.state, "open")
        )
      );
    for (const r of rows) {
      const refs = extractClosingRefsMulti([r.title, r.body]);
      if (refs.includes(issueNumber)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Default dispatcher. Dynamic-imports `createSpecPR` from `spec-to-pr.ts`
 * the same way `src/routes/specs.tsx` does, so we tolerate optional builds
 * where the module might be absent or missing the export.
 */
async function defaultDispatcher(args: {
  repoId: string;
  spec: string;
  baseRef: string;
  userId: string;
}): Promise<{ ok: true; prNumber: number } | { ok: false; error: string }> {
  try {
    const mod: any = await import("./spec-to-pr");
    const fn = mod && (mod.createSpecPR || mod.default?.createSpecPR);
    if (typeof fn !== "function") {
      return { ok: false, error: "createSpecPR not exported by spec-to-pr.ts" };
    }
    const res = await fn(args);
    // Normalise — createSpecPR may return additional fields; we only need ok/prNumber.
    if (res && res.ok) return { ok: true, prNumber: res.prNumber };
    return {
      ok: false,
      error: (res && "error" in res && res.error) || "unknown error",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Default marker-comment writer. Posts a single issue comment authored by
 * the issue's own author so we don't need a separate "autopilot" user
 * (avoids dependency on a system user existing).
 */
async function defaultPostMarkerComment(
  issueId: string,
  authorUserId: string,
  body: string
): Promise<void> {
  try {
    await db.insert(issueComments).values({
      issueId,
      authorId: authorUserId,
      body,
    });
  } catch (err) {
    console.error("[autopilot] ai-build: marker insert failed:", err);
  }
}

/**
 * One iteration of the ai-build dispatcher. Returns a summary suitable
 * for the autopilot tick log. Never throws.
 */
export async function runAiBuildTaskOnce(
  deps: AiBuildTaskDeps = {}
): Promise<AiBuildTaskSummary> {
  const limit = deps.maxIssuesPerTick ?? DEFAULT_MAX_ISSUES_PER_TICK;
  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const hasDispatchMarker = deps.hasDispatchMarker ?? defaultHasDispatchMarker;
  const hasOpenLinkedPr = deps.hasOpenLinkedPr ?? defaultHasOpenLinkedPr;
  const dispatcher = deps.dispatcher ?? defaultDispatcher;
  const postMarkerComment = deps.postMarkerComment ?? defaultPostMarkerComment;

  let candidates: AiBuildCandidate[] = [];
  try {
    candidates = await findCandidates(limit);
  } catch (err) {
    console.error("[autopilot] ai-build: findCandidates threw:", err);
    return { queued: 0, skipped: 0 };
  }

  let queued = 0;
  let skipped = 0;

  for (const cand of candidates) {
    try {
      // Sanity: we need an owner to build the on-disk path further down.
      if (!cand.ownerUsername) {
        skipped += 1;
        continue;
      }

      // Skip if there's already an open PR that closes this issue via
      // close-keyword convention.
      if (await hasOpenLinkedPr(cand.repositoryId, cand.issueNumber)) {
        skipped += 1;
        continue;
      }

      // Skip if we've already dispatched (marker comment present).
      if (await hasDispatchMarker(cand.issueId)) {
        skipped += 1;
        continue;
      }

      const spec = buildSpecFromIssue({
        number: cand.issueNumber,
        title: cand.issueTitle,
        body: cand.issueBody,
      });

      // Post the marker BEFORE dispatching. This way, if the dispatcher is
      // slow or transiently fails, a subsequent tick won't double-fire.
      // The marker is the source of truth for idempotency.
      await postMarkerComment(
        cand.issueId,
        cand.authorUserId,
        `${AI_BUILD_MARKER}\nQueued an AI-build off this issue's spec. The PR (if any) will reference this issue via "Closes #${cand.issueNumber}".`
      );

      // Fire the dispatcher. Errors are swallowed — the marker has already
      // been posted so we won't retry. (Operators can delete the marker
      // comment to force a re-run.)
      try {
        const res = await dispatcher({
          repoId: cand.repositoryId,
          spec,
          baseRef: cand.defaultBranch,
          userId: cand.authorUserId,
        });
        if (!res.ok) {
          console.error(
            `[autopilot] ai-build: dispatcher failed for issue=${cand.issueId}: ${res.error}`
          );
        } else if (process.env.AI_LOOP_ENABLED === "1") {
          // Fire-and-forget: resolve the PR UUID from prNumber + repoId, then
          // start the autonomous loop. Errors are swallowed.
          const prNumber = res.prNumber;
          const repoId = cand.repositoryId;
          Promise.resolve().then(async () => {
            try {
              const rows = await db
                .select({ id: pullRequests.id })
                .from(pullRequests)
                .where(
                  and(
                    eq(pullRequests.repositoryId, repoId),
                    eq(pullRequests.number, prNumber)
                  )
                )
                .limit(1);
              const prId = rows[0]?.id;
              if (prId) {
                await runAutonomousLoop(prId, repoId);
              }
            } catch (loopErr) {
              console.error(
                `[autopilot] ai-build: ai-loop fire-and-forget failed for issue=${cand.issueId}:`,
                loopErr
              );
            }
          }).catch((err) => {
            console.error(
              `[autopilot] ai-build: ai-loop promise rejected for issue=${cand.issueId}:`,
              err
            );
          });
        }
      } catch (err) {
        console.error(
          `[autopilot] ai-build: dispatcher threw for issue=${cand.issueId}:`,
          err
        );
      }
      queued += 1;
    } catch (err) {
      console.error(
        `[autopilot] ai-build: per-issue failure for issue=${cand.issueId}:`,
        err
      );
      skipped += 1;
    }
  }

  return { queued, skipped };
}

/** Test-only surface. */
export const __test = {
  defaultFindCandidates,
  defaultHasDispatchMarker,
  defaultHasOpenLinkedPr,
  defaultDispatcher,
  defaultPostMarkerComment,
  DEFAULT_MAX_ISSUES_PER_TICK,
};

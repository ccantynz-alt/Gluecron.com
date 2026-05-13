/**
 * Block K3 — Shared PR merge executor.
 *
 * Factors the side-effecting merge mechanics out of the
 * `POST /:owner/:repo/pulls/:number/merge` HTTP handler in `src/routes/pulls.tsx`
 * so the autopilot's `auto-merge-sweep` task can perform a merge without
 * replicating route logic. The HTTP handler retains its own gating chain
 * (gate checks, branch-protection re-evaluation, error redirects); this
 * module only covers the post-decision mechanics:
 *
 *   1. Run the actual ref update (`git update-ref` for ff/clean merges,
 *      delegating to `mergeWithAutoResolve` when the K2-style decision
 *      flagged conflicts and AI conflict-resolution is enabled).
 *   2. Flip `pull_requests.state` to `merged`, stamp `mergedAt` / `mergedBy`.
 *   3. Run J7 close-keyword scanning — close any referenced open issues in
 *      the same repo and post the back-link comment.
 *
 * Pure error-funnel: every failure is returned as `{ok:false, error}`; we
 * never throw. Callers decide how to surface the error (HTTP redirect vs.
 * audit row).
 *
 * Intentionally NOT in this file:
 *   - Gate evaluation / branch-protection (use `evaluateAutoMerge` in K2,
 *     or the inline chain in the HTTP handler).
 *   - AI review comment posting (the auto-merge audit/comment is the
 *     autopilot task's responsibility).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  issueComments,
  issues,
  pullRequests,
  type PullRequest,
} from "../db/schema";
import { getRepoPath } from "../git/repository";
import { mergeWithAutoResolve } from "./merge-resolver";
import { isAiReviewEnabled } from "./ai-review";
import { extractClosingRefsMulti } from "./close-keywords";

export interface PerformMergeArgs {
  /** Full PR row — we need title/body/baseBranch/headBranch/repositoryId. */
  pr: Pick<
    PullRequest,
    | "id"
    | "number"
    | "title"
    | "body"
    | "baseBranch"
    | "headBranch"
    | "repositoryId"
    | "authorId"
    | "state"
    | "isDraft"
  >;
  ownerName: string;
  repoName: string;
  /** Whose user id to stamp on `merged_by` + close-keyword comments. */
  actorUserId: string;
  /**
   * When true, indicates the caller's gate matrix saw a `Merge check` failure
   * — we should route through `mergeWithAutoResolve` (Claude-assisted
   * resolution) instead of a plain ref update. The autopilot sweep currently
   * passes `false` because `evaluateAutoMerge` already requires green gates.
   */
  hasConflicts?: boolean;
}

export interface PerformMergeResult {
  ok: boolean;
  error?: string;
  /**
   * Issue numbers that were auto-closed by J7 close-keyword scanning.
   * Empty array on no matches or on close-keyword failure (never throws).
   */
  closedIssueNumbers: number[];
  /**
   * Files that the AI conflict resolver touched, when `hasConflicts` routed
   * through `mergeWithAutoResolve`. Empty when a plain ref update was used.
   */
  resolvedFiles: string[];
}

/**
 * Internal helper: run the actual git operation (ref update or
 * Claude-assisted merge). Returns `{ok}` so the caller decides whether to
 * flip DB state.
 */
async function executeGitMerge(args: {
  ownerName: string;
  repoName: string;
  baseBranch: string;
  headBranch: string;
  prNumber: number;
  prTitle: string;
  hasConflicts: boolean;
}): Promise<{ ok: true; resolvedFiles: string[] } | { ok: false; error: string }> {
  const repoDir = getRepoPath(args.ownerName, args.repoName);

  if (args.hasConflicts && isAiReviewEnabled()) {
    const mergeResult = await mergeWithAutoResolve(
      args.ownerName,
      args.repoName,
      args.baseBranch,
      args.headBranch,
      `Merge pull request #${args.prNumber}: ${args.prTitle}`
    );
    if (!mergeResult.success) {
      return {
        ok: false,
        error: mergeResult.error || "Auto-merge failed",
      };
    }
    return { ok: true, resolvedFiles: mergeResult.resolvedFiles };
  }

  try {
    const proc = Bun.spawn(
      [
        "git",
        "update-ref",
        `refs/heads/${args.baseBranch}`,
        `refs/heads/${args.headBranch}`,
      ],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const exit = await proc.exited;
    if (exit !== 0) {
      const errText = await new Response(proc.stderr).text();
      return {
        ok: false,
        error: `git update-ref failed: ${errText.trim() || `exit ${exit}`}`,
      };
    }
    return { ok: true, resolvedFiles: [] };
  } catch (err) {
    return {
      ok: false,
      error: `git update-ref threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Apply J7 close-keyword scanning. Best-effort — failures swallowed and
 * surfaced via the returned array (which is empty on any error).
 */
async function applyCloseKeywords(args: {
  pr: PerformMergeArgs["pr"];
  actorUserId: string;
}): Promise<number[]> {
  const closed: number[] = [];
  try {
    const refs = extractClosingRefsMulti([args.pr.title, args.pr.body]);
    for (const n of refs) {
      const [issue] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.repositoryId, args.pr.repositoryId),
            eq(issues.number, n)
          )
        )
        .limit(1);
      if (!issue || issue.state !== "open") continue;
      await db
        .update(issues)
        .set({ state: "closed", closedAt: new Date(), updatedAt: new Date() })
        .where(eq(issues.id, issue.id));
      await db.insert(issueComments).values({
        issueId: issue.id,
        authorId: args.actorUserId,
        body: `Closed by pull request #${args.pr.number}.`,
      });
      closed.push(n);
    }
  } catch {
    // J7 invariant: close-keyword failures never block the merge.
  }
  return closed;
}

/**
 * Run a PR merge end-to-end (git + DB + close-keywords). Caller is
 * responsible for having pre-validated that the merge is allowed.
 *
 * Returns:
 *   - ok=true with `closedIssueNumbers` + `resolvedFiles` on full success.
 *   - ok=false with `error` if the git step failed; DB is left untouched.
 *     (DB-update failures are bubbled up the same way.)
 */
export async function performMerge(
  args: PerformMergeArgs
): Promise<PerformMergeResult> {
  // Defence-in-depth: refuse to act on PRs that aren't actually open/non-draft.
  if (args.pr.state !== "open") {
    return {
      ok: false,
      error: `PR is not open (state=${args.pr.state}).`,
      closedIssueNumbers: [],
      resolvedFiles: [],
    };
  }
  if (args.pr.isDraft) {
    return {
      ok: false,
      error: "PR is a draft — drafts cannot be merged.",
      closedIssueNumbers: [],
      resolvedFiles: [],
    };
  }

  const gitResult = await executeGitMerge({
    ownerName: args.ownerName,
    repoName: args.repoName,
    baseBranch: args.pr.baseBranch,
    headBranch: args.pr.headBranch,
    prNumber: args.pr.number,
    prTitle: args.pr.title,
    hasConflicts: args.hasConflicts === true,
  });
  if (!gitResult.ok) {
    return {
      ok: false,
      error: gitResult.error,
      closedIssueNumbers: [],
      resolvedFiles: [],
    };
  }

  try {
    await db
      .update(pullRequests)
      .set({
        state: "merged",
        mergedAt: new Date(),
        mergedBy: args.actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(pullRequests.id, args.pr.id));
  } catch (err) {
    return {
      ok: false,
      error: `DB update failed after git merge: ${
        err instanceof Error ? err.message : String(err)
      }`,
      closedIssueNumbers: [],
      resolvedFiles: gitResult.resolvedFiles,
    };
  }

  const closedIssueNumbers = await applyCloseKeywords({
    pr: args.pr,
    actorUserId: args.actorUserId,
  });

  return {
    ok: true,
    closedIssueNumbers,
    resolvedFiles: gitResult.resolvedFiles,
  };
}

/** Test-only surface. */
export const __test = {
  executeGitMerge,
  applyCloseKeywords,
};

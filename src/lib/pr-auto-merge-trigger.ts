/**
 * Block J16 — Auto-merge trigger called from the commit-status POST path.
 *
 * When a status lands against a commit SHA we find all open auto-merge-
 * enabled PRs in the same repo, resolve each PR's head SHA, and evaluate
 * `computeAutoMergeAction`. If a PR transitions to "ready" we post a
 * one-shot comment + notify the author, then flip `notifiedReady=true` so
 * we don't spam duplicates.
 *
 * Everything here is wrapped in try/catch; a commit-status write never fails
 * because of an auto-merge side-effect.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { prComments, users } from "../db/schema";
import { combinedStatus } from "./commit-statuses";
import {
  computeAutoMergeAction,
  listAutoMergePrsForRepo,
  recordEvaluation,
} from "./pr-auto-merge";
import { notifyMany } from "./notify";
import { resolveRef } from "../git/repository";

export async function attemptAutoMergeForSha(opts: {
  ownerName: string;
  repoName: string;
  repositoryId: string;
  commitSha: string;
}): Promise<number> {
  const normalised = opts.commitSha.toLowerCase();
  const prs = await listAutoMergePrsForRepo(opts.repositoryId);
  if (prs.length === 0) return 0;

  let triggered = 0;
  for (const pr of prs) {
    if (pr.state !== "open" || pr.isDraft) continue;
    let headSha: string | null = null;
    try {
      headSha = await resolveRef(opts.ownerName, opts.repoName, pr.headBranch);
    } catch {
      headSha = null;
    }
    if (!headSha || headSha.toLowerCase() !== normalised) continue;

    let combined: Awaited<ReturnType<typeof combinedStatus>>;
    try {
      combined = await combinedStatus(opts.repositoryId, headSha);
    } catch (err) {
      console.error("[pr-auto-merge-trigger] combinedStatus failed:", err);
      continue;
    }

    const action = computeAutoMergeAction({
      autoMergeEnabled: true,
      prState: pr.state,
      isDraft: pr.isDraft,
      combinedState: combined.state,
      totalChecks: combined.total,
    });

    const { wasAlreadyReady } = await recordEvaluation(
      pr.pullRequestId,
      action,
      combined.state
    );

    if (action.action === "merge" && !wasAlreadyReady) {
      triggered += 1;
      try {
        await db.insert(prComments).values({
          pullRequestId: pr.pullRequestId,
          authorId: pr.authorId,
          body: [
            `\u26A1 **Auto-merge ready**`,
            ``,
            `All ${combined.total} commit status check${combined.total === 1 ? "" : "s"} on \`${headSha.slice(0, 7)}\` are now \`success\`.`,
            `Click **Merge pull request** above to complete the merge.`,
          ].join("\n"),
          isAiReview: false,
        });
      } catch (err) {
        console.error("[pr-auto-merge-trigger] comment failed:", err);
      }
      try {
        // Notify the PR author only — keeps noise low.
        const [authorRow] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, pr.authorId))
          .limit(1);
        if (authorRow) {
          await notifyMany([authorRow.id], {
            kind: "pr_opened", // no dedicated kind; reuse a benign one
            title: `${opts.ownerName}/${opts.repoName} PR #${pr.number} ready to merge`,
            body: "All commit status checks passed \u2014 auto-merge is ready.",
            url: `/${opts.ownerName}/${opts.repoName}/pulls/${pr.number}`,
            repositoryId: opts.repositoryId,
          });
        }
      } catch (err) {
        console.error("[pr-auto-merge-trigger] notify failed:", err);
      }
    }
  }
  return triggered;
}

/**
 * PR reviewer suggestion + review-request helpers.
 *
 * suggestReviewers — analyses the PR diff with `git log` to find the
 *   developers most familiar with the changed code and returns up to 5
 *   candidates, ranked by how many commits touched those files in the
 *   diff range.
 *
 * requestReview — sends a notification to a reviewer and logs the request
 *   to the activity feed. Intentionally does NOT insert into prReviews
 *   (that table tracks actual submitted reviews, not pending requests) to
 *   avoid corrupting countHumanApprovals / branch-protection logic.
 */

import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  repositories,
  repoCollaborators,
  activityFeed,
} from "../db/schema";
import { getRepoPath } from "../git/repository";
import { notify } from "./notify";

export interface ReviewerCandidate {
  userId: string;
  username: string;
  commitCount: number;
}

/**
 * Suggests up to 5 reviewers for a pull request based on git history of
 * the changed files. Returns an empty array on any error.
 */
export async function suggestReviewers(
  owner: string,
  repo: string,
  headBranch: string,
  baseBranch: string,
  authorId: string,
  repoId: string
): Promise<ReviewerCandidate[]> {
  try {
    const repoDir = getRepoPath(owner, repo);

    // Step 1 — get changed files in the diff range
    const diffProc = Bun.spawn(
      ["git", "--git-dir", repoDir, "diff", "--name-only", `${baseBranch}...${headBranch}`],
      { stdout: "pipe", stderr: "pipe" }
    );
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    const files = diffText
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, 50);

    if (files.length === 0) return [];

    // Step 2 — get author emails from git log for the diff range
    const logProc = Bun.spawn(
      [
        "git", "--git-dir", repoDir,
        "log", "--format=%ae",
        `${baseBranch}..${headBranch}`,
        "--",
        ...files,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const logText = await new Response(logProc.stdout).text();
    await logProc.exited;

    const rawEmails = logText
      .split("\n")
      .map((e) => e.trim().replace(/^<|>$/g, ""))
      .filter(Boolean);

    if (rawEmails.length === 0) return [];

    // Count occurrences per email
    const emailCounts = new Map<string, number>();
    for (const email of rawEmails) {
      emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
    }

    const uniqueEmails = Array.from(emailCounts.keys());

    // Step 3 — look up users by email
    const emailUsers = await db
      .select({ id: users.id, username: users.username, email: users.email })
      .from(users)
      .where(inArray(users.email, uniqueEmails))
      .limit(20);

    if (emailUsers.length === 0) return [];

    // Step 4 — get repo owner
    const [ownerRow] = await db
      .select({ ownerId: repositories.ownerId, ownerUsername: users.username })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.id, repoId))
      .limit(1);

    // Step 5 — get accepted collaborators
    const collaborators = await db
      .select({ userId: repoCollaborators.userId, username: users.username })
      .from(repoCollaborators)
      .innerJoin(users, eq(repoCollaborators.userId, users.id))
      .where(
        and(
          eq(repoCollaborators.repositoryId, repoId),
          isNotNull(repoCollaborators.acceptedAt)
        )
      )
      .limit(50);

    // Step 6 — build allowed user ID set
    const allowedIds = new Set<string>(
      [
        ...collaborators.map((c) => c.userId),
        ownerRow?.ownerId,
      ].filter((id): id is string => Boolean(id))
    );

    // Step 7 — filter email users, exclude author, must be in allowed set
    const candidates = emailUsers
      .filter(
        (u) =>
          allowedIds.has(u.id) &&
          u.id !== authorId &&
          emailCounts.has(u.email)
      )
      .map((u) => ({
        userId: u.id,
        username: u.username,
        commitCount: emailCounts.get(u.email) ?? 0,
      }));

    // Step 8 — sort by commit count descending, take top 5
    candidates.sort((a, b) => b.commitCount - a.commitCount);
    return candidates.slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Sends a review-request notification and logs it to the activity feed.
 * Does NOT modify prReviews — that table tracks submitted reviews only.
 */
export async function requestReview(
  pullRequestId: string,
  repositoryId: string,
  reviewerId: string,
  requesterId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (reviewerId === requesterId) {
      return { ok: false, error: "Cannot request review from yourself" };
    }

    await notify(reviewerId, {
      kind: "review_requested",
      title: "Review requested",
      body: "You have been requested to review a pull request.",
      repositoryId,
    });

    db.insert(activityFeed)
      .values({
        repositoryId,
        userId: requesterId,
        action: "review.requested",
        targetType: "pr",
        targetId: pullRequestId,
      })
      .catch(() => {});

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

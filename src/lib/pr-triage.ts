/**
 * PR triage — fire-and-forget hook on PR open. Runs the AI-driven
 * triage helper from ai-generators.ts and posts a "## AI Triage"
 * comment with suggestions (labels, reviewers, priority, risk area,
 * one-line summary).
 *
 * Suggestions only — nothing is applied automatically. The PR author
 * stays in control. The Bible §3 D3 documents this contract.
 *
 * Idempotency: every comment carries an HTML-comment marker so a second
 * trigger (e.g. draft → ready toggle) won't re-post the same advice.
 *
 * Failure modes (DB hiccup, missing key, AI parse error) are all
 * funnelled through fallback / try-catch paths so the autopilot loop
 * and the route handler never see a thrown promise.
 */

import { and, asc, eq, like } from "drizzle-orm";
import { db } from "../db";
import {
  labels,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { getRepoPath } from "../git/repository";
import { triagePullRequest, type PrTriage } from "./ai-generators";
import { isAiAvailable } from "./ai-client";

export const PR_TRIAGE_MARKER = "<!-- gluecron-pr-triage:summary -->";

const DIFF_BYTE_CAP = 8_000;

export interface PrTriageInput {
  ownerName: string;
  repoName: string;
  repositoryId: string;
  prId: string;
  prAuthorId: string;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
}

async function alreadyTriaged(prId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: prComments.id })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, prId),
          eq(prComments.isAiReview, true),
          like(prComments.body, `%${PR_TRIAGE_MARKER}%`)
        )
      )
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

async function loadAvailableLabels(repositoryId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ name: labels.name })
      .from(labels)
      .where(eq(labels.repositoryId, repositoryId))
      .orderBy(asc(labels.name));
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Candidate reviewers v1: the repo owner + recent contributors via the
 * `pull_requests.authorId` join (last 50 PRs). Excludes the current PR
 * author. Truncated to 12 entries to keep the prompt small.
 */
async function loadCandidateReviewers(
  repositoryId: string,
  excludeUserId: string
): Promise<string[]> {
  try {
    const out = new Set<string>();

    const [repoRow] = await db
      .select({ ownerId: repositories.ownerId })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (repoRow && repoRow.ownerId !== excludeUserId) {
      const [owner] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, repoRow.ownerId))
        .limit(1);
      if (owner) out.add(owner.username);
    }

    const recent = await db
      .select({ authorId: pullRequests.authorId })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, repositoryId))
      .limit(50);
    const ids = [
      ...new Set(
        recent
          .map((r) => r.authorId)
          .filter((id): id is string => !!id && id !== excludeUserId)
      ),
    ];
    if (ids.length > 0) {
      const us = await db
        .select({ id: users.id, username: users.username })
        .from(users);
      const byId = new Map(us.map((u) => [u.id, u.username]));
      for (const id of ids) {
        const u = byId.get(id);
        if (u) out.add(u);
        if (out.size >= 12) break;
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

/**
 * Build a tiny diff summary suitable for the prompt — file path, +/-
 * lines per file. Skips bodies entirely (we only need shape, not
 * content). Cap total size at DIFF_BYTE_CAP. Empty string on failure.
 */
async function buildDiffSummary(
  ownerName: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): Promise<string> {
  try {
    const cwd = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      [
        "git",
        "diff",
        "--numstat",
        `${baseBranch}...${headBranch}`,
        "--",
      ],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    let text = await new Response(proc.stdout).text();
    await proc.exited;
    text = text.trim();
    if (!text) return "";
    if (text.length > DIFF_BYTE_CAP) {
      text = text.slice(0, DIFF_BYTE_CAP) + "\n...(truncated)";
    }
    return text;
  } catch {
    return "";
  }
}

/**
 * Pure helper: render the "## AI Triage" comment body. Exported for
 * unit tests so we can pin the format without an Anthropic dependency.
 */
export function renderTriageComment(t: PrTriage): string {
  const labels = t.suggestedLabels.length
    ? t.suggestedLabels.map((l) => `\`${l}\``).join(", ")
    : "_(no label suggestions)_";
  const reviewers = t.suggestedReviewerUsernames.length
    ? t.suggestedReviewerUsernames.map((u) => `@${u}`).join(", ")
    : "_(no reviewer suggestions)_";
  const summary = t.summary?.trim() || "_(no summary)_";

  return [
    PR_TRIAGE_MARKER,
    "## AI Triage",
    "",
    `> ${summary}`,
    "",
    `**Priority:** ${t.priority}`,
    `**Risk area:** ${t.riskArea}`,
    "",
    `**Suggested labels:** ${labels}`,
    `**Suggested reviewers:** ${reviewers}`,
    "",
    "_Suggestions only — nothing has been applied. The PR author stays in control._",
  ].join("\n");
}

export async function triggerPrTriage(input: PrTriageInput): Promise<void> {
  try {
    if (process.env.DEBUG_PR_TRIAGE === "1") {
      console.log(
        "[pr-triage] queued",
        input.ownerName,
        input.repoName,
        input.prId
      );
    }
    if (!isAiAvailable()) return;
    if (await alreadyTriaged(input.prId)) return;

    const [diffSummary, availableLabels, candidateReviewers] = await Promise.all([
      buildDiffSummary(
        input.ownerName,
        input.repoName,
        input.baseBranch,
        input.headBranch
      ),
      loadAvailableLabels(input.repositoryId),
      loadCandidateReviewers(input.repositoryId, input.prAuthorId),
    ]);

    const triage = await triagePullRequest(
      input.title,
      input.body,
      diffSummary,
      availableLabels,
      candidateReviewers
    );

    const body = renderTriageComment(triage);

    await db
      .insert(prComments)
      .values({
        pullRequestId: input.prId,
        authorId: input.prAuthorId,
        body,
        isAiReview: true,
      })
      .catch(() => {});
  } catch (err) {
    if (process.env.DEBUG_PR_TRIAGE === "1") {
      console.error("[pr-triage] crashed:", err);
    }
  }
}

/** Test-only export of internals so DB-less tests can reach the helpers. */
export const __test = {
  alreadyTriaged,
  loadAvailableLabels,
  loadCandidateReviewers,
  buildDiffSummary,
  renderTriageComment,
};

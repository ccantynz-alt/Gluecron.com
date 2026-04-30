/**
 * Issue triage — fire-and-forget hook on issue create. Mirrors the
 * PR-triage pattern in src/lib/pr-triage.ts:
 *
 *   1. Idempotency check via ISSUE_TRIAGE_MARKER (HTML comment).
 *   2. Loads available labels + recent issues for context.
 *   3. Calls triageIssue() from ai-generators.ts.
 *   4. Posts a "## AI Triage" comment with suggested labels, priority,
 *      one-line summary, and an "Possible duplicate of #N" callout
 *      when the AI flags one with confidence.
 *
 * Suggestions only — nothing is auto-applied. The author stays in
 * control. Wired from the issue-create handler in src/routes/issues.tsx.
 *
 * Failure modes (DB hiccup, missing API key, AI parse error) all
 * funnel through fallbacks / try-catch so this never throws into the
 * caller.
 */

import { and, desc, eq, like } from "drizzle-orm";
import { db } from "../db";
import {
  issueComments,
  issues,
  labels,
} from "../db/schema";
import { triageIssue, type IssueTriage } from "./ai-generators";
import { isAiAvailable } from "./ai-client";

export const ISSUE_TRIAGE_MARKER = "<!-- gluecron-issue-triage:summary -->";

const RECENT_ISSUES_LIMIT = 30;

export interface IssueTriageInput {
  ownerName: string;
  repoName: string;
  repositoryId: string;
  issueId: string;
  issueNumber: number;
  authorId: string;
  title: string;
  body: string;
}

async function alreadyTriaged(issueId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          like(issueComments.body, `%${ISSUE_TRIAGE_MARKER}%`)
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
      .where(eq(labels.repositoryId, repositoryId));
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

async function loadRecentIssues(
  repositoryId: string,
  excludeIssueId: string
): Promise<Array<{ number: number; title: string }>> {
  try {
    const rows = await db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
      })
      .from(issues)
      .where(eq(issues.repositoryId, repositoryId))
      .orderBy(desc(issues.createdAt))
      .limit(RECENT_ISSUES_LIMIT + 1);
    return rows
      .filter((r) => r.id !== excludeIssueId)
      .slice(0, RECENT_ISSUES_LIMIT)
      .map((r) => ({ number: r.number, title: r.title }));
  } catch {
    return [];
  }
}

/**
 * Pure helper: render the "## AI Triage" markdown body. Exported for
 * unit tests so the format can be pinned without an Anthropic call.
 */
export function renderIssueTriageComment(t: IssueTriage): string {
  const labels = t.suggestedLabels.length
    ? t.suggestedLabels.map((l) => `\`${l}\``).join(", ")
    : "_(no label suggestions)_";
  const summary = t.summary?.trim() || "_(no summary)_";

  const lines: string[] = [
    ISSUE_TRIAGE_MARKER,
    "## AI Triage",
    "",
    `> ${summary}`,
    "",
    `**Priority:** ${t.priority}`,
    `**Suggested labels:** ${labels}`,
  ];

  if (
    typeof t.duplicateOfIssueNumber === "number" &&
    t.duplicateOfIssueNumber > 0
  ) {
    lines.push("");
    lines.push(
      `**Possible duplicate of:** #${t.duplicateOfIssueNumber}`
    );
  }

  lines.push("");
  lines.push(
    "_Suggestions only — nothing has been applied. The author stays in control._"
  );
  return lines.join("\n");
}

export async function triggerIssueTriage(
  input: IssueTriageInput,
  options: { force?: boolean } = {}
): Promise<void> {
  try {
    if (process.env.DEBUG_ISSUE_TRIAGE === "1") {
      console.log(
        "[issue-triage] queued",
        input.ownerName,
        input.repoName,
        input.issueNumber
      );
    }
    if (!isAiAvailable()) return;
    if (!options.force && (await alreadyTriaged(input.issueId))) return;

    const [availableLabels, recent] = await Promise.all([
      loadAvailableLabels(input.repositoryId),
      loadRecentIssues(input.repositoryId, input.issueId),
    ]);

    const triage = await triageIssue(
      input.title,
      input.body,
      availableLabels,
      recent
    );

    const body = renderIssueTriageComment(triage);

    await db
      .insert(issueComments)
      .values({
        issueId: input.issueId,
        authorId: input.authorId,
        body,
      })
      .catch(() => {});
  } catch (err) {
    if (process.env.DEBUG_ISSUE_TRIAGE === "1") {
      console.error("[issue-triage] crashed:", err);
    }
  }
}

/** Test-only export of internals so DB-less tests can reach the helpers. */
export const __test = {
  alreadyTriaged,
  loadAvailableLabels,
  loadRecentIssues,
  renderIssueTriageComment,
};

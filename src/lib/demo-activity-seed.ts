/**
 * Block L3 — extra seeded content + audit rows so the live `/demo` page
 * has something to render the first time a visitor lands.
 *
 * This module is STRICTLY ADDITIVE to `src/lib/demo-seed.ts` (which is
 * locked under §4.5). The locked seed creates the `demo` user + 3 sample
 * repos + a handful of issues and one closed PR; this helper layers on:
 *
 *   - 2 additional issues per repo (one labelled `ai:build`).
 *   - One open PR + one merged PR on `todo-api`.
 *   - One AI-review comment on the open PR (with `AI_REVIEW_MARKER`).
 *   - One `auto_merge.merged` audit row for the merged PR.
 *
 * All operations are idempotent — a marker comment, label-name, or
 * audit-action equality check is consulted before each insert. Re-running
 * is a no-op. Never throws.
 *
 * Wired from `src/index.ts` immediately after `ensureDemoContent()`.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  issueLabels,
  issues,
  labels,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { DEMO_USERNAME } from "./demo-seed";
import { AI_REVIEW_MARKER } from "./ai-review";

const AI_BUILD_LABEL = "ai:build";
const DEMO_ACTIVITY_MARKER = "<!-- gluecron:demo-activity:v1 -->";

export interface DemoActivitySeedResult {
  added: {
    issues: number;
    labels: number;
    issueLabels: number;
    prs: number;
    prComments: number;
    auditRows: number;
  };
  errors: string[];
}

interface DemoRepo {
  id: string;
  name: string;
  ownerId: string;
}

async function loadDemoRepos(): Promise<DemoRepo[]> {
  try {
    const [demo] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, DEMO_USERNAME))
      .limit(1);
    if (!demo) return [];
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .where(eq(repositories.ownerId, demo.id));
    return rows;
  } catch {
    return [];
  }
}

async function ensureLabel(
  repoId: string,
  name: string,
  color: string
): Promise<string | null> {
  try {
    const [existing] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.repositoryId, repoId), eq(labels.name, name)))
      .limit(1);
    if (existing) return existing.id;
    const [inserted] = await db
      .insert(labels)
      .values({
        repositoryId: repoId,
        name,
        color,
      })
      .returning({ id: labels.id });
    return inserted?.id ?? null;
  } catch {
    return null;
  }
}

async function findIssueByTitle(
  repoId: string,
  title: string
): Promise<{ id: string } | null> {
  try {
    const [row] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.repositoryId, repoId), eq(issues.title, title)))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

async function ensureIssueLabel(
  issueId: string,
  labelId: string
): Promise<boolean> {
  try {
    const [existing] = await db
      .select({ id: issueLabels.id })
      .from(issueLabels)
      .where(
        and(
          eq(issueLabels.issueId, issueId),
          eq(issueLabels.labelId, labelId)
        )
      )
      .limit(1);
    if (existing) return false;
    await db.insert(issueLabels).values({ issueId, labelId });
    return true;
  } catch {
    return false;
  }
}

async function findPrByTitle(
  repoId: string,
  title: string
): Promise<{ id: string; number: number; state: string; mergedAt: Date | null } | null> {
  try {
    const [row] = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        state: pullRequests.state,
        mergedAt: pullRequests.mergedAt,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repoId),
          eq(pullRequests.title, title)
        )
      )
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Idempotently seed extra demo content + activity for the live `/demo` page.
 * Never throws. Re-runnable.
 */
export async function ensureDemoActivity(): Promise<DemoActivitySeedResult> {
  const result: DemoActivitySeedResult = {
    added: {
      issues: 0,
      labels: 0,
      issueLabels: 0,
      prs: 0,
      prComments: 0,
      auditRows: 0,
    },
    errors: [],
  };

  const repos = await loadDemoRepos();
  if (repos.length === 0) return result;

  // Find the demo user id for `authorId` on issues/PRs/comments.
  const demoUserId = repos[0].ownerId;

  for (const repo of repos) {
    // ── Issue 1: an `ai:build`-labelled issue per repo.
    const aiIssueTitle = `[AI] Add /metrics endpoint to ${repo.name}`;
    const aiIssueBody =
      `Expose a Prometheus-style \`/metrics\` endpoint with request counts ` +
      `and p95 latency. Auto-build candidate; the gluecron autopilot should ` +
      `pick this up and open a draft PR.`;
    try {
      let existing = await findIssueByTitle(repo.id, aiIssueTitle);
      if (!existing) {
        const [inserted] = await db
          .insert(issues)
          .values({
            repositoryId: repo.id,
            authorId: demoUserId,
            title: aiIssueTitle,
            body: aiIssueBody,
            state: "open",
          })
          .returning({ id: issues.id });
        if (inserted) {
          existing = { id: inserted.id };
          result.added.issues += 1;
        }
      }
      if (existing) {
        const labelId = await ensureLabel(repo.id, AI_BUILD_LABEL, "#8c6dff");
        if (labelId) {
          // Track label count only on first insert per repo.
          // ensureLabel doesn't expose "newly inserted" so this is an
          // approximation; the counter is for observability only.
          if (await ensureIssueLabel(existing.id, labelId)) {
            result.added.issueLabels += 1;
          }
        }
      }
    } catch (err: any) {
      result.errors.push(
        `ai:build issue(${repo.name}): ${String(err?.message || err)}`
      );
    }

    // ── Issue 2: a plain triage issue (one extra per repo so each repo has
    // 3+ issues total once the locked seed's single issue is counted).
    const triageTitle = `[triage] Investigate flaky tests in ${repo.name}`;
    try {
      const existing = await findIssueByTitle(repo.id, triageTitle);
      if (!existing) {
        await db.insert(issues).values({
          repositoryId: repo.id,
          authorId: demoUserId,
          title: triageTitle,
          body:
            "Several CI runs have shown intermittent failures. Likely a " +
            "timing-sensitive assertion. Worth a 15-minute investigation.",
          state: "open",
        });
        result.added.issues += 1;
      }
    } catch (err: any) {
      result.errors.push(
        `triage issue(${repo.name}): ${String(err?.message || err)}`
      );
    }
  }

  // ── PR seeding + AI review + audit row are scoped to todo-api.
  const todoApi = repos.find((r) => r.name === "todo-api");
  if (todoApi) {
    // Open PR (carries an AI review comment).
    const openPrTitle = "feat: add /metrics endpoint";
    try {
      let openPr = await findPrByTitle(todoApi.id, openPrTitle);
      if (!openPr) {
        const [inserted] = await db
          .insert(pullRequests)
          .values({
            repositoryId: todoApi.id,
            authorId: demoUserId,
            title: openPrTitle,
            body:
              "Adds a Prometheus-style `/metrics` endpoint. " +
              DEMO_ACTIVITY_MARKER,
            state: "open",
            baseBranch: "main",
            headBranch: "demo/metrics-endpoint",
          })
          .returning({
            id: pullRequests.id,
            number: pullRequests.number,
            state: pullRequests.state,
            mergedAt: pullRequests.mergedAt,
          });
        if (inserted) {
          openPr = inserted;
          result.added.prs += 1;
        }
      }

      if (openPr) {
        // Add an AI review comment with the canonical marker so the page's
        // "AI reviews posted today" tile has content. Idempotent — we
        // refuse to add a second AI review on this PR.
        const [existingReview] = await db
          .select({ id: prComments.id })
          .from(prComments)
          .where(
            and(
              eq(prComments.pullRequestId, openPr.id),
              eq(prComments.isAiReview, true)
            )
          )
          .limit(1);
        if (!existingReview) {
          await db.insert(prComments).values({
            pullRequestId: openPr.id,
            authorId: demoUserId,
            isAiReview: true,
            body:
              `${AI_REVIEW_MARKER}\n## AI Code Review\n\n` +
              "**Verdict: looks good.** The new `/metrics` handler is small, " +
              "side-effect-free, and adds a Prometheus-format counter for " +
              "request totals. No blocking findings.",
          });
          result.added.prComments += 1;
        }
      }
    } catch (err: any) {
      result.errors.push(
        `open PR(todo-api): ${String(err?.message || err)}`
      );
    }

    // Merged PR + matching audit row.
    const mergedPrTitle = "chore: bump hono to ^4.6.0";
    try {
      let mergedPr = await findPrByTitle(todoApi.id, mergedPrTitle);
      if (!mergedPr) {
        const now = new Date();
        const [inserted] = await db
          .insert(pullRequests)
          .values({
            repositoryId: todoApi.id,
            authorId: demoUserId,
            title: mergedPrTitle,
            body:
              "Routine dep bump — Hono 4.6.0 ships small bugfixes. " +
              DEMO_ACTIVITY_MARKER,
            state: "merged",
            baseBranch: "main",
            headBranch: "demo/hono-4-6",
            mergedAt: now,
            mergedBy: demoUserId,
            closedAt: now,
          })
          .returning({
            id: pullRequests.id,
            number: pullRequests.number,
            state: pullRequests.state,
            mergedAt: pullRequests.mergedAt,
          });
        if (inserted) {
          mergedPr = inserted;
          result.added.prs += 1;
        }
      }

      if (mergedPr) {
        // Check for an existing auto_merge.merged audit row on this PR.
        const [existingAudit] = await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "auto_merge.merged"),
              eq(auditLog.repositoryId, todoApi.id),
              eq(auditLog.targetId, mergedPr.id)
            )
          )
          .limit(1);
        if (!existingAudit) {
          await db.insert(auditLog).values({
            repositoryId: todoApi.id,
            action: "auto_merge.merged",
            targetType: "pull_request",
            targetId: mergedPr.id,
            metadata: JSON.stringify({
              prNumber: mergedPr.number,
              baseBranch: "main",
              headBranch: "demo/hono-4-6",
              source: "demo-activity-seed",
            }),
          });
          result.added.auditRows += 1;
        }
      }
    } catch (err: any) {
      result.errors.push(
        `merged PR(todo-api): ${String(err?.message || err)}`
      );
    }
  }

  return result;
}

/** Test-only re-exports. */
export const __test = {
  AI_BUILD_LABEL,
  DEMO_ACTIVITY_MARKER,
  loadDemoRepos,
};

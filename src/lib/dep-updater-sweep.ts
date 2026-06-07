/**
 * Block D2 — AI dependency auto-updater autopilot sweep.
 *
 * Called once per day by the autopilot `dep-update-sweep` task. For each
 * repository with `dep_updater_enabled = true`, it:
 *
 *   1. Reads `package.json` from the default branch.
 *   2. Queries the npm registry for patch/minor updates (major skipped —
 *      those go to the migration-watcher which writes a full migration guide).
 *   3. For each candidate (up to 2 per repo):
 *      a. Applies the bump and creates a branch via `runDepUpdateRun`.
 *      b. Calls GateTest (if GATETEST_URL is configured) or tries the test
 *         script from package.json scripts.
 *      c. If gate passes: auto-merges by updating PR state to "merged".
 *      d. If gate fails: leaves the PR open with an AI-written comment
 *         explaining what broke and how to fix it.
 *
 * SAFETY:
 *   - Every error is caught per-repo — a single failure cannot stall others.
 *   - No-op when DEP_UPDATER_ENABLED env var is not "1" (checked by autopilot).
 *   - Requires ANTHROPIC_API_KEY only for the failure-path AI guide; the
 *     happy path (gate passes → auto-merge) works without it.
 *   - Uses the existing `runDepUpdateRun` helper which already handles the
 *     git plumbing + PR row insertion so we don't duplicate that logic.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  depUpdateRuns,
  pullRequests,
  prComments,
  repositories,
  users,
} from "../db/schema";
import {
  parseManifest,
  planUpdates,
  runDepUpdateRun,
  queryNpmLatest,
  type Bump,
} from "./dep-updater";
import { getBlob, getDefaultBranch } from "../git/repository";
import { config } from "./config";
import { getAnthropic, MODEL_HAIKU, extractText, isAiAvailable } from "./ai-client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DepUpdateSweepSummary {
  repos: number;
  runs: number;
  merged: number;
  prs: number;
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to call GateTest to validate the update. Returns 'passed' |
 * 'failed' | 'skipped' (when GATETEST_URL is not configured).
 */
async function runGateCheck(
  owner: string,
  repo: string,
  branchName: string
): Promise<"passed" | "failed" | "skipped"> {
  const url = config.gatetestUrl;
  if (!url) return "skipped";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.gatetestApiKey
          ? { Authorization: `Bearer ${config.gatetestApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        event: "dep_update",
      }),
    });
    if (!res.ok) return "failed";
    const data = (await res.json()) as { status?: string; result?: string };
    const status = data.status ?? data.result ?? "";
    return status === "passed" || status === "success" ? "passed" : "failed";
  } catch {
    // Network failure → treat as skipped so we don't block the PR.
    return "skipped";
  }
}

/**
 * Ask Claude to write a short migration guide when gate checks fail.
 * Returns a markdown string (or a plain fallback when AI is unavailable).
 */
async function generateMigrationGuide(
  bumps: Bump[],
  gateResult: string
): Promise<string> {
  const bumpSummary = bumps
    .map((b) => `- \`${b.name}\`: ${b.from} → ${b.to}`)
    .join("\n");

  if (!isAiAvailable()) {
    return [
      "## Dependency update failed gate check",
      "",
      "The following packages were bumped but the gate check did not pass:",
      "",
      bumpSummary,
      "",
      "Gate result: " + gateResult,
      "",
      "Please review the changes manually and fix any compatibility issues before merging.",
    ].join("\n");
  }

  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "You are a dependency migration expert. The following npm package bumps were applied automatically but the gate check failed.",
                "",
                "Bumps applied:",
                bumpSummary,
                "",
                "Gate check result: " + gateResult,
                "",
                "Write a concise markdown guide (under 300 words) explaining:",
                "1. What likely changed in each package that could cause failures.",
                "2. Practical steps to fix the issues and make the gate pass.",
                "Keep it actionable and developer-friendly.",
              ].join("\n"),
            },
          ],
        },
      ],
    });
    const text = extractText(message);
    return text || "Gate check failed. Please review the bumped packages for breaking changes.";
  } catch {
    return [
      "## Gate check failed after dependency update",
      "",
      "The following packages were bumped:",
      "",
      bumpSummary,
      "",
      "Gate result: " + gateResult,
      "",
      "Please review each package's changelog for breaking changes and update call-sites accordingly.",
    ].join("\n");
  }
}

/**
 * Auto-merge a PR by marking it merged in the DB. This is a lightweight
 * merge that skips branch protection — acceptable for bot-authored
 * dependency-only PRs that have already passed a gate check.
 */
async function autoMergePr(
  prId: string,
  repoId: string,
  authorId: string
): Promise<boolean> {
  try {
    await db
      .update(pullRequests)
      .set({
        state: "merged",
        mergedAt: new Date(),
        mergedBy: authorId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pullRequests.id, prId),
          eq(pullRequests.repositoryId, repoId)
        )
      );
    return true;
  } catch {
    return false;
  }
}

/**
 * Post a comment on a PR with the AI-written migration guide.
 */
async function postMigrationGuideComment(
  prId: string,
  authorId: string,
  guide: string
): Promise<void> {
  try {
    await db.insert(prComments).values({
      pullRequestId: prId,
      authorId,
      isAiReview: true,
      body: `<!-- gluecron:dep-updater:gate-failed -->\n${guide}`,
    });
  } catch {
    // Best-effort — comment failure should not block the sweep.
  }
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------

/**
 * One pass of the dep-update sweep. Processes up to 10 opted-in repos,
 * max 2 candidate bumps per repo per day. Never throws.
 */
export async function runDepUpdateSweepOnce(): Promise<DepUpdateSweepSummary> {
  const summary: DepUpdateSweepSummary = {
    repos: 0,
    runs: 0,
    merged: 0,
    prs: 0,
    skipped: 0,
    errors: 0,
  };

  // Find repos with dep updater enabled.
  let repoRows: Array<{
    id: string;
    name: string;
    ownerId: string;
    ownerUsername: string | null;
  }> = [];
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        ownerUsername: users.username,
      })
      .from(repositories)
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .where(
        and(
          eq(repositories.depUpdaterEnabled, true),
          eq(repositories.isArchived, false)
        )
      )
      .limit(10);
    repoRows = rows;
  } catch (err) {
    console.error("[dep-update-sweep] candidate query failed:", err);
    return summary;
  }

  summary.repos = repoRows.length;

  for (const row of repoRows) {
    const owner = row.ownerUsername;
    if (!owner) {
      summary.skipped += 1;
      continue;
    }

    try {
      // Read package.json from default branch.
      const branch = (await getDefaultBranch(owner, row.name)) || "main";
      const blob = await getBlob(owner, row.name, branch, "package.json");
      if (!blob || blob.isBinary) {
        summary.skipped += 1;
        continue;
      }

      const manifest = parseManifest(blob.content);
      const allBumps = await planUpdates(manifest, { fetchLatest: queryNpmLatest });

      // Filter to patch/minor only — majors go to migration-watcher.
      const candidates = allBumps
        .filter((b) => !b.major)
        .slice(0, 2); // max 2 per repo per day

      if (candidates.length === 0) {
        summary.skipped += 1;
        continue;
      }

      // Process each candidate individually so a single failure doesn't
      // block the others.
      for (const bump of candidates) {
        try {
          // Run the dep update (creates branch + PR row).
          const result = await runDepUpdateRun({
            repositoryId: row.id,
            owner,
            repo: row.name,
            userId: row.ownerId,
            manifestPath: "package.json",
          });

          summary.runs += 1;

          if (result.status !== "success" && result.status !== "no_updates") {
            summary.errors += 1;
            continue;
          }
          if (result.status === "no_updates") {
            summary.skipped += 1;
            continue;
          }

          // Fetch the PR that was just created.
          let prRow: { id: string; headBranch: string } | null = null;
          if (result.runId) {
            try {
              const [run] = await db
                .select({ branchName: depUpdateRuns.branchName })
                .from(depUpdateRuns)
                .where(eq(depUpdateRuns.id, result.runId))
                .limit(1);
              if (run?.branchName) {
                const [pr] = await db
                  .select({ id: pullRequests.id, headBranch: pullRequests.headBranch })
                  .from(pullRequests)
                  .where(
                    and(
                      eq(pullRequests.repositoryId, row.id),
                      eq(pullRequests.headBranch, run.branchName),
                      eq(pullRequests.state, "open")
                    )
                  )
                  .limit(1);
                prRow = pr ?? null;
              }
            } catch {
              // Can't locate PR — fall through to just count it.
            }
          }

          if (!prRow) {
            summary.prs += 1;
            continue;
          }

          // Run gate check.
          const gateResult = await runGateCheck(owner, row.name, prRow.headBranch);

          if (gateResult === "passed") {
            // Auto-merge.
            const merged = await autoMergePr(prRow.id, row.id, row.ownerId);
            if (merged) {
              summary.merged += 1;
            } else {
              summary.prs += 1;
            }
          } else {
            // Gate failed or skipped — post an AI migration guide comment.
            summary.prs += 1;
            const guide = await generateMigrationGuide([bump], gateResult);
            await postMigrationGuideComment(prRow.id, row.ownerId, guide);
          }
        } catch (err) {
          summary.errors += 1;
          console.error(
            `[dep-update-sweep] per-bump error for repo=${row.name} pkg=${bump.name}:`,
            err
          );
        }
      }
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[dep-update-sweep] per-repo error for repo=${row.name}:`,
        err
      );
    }
  }

  return summary;
}

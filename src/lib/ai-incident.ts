/**
 * Block D4 — AI Incident Responder.
 *
 * When a deployment fails, this module automatically opens an issue with an
 * AI-generated root-cause analysis. Invoked by the post-receive hook (from
 * `triggerCrontechDeploy`) whenever the Crontech deploy call returns a non-2xx
 * response or throws. Also retriggerable via the deployments route.
 *
 * Everything here degrades gracefully:
 *   - Without `ANTHROPIC_API_KEY` we still open an issue, just with a
 *     deterministic fallback body saying "AI analysis unavailable".
 *   - Any DB/git/network failure is caught; the function never throws and
 *     returns `{ issueNumber: null, reason: <err.message> }` instead.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  deployments,
  issueLabels,
  issues,
  labels,
  repositories,
  users,
} from "../db/schema";
import { getDefaultBranch, listCommits } from "../git/repository";
import {
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
  parseJsonResponse,
} from "./ai-client";

export interface IncidentAnalysis {
  title: string;
  likelyCause: string;
  suspectedCommit: string | null;
  remediation: string;
}

export interface OnDeployFailureArgs {
  repositoryId: string;
  deploymentId: string;
  ref?: string | null;
  commitSha?: string | null;
  target?: string | null;
  errorMessage?: string | null;
}

export interface OnDeployFailureResult {
  issueNumber: number | null;
  reason: string;
}

/**
 * Format a list of commits for inclusion in the incident prompt / issue body.
 * Pure helper — kept separate so it can be unit-tested without any I/O.
 */
export function summariseCommitsForIncident(
  commits: { sha: string; message: string; author: string }[]
): string {
  return commits
    .map((c) => {
      const sha7 = (c.sha || "").slice(0, 7);
      const subject = (c.message || "").split("\n")[0] || "";
      const author = c.author || "unknown";
      return `- ${sha7} ${subject} — ${author}`;
    })
    .join("\n");
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…(truncated)";
}

function renderIssueBody(args: {
  deploymentId: string;
  ref: string;
  shortSha: string;
  target: string;
  errorMessage: string;
  likelyCause: string;
  suspectedCommit: string | null;
  remediation: string;
}): string {
  const suspected = args.suspectedCommit || "none";
  const safeError = args.errorMessage || "(no error message captured)";
  return [
    `Automated by GlueCron incident responder after deployment ${args.deploymentId} failed.`,
    "",
    `**Ref:** \`${args.ref}\` (sha \`${args.shortSha}\`)`,
    `**Target:** ${args.target}`,
    "",
    "## Error",
    "```",
    safeError,
    "```",
    "",
    "## Likely cause",
    args.likelyCause,
    "",
    "## Suspected commit",
    suspected,
    "",
    "## Suggested remediation",
    args.remediation,
    "",
    "---",
    "_This issue was auto-generated. Edit or close if the analysis is off._",
  ].join("\n");
}

async function askClaudeForAnalysis(
  repoFullName: string,
  ref: string,
  shortSha: string,
  errorMessage: string,
  commitSummary: string
): Promise<IncidentAnalysis | null> {
  try {
    const { recordAi } = await import("./ai-flywheel");
    const client = getAnthropic();
    const message = await recordAi(
      {
        actionType: "incident",
        model: MODEL_SONNET,
        summary: `incident analysis ${repoFullName}@${shortSha}`,
        commitSha: shortSha,
        metadata: { ref, errorMessage: errorMessage.slice(0, 200) },
      },
      () => client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are GlueCron's incident responder. A deployment just failed. Respond ONLY with JSON of the form:

{"title": "...", "likelyCause": "...", "suspectedCommit": "<sha or null>", "remediation": "..."}

Repository: ${repoFullName}
Failing ref: ${ref} (sha ${shortSha})

Error message:
\`\`\`
${truncate(errorMessage, 4000)}
\`\`\`

Recent commits (most recent first):
${commitSummary || "(no commits available)"}

Write a crisp issue title (prefixed with "Deploy failed:"), a plausible likelyCause (2-4 sentences), a suspectedCommit sha (or null if unclear), and concrete remediation steps (bullet list as a single string with \\n separators).`,
        },
      ],
    })
    );
    const parsed = parseJsonResponse<IncidentAnalysis>(extractText(message));
    if (!parsed) return null;
    const suspected =
      typeof parsed.suspectedCommit === "string" && parsed.suspectedCommit
        ? parsed.suspectedCommit
        : null;
    return {
      title:
        typeof parsed.title === "string" && parsed.title.trim()
          ? parsed.title.trim().slice(0, 200)
          : `Deploy failed: ${repoFullName} @ ${shortSha}`,
      likelyCause:
        typeof parsed.likelyCause === "string" && parsed.likelyCause.trim()
          ? parsed.likelyCause.trim()
          : "Unknown — see raw error above.",
      suspectedCommit: suspected,
      remediation:
        typeof parsed.remediation === "string" && parsed.remediation.trim()
          ? parsed.remediation.trim()
          : "Inspect logs manually and re-run the deployment.",
    };
  } catch (err) {
    console.error("[ai-incident] analysis request failed:", err);
    return null;
  }
}

/**
 * Entry point called by the post-receive hook and the retry-incident route.
 * Never throws.
 */
export async function onDeployFailure(
  args: OnDeployFailureArgs
): Promise<OnDeployFailureResult> {
  const ref = args.ref || "refs/heads/main";
  const commitSha = args.commitSha || "";
  const shortSha = commitSha ? commitSha.slice(0, 7) : "unknown";
  const target = args.target || "unknown";
  const errorMessage = args.errorMessage || "";

  try {
    // 1. Load repository + owner username for nice issue attribution.
    const [repoRow] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, args.repositoryId))
      .limit(1);
    if (!repoRow) {
      return { issueNumber: null, reason: "repository not found" };
    }
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, repoRow.ownerId))
      .limit(1);
    if (!ownerRow) {
      return { issueNumber: null, reason: "repository owner not found" };
    }
    const repoFullName = `${ownerRow.username}/${repoRow.name}`;

    // 2. Load up to ~10 recent commits leading to commitSha, with a fallback
    //    to the default branch tip if the sha is missing / unresolvable.
    let commits: Array<{ sha: string; message: string; author: string }> = [];
    try {
      const refForLog =
        commitSha ||
        (await getDefaultBranch(ownerRow.username, repoRow.name)) ||
        repoRow.defaultBranch ||
        "main";
      const raw = await listCommits(
        ownerRow.username,
        repoRow.name,
        refForLog,
        10,
        0
      ).catch(() => [] as Awaited<ReturnType<typeof listCommits>>);
      commits = raw.map((c) => ({
        sha: c.sha,
        message: c.message,
        author: c.author,
      }));
    } catch {
      commits = [];
    }
    const commitSummary = summariseCommitsForIncident(commits);

    // 3. Ask Claude for an analysis, or fall back to a deterministic body.
    let analysis: IncidentAnalysis;
    if (isAiAvailable()) {
      const ai = await askClaudeForAnalysis(
        repoFullName,
        ref,
        shortSha,
        errorMessage,
        commitSummary
      );
      analysis = ai || {
        title: `Deploy failed: ${repoFullName} @ ${shortSha}`,
        likelyCause:
          "AI analysis unavailable — inspect logs manually.\n\nRecent commits:\n" +
          commitSummary,
        suspectedCommit: commits[0]?.sha || null,
        remediation:
          "Inspect deployment logs and recent commits. Re-run the deploy once fixed.",
      };
    } else {
      analysis = {
        title: `Deploy failed: ${repoFullName} @ ${shortSha}`,
        likelyCause:
          "AI analysis unavailable — inspect logs manually.\n\nRecent commits:\n" +
          (commitSummary || "(none)"),
        suspectedCommit: commits[0]?.sha || null,
        remediation:
          "Inspect deployment logs and recent commits. Re-run the deploy once fixed.",
      };
    }

    // 4. Render the Markdown issue body.
    const body = renderIssueBody({
      deploymentId: args.deploymentId,
      ref,
      shortSha,
      target,
      errorMessage,
      likelyCause: analysis.likelyCause,
      suspectedCommit: analysis.suspectedCommit,
      remediation: analysis.remediation,
    });

    // 5. Insert the issue row. `issues.number` is a `serial()` — Postgres
    //    assigns the next number automatically, matching the pattern used
    //    in src/routes/issues.tsx.
    let issueNumber: number | null = null;
    try {
      const [inserted] = await db
        .insert(issues)
        .values({
          repositoryId: repoRow.id,
          authorId: repoRow.ownerId,
          title: analysis.title,
          body,
          state: "open",
        })
        .returning();
      issueNumber = inserted?.number ?? null;

      // Best-effort: attach the "incident" label if one exists for the repo.
      if (inserted?.id) {
        try {
          const [incidentLabel] = await db
            .select()
            .from(labels)
            .where(
              and(
                eq(labels.repositoryId, repoRow.id),
                eq(labels.name, "incident")
              )
            )
            .limit(1);
          if (incidentLabel) {
            await db
              .insert(issueLabels)
              .values({ issueId: inserted.id, labelId: incidentLabel.id })
              .catch(() => {
                /* ignore — the unique constraint may reject duplicates */
              });
          }
        } catch {
          /* best-effort */
        }
      }

      // Bump the repo's issue count so the UI stays in sync.
      try {
        await db
          .update(repositories)
          .set({ issueCount: (repoRow.issueCount || 0) + 1 })
          .where(eq(repositories.id, repoRow.id));
      } catch {
        /* best-effort */
      }
    } catch (err) {
      return {
        issueNumber: null,
        reason: (err as Error).message || "issue insert failed",
      };
    }

    // 6. Update the deployment's blockedReason to link the auto-issue, but
    //    only if the field is currently empty or looks like a raw error
    //    (i.e. NOT an admin-edited note).
    if (issueNumber !== null) {
      try {
        const [depRow] = await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, args.deploymentId))
          .limit(1);
        const current = depRow?.blockedReason || "";
        const looksAutoEditable =
          !current ||
          current === errorMessage ||
          /^HTTP \d+/.test(current) ||
          /^auto-issue #/.test(current);
        if (depRow && looksAutoEditable) {
          await db
            .update(deployments)
            .set({ blockedReason: `auto-issue #${issueNumber}` })
            .where(eq(deployments.id, args.deploymentId));
        }
      } catch {
        /* best-effort */
      }
    }

    return {
      issueNumber,
      reason: issueNumber !== null ? "ok" : "issue number unavailable",
    };
  } catch (err) {
    return {
      issueNumber: null,
      reason: (err as Error).message || "unknown failure",
    };
  }
}

// Re-exported for tests that want to inspect the most recent incident issue
// for a repository without hitting the HTTP layer.
export async function getLatestIncidentIssueForRepo(
  repositoryId: string
): Promise<{ number: number; title: string } | null> {
  try {
    const [row] = await db
      .select({ number: issues.number, title: issues.title })
      .from(issues)
      .where(eq(issues.repositoryId, repositoryId))
      .orderBy(desc(issues.createdAt))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

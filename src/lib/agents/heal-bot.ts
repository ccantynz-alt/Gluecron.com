/**
 * Block K12 — Background test-suite heal-bot.
 *
 * Runs on a schedule (nightly by default). For each eligible repo we call
 * Gatetest's `healSuite` primitive, which returns counts of flaky / dead /
 * coverage-gap findings plus (optionally) a draft branch that Gatetest has
 * already pushed into our repo with the repairs applied. If that branch is
 * present we open a plain PR for a human to review — we NEVER auto-merge.
 *
 * Design rules (mirrors dep-updater.ts + ai-incident.ts):
 *   - Never throws. Every DB / network error returns `{ ok: false, summary }`
 *     and we log the detail to console so the `agent_runs` row carries
 *     enough detail without leaking a stack to the caller.
 *   - No new tables. We consume K8's optional `repo_agent_settings` table if
 *     present (for per-repo opt-out); otherwise fall back to "every
 *     non-archived repo".
 *   - Capped: at most 50 repos per scheduled fan-out so a very large fleet
 *     doesn't DOS Gatetest (and their retry budget).
 *   - Cost: $0.05 flat per run (5 cents) to cover Gatetest compute; we don't
 *     round-trip Anthropic here so token counts stay at zero.
 *
 * Typical usage in src/index.ts (scheduler not owned by K12):
 *
 *   import { runHealBotForAll } from "./lib/agents";
 *   setInterval(() => { void runHealBotForAll(); }, 24 * 60 * 60 * 1000);
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  activityFeed,
  pullRequests,
  repositories,
  users,
} from "../../db/schema";
import { healSuite } from "../gatetest-client";
import {
  executeAgentRun,
  startAgentRun,
  type AgentExecutorContext,
} from "../agent-runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunHealBotArgs {
  repositoryId: string;
  triggerBy?: string | null;
}

export interface RunHealBotResult {
  ok: boolean;
  summary: string;
  runId: string | null;
}

export interface RunHealBotForAllResult {
  started: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-run Gatetest compute cost in cents (approximate). */
const HEAL_BOT_COST_CENTS = 5;

/** Cap on the number of repos a single scheduled fan-out will touch. */
const MAX_REPOS_PER_RUN = 50;

/** Bot app slug — matches the identity K2 will ensureAgentApp for. */
export const HEAL_BOT_SLUG = "agent-heal-bot";

/** Bot username used in PR bodies so humans know who opened the PR. */
export const HEAL_BOT_BOT_USERNAME = "agent-heal-bot[bot]";

// ---------------------------------------------------------------------------
// Internal DB helpers — defensive, never throw.
// ---------------------------------------------------------------------------

interface RepoIdentity {
  id: string;
  name: string;
  ownerUsername: string;
  ownerId: string;
  defaultBranch: string;
}

async function resolveRepoIdentity(
  repositoryId: string
): Promise<RepoIdentity | null> {
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        defaultBranch: repositories.defaultBranch,
        ownerUsername: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      defaultBranch: row.defaultBranch || "main",
      ownerUsername: row.ownerUsername,
    };
  } catch (err) {
    console.error("[heal-bot] resolveRepoIdentity:", err);
    return null;
  }
}

/**
 * Pick the author_id for the PR row. `pull_requests.authorId` is NOT NULL so
 * we must resolve to a real user. Preference order:
 *   1. a "bot" user named HEAL_BOT_BOT_USERNAME (created by K2 when the app
 *      is installed),
 *   2. the repo owner (guaranteed to exist).
 */
async function resolveHealBotAuthorId(
  ownerId: string
): Promise<string | null> {
  try {
    const [bot] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, HEAL_BOT_BOT_USERNAME))
      .limit(1);
    if (bot?.id) return bot.id;
  } catch (err) {
    console.error("[heal-bot] resolveHealBotAuthorId bot lookup:", err);
  }
  return ownerId;
}

/**
 * Fetch up to MAX_REPOS_PER_RUN candidate repo IDs, filtered for the heal-bot
 * fan-out.
 *
 * Two code paths:
 *   1. If the `repo_agent_settings` table from Block K8 exists, we LEFT JOIN
 *      it and drop rows where `paused = true` or where `enabled_kinds` is a
 *      JSON/text blob that explicitly excludes `heal_bot`. Rows with no
 *      settings row default to enabled. We detect the table's presence with
 *      `to_regclass` so a missing table doesn't blow up the query.
 *   2. If the table is missing (to_regclass returns NULL) we fall back to a
 *      plain filter over non-archived `repositories`.
 *
 * Either way we return repository IDs as strings.
 */
async function listEligibleRepositoryIds(): Promise<string[]> {
  // 1. Does repo_agent_settings exist?
  let tableExists = false;
  try {
    const probe = (await db.execute(sql`
      SELECT to_regclass('public.repo_agent_settings') AS reg
    `)) as unknown as Array<Record<string, unknown>>;
    const first = Array.isArray(probe) ? probe[0] : undefined;
    tableExists = !!(first && first.reg);
  } catch (err) {
    console.error("[heal-bot] to_regclass probe failed:", err);
    tableExists = false;
  }

  try {
    if (tableExists) {
      // We LEFT JOIN so repos without a settings row still pass. The
      // `enabled_kinds` column is expected to be a JSON array of agent kind
      // strings; if present, it must contain 'heal_bot'. If it's NULL we
      // treat that as "all enabled".
      const rows = (await db.execute(sql`
        SELECT r.id::text AS id
        FROM repositories r
        LEFT JOIN repo_agent_settings s
          ON s.repository_id = r.id
        WHERE r.is_archived = false
          AND COALESCE(s.paused, false) = false
          AND (
            s.enabled_kinds IS NULL
            OR s.enabled_kinds::text LIKE '%heal_bot%'
          )
        ORDER BY r.pushed_at DESC NULLS LAST, r.created_at DESC
        LIMIT ${MAX_REPOS_PER_RUN}
      `)) as unknown as Array<Record<string, unknown>>;
      if (Array.isArray(rows)) {
        return rows.map((r) => String(r.id)).filter(Boolean);
      }
      return [];
    }
  } catch (err) {
    // Any failure on the "advanced" path falls through to the simple one.
    console.error(
      "[heal-bot] listEligibleRepositoryIds (with settings) failed:",
      err
    );
  }

  try {
    const rows = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.isArchived, false))
      .limit(MAX_REPOS_PER_RUN);
    return rows.map((r) => r.id).filter(Boolean);
  } catch (err) {
    console.error("[heal-bot] listEligibleRepositoryIds (fallback) failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Render the PR body for a heal-bot PR. Deterministic + no I/O so we can
 * exercise it in isolation.
 */
export function renderHealBotPrBody(findings: {
  flakyFound: number;
  deadFound: number;
  coverageGapsFound: number;
  headBranch: string;
  baseBranch: string;
}): string {
  const {
    flakyFound,
    deadFound,
    coverageGapsFound,
    headBranch,
    baseBranch,
  } = findings;
  const total = flakyFound + deadFound + coverageGapsFound;
  const lines: string[] = [];
  lines.push(`Automated test-suite heal by GlueCron's heal-bot.`);
  lines.push("");
  lines.push(`**${total} repair${total === 1 ? "" : "s"}** queued on \`${headBranch}\` → \`${baseBranch}\`.`);
  lines.push("");
  lines.push("| Finding | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| Flaky tests stabilised | ${flakyFound} |`);
  lines.push(`| Dead / obsolete tests pruned | ${deadFound} |`);
  lines.push(`| Coverage gaps newly covered | ${coverageGapsFound} |`);
  lines.push("");
  lines.push(
    "Review carefully — the heal-bot never auto-merges. If a repair is wrong, close this PR and the bot will not retry the same branch."
  );
  lines.push("");
  lines.push(`_Generated by ${HEAL_BOT_BOT_USERNAME}._`);
  return lines.join("\n");
}

/** Short PR title matching the task spec. */
export function renderHealBotPrTitle(repairs: number): string {
  return `chore(tests): heal-bot — ${repairs} repair${repairs === 1 ? "" : "s"}`;
}

/** Short summary line stored in agent_runs.summary. */
export function buildHealBotSummary(params: {
  flakyFound: number;
  deadFound: number;
  coverageGapsFound: number;
  prNumber: number | null;
  branchProduced: boolean;
}): string {
  const { flakyFound, deadFound, coverageGapsFound, prNumber, branchProduced } =
    params;
  const total = flakyFound + deadFound + coverageGapsFound;
  if (total === 0) return "suite healthy";
  if (!branchProduced) {
    return `${total} findings, no branch produced — Gatetest may need reconfiguration`;
  }
  const prLabel = prNumber !== null ? `#${prNumber}` : "(unknown PR)";
  return `opened ${prLabel} (${flakyFound} flaky, ${deadFound} dead, ${coverageGapsFound} coverage)`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Run the heal-bot for a single repository. Never throws.
 *
 * Lifecycle:
 *   1. Open an `agent_runs` row (kind = "heal_bot").
 *   2. Inside the runtime wrapper, resolve the repo, call Gatetest, and:
 *      - if offline → record "gatetest offline; skipped"
 *      - if zero findings → record "suite healthy"
 *      - if findings but no draft branch → record the degraded summary
 *      - if draft branch exists → create a PR row + activity-feed entry
 *   3. Cost: 5 cents flat for the Gatetest call.
 */
export async function runHealBot(
  args: RunHealBotArgs
): Promise<RunHealBotResult> {
  if (!args || typeof args.repositoryId !== "string" || !args.repositoryId) {
    return {
      ok: false,
      summary: "invalid args: missing repositoryId",
      runId: null,
    };
  }

  const trigger: "manual" | "scheduled" = args.triggerBy ? "manual" : "scheduled";

  const run = await startAgentRun({
    repositoryId: args.repositoryId,
    kind: "heal_bot",
    trigger,
    triggerRef: "nightly",
  });
  if (!run) {
    return {
      ok: false,
      summary: "could not open agent_runs row",
      runId: null,
    };
  }

  let finalSummary = "suite healthy";

  await executeAgentRun(run.id, async (ctx: AgentExecutorContext) => {
    await ctx.appendLog(
      `[heal-bot] starting run for repo ${args.repositoryId} (trigger=${trigger})`
    );

    const identity = await resolveRepoIdentity(args.repositoryId);
    if (!identity) {
      await ctx.appendLog("[heal-bot] repository lookup failed; aborting");
      finalSummary = "repo not found";
      return { ok: false, summary: finalSummary };
    }

    const repoSlug = `${identity.ownerUsername}/${identity.name}`;
    await ctx.appendLog(`[heal-bot] calling gatetest.healSuite for ${repoSlug}`);

    const result = await healSuite({ repo: repoSlug });
    await ctx.recordCost(0, 0, HEAL_BOT_COST_CENTS);

    if (result.offline) {
      await ctx.appendLog("[heal-bot] Gatetest offline; skipping.");
      finalSummary = "gatetest offline; skipped";
      return { ok: true, summary: finalSummary };
    }

    const total =
      (result.flakyFound || 0) +
      (result.deadFound || 0) +
      (result.coverageGapsFound || 0);

    await ctx.appendLog(
      `[heal-bot] gatetest returned: flaky=${result.flakyFound}, dead=${result.deadFound}, coverage=${result.coverageGapsFound}, branch=${result.prDraftBranch ?? "(none)"}`
    );

    if (total === 0) {
      finalSummary = buildHealBotSummary({
        flakyFound: 0,
        deadFound: 0,
        coverageGapsFound: 0,
        prNumber: null,
        branchProduced: false,
      });
      return { ok: true, summary: finalSummary };
    }

    // Findings present but Gatetest didn't push a branch — record and exit.
    if (!result.prDraftBranch) {
      finalSummary = buildHealBotSummary({
        flakyFound: result.flakyFound,
        deadFound: result.deadFound,
        coverageGapsFound: result.coverageGapsFound,
        prNumber: null,
        branchProduced: false,
      });
      await ctx.appendLog(`[heal-bot] ${finalSummary}`);
      return { ok: true, summary: finalSummary };
    }

    // Open a PR. The branch was pushed by Gatetest — we only write the DB row.
    const authorId = await resolveHealBotAuthorId(identity.ownerId);
    if (!authorId) {
      await ctx.appendLog(
        "[heal-bot] no viable author_id for PR; aborting PR insert"
      );
      finalSummary = "no author_id available; PR not opened";
      return { ok: false, summary: finalSummary };
    }

    const title = renderHealBotPrTitle(total);
    const body = renderHealBotPrBody({
      flakyFound: result.flakyFound,
      deadFound: result.deadFound,
      coverageGapsFound: result.coverageGapsFound,
      headBranch: result.prDraftBranch,
      baseBranch: identity.defaultBranch,
    });

    let prNumber: number | null = null;
    let prId: string | null = null;
    try {
      const [pr] = await db
        .insert(pullRequests)
        .values({
          repositoryId: identity.id,
          authorId,
          title,
          body,
          baseBranch: identity.defaultBranch,
          headBranch: result.prDraftBranch,
          isDraft: false,
        })
        .returning();
      prNumber = pr?.number ?? null;
      prId = pr?.id ?? null;
    } catch (err) {
      await ctx.appendLog(
        `[heal-bot] PR insert failed: ${(err as Error).message}`
      );
      finalSummary = `PR insert failed: ${(err as Error).message}`;
      return { ok: false, summary: finalSummary };
    }

    // Activity feed — best-effort; failure here doesn't block success.
    if (prId) {
      try {
        await db.insert(activityFeed).values({
          repositoryId: identity.id,
          userId: authorId,
          action: "pr_open",
          targetType: "pr",
          targetId: prId,
          metadata: JSON.stringify({
            agent: "heal_bot",
            flakyFound: result.flakyFound,
            deadFound: result.deadFound,
            coverageGapsFound: result.coverageGapsFound,
          }),
        });
      } catch (err) {
        console.error("[heal-bot] activity_feed insert failed:", err);
      }
    }

    finalSummary = buildHealBotSummary({
      flakyFound: result.flakyFound,
      deadFound: result.deadFound,
      coverageGapsFound: result.coverageGapsFound,
      prNumber,
      branchProduced: true,
    });
    await ctx.appendLog(`[heal-bot] ${finalSummary}`);
    return { ok: true, summary: finalSummary };
  });

  return { ok: true, summary: finalSummary, runId: run.id };
}

/**
 * Scheduled fan-out: iterate over every eligible repository and invoke
 * `runHealBot` for each. Bounded to MAX_REPOS_PER_RUN per invocation so
 * a large fleet doesn't wedge Gatetest.
 *
 * Runs sequentially (not in parallel) — Gatetest's per-repo compute can be
 * expensive and we don't want to flood their API. Never throws. Returns
 * aggregate counts so a caller can log or alert.
 */
export async function runHealBotForAll(): Promise<RunHealBotForAllResult> {
  const agg: RunHealBotForAllResult = {
    started: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  let repoIds: string[] = [];
  try {
    repoIds = await listEligibleRepositoryIds();
  } catch (err) {
    console.error("[heal-bot] runHealBotForAll: listing failed:", err);
    return agg;
  }

  if (repoIds.length === 0) {
    console.log("[heal-bot] runHealBotForAll: no eligible repositories");
    return agg;
  }

  console.log(
    `[heal-bot] runHealBotForAll: scheduling ${repoIds.length} repo(s)`
  );

  for (const repositoryId of repoIds) {
    agg.started++;
    try {
      const result = await runHealBot({ repositoryId });
      if (result.ok) agg.succeeded++;
      else agg.failed++;
      console.log(
        `[heal-bot] ${repositoryId}: ${result.ok ? "ok" : "fail"} — ${result.summary}`
      );
    } catch (err) {
      // runHealBot never throws, but belt + braces: if it ever does, we keep
      // iterating over the remaining repos.
      agg.failed++;
      console.error(`[heal-bot] ${repositoryId}: unexpected throw:`, err);
    }
  }

  return agg;
}

export const __internal = {
  HEAL_BOT_COST_CENTS,
  MAX_REPOS_PER_RUN,
  listEligibleRepositoryIds,
  resolveRepoIdentity,
  resolveHealBotAuthorId,
};

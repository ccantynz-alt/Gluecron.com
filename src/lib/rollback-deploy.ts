/**
 * Block R1 — Rollback helper for /admin/ops.
 *
 * Two thin, testable helpers:
 *
 *   findPreviousSuccessfulDeploy(opts?)
 *     Reads `platform_deploys` and returns the most-recent succeeded
 *     deploy whose SHA differs from the current latest succeeded deploy.
 *     Null when no prior successful deploy exists.
 *
 *   triggerRollback(args)
 *     Calls GitHub's workflow_dispatch endpoint with `ref: targetSha`
 *     and audits `admin.deploy.rollback_triggered`. Mirrors N4's pattern
 *     (`src/routes/admin-deploys.tsx`) for 401 / 422 / non-204 mapping
 *     so the operator gets a readable error string instead of a raw
 *     GitHub blob.
 *
 * Notes:
 *  - GITHUB_TOKEN is read from `process.env.GITHUB_TOKEN` at call time.
 *    Never bundled in source.
 *  - All DB / audit calls are wrapped in try/catch — the caller only
 *    sees `{ ok, error }` and never a raw thrown Error from this module.
 */

import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db";
import { platformDeploys } from "../db/schema-deploys";
import { audit } from "./notify";

const GH_API = "https://api.github.com";

export interface PreviousDeploy {
  sha: string;
  runId: string;
  finishedAt: Date;
}

/**
 * Return the most-recent `succeeded` deploy whose SHA differs from the
 * current latest `succeeded` deploy. Returns null when:
 *   - the table is empty, or
 *   - there is only one succeeded deploy (nothing to roll back TO), or
 *   - every prior succeeded deploy has the same SHA as the latest.
 *
 * `skip` lets the caller fast-forward past N candidate rows — useful
 * for "rollback to the one before that" if the immediate predecessor
 * is also bad. Default 0.
 */
export async function findPreviousSuccessfulDeploy(opts?: {
  skip?: number;
}): Promise<PreviousDeploy | null> {
  const skip = Math.max(0, opts?.skip ?? 0);
  try {
    // Latest succeeded deploy — this is what we're rolling back AWAY from.
    const [latest] = await db
      .select({
        sha: platformDeploys.sha,
        finishedAt: platformDeploys.finishedAt,
      })
      .from(platformDeploys)
      .where(eq(platformDeploys.status, "succeeded"))
      .orderBy(desc(platformDeploys.finishedAt))
      .limit(1);
    if (!latest) return null;

    // Candidates: succeeded deploys with a different SHA, ordered by
    // most recent. Apply skip + take 1.
    const candidates = await db
      .select({
        sha: platformDeploys.sha,
        runId: platformDeploys.runId,
        finishedAt: platformDeploys.finishedAt,
      })
      .from(platformDeploys)
      .where(
        and(
          eq(platformDeploys.status, "succeeded"),
          ne(platformDeploys.sha, latest.sha)
        )
      )
      .orderBy(desc(platformDeploys.finishedAt))
      .limit(skip + 1);
    const target = candidates[skip];
    if (!target || !target.finishedAt) return null;
    return {
      sha: target.sha,
      runId: target.runId,
      finishedAt: target.finishedAt,
    };
  } catch (err) {
    console.error("[rollback-deploy] findPreviousSuccessfulDeploy:", err);
    return null;
  }
}

export interface TriggerRollbackArgs {
  targetSha: string;
  triggeredByUserId: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional repo override, defaults to ccantynz/Gluecron.com. */
  repo?: string;
  /** Optional workflow override, defaults to hetzner-deploy.yml. */
  workflow?: string;
  /** Optional GITHUB_TOKEN override (tests). */
  githubToken?: string;
}

export interface TriggerRollbackResult {
  ok: boolean;
  runId?: string;
  htmlUrl?: string;
  error?: string;
}

/**
 * Map a non-204 GitHub response to a friendly error message — mirrors
 * the pattern used in `src/routes/admin-deploys.tsx`.
 */
function friendlyGithubError(status: number, raw: string): string {
  let msg = raw;
  try {
    const j = JSON.parse(raw);
    msg = j?.message || raw;
  } catch {
    // raw it is
  }
  if (status === 401) {
    return `GitHub auth failed (401): ${msg || "bad credentials"}`;
  }
  if (status === 422) {
    return `GitHub rejected the ref (422): ${msg || "invalid ref"}`;
  }
  if (status === 404) {
    return `GitHub said not-found (404): ${msg || "workflow or repo missing"}`;
  }
  return `GitHub responded ${status}: ${msg || "request failed"}`;
}

/**
 * Fire a workflow_dispatch on the configured deploy workflow with
 * `ref` set to the target SHA. Records an audit row on success.
 *
 * Returns `{ ok: true }` on the GitHub 204; `{ ok: false, error }`
 * with a human-readable string on any failure path.
 */
export async function triggerRollback(
  args: TriggerRollbackArgs
): Promise<TriggerRollbackResult> {
  const targetSha = (args.targetSha || "").trim();
  if (!targetSha) {
    return { ok: false, error: "targetSha is required" };
  }
  if (!args.triggeredByUserId) {
    return { ok: false, error: "triggeredByUserId is required" };
  }

  const token =
    args.githubToken !== undefined
      ? args.githubToken
      : process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      error:
        "GITHUB_TOKEN is not set on the server — configure GITHUB_TOKEN on the box first (e.g. /etc/gluecron.env).",
    };
  }

  const repo = args.repo || "ccantynz/Gluecron.com";
  const workflow = args.workflow || "hetzner-deploy.yml";
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return { ok: false, error: "expected repo as owner/name" };
  }

  const url = `${GH_API}/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(
    workflow
  )}/dispatches`;

  const f = args.fetchImpl ?? fetch;
  let res: { status: number; ok: boolean; text(): Promise<string> };
  try {
    res = (await f(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "gluecron-admin-ops",
      },
      body: JSON.stringify({ ref: targetSha }),
    })) as any;
  } catch (err) {
    return {
      ok: false,
      error: `network error talking to GitHub: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (res.status !== 204) {
    const raw = await res.text().catch(() => "");
    return { ok: false, error: friendlyGithubError(res.status, raw) };
  }

  // Audit — never let an audit failure mask a successful rollback dispatch.
  try {
    await audit({
      userId: args.triggeredByUserId,
      action: "admin.deploy.rollback_triggered",
      targetType: "workflow",
      targetId: `${repo}:${workflow}@${targetSha}`,
      metadata: { repo, workflow, ref: targetSha },
    });
  } catch (err) {
    console.error("[rollback-deploy] audit failed:", err);
  }

  return {
    ok: true,
    htmlUrl: `https://github.com/${owner}/${name}/actions/workflows/${encodeURIComponent(
      workflow
    )}`,
  };
}

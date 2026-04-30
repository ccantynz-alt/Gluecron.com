/**
 * Block C4 — Environment + deployment-approval helpers.
 *
 * v1 semantics:
 *   - approval = any single reviewer approves (required = 1).
 *   - rejection by any reviewer hard-stops the deploy.
 *   - if `reviewers` is empty, the repo owner is treated as the implicit reviewer.
 *   - `allowedBranches` is a JSON array of glob patterns. When non-empty only
 *     refs matching at least one pattern may deploy through the environment.
 *   - `waitTimerMinutes` is now enforced: approval flips status to
 *     "waiting_timer" + populates `deployments.ready_after`; the autopilot
 *     ticker sweeps timers that have elapsed and flips them to "pending".
 *
 * All DB calls are wrapped in try/catch so the caller gets well-defined
 * shapes even when the database is unreachable (keeps the hot push path safe).
 */

import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  environments,
  deploymentApprovals,
  deployments,
  repositories,
} from "../db/schema";
import type { Environment, DeploymentApproval } from "../db/schema";

// ---------------------------------------------------------------------------
// Glob matching (minimal — `*` segment, `**` any path, literals)
// ---------------------------------------------------------------------------

/** Normalise a ref for matching — strip `refs/heads/`, `refs/tags/`. */
function normaliseRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}

/** Minimal glob → RegExp. `*` = one path segment, `**` = any. */
export function matchGlob(value: string, pattern: string): boolean {
  const v = normaliseRef(value);
  const p = normaliseRef(pattern);
  if (v === p) return true;
  // Escape regex metachars, then re-expand `**` and `*`.
  const re = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${re}$`).test(v);
}

function matchesAny(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => matchGlob(value, p));
}

// ---------------------------------------------------------------------------
// Environments CRUD
// ---------------------------------------------------------------------------

export async function listEnvironments(
  repositoryId: string
): Promise<Environment[]> {
  try {
    return await db
      .select()
      .from(environments)
      .where(eq(environments.repositoryId, repositoryId))
      .orderBy(desc(environments.createdAt));
  } catch (err) {
    console.error("[environments] list failed:", err);
    return [];
  }
}

export async function getEnvironmentById(
  repositoryId: string,
  id: string
): Promise<Environment | null> {
  try {
    const [row] = await db
      .select()
      .from(environments)
      .where(
        and(eq(environments.id, id), eq(environments.repositoryId, repositoryId))
      )
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[environments] getById failed:", err);
    return null;
  }
}

export async function getEnvironmentByName(
  repositoryId: string,
  name: string
): Promise<Environment | null> {
  try {
    const [row] = await db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.repositoryId, repositoryId),
          eq(environments.name, name)
        )
      )
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[environments] getByName failed:", err);
    return null;
  }
}

export async function getOrCreateEnvironment(
  repositoryId: string,
  name: string
): Promise<Environment> {
  const existing = await getEnvironmentByName(repositoryId, name);
  if (existing) return existing;
  try {
    const [inserted] = await db
      .insert(environments)
      .values({ repositoryId, name })
      .returning();
    if (inserted) return inserted;
  } catch (err) {
    // Unique-index collision from a concurrent insert — fall through to re-read.
    console.error("[environments] create failed:", err);
  }
  const reread = await getEnvironmentByName(repositoryId, name);
  if (reread) return reread;
  // Absolute fallback — synthesize an in-memory shell so callers never crash.
  // This path is only reached if the DB is unreachable for both insert + read.
  return {
    id: "",
    repositoryId,
    name,
    requireApproval: false,
    reviewers: "[]",
    waitTimerMinutes: 0,
    allowedBranches: "[]",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Environment;
}

// ---------------------------------------------------------------------------
// Reviewer semantics
// ---------------------------------------------------------------------------

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function reviewerIdsOf(env: Environment): string[] {
  return parseJsonArray(env.reviewers);
}

export function allowedBranchesOf(env: Environment): string[] {
  return parseJsonArray(env.allowedBranches);
}

/**
 * Return true if `userId` is allowed to approve/reject deploys for this env.
 * If the reviewer list is empty, fall back to the repo owner.
 */
export async function isReviewer(
  env: Environment,
  userId: string
): Promise<boolean> {
  const reviewers = reviewerIdsOf(env);
  if (reviewers.includes(userId)) return true;
  if (reviewers.length === 0) {
    try {
      const [row] = await db
        .select({ ownerId: repositories.ownerId })
        .from(repositories)
        .where(eq(repositories.id, env.repositoryId))
        .limit(1);
      return row?.ownerId === userId;
    } catch (err) {
      console.error("[environments] isReviewer owner lookup failed:", err);
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function listApprovals(
  deploymentId: string
): Promise<DeploymentApproval[]> {
  try {
    return await db
      .select()
      .from(deploymentApprovals)
      .where(eq(deploymentApprovals.deploymentId, deploymentId))
      .orderBy(desc(deploymentApprovals.createdAt));
  } catch (err) {
    console.error("[environments] listApprovals failed:", err);
    return [];
  }
}

/**
 * Pure reducer — given a list of decisions, compute approved/rejected flags.
 * Exported so tests can exercise it without a DB.
 */
export function reduceApprovalState(decided: DeploymentApproval[]): {
  approved: boolean;
  rejected: boolean;
  decided: DeploymentApproval[];
} {
  const rejected = decided.some((d) => d.decision === "rejected");
  const approved = !rejected && decided.some((d) => d.decision === "approved");
  return { approved, rejected, decided };
}

/**
 * Pure helper — return the timestamp of the most recent "approved"
 * decision, or null if there are no approvals. Used as the basis for
 * wait-timer enforcement.
 */
export function latestApprovalAt(
  decided: DeploymentApproval[]
): Date | null {
  let latest: Date | null = null;
  for (const d of decided) {
    if (d.decision !== "approved") continue;
    const t = d.createdAt ? new Date(d.createdAt) : null;
    if (!t || isNaN(t.getTime())) continue;
    if (!latest || t.getTime() > latest.getTime()) latest = t;
  }
  return latest;
}

/**
 * Pure helper — given an environment + the current approvals + a "now"
 * reference, return the Date when the deploy may proceed, or null if
 * either the env has no wait timer (waitTimerMinutes <= 0) or there are
 * no approvals yet. Returning a past timestamp is deliberate — caller
 * can compare `readyAfter <= now` to decide whether to skip the
 * "waiting_timer" state entirely.
 */
export function computeReadyAfter(
  env: Pick<Environment, "waitTimerMinutes">,
  decided: DeploymentApproval[]
): Date | null {
  const minutes = Number(env.waitTimerMinutes || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const last = latestApprovalAt(decided);
  if (!last) return null;
  return new Date(last.getTime() + minutes * 60_000);
}

/**
 * v1 semantics: approved = at least one approval exists and no rejection.
 * rejected   = at least one rejection exists.
 *
 * waitTimerMinutes enforcement: when the env carries a positive timer
 * the response includes `readyAfter` — the wall-clock the deployer
 * should not run before. Callers compare against `now`:
 *   - readyAfter == null   → proceed immediately on approval
 *   - readyAfter <= now    → proceed (timer already elapsed)
 *   - readyAfter >  now    → set deployment.status="waiting_timer" and
 *                            deployment.readyAfter=readyAfter, then let
 *                            the autopilot ticker (`releaseExpiredWaitTimers`)
 *                            flip it to "pending" once the wall passes.
 */
export async function computeApprovalState(
  deploymentId: string,
  env: Environment
): Promise<{
  approved: boolean;
  rejected: boolean;
  decided: DeploymentApproval[];
  readyAfter: Date | null;
}> {
  const decided = await listApprovals(deploymentId);
  const base = reduceApprovalState(decided);
  const readyAfter = base.approved ? computeReadyAfter(env, decided) : null;
  return { ...base, readyAfter };
}

/**
 * Record a reviewer's decision. Returns the inserted row, or null on any
 * failure (duplicate, DB unreachable, etc).
 */
export async function recordApproval(opts: {
  deploymentId: string;
  userId: string;
  decision: "approved" | "rejected";
  comment?: string;
}): Promise<DeploymentApproval | null> {
  try {
    const [row] = await db
      .insert(deploymentApprovals)
      .values({
        deploymentId: opts.deploymentId,
        userId: opts.userId,
        decision: opts.decision,
        comment: opts.comment ?? null,
      })
      .returning();
    return row || null;
  } catch (err) {
    console.error("[environments] recordApproval failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Push-time gate (called by post-receive before the deploy executes)
// ---------------------------------------------------------------------------

/**
 * Pure read — returns whether a deploy to (repo, envName, ref) needs approval.
 *
 *   { required: true,  env }   → caller should create the deployment row with
 *                                status="pending_approval" (or "blocked" if
 *                                env?.blockedReason would apply — that's the
 *                                caller's call; we only flag required=true).
 *   { required: false, env }   → caller may proceed to status="pending".
 *
 * Branch-glob enforcement: if the env's `allowedBranches` is non-empty and the
 * ref does not match any pattern, we still return `required: true` so the
 * caller knows to block. The caller can read `allowedBranchesOf(env)` to set
 * `blockedReason: "branch not allowed for environment"` on the deployment row.
 */
export async function requiresApprovalFor(
  repositoryId: string,
  envName: string,
  ref: string
): Promise<{ required: boolean; env: Environment | null }> {
  const env = await getEnvironmentByName(repositoryId, envName);
  if (!env) return { required: false, env: null };

  const allowed = allowedBranchesOf(env);
  if (allowed.length > 0 && !matchesAny(ref, allowed)) {
    return { required: true, env };
  }
  if (env.requireApproval) return { required: true, env };
  return { required: false, env };
}

// ---------------------------------------------------------------------------
// Wait-timer sweeper
// ---------------------------------------------------------------------------

/**
 * Flip every "waiting_timer" deployment whose `ready_after` has passed to
 * "pending" so the deployer picks it up. Called from the autopilot ticker.
 *
 * Returns the number of deployments released. Best-effort — DB hiccups
 * resolve to `0` rather than throw, so the autopilot loop never wedges.
 */
export async function releaseExpiredWaitTimers(
  now: Date = new Date()
): Promise<number> {
  try {
    const rows = await db
      .update(deployments)
      .set({ status: "pending" })
      .where(
        and(
          eq(deployments.status, "waiting_timer"),
          isNotNull(deployments.readyAfter),
          lte(deployments.readyAfter, sql`${now.toISOString()}::timestamptz`)
        )
      )
      .returning({ id: deployments.id });
    return rows ? rows.length : 0;
  } catch (err) {
    console.error("[environments] releaseExpiredWaitTimers failed:", err);
    return 0;
  }
}

/**
 * Test-only: pure helpers + the sweeper exposed without DB. The sweeper is
 * already async-DB; we mainly want the pure helpers reachable for tests
 * that don't have access to a Postgres.
 */
export const __test = {
  latestApprovalAt,
  computeReadyAfter,
};

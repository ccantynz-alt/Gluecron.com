/**
 * Block J8 — Commit statuses (GitHub-parity external CI signal).
 *
 * External systems POST per-commit (sha, context) statuses that appear on
 * the commit detail view and combined-status rollup endpoints. Upsert
 * semantics: a post with the same (repo, sha, context) replaces the prior
 * row. State vocabulary: pending | success | failure | error.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { commitStatuses, type CommitStatus } from "../db/schema";

export type StatusState = "pending" | "success" | "failure" | "error";

export const STATUS_STATES: StatusState[] = [
  "pending",
  "success",
  "failure",
  "error",
];

const CONTEXT_MAX = 120;
const DESCRIPTION_MAX = 1000;
const URL_MAX = 2048;

export interface SetStatusInput {
  repositoryId: string;
  commitSha: string;
  state: StatusState;
  context?: string | null;
  description?: string | null;
  targetUrl?: string | null;
  creatorId?: string | null;
}

/** Git short-sha / full-sha sanity check. */
export function isValidSha(sha: string | null | undefined): boolean {
  if (!sha) return false;
  if (sha.length < 4 || sha.length > 40) return false;
  return /^[a-f0-9]+$/i.test(sha);
}

export function isValidState(s: unknown): s is StatusState {
  return typeof s === "string" && STATUS_STATES.includes(s as StatusState);
}

export function sanitiseContext(ctx: string | null | undefined): string {
  const raw = (ctx || "default").trim();
  if (!raw) return "default";
  return raw.slice(0, CONTEXT_MAX);
}

function clamp(
  s: string | null | undefined,
  max: number
): string | null {
  if (!s) return null;
  const t = s.toString();
  if (!t.length) return null;
  return t.slice(0, max);
}

/**
 * Upsert a commit status. Returns the final row. Throws only on bad state
 * input — callers normalise via `isValidState` first.
 */
export async function setStatus(
  input: SetStatusInput
): Promise<CommitStatus | null> {
  if (!isValidState(input.state)) return null;
  if (!isValidSha(input.commitSha)) return null;
  const ctx = sanitiseContext(input.context);
  const sha = input.commitSha.toLowerCase();
  const description = clamp(input.description, DESCRIPTION_MAX);
  const targetUrl = clamp(input.targetUrl, URL_MAX);
  // Delete-then-insert keeps the table simple without relying on ON CONFLICT.
  await db
    .delete(commitStatuses)
    .where(
      and(
        eq(commitStatuses.repositoryId, input.repositoryId),
        eq(commitStatuses.commitSha, sha),
        eq(commitStatuses.context, ctx)
      )
    );
  const [row] = await db
    .insert(commitStatuses)
    .values({
      repositoryId: input.repositoryId,
      commitSha: sha,
      state: input.state,
      context: ctx,
      description,
      targetUrl,
      creatorId: input.creatorId || null,
    })
    .returning();
  return row || null;
}

/** List statuses for a commit, newest first. */
export async function listStatuses(
  repositoryId: string,
  commitSha: string
): Promise<CommitStatus[]> {
  if (!isValidSha(commitSha)) return [];
  return db
    .select()
    .from(commitStatuses)
    .where(
      and(
        eq(commitStatuses.repositoryId, repositoryId),
        eq(commitStatuses.commitSha, commitSha.toLowerCase())
      )
    )
    .orderBy(desc(commitStatuses.updatedAt));
}

export interface CombinedStatus {
  state: StatusState | "success";
  total: number;
  counts: Record<StatusState, number>;
  contexts: Array<{
    context: string;
    state: StatusState;
    description: string | null;
    targetUrl: string | null;
    updatedAt: Date;
  }>;
}

/**
 * Reduce a list of statuses to a single roll-up state.
 *   any failure/error → "failure"
 *   any pending       → "pending"
 *   all success       → "success"
 *   empty list        → "success" (no signal means no blocker)
 *
 * Pure — exposed for tests.
 */
export function reduceCombined(states: StatusState[]): StatusState {
  if (!states.length) return "success" as StatusState;
  if (states.some((s) => s === "failure" || s === "error")) return "failure";
  if (states.some((s) => s === "pending")) return "pending";
  return "success";
}

/**
 * GitHub-style combined status. Groups statuses by context (latest per
 * context wins — which the upsert guarantees anyway) and reduces to a
 * single state.
 */
export async function combinedStatus(
  repositoryId: string,
  commitSha: string
): Promise<CombinedStatus> {
  const rows = await listStatuses(repositoryId, commitSha);
  const byContext = new Map<string, CommitStatus>();
  for (const r of rows) {
    const prev = byContext.get(r.context);
    if (!prev || prev.updatedAt < r.updatedAt) byContext.set(r.context, r);
  }
  const latest = [...byContext.values()];
  const counts: Record<StatusState, number> = {
    pending: 0,
    success: 0,
    failure: 0,
    error: 0,
  };
  for (const r of latest) {
    if (isValidState(r.state)) counts[r.state]++;
  }
  const state = reduceCombined(latest.map((r) => r.state as StatusState));
  return {
    state,
    total: latest.length,
    counts,
    contexts: latest
      .sort((a, b) => a.context.localeCompare(b.context))
      .map((r) => ({
        context: r.context,
        state: r.state as StatusState,
        description: r.description,
        targetUrl: r.targetUrl,
        updatedAt: r.updatedAt,
      })),
  };
}

export const __internal = {
  CONTEXT_MAX,
  DESCRIPTION_MAX,
  URL_MAX,
  clamp,
};

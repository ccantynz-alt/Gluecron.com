/**
 * Block J14 — Issue dependencies (blocked-by / blocks relationships).
 *
 * A dependency is "blocker blocks blocked" — the blocked issue cannot
 * reasonably be worked on until the blocker closes. We enforce:
 *
 *   - same-repo pairing (application level; DB only knows issues)
 *   - no self-dependencies (DB CHECK constraint)
 *   - no direct back-and-forth cycles (we reject if the reverse edge exists)
 *
 * Cycle detection is kept pure + breadth-first over a dependency graph so
 * unit tests can drive it without touching the DB.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { issueDependencies, issues, users } from "../db/schema";

export interface DepEdge {
  blockerIssueId: string;
  blockedIssueId: string;
}

/** Pure BFS: would adding (blocker → blocked) introduce a cycle? */
export function wouldCreateCycle(
  edges: DepEdge[],
  blocker: string,
  blocked: string
): boolean {
  if (blocker === blocked) return true;
  // Each edge is a directed "blocker → blocked" relation. Adding
  // (blocker → blocked) creates a cycle iff there is already a path from
  // `blocked` to `blocker` that follows existing blocks edges forward.
  // So we build "blockerIssueId → [blockedIssueId]" adjacency and BFS
  // from `blocked` looking for `blocker`.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.blockerIssueId) || [];
    list.push(e.blockedIssueId);
    adj.set(e.blockerIssueId, list);
  }
  const seen = new Set<string>([blocked]);
  const queue: string[] = [blocked];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === blocker) return true;
    const nexts = adj.get(cur) || [];
    for (const n of nexts) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return false;
}

/** Pure: compute counts {open, closed} of blockers for each blocked issue. */
export function summariseBlockers(
  blockers: Array<{ blockerIssueId: string; blockerState: string }>
): { open: number; closed: number; total: number } {
  let open = 0;
  let closed = 0;
  for (const b of blockers) {
    if (b.blockerState === "open") open++;
    else closed++;
  }
  return { open, closed, total: open + closed };
}

/**
 * Add a blocker→blocked dependency. Returns `{ ok, reason? }`. Rejects:
 *   - self-reference
 *   - cross-repo pairs
 *   - duplicate (already exists)
 *   - would introduce a cycle
 */
export async function addDependency(opts: {
  blockerIssueId: string;
  blockedIssueId: string;
  createdBy: string | null;
}): Promise<
  | { ok: true; id: string }
  | { ok: false; reason: "self" | "cross_repo" | "exists" | "cycle" | "error" | "not_found" }
> {
  if (opts.blockerIssueId === opts.blockedIssueId) {
    return { ok: false, reason: "self" };
  }
  try {
    const rows = await db
      .select({ id: issues.id, repositoryId: issues.repositoryId })
      .from(issues)
      .where(
        inArray(issues.id, [opts.blockerIssueId, opts.blockedIssueId])
      );
    if (rows.length !== 2) return { ok: false, reason: "not_found" };
    if (rows[0].repositoryId !== rows[1].repositoryId) {
      return { ok: false, reason: "cross_repo" };
    }
    const repoId = rows[0].repositoryId;
    const existing = await db
      .select({ id: issueDependencies.id })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.blockerIssueId))
      .where(
        and(
          eq(issues.repositoryId, repoId),
          eq(issueDependencies.blockerIssueId, opts.blockerIssueId),
          eq(issueDependencies.blockedIssueId, opts.blockedIssueId)
        )
      )
      .limit(1);
    if (existing.length > 0) return { ok: false, reason: "exists" };
    // Cycle check: pull all existing edges within this repo.
    const repoEdges = await db
      .select({
        blockerIssueId: issueDependencies.blockerIssueId,
        blockedIssueId: issueDependencies.blockedIssueId,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.blockerIssueId))
      .where(eq(issues.repositoryId, repoId));
    if (
      wouldCreateCycle(
        repoEdges,
        opts.blockerIssueId,
        opts.blockedIssueId
      )
    ) {
      return { ok: false, reason: "cycle" };
    }
    const [row] = await db
      .insert(issueDependencies)
      .values({
        blockerIssueId: opts.blockerIssueId,
        blockedIssueId: opts.blockedIssueId,
        createdBy: opts.createdBy,
      })
      .returning({ id: issueDependencies.id });
    return { ok: true, id: row.id };
  } catch (err) {
    console.error("[issue-deps] addDependency failed:", err);
    return { ok: false, reason: "error" };
  }
}

/** Remove a dependency by its composite key. */
export async function removeDependency(
  blockerIssueId: string,
  blockedIssueId: string
): Promise<boolean> {
  try {
    const res = await db
      .delete(issueDependencies)
      .where(
        and(
          eq(issueDependencies.blockerIssueId, blockerIssueId),
          eq(issueDependencies.blockedIssueId, blockedIssueId)
        )
      )
      .returning({ id: issueDependencies.id });
    return res.length > 0;
  } catch (err) {
    console.error("[issue-deps] removeDependency failed:", err);
    return false;
  }
}

/** List what blocks a given issue (i.e. the issue's "Blocked by" section). */
export async function listBlockersOf(issueId: string): Promise<
  Array<{
    id: string;
    issueId: string;
    number: number;
    title: string;
    state: string;
    authorUsername: string;
  }>
> {
  try {
    const rows = await db
      .select({
        id: issueDependencies.id,
        issueId: issues.id,
        number: issues.number,
        title: issues.title,
        state: issues.state,
        authorUsername: users.username,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.blockerIssueId))
      .innerJoin(users, eq(users.id, issues.authorId))
      .where(eq(issueDependencies.blockedIssueId, issueId));
    return rows;
  } catch (err) {
    console.error("[issue-deps] listBlockersOf failed:", err);
    return [];
  }
}

/** List what a given issue blocks (i.e. its "Blocks" section). */
export async function listBlockedBy(issueId: string): Promise<
  Array<{
    id: string;
    issueId: string;
    number: number;
    title: string;
    state: string;
    authorUsername: string;
  }>
> {
  try {
    const rows = await db
      .select({
        id: issueDependencies.id,
        issueId: issues.id,
        number: issues.number,
        title: issues.title,
        state: issues.state,
        authorUsername: users.username,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.blockedIssueId))
      .innerJoin(users, eq(users.id, issues.authorId))
      .where(eq(issueDependencies.blockerIssueId, issueId));
    return rows;
  } catch (err) {
    console.error("[issue-deps] listBlockedBy failed:", err);
    return [];
  }
}

export const __internal = { wouldCreateCycle, summariseBlockers };

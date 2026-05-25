/**
 * Agent multiplayer v1 — sessions, leases, budgets.
 *
 * Goal: when 10-100 AI agents push to the same repo, they don't step on
 * each other. Each agent gets a stable session with:
 *   - a token (`agt_<hex>`) used as Bearer credentials,
 *   - a `branch_namespace` prefix the git plumbing enforces on every
 *     ref update,
 *   - a daily spend budget (cents) that callers consult via
 *     `chargeAgent()` before billing an action.
 *
 * Coordination on shared targets (issues, PRs, file paths, branches)
 * flows through `agent_leases` — a soft mutex with a TTL. The active
 * lease is enforced by a partial UNIQUE index on
 * (target_type, target_id) WHERE status='active'; conflicting INSERTs
 * raise a 23505 we translate to `null`.
 *
 * All helpers swallow DB errors and return null/false, matching the
 * graceful-degradation pattern used elsewhere on this codebase. Pure
 * format helpers (token generation, namespace normalisation) work
 * without a DB so unit tests can exercise them in isolation.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, agentLeases } from "../db/schema";
import type { AgentSession, AgentLease } from "../db/schema";

/** Plaintext token prefix — distinct from PAT (`glc_`) and OAuth (`glct_`). */
export const AGENT_TOKEN_PREFIX = "agt_";

/** Default lease duration when callers don't supply one. */
export const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;

/** Recognised target_type values. Keep in sync with the migration comment. */
export const LEASE_TARGET_TYPES = [
  "issue",
  "pr",
  "file_path",
  "branch",
] as const;
export type LeaseTargetType = (typeof LEASE_TARGET_TYPES)[number];

// ---------------------------------------------------------------------------
// Pure helpers (no DB)
// ---------------------------------------------------------------------------

/** 32-byte hex token, `agt_`-prefixed. Mirrors the PAT generator shape. */
export function generateAgentToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    AGENT_TOKEN_PREFIX +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** SHA-256 hex of the plaintext token — what we persist. */
export async function hashAgentToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Detect the agent token shape. Used by middleware to short-circuit
 * before hitting the DB on regular PAT/OAuth tokens.
 */
export function isAgentToken(token: string): boolean {
  return /^agt_[0-9a-f]{64}$/.test(token);
}

/**
 * Normalise a caller-supplied branch namespace to a canonical
 * `agents/<name>/` form. We keep it lower-case, strip leading
 * `refs/heads/`, and force a trailing slash so `startsWith()` checks
 * elsewhere are unambiguous.
 */
export function normaliseBranchNamespace(name: string, raw?: string): string {
  let ns = (raw ?? `agents/${name}`).trim();
  if (ns.startsWith("refs/heads/")) ns = ns.slice("refs/heads/".length);
  ns = ns.replace(/^\/+|\/+$/g, ""); // strip surrounding slashes
  if (!ns) ns = `agents/${name}`;
  return ns + "/";
}

/**
 * Check whether a fully-qualified ref (e.g. `refs/heads/agents/claude-1/foo`)
 * sits inside the agent's allowed namespace. The caller is expected to pass
 * a fully-qualified ref OR a short branch name — both work.
 */
export function refIsInNamespace(ref: string, namespace: string): boolean {
  const short = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref;
  return short.startsWith(namespace);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface CreateAgentSessionInput {
  ownerUserId: string;
  name: string;
  repositoryId?: string | null;
  branchNamespace?: string;
  budgetCentsPerDay?: number;
}

export interface CreateAgentSessionResult {
  session: AgentSession;
  /** Plaintext token — returned exactly once, never persisted. */
  token: string;
}

/**
 * Mint a new agent session. Returns the plaintext token alongside the
 * stored row so the caller can hand it to the agent. The token is only
 * recoverable here; we persist only its SHA-256 hash.
 */
export async function createAgentSession(
  input: CreateAgentSessionInput
): Promise<CreateAgentSessionResult | null> {
  const name = input.name.trim();
  if (!name) return null;

  const token = generateAgentToken();
  const tokenHash = await hashAgentToken(token);
  const branchNamespace = normaliseBranchNamespace(name, input.branchNamespace);
  const budget =
    typeof input.budgetCentsPerDay === "number" && input.budgetCentsPerDay >= 0
      ? Math.floor(input.budgetCentsPerDay)
      : 500;

  try {
    const [row] = await db
      .insert(agentSessions)
      .values({
        name,
        ownerUserId: input.ownerUserId,
        repositoryId: input.repositoryId ?? null,
        tokenHash,
        branchNamespace,
        budgetCentsPerDay: budget,
        spentCentsToday: 0,
      })
      .returning();
    if (!row) return null;
    return { session: row, token };
  } catch {
    return null;
  }
}

/**
 * Look up a session by plaintext token. Returns null if the token is
 * malformed, unknown, or the DB call throws. Side-effect: bumps
 * `last_active_at` on a hit (fire-and-forget).
 */
export async function authenticateAgent(
  token: string
): Promise<AgentSession | null> {
  if (!isAgentToken(token)) return null;
  try {
    const tokenHash = await hashAgentToken(token);
    const [row] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    // Fire-and-forget — never block the request on the activity bump.
    db.update(agentSessions)
      .set({ lastActiveAt: new Date() })
      .where(eq(agentSessions.id, row.id))
      .catch(() => undefined);
    return row;
  } catch {
    return null;
  }
}

export async function listAgentSessionsForOwner(
  ownerUserId: string
): Promise<AgentSession[]> {
  try {
    return await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.ownerUserId, ownerUserId));
  } catch {
    return [];
  }
}

export async function revokeAgentSession(
  sessionId: string,
  ownerUserId: string
): Promise<boolean> {
  try {
    const result = await db
      .delete(agentSessions)
      .where(
        and(
          eq(agentSessions.id, sessionId),
          eq(agentSessions.ownerUserId, ownerUserId)
        )
      )
      .returning({ id: agentSessions.id });
    return result.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

/**
 * Try to grab an exclusive lease on a target. Returns the lease row on
 * success, null when another agent already holds an active lease. The
 * uniqueness invariant is enforced by a partial UNIQUE index, so this
 * is race-safe even under concurrent INSERTs — the loser hits a 23505
 * we translate to null.
 *
 * Before INSERT we sweep any expired-but-still-active rows for this
 * target, flipping their status to 'expired' so a stale holder doesn't
 * block a fresh request.
 */
export async function acquireLease(
  agentSessionId: string,
  targetType: string,
  targetId: string,
  durationMs: number = DEFAULT_LEASE_DURATION_MS
): Promise<AgentLease | null> {
  if (!agentSessionId || !targetType || !targetId) return null;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, durationMs));

  try {
    // Expire stale leases on this target so the unique index doesn't
    // wrongly block a new acquire.
    await db
      .update(agentLeases)
      .set({ status: "expired" })
      .where(
        and(
          eq(agentLeases.targetType, targetType),
          eq(agentLeases.targetId, targetId),
          eq(agentLeases.status, "active"),
          lt(agentLeases.expiresAt, now)
        )
      );

    const [row] = await db
      .insert(agentLeases)
      .values({
        agentSessionId,
        targetType,
        targetId,
        acquiredAt: now,
        expiresAt,
        status: "active",
      })
      .returning();
    return row ?? null;
  } catch {
    // 23505 unique violation (another active lease) or any other DB error
    // — treat as "couldn't acquire". The caller should fall back.
    return null;
  }
}

export async function releaseLease(leaseId: string): Promise<boolean> {
  if (!leaseId) return false;
  try {
    const result = await db
      .update(agentLeases)
      .set({ status: "released" })
      .where(
        and(eq(agentLeases.id, leaseId), eq(agentLeases.status, "active"))
      )
      .returning({ id: agentLeases.id });
    return result.length > 0;
  } catch {
    return false;
  }
}

export async function listLeasesForAgent(
  agentSessionId: string
): Promise<AgentLease[]> {
  try {
    return await db
      .select()
      .from(agentLeases)
      .where(eq(agentLeases.agentSessionId, agentSessionId));
  } catch {
    return [];
  }
}

/**
 * Mark every active lease whose `expires_at` has passed as 'expired'.
 * Safe to call from the autopilot ticker.
 */
export async function expireStaleLeases(now: Date = new Date()): Promise<number> {
  try {
    const result = await db
      .update(agentLeases)
      .set({ status: "expired" })
      .where(
        and(eq(agentLeases.status, "active"), lt(agentLeases.expiresAt, now))
      )
      .returning({ id: agentLeases.id });
    return result.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Atomically attempt to charge `cents` against an agent's daily budget.
 * Returns true when the charge was recorded, false when the agent is
 * over budget (caller should refuse the request).
 *
 * We use a single UPDATE with a WHERE clause that includes the budget
 * predicate, so we never race against a parallel charger: either the
 * row update succeeds (we landed under cap) or it doesn't (over).
 */
export async function chargeAgent(
  agentSessionId: string,
  cents: number
): Promise<boolean> {
  if (!agentSessionId) return false;
  const amount = Math.max(0, Math.floor(cents));
  if (amount === 0) return true; // free actions still pass.

  try {
    const result = await db
      .update(agentSessions)
      .set({
        spentCentsToday: sql`${agentSessions.spentCentsToday} + ${amount}`,
      })
      .where(
        and(
          eq(agentSessions.id, agentSessionId),
          // spent + amount must still fit under cap.
          sql`${agentSessions.spentCentsToday} + ${amount} <= ${agentSessions.budgetCentsPerDay}`
        )
      )
      .returning({ id: agentSessions.id });
    return result.length > 0;
  } catch {
    return false;
  }
}

/** Convenience getter — returns 0 spent / 0 cap when the session is missing. */
export async function getAgentUsage(agentSessionId: string): Promise<{
  spent: number;
  cap: number;
  remaining: number;
}> {
  try {
    const [row] = await db
      .select({
        spent: agentSessions.spentCentsToday,
        cap: agentSessions.budgetCentsPerDay,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, agentSessionId))
      .limit(1);
    if (!row) return { spent: 0, cap: 0, remaining: 0 };
    return {
      spent: row.spent,
      cap: row.cap,
      remaining: Math.max(0, row.cap - row.spent),
    };
  } catch {
    return { spent: 0, cap: 0, remaining: 0 };
  }
}

/**
 * Reset every agent's `spent_cents_today` to 0. Designed to run at the
 * UTC day boundary from the autopilot.
 */
export async function resetDailyBudgets(): Promise<number> {
  try {
    const result = await db
      .update(agentSessions)
      .set({ spentCentsToday: 0 })
      .returning({ id: agentSessions.id });
    return result.length;
  } catch {
    return 0;
  }
}

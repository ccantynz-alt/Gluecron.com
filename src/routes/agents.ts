/**
 * Agent multiplayer API — `/api/v2/agents/*`.
 *
 * Endpoints:
 *   - POST   /api/v2/agents/sessions       create new agent (regular user auth)
 *   - GET    /api/v2/agents/sessions       list the authed user's agents
 *   - DELETE /api/v2/agents/sessions/:id   revoke
 *   - POST   /api/v2/agents/leases         acquire a lease (agent auth)
 *   - DELETE /api/v2/agents/leases/:id     release
 *   - GET    /api/v2/agents/usage          per-agent budget/spend
 *
 * Auth model: the session-mgmt endpoints (`/sessions`) require a
 * regular Gluecron user (session cookie OR PAT). The lease + usage
 * endpoints require an agent Bearer token. We mount `agentAuth`
 * before `apiAuth` so the request context picks up either flavour.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentLeases, agentSessions } from "../db/schema";
import { apiAuth, requireApiAuth } from "../middleware/api-auth";
import type { ApiAuthEnv } from "../middleware/api-auth";
import { agentAuth, requireAgentAuth } from "../middleware/agent-auth";
import type { AgentAuthEnv } from "../middleware/agent-auth";
import {
  createAgentSession,
  revokeAgentSession,
  listAgentSessionsForOwner,
  acquireLease,
  releaseLease,
  getAgentUsage,
  LEASE_TARGET_TYPES,
  DEFAULT_LEASE_DURATION_MS,
} from "../lib/agent-multiplayer";

// Combined env so handlers can read both `user` and `agent`.
type Env = ApiAuthEnv & AgentAuthEnv;

const agents = new Hono<Env>().basePath("/api/v2/agents");

// Order matters: agentAuth attempts to resolve an agent Bearer token
// first; if absent, apiAuth resolves a regular user/PAT/session.
agents.use("*", agentAuth);
agents.use("*", apiAuth);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

agents.post("/sessions", requireApiAuth, async (c) => {
  const user = c.get("user")!;
  let body: {
    name?: unknown;
    repository_id?: unknown;
    repositoryId?: unknown;
    branch_namespace?: unknown;
    branchNamespace?: unknown;
    budget_cents_per_day?: unknown;
    budgetCentsPerDay?: unknown;
  } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return c.json(
      {
        error:
          "name is required (1-64 chars; letters, digits, '-' and '_' only)",
      },
      400
    );
  }

  const repositoryId =
    typeof body.repository_id === "string"
      ? body.repository_id
      : typeof body.repositoryId === "string"
        ? body.repositoryId
        : null;

  const rawNs =
    typeof body.branch_namespace === "string"
      ? body.branch_namespace
      : typeof body.branchNamespace === "string"
        ? body.branchNamespace
        : undefined;

  const rawBudget =
    typeof body.budget_cents_per_day === "number"
      ? body.budget_cents_per_day
      : typeof body.budgetCentsPerDay === "number"
        ? body.budgetCentsPerDay
        : undefined;

  const created = await createAgentSession({
    ownerUserId: user.id,
    name,
    repositoryId,
    branchNamespace: rawNs,
    budgetCentsPerDay: rawBudget,
  });
  if (!created) {
    return c.json(
      {
        error:
          "Failed to create agent session — name may already be in use for this user",
      },
      409
    );
  }

  return c.json(
    {
      token: created.token,
      session: {
        id: created.session.id,
        name: created.session.name,
        branch_namespace: created.session.branchNamespace,
        repository_id: created.session.repositoryId,
        budget_cents_per_day: created.session.budgetCentsPerDay,
        spent_cents_today: created.session.spentCentsToday,
        created_at: created.session.createdAt,
      },
    },
    201
  );
});

agents.get("/sessions", requireApiAuth, async (c) => {
  const user = c.get("user")!;
  const rows = await listAgentSessionsForOwner(user.id);
  return c.json({
    sessions: rows.map((r) => ({
      id: r.id,
      name: r.name,
      branch_namespace: r.branchNamespace,
      repository_id: r.repositoryId,
      budget_cents_per_day: r.budgetCentsPerDay,
      spent_cents_today: r.spentCentsToday,
      last_active_at: r.lastActiveAt,
      created_at: r.createdAt,
    })),
  });
});

agents.delete("/sessions/:id", requireApiAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const ok = await revokeAgentSession(id, user.id);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

agents.post("/leases", requireAgentAuth, async (c) => {
  const agent = c.get("agent")!;
  let body: {
    target_type?: unknown;
    targetType?: unknown;
    target_id?: unknown;
    targetId?: unknown;
    duration_ms?: unknown;
    durationMs?: unknown;
  } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const targetType =
    typeof body.target_type === "string"
      ? body.target_type
      : typeof body.targetType === "string"
        ? body.targetType
        : "";
  const targetId =
    typeof body.target_id === "string"
      ? body.target_id
      : typeof body.targetId === "string"
        ? body.targetId
        : "";

  if (!targetType || !targetId) {
    return c.json({ error: "target_type and target_id are required" }, 400);
  }
  if (!(LEASE_TARGET_TYPES as readonly string[]).includes(targetType)) {
    return c.json(
      {
        error: `target_type must be one of ${LEASE_TARGET_TYPES.join(", ")}`,
      },
      400
    );
  }

  const rawDur =
    typeof body.duration_ms === "number"
      ? body.duration_ms
      : typeof body.durationMs === "number"
        ? body.durationMs
        : DEFAULT_LEASE_DURATION_MS;
  const durationMs = Math.max(
    1000,
    Math.min(60 * 60 * 1000, Math.floor(rawDur))
  );

  const lease = await acquireLease(agent.id, targetType, targetId, durationMs);
  if (!lease) {
    return c.json(
      {
        error: "Lease unavailable — another agent holds it",
        target_type: targetType,
        target_id: targetId,
      },
      409
    );
  }

  return c.json(
    {
      lease: {
        id: lease.id,
        target_type: lease.targetType,
        target_id: lease.targetId,
        acquired_at: lease.acquiredAt,
        expires_at: lease.expiresAt,
        status: lease.status,
      },
    },
    201
  );
});

agents.delete("/leases/:id", requireAgentAuth, async (c) => {
  const agent = c.get("agent")!;
  const id = c.req.param("id");
  // Only let the holder release the lease.
  try {
    const [row] = await db
      .select()
      .from(agentLeases)
      .where(eq(agentLeases.id, id))
      .limit(1);
    if (!row || row.agentSessionId !== agent.id) {
      return c.json({ error: "Not found" }, 404);
    }
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  const ok = await releaseLease(id);
  if (!ok) return c.json({ error: "Lease was not active" }, 409);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

agents.get("/usage", async (c) => {
  // Two modes:
  //   - Agent-authed call: return that agent's usage only.
  //   - User-authed call: return all of the user's agents.
  const agent = c.get("agent");
  if (agent) {
    const usage = await getAgentUsage(agent.id);
    return c.json({
      agent_id: agent.id,
      name: agent.name,
      branch_namespace: agent.branchNamespace,
      spent_cents_today: usage.spent,
      budget_cents_per_day: usage.cap,
      remaining_cents: usage.remaining,
    });
  }

  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.ownerUserId, user.id));
  return c.json({
    sessions: rows.map((r) => ({
      id: r.id,
      name: r.name,
      branch_namespace: r.branchNamespace,
      spent_cents_today: r.spentCentsToday,
      budget_cents_per_day: r.budgetCentsPerDay,
      remaining_cents: Math.max(0, r.budgetCentsPerDay - r.spentCentsToday),
    })),
  });
});

export default agents;

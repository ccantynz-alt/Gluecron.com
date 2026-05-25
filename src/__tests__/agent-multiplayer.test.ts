/**
 * Agent multiplayer v1 — sessions, leases, budgets, branch namespacing.
 *
 * Two layers:
 *   - Pure helpers (token shape, namespace normalisation, ref membership)
 *     run unconditionally — no DB required.
 *   - DB-backed flows (create session, acquire/conflict lease, budget
 *     exhaustion, PATCH ref namespace guard) are gated behind `HAS_DB`
 *     so the suite stays green on machines without Postgres.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import { randomBytes } from "crypto";
import app from "../app";
import { clearRateLimitStore } from "../middleware/rate-limit";
import { initBareRepo, getRepoPath, resolveRef } from "../git/repository";
import {
  AGENT_TOKEN_PREFIX,
  generateAgentToken,
  hashAgentToken,
  isAgentToken,
  normaliseBranchNamespace,
  refIsInNamespace,
} from "../lib/agent-multiplayer";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-agent-multiplayer-" + Date.now()
);

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  clearRateLimitStore();
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  await proc.exited;
}

async function seedBareRepoWithCommit(
  owner: string,
  name: string,
  branch: string = "main"
) {
  await initBareRepo(owner, name);
  const bare = getRepoPath(owner, name);
  const work = join(TEST_REPOS, "_work_" + randomBytes(4).toString("hex"));
  await mkdir(work, { recursive: true });
  await run(["git", "clone", bare, work], TEST_REPOS);
  await run(["git", "config", "user.email", "test@gluecron.com"], work);
  await run(["git", "config", "user.name", "Test User"], work);
  await run(["git", "checkout", "-B", branch], work);
  await Bun.write(join(work, "README.md"), "# hi\n");
  await run(["git", "add", "-A"], work);
  await run(["git", "commit", "-m", "seed"], work);
  await run(["git", "push", "-u", "origin", branch], work);
  await rm(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB)
// ---------------------------------------------------------------------------

describe("agent-multiplayer — pure helpers", () => {
  it("generates a 32-byte hex token with the agt_ prefix", () => {
    const t = generateAgentToken();
    expect(t.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(t.length).toBe(AGENT_TOKEN_PREFIX.length + 64);
    expect(/^agt_[0-9a-f]{64}$/.test(t)).toBe(true);
  });

  it("generates unique tokens on repeated calls", () => {
    const a = generateAgentToken();
    const b = generateAgentToken();
    const c = generateAgentToken();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it("isAgentToken rejects non-agent and malformed tokens", () => {
    expect(isAgentToken(generateAgentToken())).toBe(true);
    expect(isAgentToken("glc_" + "a".repeat(64))).toBe(false);
    expect(isAgentToken("agt_too-short")).toBe(false);
    expect(isAgentToken("agt_" + "z".repeat(64))).toBe(false);
    expect(isAgentToken("")).toBe(false);
  });

  it("hashAgentToken is a deterministic 64-char hex digest", async () => {
    const t = generateAgentToken();
    const h1 = await hashAgentToken(t);
    const h2 = await hashAgentToken(t);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(h1)).toBe(true);
    expect(h1).not.toBe(t);
  });

  it("normaliseBranchNamespace defaults to agents/<name>/", () => {
    expect(normaliseBranchNamespace("claude-1")).toBe("agents/claude-1/");
    expect(normaliseBranchNamespace("claude-1", "")).toBe("agents/claude-1/");
    expect(normaliseBranchNamespace("claude-1", "agents/foo")).toBe("agents/foo/");
    expect(normaliseBranchNamespace("claude-1", "agents/foo/")).toBe(
      "agents/foo/"
    );
    expect(normaliseBranchNamespace("claude-1", "refs/heads/agents/bar")).toBe(
      "agents/bar/"
    );
    expect(normaliseBranchNamespace("claude-1", "/agents/zap/")).toBe(
      "agents/zap/"
    );
  });

  it("refIsInNamespace handles short and fully-qualified refs", () => {
    expect(refIsInNamespace("agents/claude-1/feat", "agents/claude-1/")).toBe(
      true
    );
    expect(
      refIsInNamespace("refs/heads/agents/claude-1/feat", "agents/claude-1/")
    ).toBe(true);
    expect(refIsInNamespace("main", "agents/claude-1/")).toBe(false);
    expect(
      refIsInNamespace("agents/other/x", "agents/claude-1/")
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP shape — no DB required
// ---------------------------------------------------------------------------

describe("agent-multiplayer — HTTP auth", () => {
  it("POST /api/v2/agents/sessions without auth returns 401", async () => {
    const res = await app.request("/api/v2/agents/sessions", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "claude-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/v2/agents/leases without agent auth returns 401", async () => {
    const res = await app.request("/api/v2/agents/leases", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ target_type: "issue", target_id: "42" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/v2/agents/leases with a bogus agt_ token returns 401", async () => {
    const res = await app.request("/api/v2/agents/leases", {
      method: "POST",
      headers: jsonHeaders(bearer("agt_" + "0".repeat(64))),
      body: JSON.stringify({ target_type: "issue", target_id: "42" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/v2/agents/usage without any auth returns 401", async () => {
    const res = await app.request("/api/v2/agents/usage");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DB-backed lib behaviour
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("agent-multiplayer — DB-backed flows", () => {
  it("createAgentSession + authenticateAgent round-trip", async () => {
    const { db } = await import("../db");
    const { users } = await import("../db/schema");
    const { createAgentSession, authenticateAgent } = await import(
      "../lib/agent-multiplayer"
    );

    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `agentowner-${stamp}`,
        email: `agentowner-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    expect(u).toBeDefined();
    if (!u) return;

    const created = await createAgentSession({
      ownerUserId: u.id,
      name: `claude-${stamp}`,
      budgetCentsPerDay: 1000,
    });
    expect(created).not.toBeNull();
    if (!created) return;
    expect(created.token.startsWith("agt_")).toBe(true);
    expect(created.session.branchNamespace).toBe(`agents/claude-${stamp}/`);
    expect(created.session.budgetCentsPerDay).toBe(1000);

    const looked = await authenticateAgent(created.token);
    expect(looked).not.toBeNull();
    expect(looked?.id).toBe(created.session.id);

    const bad = await authenticateAgent("agt_" + "0".repeat(64));
    expect(bad).toBeNull();
  });

  it("acquireLease — happy path returns an active lease", async () => {
    const { db } = await import("../db");
    const { users } = await import("../db/schema");
    const { createAgentSession, acquireLease, releaseLease } = await import(
      "../lib/agent-multiplayer"
    );

    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `leaseuser-${stamp}`,
        email: `leaseuser-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    const a1 = await createAgentSession({
      ownerUserId: u.id,
      name: `agent-a-${stamp}`,
    });
    if (!a1) return;

    const lease = await acquireLease(a1.session.id, "issue", `iss-${stamp}`);
    expect(lease).not.toBeNull();
    expect(lease?.status).toBe("active");
    expect(lease?.targetType).toBe("issue");

    // Clean up so the test is idempotent.
    if (lease) await releaseLease(lease.id);
  });

  it("acquireLease — conflict: second agent on same target fails", async () => {
    const { db } = await import("../db");
    const { users } = await import("../db/schema");
    const { createAgentSession, acquireLease, releaseLease } = await import(
      "../lib/agent-multiplayer"
    );

    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `conflictuser-${stamp}`,
        email: `conflictuser-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    const a1 = await createAgentSession({
      ownerUserId: u.id,
      name: `agent-a-${stamp}`,
    });
    const a2 = await createAgentSession({
      ownerUserId: u.id,
      name: `agent-b-${stamp}`,
    });
    if (!a1 || !a2) return;

    const target = `pr-${stamp}`;
    const first = await acquireLease(a1.session.id, "pr", target);
    expect(first).not.toBeNull();

    const second = await acquireLease(a2.session.id, "pr", target);
    expect(second).toBeNull();

    // Release the first; the second agent should now be able to grab it.
    if (first) {
      const released = await releaseLease(first.id);
      expect(released).toBe(true);
    }

    const third = await acquireLease(a2.session.id, "pr", target);
    expect(third).not.toBeNull();
    if (third) await releaseLease(third.id);
  });

  it("chargeAgent — budget exhaustion blocks the next charge", async () => {
    const { db } = await import("../db");
    const { users, agentSessions } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const { createAgentSession, chargeAgent, getAgentUsage } = await import(
      "../lib/agent-multiplayer"
    );

    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `budgetuser-${stamp}`,
        email: `budgetuser-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    const created = await createAgentSession({
      ownerUserId: u.id,
      name: `agent-bg-${stamp}`,
      budgetCentsPerDay: 100,
    });
    if (!created) return;
    const sid = created.session.id;

    expect(await chargeAgent(sid, 40)).toBe(true);
    expect(await chargeAgent(sid, 50)).toBe(true);
    // 90 spent, 10 remaining — a 20-cent charge must fail.
    expect(await chargeAgent(sid, 20)).toBe(false);
    // A 10-cent charge fits exactly.
    expect(await chargeAgent(sid, 10)).toBe(true);
    // Now full — any further charge is denied.
    expect(await chargeAgent(sid, 1)).toBe(false);

    const usage = await getAgentUsage(sid);
    expect(usage.spent).toBe(100);
    expect(usage.cap).toBe(100);
    expect(usage.remaining).toBe(0);

    // Clean-up: leave the row in place but drop the spent counter so a
    // re-run on a stale DB doesn't accumulate.
    await db
      .update(agentSessions)
      .set({ spentCentsToday: 0 })
      .where(eq(agentSessions.id, sid));
  });

  it("resetDailyBudgets clears spent_cents_today", async () => {
    const { db } = await import("../db");
    const { users, agentSessions } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const {
      createAgentSession,
      chargeAgent,
      resetDailyBudgets,
      getAgentUsage,
    } = await import("../lib/agent-multiplayer");

    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `resetuser-${stamp}`,
        email: `resetuser-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    const created = await createAgentSession({
      ownerUserId: u.id,
      name: `agent-reset-${stamp}`,
      budgetCentsPerDay: 200,
    });
    if (!created) return;

    expect(await chargeAgent(created.session.id, 150)).toBe(true);
    let usage = await getAgentUsage(created.session.id);
    expect(usage.spent).toBe(150);

    const count = await resetDailyBudgets();
    expect(count).toBeGreaterThan(0);
    usage = await getAgentUsage(created.session.id);
    expect(usage.spent).toBe(0);
    expect(usage.remaining).toBe(200);

    await db
      .delete(agentSessions)
      .where(eq(agentSessions.id, created.session.id));
  });

  // -----------------------------------------------------------------------
  // Branch-namespace enforcement on PATCH /git/refs/heads/:branch
  // -----------------------------------------------------------------------
  it("PATCH /git/refs/heads/:branch rejects refs outside the agent's namespace", async () => {
    const { db } = await import("../db");
    const { users, repositories } = await import("../db/schema");
    const { createAgentSession } = await import("../lib/agent-multiplayer");

    const stamp = randomBytes(4).toString("hex");
    const username = `nsuser-${stamp}`;
    const reponame = `nsrepo-${stamp}`;

    const [u] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    await seedBareRepoWithCommit(username, reponame);

    const [r] = await db
      .insert(repositories)
      .values({
        name: reponame,
        ownerId: u.id,
        diskPath: getRepoPath(username, reponame),
        defaultBranch: "main",
      })
      .returning();
    if (!r) return;

    const agent = await createAgentSession({
      ownerUserId: u.id,
      name: `claude-${stamp}`,
      repositoryId: r.id,
    });
    if (!agent) return;
    // Sanity: the namespace is what we expect.
    expect(agent.session.branchNamespace).toBe(`agents/claude-${stamp}/`);

    const headSha = await resolveRef(username, reponame, "refs/heads/main");
    expect(headSha).not.toBeNull();
    if (!headSha) return;

    // 1. Update of `main` (outside the namespace) → 403.
    const denied = await app.request(
      `/api/v2/repos/${username}/${reponame}/git/refs/heads/main`,
      {
        method: "PATCH",
        headers: jsonHeaders(bearer(agent.token)),
        body: JSON.stringify({ sha: headSha, force: true }),
      }
    );
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as any;
    expect(deniedBody.namespace).toBe(`agents/claude-${stamp}/`);
  });
});

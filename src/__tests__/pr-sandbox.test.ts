/**
 * Tests for src/lib/pr-sandbox.ts — per-PR runnable sandboxes (migration 0067).
 *
 * Two layers:
 *
 *   1. Pure helpers — sandbox URL building, status label mapping,
 *      expires-in formatting. No DB, no network. Always run.
 *
 *   2. DB-backed pipeline — gated on HAS_DB so the suite stays green
 *      on machines without Postgres. Covers:
 *        - provisioning lifecycle (status transitions)
 *        - auto-expire after the TTL
 *        - idempotent re-provision on the same PR replaces the row
 *        - destroy flips status
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  buildSandboxUrl,
  destroySandbox,
  expireOldSandboxes,
  formatSandboxExpiresIn,
  getSandboxForPr,
  markSandboxFailed,
  markSandboxReady,
  provisionSandbox,
  sandboxStatusLabel,
  SANDBOX_TTL_MS,
} from "../lib/pr-sandbox";
import { db } from "../db";
import {
  prSandboxes,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { eq } from "drizzle-orm";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe("pr-sandbox — buildSandboxUrl", () => {
  it("produces a wildcard subdomain URL with default domain", () => {
    const prev = process.env.PR_SANDBOX_DOMAIN;
    delete process.env.PR_SANDBOX_DOMAIN;
    try {
      const url = buildSandboxUrl(42, "alice", "site");
      expect(url).toBe("https://pr-42-alice-site.sandbox.gluecron.com");
    } finally {
      if (prev !== undefined) process.env.PR_SANDBOX_DOMAIN = prev;
    }
  });

  it("honours a custom PR_SANDBOX_DOMAIN env var", () => {
    const prev = process.env.PR_SANDBOX_DOMAIN;
    process.env.PR_SANDBOX_DOMAIN = "sandbox.acme.dev";
    try {
      const url = buildSandboxUrl(1, "a", "b");
      expect(url).toBe("https://pr-1-a-b.sandbox.acme.dev");
    } finally {
      if (prev === undefined) delete process.env.PR_SANDBOX_DOMAIN;
      else process.env.PR_SANDBOX_DOMAIN = prev;
    }
  });

  it("strips scheme from PR_SANDBOX_DOMAIN if accidentally included", () => {
    const prev = process.env.PR_SANDBOX_DOMAIN;
    process.env.PR_SANDBOX_DOMAIN = "https://sandbox.foo.com";
    try {
      const url = buildSandboxUrl(7, "a", "b");
      expect(url).toBe("https://pr-7-a-b.sandbox.foo.com");
    } finally {
      if (prev === undefined) delete process.env.PR_SANDBOX_DOMAIN;
      else process.env.PR_SANDBOX_DOMAIN = prev;
    }
  });

  it("clamps negative / NaN PR numbers to 0", () => {
    expect(buildSandboxUrl(-3, "a", "b")).toContain("pr-0-");
    expect(buildSandboxUrl(NaN, "a", "b")).toContain("pr-0-");
  });

  it("slugifies owner/repo into one DNS label", () => {
    const url = buildSandboxUrl(2, "Big Org", "My_Repo");
    expect(url).toContain("pr-2-big-org-my-repo.");
  });
});

describe("pr-sandbox — sandboxStatusLabel", () => {
  it("maps known statuses to human labels", () => {
    expect(sandboxStatusLabel("provisioning")).toBe("Provisioning");
    expect(sandboxStatusLabel("ready")).toBe("Ready");
    expect(sandboxStatusLabel("failed")).toBe("Failed");
    expect(sandboxStatusLabel("destroyed")).toBe("Destroyed");
  });

  it("passes through unknown statuses unchanged", () => {
    expect(sandboxStatusLabel("unknown")).toBe("unknown");
  });
});

describe("pr-sandbox — formatSandboxExpiresIn", () => {
  it("returns 'expired' for past timestamps", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const past = new Date("2026-01-01T11:00:00Z");
    expect(formatSandboxExpiresIn(past, now)).toBe("expired");
  });

  it("returns 'less than a minute' for sub-minute futures", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const soon = new Date("2026-01-01T12:00:30Z");
    expect(formatSandboxExpiresIn(soon, now)).toBe("less than a minute");
  });

  it("returns just minutes when under an hour away", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const future = new Date("2026-01-01T12:42:00Z");
    expect(formatSandboxExpiresIn(future, now)).toBe("42m");
  });

  it("returns hours + minutes when over an hour away", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const future = new Date("2026-01-01T14:30:00Z");
    expect(formatSandboxExpiresIn(future, now)).toBe("2h 30m");
  });

  it("returns em-dash for null", () => {
    expect(formatSandboxExpiresIn(null)).toBe("—");
  });
});

describe("pr-sandbox — TTL constant matches 4h", () => {
  it("SANDBOX_TTL_MS is exactly 4 hours", () => {
    expect(SANDBOX_TTL_MS).toBe(4 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 2. Graceful no-ops without DB — must not throw on empty inputs
// ---------------------------------------------------------------------------

describe("pr-sandbox — graceful no-ops", () => {
  it("provisionSandbox returns null for empty PR id", async () => {
    expect(await provisionSandbox({ prId: "" })).toBeNull();
  });

  it("getSandboxForPr returns null for empty PR id", async () => {
    expect(await getSandboxForPr("")).toBeNull();
  });

  it("markSandboxReady / markSandboxFailed / destroySandbox swallow empty ids", async () => {
    await markSandboxReady("");
    await markSandboxFailed("", "err");
    await destroySandbox("");
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. DB-backed pipeline
// ---------------------------------------------------------------------------

const TEST_USER_PREFIX = "sandboxtest_";

async function seedPr(): Promise<{
  userId: string;
  repoId: string;
  prId: string;
  prNumber: number;
}> {
  const username =
    TEST_USER_PREFIX + Math.random().toString(36).slice(2, 10);
  const [user] = await db
    .insert(users)
    .values({
      username,
      email: `${username}@sandboxtest.local`,
      passwordHash: "$2b$10$" + "x".repeat(53),
    })
    .returning();
  const [repo] = await db
    .insert(repositories)
    .values({
      name: "sandbox-test-" + Math.random().toString(36).slice(2, 8),
      ownerId: user!.id,
      diskPath: "/tmp/sandbox-test-" + Math.random().toString(36).slice(2, 8),
    })
    .returning();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      repositoryId: repo!.id,
      authorId: user!.id,
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
      headBranch: "feature/x",
    })
    .returning();
  return {
    userId: user!.id,
    repoId: repo!.id,
    prId: pr!.id,
    prNumber: pr!.number,
  };
}

async function cleanupUser(userId: string): Promise<void> {
  try {
    // Repositories CASCADE PRs which CASCADE pr_sandboxes — single delete OK.
    await db.delete(repositories).where(eq(repositories.ownerId, userId));
    await db.delete(users).where(eq(users.id, userId));
  } catch {
    /* best effort */
  }
}

describe.skipIf(!HAS_DB)("pr-sandbox — DB pipeline", () => {
  let userId = "";

  afterEach(async () => {
    if (userId) await cleanupUser(userId);
    userId = "";
  });

  it("provisioning lifecycle: provisioning → ready", async () => {
    const seeded = await seedPr();
    userId = seeded.userId;

    const row = await provisionSandbox({
      prId: seeded.prId,
      // Skip the AI generator path in tests.
      playgroundYml: "runtime: docker\nimage: node:20-alpine\n",
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("provisioning");
    expect(row!.sandboxUrl).toContain(`pr-${seeded.prNumber}-`);
    expect(row!.sandboxUrl.startsWith("https://")).toBe(true);
    expect(row!.expiresAt instanceof Date).toBe(true);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row!.playgroundYml).toContain("docker");

    await markSandboxReady(row!.id, "ctr-abc123");
    const ready = await getSandboxForPr(seeded.prId);
    expect(ready!.status).toBe("ready");
    expect(ready!.containerId).toBe("ctr-abc123");
  });

  it("provisioning lifecycle: provisioning → failed records error", async () => {
    const seeded = await seedPr();
    userId = seeded.userId;

    const row = await provisionSandbox({
      prId: seeded.prId,
      playgroundYml: "runtime: docker\n",
    });
    expect(row).not.toBeNull();

    const longError = "boom\n".repeat(10_000);
    await markSandboxFailed(row!.id, longError);
    const after = await getSandboxForPr(seeded.prId);
    expect(after!.status).toBe("failed");
    expect(after!.errorMessage).not.toBeNull();
    expect(after!.errorMessage!.length).toBeLessThanOrEqual(2_000);
  });

  it("idempotent: re-provisioning on same PR replaces the row", async () => {
    const seeded = await seedPr();
    userId = seeded.userId;

    const first = await provisionSandbox({
      prId: seeded.prId,
      playgroundYml: "runtime: docker # v1\n",
    });
    expect(first).not.toBeNull();

    // Flip to ready so we can verify the upsert resets it.
    await markSandboxReady(first!.id);
    let row = await getSandboxForPr(seeded.prId);
    expect(row!.status).toBe("ready");

    // Re-provision (force-push scenario).
    const second = await provisionSandbox({
      prId: seeded.prId,
      playgroundYml: "runtime: docker # v2\n",
    });
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id); // same row
    expect(second!.status).toBe("provisioning"); // reset
    expect(second!.playgroundYml).toContain("v2");
    expect(second!.errorMessage).toBeNull();
    expect(second!.destroyedAt).toBeNull();

    // And only ONE row exists per PR (unique constraint).
    const all = await db
      .select()
      .from(prSandboxes)
      .where(eq(prSandboxes.prId, seeded.prId));
    expect(all.length).toBe(1);
  });

  it("destroySandbox flips status + records destroyed_at", async () => {
    const seeded = await seedPr();
    userId = seeded.userId;

    const row = await provisionSandbox({
      prId: seeded.prId,
      playgroundYml: "runtime: docker\n",
    });
    await markSandboxReady(row!.id);

    await destroySandbox(row!.id);
    const after = await getSandboxForPr(seeded.prId);
    expect(after!.status).toBe("destroyed");
    expect(after!.destroyedAt).not.toBeNull();
  });

  it("expireOldSandboxes transitions ready rows past expires_at to 'destroyed'", async () => {
    const seeded = await seedPr();
    userId = seeded.userId;

    const row = await provisionSandbox({
      prId: seeded.prId,
      playgroundYml: "runtime: docker\n",
    });
    await markSandboxReady(row!.id);

    // Force expires_at into the past.
    await db
      .update(prSandboxes)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(prSandboxes.id, row!.id));

    const flipped = await expireOldSandboxes();
    expect(flipped).toBeGreaterThanOrEqual(1);

    const after = await getSandboxForPr(seeded.prId);
    expect(after!.status).toBe("destroyed");
    expect(after!.destroyedAt).not.toBeNull();
  });

  it("expireOldSandboxes leaves fresh rows alone", async () => {
    const seeded = await seedPr();
    userId = seeded.userId;

    const row = await provisionSandbox({
      prId: seeded.prId,
      playgroundYml: "runtime: docker\n",
    });
    await markSandboxReady(row!.id);

    // Default expiresAt is now+4h → expire pass should ignore it.
    await expireOldSandboxes();
    const after = await getSandboxForPr(seeded.prId);
    expect(after!.status).toBe("ready");
  });

  it("expireOldSandboxes also sweeps stuck 'provisioning' rows", async () => {
    const seeded = await seedPr();
    userId = seeded.userId;

    const row = await provisionSandbox({
      prId: seeded.prId,
      playgroundYml: "runtime: docker\n",
    });
    // Leave status='provisioning' but force expires_at into the past.
    await db
      .update(prSandboxes)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(prSandboxes.id, row!.id));

    const flipped = await expireOldSandboxes();
    expect(flipped).toBeGreaterThanOrEqual(1);

    const after = await getSandboxForPr(seeded.prId);
    expect(after!.status).toBe("destroyed");
  });
});

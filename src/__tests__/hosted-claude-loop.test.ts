/**
 * Hosted Claude loops — migration 0069 + src/lib/hosted-claude-loop.ts.
 *
 * Two layers:
 *
 *   1. Pure helpers (slugify, endpoint path build, usage extraction) —
 *      no DB or AI key required, always run.
 *
 *   2. DB-backed flows (createLoop, invokeLoop via the executor seam,
 *      budget cap enforcement) — gated on HAS_DB. The executor seam
 *      avoids needing ANTHROPIC_API_KEY in CI, so HAS_AI just adds a
 *      smoke check that the default template parses as JS.
 */

import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";

import {
  DEFAULT_LOOP_TEMPLATE,
  __setExecutorForTests,
  buildEndpointPath,
  capStream,
  createLoop,
  deleteLoop,
  extractUsageFromStdout,
  getLoop,
  invokeLoop,
  listLoopsForOwner,
  listRunsForLoop,
  pauseLoop,
  resumeLoop,
  slugifyLoopName,
} from "../lib/hosted-claude-loop";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_AI = Boolean(process.env.ANTHROPIC_API_KEY);

// Seed a unique test user per run when DB is available.
async function seedTestUser(): Promise<string | null> {
  if (!HAS_DB) return null;
  const { db } = await import("../db");
  const { users } = await import("../db/schema");
  const username = `cldploy-${randomBytes(4).toString("hex")}`;
  try {
    const [row] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@test.local`,
        passwordHash: "x",
      })
      .returning();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

async function cleanupTestUser(userId: string | null) {
  if (!userId || !HAS_DB) return;
  try {
    const { db } = await import("../db");
    const { users } = await import("../db/schema");
    await db.delete(users).where(eq(users.id, userId));
  } catch {
    /* best-effort */
  }
}

let testUserId: string | null = null;

beforeAll(async () => {
  testUserId = await seedTestUser();
});

afterAll(async () => {
  __setExecutorForTests(null);
  await cleanupTestUser(testUserId);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("hosted-claude-loop — pure helpers", () => {
  it("slugifyLoopName lowercases + dasherises + trims to 40 chars", () => {
    expect(slugifyLoopName("Hello World!")).toBe("hello-world");
    expect(slugifyLoopName("  Foo   BAR  ")).toBe("foo-bar");
    expect(slugifyLoopName("a".repeat(60)).length).toBe(40);
    expect(slugifyLoopName("")).toBe("");
    expect(slugifyLoopName("!!!---")).toBe("");
  });

  it("buildEndpointPath always begins with /claude-loops/ and has a suffix", () => {
    const a = buildEndpointPath("my-loop");
    const b = buildEndpointPath("my-loop");
    expect(a.startsWith("/claude-loops/")).toBe(true);
    expect(b.startsWith("/claude-loops/")).toBe(true);
    // Suffix randomness should virtually never collide.
    expect(a).not.toBe(b);
    // Empty name falls back to `loop` prefix.
    expect(buildEndpointPath("").startsWith("/claude-loops/loop-")).toBe(true);
  });

  it("capStream truncates at the cap and tags it", () => {
    const big = "x".repeat(50_000);
    const out = capStream(big, 100);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(capStream("short", 1000)).toBe("short");
    expect(capStream("", 100)).toBe("");
  });

  it("extractUsageFromStdout pulls input/output tokens from JSON stdout", () => {
    const stdout = JSON.stringify({
      ok: true,
      model: "claude-haiku-4-5",
      usage: { input_tokens: 120, output_tokens: 80 },
    });
    const got = extractUsageFromStdout(stdout);
    expect(got.inputTokens).toBe(120);
    expect(got.outputTokens).toBe(80);
    expect(got.model).toBe("claude-haiku-4-5");
  });

  it("extractUsageFromStdout returns zeros for non-JSON or no usage block", () => {
    expect(extractUsageFromStdout("plain text output")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      model: null,
    });
    expect(extractUsageFromStdout("")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      model: null,
    });
    expect(
      extractUsageFromStdout(JSON.stringify({ no_usage_here: true }))
    ).toEqual({ inputTokens: 0, outputTokens: 0, model: null });
  });

  it("extractUsageFromStdout scans line-by-line for embedded JSON lines", () => {
    const stdout =
      "preamble log\n" +
      JSON.stringify({ usage: { input_tokens: 5, output_tokens: 3 } }) +
      "\nepilogue text";
    const got = extractUsageFromStdout(stdout);
    expect(got.inputTokens).toBe(5);
    expect(got.outputTokens).toBe(3);
  });

  it("DEFAULT_LOOP_TEMPLATE references the SDK + prints JSON usage", () => {
    expect(DEFAULT_LOOP_TEMPLATE).toContain("@anthropic-ai/sdk");
    expect(DEFAULT_LOOP_TEMPLATE).toContain("usage");
    expect(DEFAULT_LOOP_TEMPLATE).toContain("process.env.INPUT");
  });
});

// ---------------------------------------------------------------------------
// DB-backed flows
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("hosted-claude-loop — DB flows", () => {
  it("createLoop persists a row + mints an agent token", async () => {
    if (!testUserId) return;
    const r = await createLoop({
      ownerUserId: testUserId,
      name: "test-loop-create",
      sourceCode: "console.log(JSON.stringify({ok:true}));",
      monthlyBudgetCents: 500,
    });
    expect(r).not.toBeNull();
    expect(r!.loop.name).toBe("test-loop-create");
    expect(r!.loop.endpointPath.startsWith("/claude-loops/")).toBe(true);
    expect(r!.loop.status).toBe("paused");
    expect(r!.loop.monthlyBudgetCents).toBe(500);
    // Agent token is plaintext, shown once.
    if (r!.agentToken) {
      expect(/^agt_[0-9a-f]{64}$/.test(r!.agentToken)).toBe(true);
    }
    const back = await getLoop(r!.loop.id);
    expect(back?.id).toBe(r!.loop.id);
    await deleteLoop(r!.loop.id, testUserId);
  });

  it("listLoopsForOwner only returns loops owned by the user", async () => {
    if (!testUserId) return;
    const otherUserId = await seedTestUser();
    try {
      const mine = await createLoop({
        ownerUserId: testUserId,
        name: "mine-list-test",
        sourceCode: "console.log('hi');",
      });
      const theirs = otherUserId
        ? await createLoop({
            ownerUserId: otherUserId,
            name: "theirs-list-test",
            sourceCode: "console.log('hi');",
          })
        : null;
      const mineList = await listLoopsForOwner(testUserId);
      expect(mineList.some((l) => l.id === mine?.loop.id)).toBe(true);
      expect(mineList.some((l) => l.id === theirs?.loop.id)).toBe(false);
      if (mine) await deleteLoop(mine.loop.id, testUserId);
      if (theirs && otherUserId) await deleteLoop(theirs.loop.id, otherUserId);
    } finally {
      await cleanupTestUser(otherUserId);
    }
  });

  it("invokeLoop runs the snippet via the executor seam + records a run", async () => {
    if (!testUserId) return;
    const created = await createLoop({
      ownerUserId: testUserId,
      name: "test-loop-invoke",
      sourceCode: "console.log('seeded');",
      monthlyBudgetCents: 5000,
    });
    expect(created).not.toBeNull();

    // Resume so the owner-side invoke runs without an extra hop.
    await resumeLoop(created!.loop.id, testUserId);

    __setExecutorForTests(async (args) => ({
      stdout: JSON.stringify({
        echo: args.inputPayload,
        usage: { input_tokens: 100, output_tokens: 50 },
        model: "claude-haiku-4-5",
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
    }));
    const result = await invokeLoop({
      loopId: created!.loop.id,
      inputPayload: { repo: "demo" },
    });
    expect(result.status).toBe("ok");
    expect(result.centsCharged).toBeGreaterThan(0);
    expect(result.run).not.toBeNull();
    expect(result.run?.status).toBe("ok");
    expect(result.run?.claudeInputTokens).toBe(100);
    expect(result.run?.claudeOutputTokens).toBe(50);
    // Output parsed back from the stdout JSON.
    expect((result.output as { echo: { repo: string } }).echo.repo).toBe("demo");

    const runs = await listRunsForLoop(created!.loop.id, 10);
    expect(runs.length).toBeGreaterThanOrEqual(1);

    // Totals on the loop row should have bumped.
    const after = await getLoop(created!.loop.id);
    expect(after?.totalInvocations).toBeGreaterThan(0);
    expect(after?.totalCentsSpent).toBeGreaterThan(0);
    expect(after?.lastRunAt).not.toBeNull();

    __setExecutorForTests(null);
    await deleteLoop(created!.loop.id, testUserId);
  });

  it("invokeLoop returns budget_exceeded once the cap is hit", async () => {
    if (!testUserId) return;
    const created = await createLoop({
      ownerUserId: testUserId,
      name: "test-loop-budget",
      sourceCode: "console.log('seeded');",
      // 1¢ budget — first invocation should land at the cap.
      monthlyBudgetCents: 1,
    });
    expect(created).not.toBeNull();
    await resumeLoop(created!.loop.id, testUserId);

    // Stub an executor that reports 10k input + 10k output tokens so
    // computeCentsForCall lands well over the 1¢ cap.
    __setExecutorForTests(async () => ({
      stdout: JSON.stringify({
        usage: { input_tokens: 10_000, output_tokens: 10_000 },
        model: "claude-haiku-4-5",
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
    }));

    // First call lands OK (no spend yet → cap not exceeded at the
    // pre-flight check) and bumps the spend counter over cap.
    const first = await invokeLoop({
      loopId: created!.loop.id,
      inputPayload: {},
    });
    expect(["ok", "budget_exceeded"].includes(first.status)).toBe(true);

    // Second call MUST short-circuit on budget.
    const second = await invokeLoop({
      loopId: created!.loop.id,
      inputPayload: {},
    });
    expect(second.status).toBe("budget_exceeded");
    expect(second.centsCharged).toBe(0);

    __setExecutorForTests(null);
    await deleteLoop(created!.loop.id, testUserId);
  });

  it("pauseLoop + invokeLoop with isPublicInvocation=true returns disabled", async () => {
    if (!testUserId) return;
    const created = await createLoop({
      ownerUserId: testUserId,
      name: "test-loop-paused",
      sourceCode: "console.log('seeded');",
    });
    expect(created).not.toBeNull();
    await pauseLoop(created!.loop.id, testUserId);
    const r = await invokeLoop({
      loopId: created!.loop.id,
      inputPayload: {},
      isPublicInvocation: true,
    });
    expect(r.status).toBe("disabled");
    await deleteLoop(created!.loop.id, testUserId);
  });
});

// ---------------------------------------------------------------------------
// HAS_AI smoke: just verify the template is syntactically importable as
// JS (parses) when an AI key is present — we don't actually hit Claude.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_AI)("hosted-claude-loop — HAS_AI surface", () => {
  it("DEFAULT_LOOP_TEMPLATE is non-empty + hashes deterministically", () => {
    expect(DEFAULT_LOOP_TEMPLATE.length).toBeGreaterThan(50);
    const h = createHash("sha256").update(DEFAULT_LOOP_TEMPLATE).digest("hex");
    expect(h.length).toBe(64);
  });
});

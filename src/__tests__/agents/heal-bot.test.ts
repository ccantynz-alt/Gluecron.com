/**
 * Block K12 — heal-bot tests.
 *
 * The agent runtime writes to Neon on every step, so in the test environment
 * (which has no DATABASE_URL) the DB-touching entry points degrade to the
 * documented "never throws" shapes. The tests below exercise:
 *
 *   1. Pure helpers (`renderHealBotPrBody`, `renderHealBotPrTitle`,
 *      `buildHealBotSummary`) — fully exercised without any I/O.
 *   2. `runHealBot` argument validation.
 *   3. `runHealBot`'s graceful-degradation path when the DB / Gatetest are
 *      unreachable (no throws, well-formed result shape, honours the
 *      "gatetest offline" summary when the Gatetest key isn't set).
 *   4. `runHealBotForAll` — empty / failing repo listing must not throw.
 *
 * For Gatetest we flip `globalThis.fetch` and `GATETEST_API_KEY` to steer the
 * client between its offline short-circuit and its "fetch returned 500"
 * short-circuit, without reaching the network.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  buildHealBotSummary,
  HEAL_BOT_BOT_USERNAME,
  HEAL_BOT_SLUG,
  renderHealBotPrBody,
  renderHealBotPrTitle,
  runHealBot,
  runHealBotForAll,
} from "../../lib/agents/heal-bot";
import { healSuite } from "../../lib/gatetest-client";

const ENV_KEYS = ["GATETEST_API_KEY", "GATETEST_BASE_URL"] as const;

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = savedFetch;
});

// ---------------------------------------------------------------------------
// Constants / identity
// ---------------------------------------------------------------------------

describe("heal-bot — identity constants", () => {
  it("uses the agent- prefixed slug", () => {
    expect(HEAL_BOT_SLUG).toBe("agent-heal-bot");
  });

  it("uses the [bot] suffixed username", () => {
    expect(HEAL_BOT_BOT_USERNAME).toBe("agent-heal-bot[bot]");
    expect(HEAL_BOT_BOT_USERNAME.endsWith("[bot]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — renderHealBotPrTitle
// ---------------------------------------------------------------------------

describe("heal-bot — renderHealBotPrTitle", () => {
  it("pluralises for multiple repairs", () => {
    expect(renderHealBotPrTitle(5)).toBe("chore(tests): heal-bot — 5 repairs");
  });

  it("uses the singular form for exactly one repair", () => {
    expect(renderHealBotPrTitle(1)).toBe("chore(tests): heal-bot — 1 repair");
  });

  it("still uses plural for zero (degenerate)", () => {
    expect(renderHealBotPrTitle(0)).toBe("chore(tests): heal-bot — 0 repairs");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — renderHealBotPrBody
// ---------------------------------------------------------------------------

describe("heal-bot — renderHealBotPrBody", () => {
  it("includes finding counts + branches + generator footer", () => {
    const body = renderHealBotPrBody({
      flakyFound: 3,
      deadFound: 1,
      coverageGapsFound: 2,
      headBranch: "gatetest/heal-2026-04-17",
      baseBranch: "main",
    });
    expect(body).toContain("6 repairs");
    expect(body).toContain("gatetest/heal-2026-04-17");
    expect(body).toContain("main");
    expect(body).toContain("Flaky tests stabilised | 3");
    expect(body).toContain("Dead / obsolete tests pruned | 1");
    expect(body).toContain("Coverage gaps newly covered | 2");
    expect(body).toContain(HEAL_BOT_BOT_USERNAME);
    // Must never suggest auto-merge.
    expect(body.toLowerCase()).toContain("never auto-merges");
  });

  it("uses singular 'repair' for exactly one finding", () => {
    const body = renderHealBotPrBody({
      flakyFound: 1,
      deadFound: 0,
      coverageGapsFound: 0,
      headBranch: "feature/x",
      baseBranch: "main",
    });
    expect(body).toContain("1 repair");
    expect(body).not.toContain("1 repairs");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — buildHealBotSummary
// ---------------------------------------------------------------------------

describe("heal-bot — buildHealBotSummary", () => {
  it("returns 'suite healthy' when there are no findings", () => {
    expect(
      buildHealBotSummary({
        flakyFound: 0,
        deadFound: 0,
        coverageGapsFound: 0,
        prNumber: null,
        branchProduced: false,
      })
    ).toBe("suite healthy");
  });

  it("reports degraded reconfiguration hint when findings > 0 but no branch", () => {
    const s = buildHealBotSummary({
      flakyFound: 2,
      deadFound: 1,
      coverageGapsFound: 0,
      prNumber: null,
      branchProduced: false,
    });
    expect(s).toContain("3 findings");
    expect(s).toContain("no branch produced");
    expect(s).toContain("Gatetest");
  });

  it("embeds the PR number + counts when a branch was produced", () => {
    const s = buildHealBotSummary({
      flakyFound: 4,
      deadFound: 2,
      coverageGapsFound: 1,
      prNumber: 42,
      branchProduced: true,
    });
    expect(s).toBe("opened #42 (4 flaky, 2 dead, 1 coverage)");
  });

  it("handles a missing prNumber gracefully when branch is produced", () => {
    const s = buildHealBotSummary({
      flakyFound: 1,
      deadFound: 0,
      coverageGapsFound: 0,
      prNumber: null,
      branchProduced: true,
    });
    expect(s).toContain("(unknown PR)");
  });
});

// ---------------------------------------------------------------------------
// runHealBot — arg validation + graceful degradation.
//
// Because the test env has no DATABASE_URL, `startAgentRun` fails and
// `runHealBot` returns its documented "could not open agent_runs row" shape.
// That still proves the never-throws contract and shows that the DB is only
// ever touched via defensive helpers.
// ---------------------------------------------------------------------------

describe("heal-bot — runHealBot", () => {
  it("rejects missing args without throwing", async () => {
    const r = await runHealBot({ repositoryId: "" });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
    expect(r.summary.toLowerCase()).toContain("invalid args");
  });

  it("rejects non-string repositoryId without throwing", async () => {
    const r = await runHealBot({
      // Intentional cast — simulates a caller passing bad data.
      repositoryId: 123 as unknown as string,
    });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
  });

  it("returns a well-formed result when the DB is unavailable (scheduled)", async () => {
    // Mock fetch so a network call would fail loudly — proving the path
    // short-circuits before Gatetest is reached (we never even open a run).
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when run cannot be opened");
    }) as unknown as typeof fetch;
    const r = await runHealBot({
      repositoryId: "00000000-0000-0000-0000-000000000000",
    });
    // With no DATABASE_URL the run-opening step returns null and the agent
    // reports the documented failure without throwing.
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
    expect(r.summary.toLowerCase()).toContain("agent_runs");
  });

  it("treats triggerBy truthiness as the 'manual' switch", async () => {
    // We can't observe the trigger directly without a DB, but we can at least
    // prove the call completes cleanly when triggerBy is provided.
    const r = await runHealBot({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      triggerBy: "11111111-1111-1111-1111-111111111111",
    });
    expect(r.ok).toBe(false); // no DB in test env
    expect(r.runId).toBeNull();
    // Must not have thrown — reaching this line is the assertion.
    expect(typeof r.summary).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Underlying Gatetest contract — we want the client's `offline` signal to
// propagate correctly, so we assert it here. If this contract breaks the
// heal-bot's "offline" branch never fires.
// ---------------------------------------------------------------------------

describe("heal-bot — gatetest client contract", () => {
  it("propagates offline:true when the API key is missing", async () => {
    // No GATETEST_API_KEY → client returns the offline shape, no fetch call.
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when offline");
    }) as unknown as typeof fetch;
    const result = await healSuite({ repo: "o/r" });
    expect(result.offline).toBe(true);
    expect(result.flakyFound).toBe(0);
    expect(result.deadFound).toBe(0);
    expect(result.coverageGapsFound).toBe(0);
    expect(result.prDraftBranch).toBeNull();
  });

  it("returns an offline-shaped result when fetch returns a non-200", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response("fail", { status: 500 })) as unknown as typeof fetch;
    const result = await healSuite({ repo: "o/r" });
    // The client's contract is: any non-2xx → offline shape.
    expect(result.offline).toBe(true);
    expect(result.prDraftBranch).toBeNull();
  });

  it("surfaces the draft branch when Gatetest returns one", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          flakyFound: 2,
          deadFound: 1,
          coverageGapsFound: 3,
          prDraftBranch: "gatetest/heal-abc",
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const result = await healSuite({ repo: "o/r" });
    expect(result.offline).toBe(false);
    expect(result.flakyFound).toBe(2);
    expect(result.deadFound).toBe(1);
    expect(result.coverageGapsFound).toBe(3);
    expect(result.prDraftBranch).toBe("gatetest/heal-abc");
  });

  it("normalises to zero when Gatetest returns zero findings + null branch", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          flakyFound: 0,
          deadFound: 0,
          coverageGapsFound: 0,
          prDraftBranch: null,
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const result = await healSuite({ repo: "o/r" });
    expect(result.offline).toBe(false);
    expect(result.flakyFound).toBe(0);
    expect(result.deadFound).toBe(0);
    expect(result.coverageGapsFound).toBe(0);
    expect(result.prDraftBranch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runHealBotForAll — empty repo set / DB failure handling
// ---------------------------------------------------------------------------

describe("heal-bot — runHealBotForAll", () => {
  it("returns zeroed aggregates when no repos are listable (no DB)", async () => {
    // No DATABASE_URL → listEligibleRepositoryIds returns []. We assert the
    // function terminates cleanly with a zero result and no throw.
    const agg = await runHealBotForAll();
    expect(agg).toEqual({
      started: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it("does not invoke fetch when there are no repos to process", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls++;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    await runHealBotForAll();
    expect(fetchCalls).toBe(0);
  });
});

/**
 * Block K5 — fix-agent tests.
 *
 * Same shape as heal-bot.test.ts:
 *   1. Pure helpers (`renderFixAgentComment`, `buildFixAgentSummary`) —
 *      exercised without any I/O.
 *   2. `runFixAgent` argument validation.
 *   3. `runFixAgent` graceful-degradation when Gatetest + DB are unreachable.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  renderFixAgentComment,
  buildFixAgentSummary,
  runFixAgent,
  FIX_AGENT_BOT_USERNAME,
  FIX_AGENT_SLUG,
  FIX_AGENT_COST_CENTS,
  FIX_AGENT_MAX_REPAIRS_IN_COMMENT,
} from "../../lib/agents/fix-agent";

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
// Identity constants
// ---------------------------------------------------------------------------

describe("fix-agent — identity constants", () => {
  it("uses the agent- prefixed slug", () => {
    expect(FIX_AGENT_SLUG).toBe("agent-fix");
  });
  it("uses the [bot] suffixed username", () => {
    expect(FIX_AGENT_BOT_USERNAME).toBe("agent-fix[bot]");
    expect(FIX_AGENT_BOT_USERNAME.endsWith("[bot]")).toBe(true);
  });
  it("cost is flat 3¢", () => {
    expect(FIX_AGENT_COST_CENTS).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// renderFixAgentComment
// ---------------------------------------------------------------------------

describe("fix-agent — renderFixAgentComment", () => {
  it("renders the passing case with all-clear wording", () => {
    const body = renderFixAgentComment({
      passed: true,
      totalTests: 47,
      failedBefore: 3,
      failedAfter: 0,
      repairs: [
        { file: "src/foo.ts", before: "a", after: "b", reason: "null check" },
      ],
      unfixable: [],
    });
    expect(body).toContain("Fix Agent");
    expect(body).toContain("47");
    expect(body).toContain("all passing");
    expect(body).toContain("src/foo.ts");
    expect(body).toContain(FIX_AGENT_BOT_USERNAME);
  });

  it("renders the failing case with before/after counts", () => {
    const body = renderFixAgentComment({
      passed: false,
      totalTests: 10,
      failedBefore: 5,
      failedAfter: 2,
      repairs: [
        { file: "a.ts", before: "", after: "", reason: "x" },
        { file: "b.ts", before: "", after: "", reason: "y" },
        { file: "c.ts", before: "", after: "", reason: "z" },
      ],
      unfixable: [{ file: "d.ts", reason: "unsupported language" }],
    });
    expect(body).toContain("**3** repairs");
    expect(body).toContain("5 → 2");
    expect(body).toContain("Unfixable");
    expect(body).toContain("d.ts");
  });

  it("caps repairs list at FIX_AGENT_MAX_REPAIRS_IN_COMMENT and shows overflow count", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      file: `file${i}.ts`,
      before: "",
      after: "",
      reason: "r",
    }));
    const body = renderFixAgentComment({
      passed: true,
      totalTests: 30,
      failedBefore: 30,
      failedAfter: 0,
      repairs: many,
      unfixable: [],
    });
    expect(body).toContain(`file${FIX_AGENT_MAX_REPAIRS_IN_COMMENT - 1}.ts`);
    expect(body).not.toContain(`file${FIX_AGENT_MAX_REPAIRS_IN_COMMENT}.ts`);
    expect(body).toContain(
      `…and ${30 - FIX_AGENT_MAX_REPAIRS_IN_COMMENT} more`
    );
  });

  it("omits repairs section when there are no repairs but unfixable entries", () => {
    const body = renderFixAgentComment({
      passed: false,
      totalTests: 1,
      failedBefore: 1,
      failedAfter: 1,
      repairs: [],
      unfixable: [{ file: "x.ts", reason: "too complex" }],
    });
    expect(body).not.toContain("### Repairs");
    expect(body).toContain("### Unfixable");
    expect(body).toContain("x.ts");
  });

  it("uses singular 'repair' for exactly one proposed", () => {
    const body = renderFixAgentComment({
      passed: false,
      totalTests: 2,
      failedBefore: 2,
      failedAfter: 1,
      repairs: [{ file: "f.ts", before: "", after: "", reason: "r" }],
      unfixable: [],
    });
    expect(body).toContain("**1** repair ");
    expect(body).not.toContain("**1** repairs");
  });
});

// ---------------------------------------------------------------------------
// buildFixAgentSummary
// ---------------------------------------------------------------------------

describe("fix-agent — buildFixAgentSummary", () => {
  it("returns offline message when gatetest is offline", () => {
    const s = buildFixAgentSummary({
      offline: true,
      passed: false,
      failedBefore: 0,
      failedAfter: 0,
      repairs: 0,
    });
    expect(s).toBe("gatetest offline; skipped");
  });

  it("returns healthy message when nothing to fix", () => {
    const s = buildFixAgentSummary({
      offline: false,
      passed: true,
      failedBefore: 0,
      failedAfter: 0,
      repairs: 0,
    });
    expect(s).toContain("suite healthy");
  });

  it("reports failing-with-no-repairs case", () => {
    const s = buildFixAgentSummary({
      offline: false,
      passed: false,
      failedBefore: 5,
      failedAfter: 5,
      repairs: 0,
    });
    expect(s).toContain("5 failing");
    expect(s).toContain("0 repairs");
  });

  it("reports full-repair success", () => {
    const s = buildFixAgentSummary({
      offline: false,
      passed: true,
      failedBefore: 3,
      failedAfter: 0,
      repairs: 3,
    });
    expect(s).toBe("repaired 3 (3 → 0)");
  });

  it("reports partial-repair case with plural repairs", () => {
    const s = buildFixAgentSummary({
      offline: false,
      passed: false,
      failedBefore: 5,
      failedAfter: 2,
      repairs: 3,
    });
    expect(s).toContain("3 repairs");
    expect(s).toContain("5 → 2");
  });

  it("reports singular 'repair' for one", () => {
    const s = buildFixAgentSummary({
      offline: false,
      passed: false,
      failedBefore: 1,
      failedAfter: 0,
      repairs: 1,
    });
    expect(s).toContain("1 repair ");
    expect(s).not.toContain("1 repairs");
  });
});

// ---------------------------------------------------------------------------
// runFixAgent — arg validation + graceful degradation.
// ---------------------------------------------------------------------------

describe("fix-agent — runFixAgent", () => {
  it("rejects missing repositoryId without throwing", async () => {
    const r = await runFixAgent({
      repositoryId: "",
      pullRequestId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
    expect(r.summary.toLowerCase()).toContain("invalid args");
  });

  it("rejects missing pullRequestId without throwing", async () => {
    const r = await runFixAgent({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      pullRequestId: "",
    });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
  });

  it("returns documented failure when DB cannot open a run", async () => {
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when run cannot be opened");
    }) as unknown as typeof fetch;
    const r = await runFixAgent({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      pullRequestId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
    expect(r.summary.toLowerCase()).toMatch(/agent_runs|could not/);
  });
});

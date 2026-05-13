/**
 * Block M3 — AI pre-merge risk score tests.
 *
 * Drives the pure helpers directly:
 *   - `computePrRiskScore` — six worked examples (one per band edge),
 *     caps, zero-floor, monotonicity.
 *   - `generatePrRiskSummary` — no-API-key fallback returns deterministic
 *     prose.
 *   - `computePrRiskForPullRequest` — null on non-existent PR (the DB
 *     surface is stubbed via the same K1-style spread-from-real pattern
 *     used in mcp-write.test.ts, so the test never touches Neon).
 *   - Cache hit path returns the same shape as cache miss.
 *
 * Mock policy: we spread the REAL modules first so non-overridden helpers
 * stay live, then narrow each mock to the smallest surface. Originals are
 * restored in `afterAll` so the mocks never bleed into sibling suites.
 */

import {
  describe,
  expect,
  it,
  mock,
  afterAll,
  beforeEach,
} from "bun:test";

import {
  computePrRiskScore,
  generatePrRiskSummary,
  buildSignalsFromDiff,
  isMajorBump,
  __test,
  type PrRiskSignals,
} from "../lib/pr-risk";

// ---------------------------------------------------------------------------
// computePrRiskScore — formula + bands
// ---------------------------------------------------------------------------

function zeroSignals(): PrRiskSignals {
  return {
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    teamsAffected: 0,
    schemaMigrationTouched: false,
    lockedPathTouched: false,
    addsNewDependency: false,
    bumpsMajorDependency: false,
    testsAddedForNewCode: false,
    diffMinusTestRatio: 0,
  };
}

describe("computePrRiskScore — six worked examples covering each band", () => {
  it("LOW (1/10): tiny doc-only PR with tests", () => {
    // 1 file × 0.3 = 0.3, 20 lines × 0.005 = 0.1, 1 team contributes 0,
    // tests added so the test-penalty is zero. Total ≈ 0.4 → rounds to 0
    // → band low.
    const { score, band } = computePrRiskScore({
      ...zeroSignals(),
      filesChanged: 1,
      linesAdded: 10,
      linesRemoved: 10,
      teamsAffected: 1,
      testsAddedForNewCode: true,
      diffMinusTestRatio: 0.0,
    });
    expect(band).toBe("low");
    expect(score).toBeLessThanOrEqual(2);
  });

  it("LOW (2/10): moderate feature with tests", () => {
    // 5 files × 0.3 = 1.5, 100 lines × 0.005 = 0.5, 1 team = 0, no other
    // signals. Total = 2.0 → score 2 → low.
    const { score, band } = computePrRiskScore({
      ...zeroSignals(),
      filesChanged: 5,
      linesAdded: 60,
      linesRemoved: 40,
      teamsAffected: 1,
      testsAddedForNewCode: true,
      diffMinusTestRatio: 0.0,
    });
    expect(score).toBe(2);
    expect(band).toBe("low");
  });

  it("MEDIUM (3/10): adds a new dep + cross-team but tested", () => {
    // 6 files × 0.3 = 1.8, 200 lines × 0.005 = 1.0, 2 teams = 0.8,
    // addsNewDependency = 0.5. Total = 4.1 → score 4 → medium.
    const { score, band } = computePrRiskScore({
      ...zeroSignals(),
      filesChanged: 6,
      linesAdded: 120,
      linesRemoved: 80,
      teamsAffected: 2,
      addsNewDependency: true,
      testsAddedForNewCode: true,
      diffMinusTestRatio: 0.0,
    });
    expect(band).toBe("medium");
    expect(score).toBeGreaterThanOrEqual(3);
    expect(score).toBeLessThanOrEqual(4);
  });

  it("HIGH (6/10): schema migration, no tests, multi-team", () => {
    // 8 files × 0.3 = 2.4, 300 lines × 0.005 = 1.5, 2 teams = 0.8,
    // schemaMigration = 1.5, no tests + ratio 1 = 1.0. Total = 7.2 → 7
    // → high.
    const { score, band } = computePrRiskScore({
      ...zeroSignals(),
      filesChanged: 8,
      linesAdded: 200,
      linesRemoved: 100,
      teamsAffected: 2,
      schemaMigrationTouched: true,
      testsAddedForNewCode: false,
      diffMinusTestRatio: 1.0,
    });
    expect(band).toBe("high");
    expect(score).toBeGreaterThanOrEqual(5);
    expect(score).toBeLessThanOrEqual(7);
  });

  it("HIGH (5/10): bumps major dependency without tests but no locked path", () => {
    // 5 files × 0.3 = 1.5, 100 lines × 0.005 = 0.5, 1 team = 0,
    // bumpsMajor = 1.2, no-tests + ratio 1 = 1.0. Total = 4.2 → score 4
    // → medium. Increase deps to get high.
    // Use slightly bigger PR: 8 files, 200 lines, 1 team, major bump,
    // no tests. 8 × 0.3 = 2.4, 200 × 0.005 = 1.0, major=1.2, no tests=1.0
    // Total = 5.6 → score 6 → high.
    const { score, band } = computePrRiskScore({
      ...zeroSignals(),
      filesChanged: 8,
      linesAdded: 120,
      linesRemoved: 80,
      teamsAffected: 1,
      bumpsMajorDependency: true,
      testsAddedForNewCode: false,
      diffMinusTestRatio: 1.0,
    });
    expect(band).toBe("high");
    expect(score).toBeGreaterThanOrEqual(5);
    expect(score).toBeLessThanOrEqual(7);
  });

  it("CRITICAL (9-10/10): touches schema, locked path, new dep, major bump, no tests, many teams", () => {
    const { score, band } = computePrRiskScore({
      filesChanged: 50,
      linesAdded: 2000,
      linesRemoved: 1000,
      teamsAffected: 5,
      schemaMigrationTouched: true,
      lockedPathTouched: true,
      addsNewDependency: true,
      bumpsMajorDependency: true,
      testsAddedForNewCode: false,
      diffMinusTestRatio: 1.0,
    });
    expect(band).toBe("critical");
    expect(score).toBeGreaterThanOrEqual(8);
  });
});

describe("computePrRiskScore — bounds", () => {
  it("clamps at 10 when every signal is extreme", () => {
    const { score, band } = computePrRiskScore({
      filesChanged: 10_000,
      linesAdded: 10_000_000,
      linesRemoved: 10_000_000,
      teamsAffected: 1000,
      schemaMigrationTouched: true,
      lockedPathTouched: true,
      addsNewDependency: true,
      bumpsMajorDependency: true,
      testsAddedForNewCode: false,
      diffMinusTestRatio: 1.0,
    });
    expect(score).toBe(10);
    expect(band).toBe("critical");
  });

  it("clamps at 0 when every signal is zero / negative", () => {
    const { score, band } = computePrRiskScore({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      teamsAffected: 0,
      schemaMigrationTouched: false,
      lockedPathTouched: false,
      addsNewDependency: false,
      bumpsMajorDependency: false,
      testsAddedForNewCode: true,
      diffMinusTestRatio: 0,
    });
    expect(score).toBe(0);
    expect(band).toBe("low");
  });

  it("treats negative inputs the same as zero (defensive)", () => {
    const { score } = computePrRiskScore({
      filesChanged: -5,
      linesAdded: -100,
      linesRemoved: -100,
      teamsAffected: -2,
      schemaMigrationTouched: false,
      lockedPathTouched: false,
      addsNewDependency: false,
      bumpsMajorDependency: false,
      testsAddedForNewCode: true,
      diffMinusTestRatio: -1,
    });
    expect(score).toBe(0);
  });
});

describe("computePrRiskScore — monotonicity", () => {
  it("flipping any signal from false→true never decreases the score", () => {
    const baseSignals: PrRiskSignals = {
      filesChanged: 5,
      linesAdded: 100,
      linesRemoved: 50,
      teamsAffected: 1,
      schemaMigrationTouched: false,
      lockedPathTouched: false,
      addsNewDependency: false,
      bumpsMajorDependency: false,
      testsAddedForNewCode: true,
      diffMinusTestRatio: 0.0,
    };
    const baseScore = computePrRiskScore(baseSignals).score;

    for (const key of [
      "schemaMigrationTouched",
      "lockedPathTouched",
      "addsNewDependency",
      "bumpsMajorDependency",
    ] as const) {
      const next = { ...baseSignals, [key]: true };
      const nextScore = computePrRiskScore(next).score;
      expect(nextScore).toBeGreaterThanOrEqual(baseScore);
    }

    // Removing testsAddedForNewCode + raising ratio can only raise the
    // score (never lower it).
    const noTests: PrRiskSignals = {
      ...baseSignals,
      testsAddedForNewCode: false,
      diffMinusTestRatio: 1.0,
    };
    expect(computePrRiskScore(noTests).score).toBeGreaterThanOrEqual(baseScore);

    // Increasing the integer signals can only raise the score.
    for (const key of ["filesChanged", "linesAdded", "linesRemoved", "teamsAffected"] as const) {
      const next = { ...baseSignals, [key]: baseSignals[key] + 50 };
      expect(computePrRiskScore(next).score).toBeGreaterThanOrEqual(baseScore);
    }
  });

  it("the score is the same on identical input (pure)", () => {
    const s: PrRiskSignals = {
      filesChanged: 4,
      linesAdded: 80,
      linesRemoved: 20,
      teamsAffected: 1,
      schemaMigrationTouched: false,
      lockedPathTouched: true,
      addsNewDependency: false,
      bumpsMajorDependency: false,
      testsAddedForNewCode: false,
      diffMinusTestRatio: 0.7,
    };
    expect(computePrRiskScore(s)).toEqual(computePrRiskScore(s));
  });
});

// ---------------------------------------------------------------------------
// buildSignalsFromDiff — path-classification helpers
// ---------------------------------------------------------------------------

describe("buildSignalsFromDiff", () => {
  it("flags schema migration paths and locked paths", () => {
    const signals = buildSignalsFromDiff({
      files: [
        { path: "drizzle/0099_my.sql", additions: 20, deletions: 0 },
        { path: "sensitive/api-key.pem", additions: 1, deletions: 0 },
      ],
      raw: "",
      ownerRules: [],
      baseDeps: new Map(),
      headDeps: new Map(),
    });
    expect(signals.schemaMigrationTouched).toBe(true);
    expect(signals.lockedPathTouched).toBe(true);
  });

  it("treats tests under __tests__/ as test files", () => {
    const signals = buildSignalsFromDiff({
      files: [
        { path: "src/foo.ts", additions: 50, deletions: 0 },
        { path: "src/__tests__/foo.test.ts", additions: 50, deletions: 0 },
      ],
      raw: "",
      ownerRules: [],
      baseDeps: new Map(),
      headDeps: new Map(),
    });
    expect(signals.testsAddedForNewCode).toBe(true);
    // Roughly half the diff is tests → ratio about 0.5.
    expect(signals.diffMinusTestRatio).toBeCloseTo(0.5, 1);
  });

  it("detects new dependencies and major bumps", () => {
    const base = new Map<string, string | null>([
      ["npm:react", "^17.0.0"],
      ["npm:hono", "^3.0.0"],
    ]);
    const head = new Map<string, string | null>([
      ["npm:react", "^18.0.0"], // major bump
      ["npm:hono", "^3.0.0"], // unchanged
      ["npm:zod", "^3.22.0"], // new
    ]);
    const signals = buildSignalsFromDiff({
      files: [{ path: "package.json", additions: 3, deletions: 1 }],
      raw: "",
      ownerRules: [],
      baseDeps: base,
      headDeps: head,
    });
    expect(signals.addsNewDependency).toBe(true);
    expect(signals.bumpsMajorDependency).toBe(true);
  });

  it("counts distinct CODEOWNERS owners as teamsAffected", () => {
    const signals = buildSignalsFromDiff({
      files: [
        { path: "src/api/foo.ts", additions: 5, deletions: 0 },
        { path: "src/web/bar.ts", additions: 5, deletions: 0 },
      ],
      raw: "",
      ownerRules: [
        { pattern: "src/api/**", owners: ["alice"] },
        { pattern: "src/web/**", owners: ["bob"] },
      ],
      baseDeps: new Map(),
      headDeps: new Map(),
    });
    expect(signals.teamsAffected).toBe(2);
  });
});

describe("isMajorBump", () => {
  it("returns true on a major version increase", () => {
    expect(isMajorBump("^1.0.0", "^2.0.0")).toBe(true);
    expect(isMajorBump("17.0.0", "18.0.0")).toBe(true);
    expect(isMajorBump("~1.2.3", "^2.0.0")).toBe(true);
  });
  it("returns false on minor / patch / no change", () => {
    expect(isMajorBump("^1.0.0", "^1.1.0")).toBe(false);
    expect(isMajorBump("^1.2.0", "^1.2.5")).toBe(false);
    expect(isMajorBump("^2.0.0", "^2.0.0")).toBe(false);
  });
  it("returns false on unparseable specs (defensive)", () => {
    expect(isMajorBump(null, "^1.0.0")).toBe(false);
    expect(isMajorBump("workspace:*", "^1.0.0")).toBe(false);
    expect(isMajorBump("^1.0.0", null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generatePrRiskSummary — fallback when no API key
// ---------------------------------------------------------------------------

describe("generatePrRiskSummary", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterAll(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("falls back to deterministic prose when no Anthropic key is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const text = await generatePrRiskSummary({
      signals: {
        ...zeroSignals(),
        filesChanged: 3,
        linesAdded: 50,
        linesRemoved: 10,
        teamsAffected: 1,
      },
      title: "Bump deps",
      baseBranch: "main",
      headBranch: "feature/x",
    });
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    // Deterministic fallback mentions the file count.
    expect(text).toContain("3 file");
  });

  it("deterministicSummary mentions schema migration + locked path", () => {
    const text = __test.deterministicSummary({
      ...zeroSignals(),
      filesChanged: 5,
      linesAdded: 100,
      linesRemoved: 30,
      teamsAffected: 2,
      schemaMigrationTouched: true,
      lockedPathTouched: true,
    });
    expect(text).toContain("schema migration");
    expect(text).toContain("locked");
  });
});

// ---------------------------------------------------------------------------
// computePrRiskForPullRequest — null when PR not found
// ---------------------------------------------------------------------------

// Stub `../db` with a chain that returns no PR row for a probe id. We use
// the same spread-from-real pattern as mcp-write.test.ts so the original
// surface stays live and other test files are not poisoned by mock.module().
const _real_db = await import("../db");

let _nextPrJoinRow: any = null;

const _selectChain: any = {
  from: () => _selectChain,
  innerJoin: () => _selectChain,
  leftJoin: () => _selectChain,
  rightJoin: () => _selectChain,
  where: () => _selectChain,
  orderBy: () => _selectChain,
  groupBy: () => _selectChain,
  limit: async () => (_nextPrJoinRow ? [_nextPrJoinRow] : []),
  then: (resolve: (v: any) => void) =>
    resolve(_nextPrJoinRow ? [_nextPrJoinRow] : []),
};

const _insertChain = () => ({
  values: () => ({
    then: (resolve: (v: any) => void) => resolve(undefined),
    returning: async () => [],
  }),
});

const _fakeDb = {
  db: {
    select: () => _selectChain,
    insert: () => _insertChain(),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
  getDb: () => _fakeDb.db,
};

mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));

afterAll(() => {
  // Restore the real DB so downstream files see the original module.
  mock.module("../db", () => _real_db);
});

beforeEach(() => {
  _nextPrJoinRow = null;
});

describe("computePrRiskForPullRequest", () => {
  it("returns null for a non-existent pull request", async () => {
    // Re-import the orchestrator AFTER mock.module() so it picks up the
    // stubbed `../db`. Top-level import was a deliberate first-load, but
    // pr-risk is small + the import shape is preserved.
    const mod = await import("../lib/pr-risk");
    _nextPrJoinRow = null;
    const result = await mod.computePrRiskForPullRequest("missing-pr-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache hit returns the same shape as cache miss
// ---------------------------------------------------------------------------

describe("PrRiskScore shape", () => {
  it("rowToPrRiskScore returns the same fields a fresh computation would", () => {
    const row = {
      id: "x",
      pullRequestId: "pr-1",
      commitSha: "abc1234",
      score: 6,
      band: "high",
      signals: {
        ...zeroSignals(),
        filesChanged: 4,
        linesAdded: 100,
        linesRemoved: 50,
        teamsAffected: 2,
      },
      aiSummary: "Touches a schema migration.",
      generatedAt: new Date("2026-05-13T00:00:00Z"),
    } as any;
    const out = __test.rowToPrRiskScore(row);
    expect(out.score).toBe(6);
    expect(out.band).toBe("high");
    expect(out.commitSha).toBe("abc1234");
    expect(out.signals.filesChanged).toBe(4);
    expect(out.aiSummary).toBe("Touches a schema migration.");
    expect(out.generatedAt).toBeInstanceOf(Date);
  });
});

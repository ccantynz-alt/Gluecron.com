/**
 * Repair-flywheel ↔ ci-autofix wiring tests (BUILD_BIBLE §7 finding 1).
 *
 * Drives `resolveAutofix` / `recordAutofixOutcome` through their
 * dependency-injection seam (`CiAutofixDeps`) so no DB, git, or Anthropic
 * call is touched — same pattern as the auto-merge fast-lane suite.
 *
 * Covers the closed-loop contract:
 *   - Tier-0 cache hit serves the cached patch WITHOUT an AI call and
 *     records a 'cached'-tier pending row with cache lineage + the patch
 *   - cache miss / low success rate / missing patch fall through to AI
 *   - outcomes settle via updateOutcome on apply success AND failure
 *   - flywheel errors (lookup, record, settle) never break the autofix
 *     path — everything fails open to the AI tier
 *   - isAiAvailable() gating: no key + cache miss → no fix, AI never called;
 *     no key + cache hit → cached fix still served (graceful degradation)
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveAutofix,
  recordAutofixOutcome,
  extractFlywheelEntryId,
  CACHE_MIN_SUCCESS_RATE,
  FLYWHEEL_MARKER_PREFIX,
  type AutofixPlan,
  type CiAutofixDeps,
  type ClaudeAutofixResponse,
} from "../lib/ci-autofix";
import type { CachedRepair, RecordRepairInput } from "../lib/repair-flywheel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CACHED_PATCH = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-const x: string = 42;
+const x = 42;
`;

const AI_FIX: ClaudeAutofixResponse = {
  patch: "--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -1 +1 @@\n-old\n+new\n",
  explanation: "Fixes the type error in bar.ts.",
  confidence: "high",
  affectedFiles: ["src/bar.ts"],
};

const FAILURE_TEXT =
  "error TS2322: Type 'number' is not assignable to type 'string' at src/foo.ts:1:7";

const PATTERN_ID = "11111111-2222-3333-4444-555555555555";
const NEW_ENTRY_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeCached(overrides: Partial<CachedRepair> = {}): CachedRepair {
  return {
    id: PATTERN_ID,
    patchSummary: "Drop the bogus string annotation on x.",
    patch: CACHED_PATCH,
    filesChanged: ["src/foo.ts"],
    commitSha: null,
    hitCount: 3,
    successRate: 1,
    classification: null,
    appliedCount: 4,
    ...overrides,
  };
}

interface Harness {
  deps: CiAutofixDeps;
  aiCalls: number;
  recorded: RecordRepairInput[];
  outcomes: Array<{ id: string; outcome: string }>;
  generateAiFix: () => Promise<ClaudeAutofixResponse | null>;
}

function makeHarness(opts: {
  cached?: CachedRepair | null;
  aiFix?: ClaudeAutofixResponse | null;
  aiAvailable?: boolean;
  // Throw-injection hooks (default false everywhere)
  lookupThrows?: boolean;
  recordThrows?: boolean;
  updateOutcomeThrows?: boolean;
} = {}): Harness {
  const recorded: RecordRepairInput[] = [];
  const outcomes: Array<{ id: string; outcome: string }> = [];

  const harness: Harness = {
    aiCalls: 0,
    recorded,
    outcomes,
    generateAiFix: async () => {
      harness.aiCalls += 1;
      return opts.aiFix === undefined ? AI_FIX : opts.aiFix;
    },
    deps: {
      findCachedRepair: async () => {
        if (opts.lookupThrows) throw new Error("flywheel db down");
        return opts.cached ?? null;
      },
      recordRepair: async (input) => {
        if (opts.recordThrows) throw new Error("insert failed");
        recorded.push(input);
        return NEW_ENTRY_ID;
      },
      updateOutcome: async (id, outcome) => {
        if (opts.updateOutcomeThrows) throw new Error("update failed");
        outcomes.push({ id, outcome });
      },
      aiAvailable: () => opts.aiAvailable ?? true,
    },
  };
  return harness;
}

function run(h: Harness): Promise<AutofixPlan | null> {
  return resolveAutofix({
    repositoryId: "repo-1",
    failureText: FAILURE_TEXT,
    generateAiFix: h.generateAiFix,
    deps: h.deps,
  });
}

// ---------------------------------------------------------------------------
// Tier 0: cache hit
// ---------------------------------------------------------------------------

describe("resolveAutofix — cache hit (Tier 0)", () => {
  it("serves the cached patch without calling the AI", async () => {
    const h = makeHarness({ cached: makeCached() });
    const plan = await run(h);

    expect(plan).not.toBeNull();
    expect(plan!.source).toBe("cache");
    expect(plan!.fix.patch).toBe(CACHED_PATCH);
    expect(plan!.cachedPatternId).toBe(PATTERN_ID);
    expect(h.aiCalls).toBe(0);
  });

  it("records a 'cached'-tier pending row with cache lineage + the patch", async () => {
    const h = makeHarness({ cached: makeCached() });
    const plan = await run(h);

    expect(h.recorded.length).toBe(1);
    expect(h.recorded[0]!.tier).toBe("cached");
    expect(h.recorded[0]!.parentPatternId).toBe(PATTERN_ID);
    expect(h.recorded[0]!.repositoryId).toBe("repo-1");
    expect(h.recorded[0]!.failureText).toBe(FAILURE_TEXT);
    // Carried forward so the new row is itself replayable once it settles
    expect(h.recorded[0]!.patch).toBe(CACHED_PATCH);
    // outcome defaults to 'pending' inside recordRepair — must not be forced
    expect(h.recorded[0]!.outcome).toBeUndefined();
    expect(plan!.flywheelEntryId).toBe(NEW_ENTRY_ID);
  });

  it("maps success rate to confidence (>=0.9 high, else medium)", async () => {
    const high = await run(makeHarness({ cached: makeCached({ successRate: 0.95 }) }));
    expect(high!.fix.confidence).toBe("high");

    const med = await run(makeHarness({ cached: makeCached({ successRate: 0.6 }) }));
    expect(med!.fix.confidence).toBe("medium");
  });

  it("works even when the AI is unavailable (graceful degradation)", async () => {
    const h = makeHarness({ cached: makeCached(), aiAvailable: false });
    const plan = await run(h);

    expect(plan).not.toBeNull();
    expect(plan!.source).toBe("cache");
    expect(h.aiCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache miss / unusable hit → fall through to the AI tier
// ---------------------------------------------------------------------------

describe("resolveAutofix — fall-through to AI (Tier 2)", () => {
  it("cache miss falls through to the AI and records an 'ai-sonnet' row", async () => {
    const h = makeHarness({ cached: null });
    const plan = await run(h);

    expect(h.aiCalls).toBe(1);
    expect(plan!.source).toBe("ai");
    expect(plan!.fix).toEqual(AI_FIX);
    expect(plan!.cachedPatternId).toBeNull();
    expect(h.recorded.length).toBe(1);
    expect(h.recorded[0]!.tier).toBe("ai-sonnet");
    // The AI patch is stored so the entry is replayable once it succeeds
    expect(h.recorded[0]!.patch).toBe(AI_FIX.patch);
    expect(plan!.flywheelEntryId).toBe(NEW_ENTRY_ID);
  });

  it("hit below CACHE_MIN_SUCCESS_RATE is not replayed", async () => {
    const h = makeHarness({
      cached: makeCached({ successRate: CACHE_MIN_SUCCESS_RATE - 0.01 }),
    });
    const plan = await run(h);

    expect(h.aiCalls).toBe(1);
    expect(plan!.source).toBe("ai");
  });

  it("hit with no stored patch (pre-0105 row) is not replayed", async () => {
    const h = makeHarness({ cached: makeCached({ patch: null }) });
    const plan = await run(h);

    expect(h.aiCalls).toBe(1);
    expect(plan!.source).toBe("ai");
  });

  it("returns null when the AI declines (no patch)", async () => {
    const h = makeHarness({ cached: null, aiFix: null });
    expect(await run(h)).toBeNull();
    expect(h.recorded.length).toBe(0);
  });

  it("returns null on a low-confidence AI fix without recording it", async () => {
    const h = makeHarness({
      cached: null,
      aiFix: { ...AI_FIX, confidence: "low" },
    });
    expect(await run(h)).toBeNull();
    expect(h.recorded.length).toBe(0);
  });

  it("returns null (and never calls the AI) when no key + cache miss", async () => {
    const h = makeHarness({ cached: null, aiAvailable: false });
    expect(await run(h)).toBeNull();
    expect(h.aiCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fail-open: flywheel errors never break the autofix path
// ---------------------------------------------------------------------------

describe("resolveAutofix — flywheel errors fail open", () => {
  it("a throwing findCachedRepair degrades to the AI tier", async () => {
    const h = makeHarness({ lookupThrows: true });
    const plan = await run(h);

    expect(plan!.source).toBe("ai");
    expect(h.aiCalls).toBe(1);
  });

  it("a throwing recordRepair still serves the cached fix (entry id null)", async () => {
    const h = makeHarness({ cached: makeCached(), recordThrows: true });
    const plan = await run(h);

    expect(plan!.source).toBe("cache");
    expect(plan!.fix.patch).toBe(CACHED_PATCH);
    expect(plan!.flywheelEntryId).toBeNull();
    expect(h.aiCalls).toBe(0);
  });

  it("a throwing recordRepair still serves the AI fix (entry id null)", async () => {
    const h = makeHarness({ cached: null, recordThrows: true });
    const plan = await run(h);

    expect(plan!.source).toBe("ai");
    expect(plan!.fix).toEqual(AI_FIX);
    expect(plan!.flywheelEntryId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outcome settling (recordAutofixOutcome ← applyAutofix)
// ---------------------------------------------------------------------------

describe("recordAutofixOutcome", () => {
  const bodyWithMarker = `<!-- gluecron:ci-autofix:v1 -->\n${FLYWHEEL_MARKER_PREFIX}${NEW_ENTRY_ID} -->\n\n## 🔧 AI Auto-Fix`;

  it("settles 'success' for the entry referenced by the comment", async () => {
    const h = makeHarness();
    await recordAutofixOutcome(bodyWithMarker, "success", h.deps);
    expect(h.outcomes).toEqual([{ id: NEW_ENTRY_ID, outcome: "success" }]);
  });

  it("settles 'failed' when the apply blows up", async () => {
    const h = makeHarness();
    await recordAutofixOutcome(bodyWithMarker, "failed", h.deps);
    expect(h.outcomes).toEqual([{ id: NEW_ENTRY_ID, outcome: "failed" }]);
  });

  it("is a no-op when the comment carries no flywheel marker", async () => {
    const h = makeHarness();
    await recordAutofixOutcome("<!-- gluecron:ci-autofix:v1 -->", "success", h.deps);
    expect(h.outcomes.length).toBe(0);
  });

  it("never throws even when updateOutcome throws", async () => {
    const h = makeHarness({ updateOutcomeThrows: true });
    await expect(
      recordAutofixOutcome(bodyWithMarker, "success", h.deps)
    ).resolves.toBeUndefined();
  });
});

describe("extractFlywheelEntryId", () => {
  it("round-trips an id through the comment marker", () => {
    const body = `hello\n${FLYWHEEL_MARKER_PREFIX}${PATTERN_ID} -->\nworld`;
    expect(extractFlywheelEntryId(body)).toBe(PATTERN_ID);
  });

  it("returns null when absent", () => {
    expect(extractFlywheelEntryId("no markers here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wiring regression guards — the seam must actually be plumbed into the
// live paths (same readFileSync technique as the fast-lane suite).
// ---------------------------------------------------------------------------

describe("ci-autofix source wiring", () => {
  const src = readFileSync(
    join(import.meta.dir, "../lib/ci-autofix.ts"),
    "utf8"
  );

  it("_runAutofix routes through resolveAutofix (cache before AI)", () => {
    expect(src).toContain("const plan = await resolveAutofix({");
  });

  it("applyAutofix settles both success and failed outcomes", () => {
    expect(src).toContain('recordAutofixOutcome(comment.body, "success"');
    expect(src).toContain('recordAutofixOutcome(comment.body, "failed"');
  });

  it("imports the flywheel cache + outcome functions", () => {
    expect(src).toContain("findCachedRepair");
    expect(src).toContain("updateOutcome");
    expect(src).toContain('from "./repair-flywheel"');
  });
});

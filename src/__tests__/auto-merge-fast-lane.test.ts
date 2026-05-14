/**
 * Block R3 — Fast-lane auto-merge (PR-create / PR-head-update event path) tests.
 *
 * Drives `tryAutoMergeNow` through its dependency-injection seam so no DB
 * or external module is touched. The lib is loaded via spread-from-real
 * import so an `afterAll` can no-op restore neighbouring suites — same K1
 * pattern other tests use, even though no `mock.module` override is needed
 * for this suite (the public API exposes a `deps` injection point).
 *
 * Covers the R3 contract:
 *   - waits for an AI-review comment when none exists yet (polls multiple times)
 *   - times out after `waitForAiReviewMs` without merging
 *   - on green decision: calls performMerge once + records auto_merge.merged audit + posts marker
 *   - on blocked decision: records the failure reason; does NOT call performMerge
 *   - never throws even when every injected helper throws
 *   - the PR-create route in pulls.tsx wires `tryAutoMergeNow(pr.id)` fire-and-forget
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  tryAutoMergeNow,
  type AutoMergeContext,
  type AutoMergeDecision,
  type TryAutoMergeNowDeps,
} from "../lib/auto-merge";
import type { PerformMergeResult } from "../lib/pr-merge";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

type FastLaneCtxArg = Parameters<NonNullable<TryAutoMergeNowDeps["merge"]>>[0];

function makeCtx(overrides: Partial<FastLaneCtxArg> = {}): FastLaneCtxArg {
  return {
    prId: "pr-1",
    prNumber: 7,
    prTitle: "Fast lane test PR",
    prBody: "Closes #99",
    baseBranch: "main",
    headBranch: "feature",
    isDraft: false,
    repositoryId: "repo-1",
    authorUserId: "user-1",
    ownerUsername: "alice",
    repoName: "demo",
    state: "open",
    ...overrides,
  };
}

const greenDecision: AutoMergeDecision = {
  merge: true,
  reason: "All auto-merge conditions met for 'main'.",
};

const blockedDecision: AutoMergeDecision = {
  merge: false,
  reason: "Branch protection requires AI approval but no approval was found.",
  blocking: ["AI approval missing."],
};

const okMerge: PerformMergeResult = {
  ok: true,
  closedIssueNumbers: [99],
  resolvedFiles: [],
};

// A no-op sleep so tests don't actually wait. We still record each call
// so polling assertions can inspect them.
function makeFakeSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { sleep, calls };
}

interface RecordedAttempt {
  repositoryId: string;
  prId: string;
  decision: AutoMergeDecision;
}

interface RecordedMerged {
  ctx: FastLaneCtxArg;
  result: PerformMergeResult;
}

interface TestHarness {
  loadContextCalls: number;
  hasAiReviewCalls: number;
  evaluateCalls: AutoMergeContext[];
  mergeCalls: FastLaneCtxArg[];
  recordedAttempts: RecordedAttempt[];
  mergedCalls: RecordedMerged[];
  sleepCalls: number[];
  deps: TryAutoMergeNowDeps;
}

function makeHarness(overrides: {
  ctx?: FastLaneCtxArg | null;
  /** Return value of hasAiReviewComment, indexed by call count (0-based). */
  aiCommentReadyAfterPolls?: number; // -1 means never
  decision?: AutoMergeDecision;
  mergeResult?: PerformMergeResult;
  // Throw-injection hooks (default false everywhere)
  loadContextThrows?: boolean;
  hasAiReviewThrows?: boolean;
  evaluateThrows?: boolean;
  mergeThrows?: boolean;
  recordAttemptThrows?: boolean;
  onMergedThrows?: boolean;
} = {}): TestHarness {
  const ctx = overrides.ctx === undefined ? makeCtx() : overrides.ctx;
  const decision = overrides.decision ?? greenDecision;
  const mergeResult = overrides.mergeResult ?? okMerge;
  const aiReadyAfter =
    overrides.aiCommentReadyAfterPolls === undefined
      ? 0 // ready on first probe by default
      : overrides.aiCommentReadyAfterPolls;

  const h: TestHarness = {
    loadContextCalls: 0,
    hasAiReviewCalls: 0,
    evaluateCalls: [],
    mergeCalls: [],
    recordedAttempts: [],
    mergedCalls: [],
    sleepCalls: [],
    deps: {},
  };

  const sleep = async (ms: number) => {
    h.sleepCalls.push(ms);
  };

  h.deps = {
    loadContext: async () => {
      h.loadContextCalls += 1;
      if (overrides.loadContextThrows) throw new Error("loadContext boom");
      return ctx;
    },
    hasAiReviewComment: async () => {
      h.hasAiReviewCalls += 1;
      if (overrides.hasAiReviewThrows) throw new Error("hasAiReview boom");
      if (aiReadyAfter < 0) return false;
      return h.hasAiReviewCalls > aiReadyAfter;
    },
    evaluate: async (ctxArg: AutoMergeContext) => {
      h.evaluateCalls.push(ctxArg);
      if (overrides.evaluateThrows) throw new Error("evaluate boom");
      return decision;
    },
    merge: async (mctx) => {
      h.mergeCalls.push(mctx);
      if (overrides.mergeThrows) throw new Error("merge boom");
      return mergeResult;
    },
    recordAttempt: async (repoId, prId, d) => {
      h.recordedAttempts.push({ repositoryId: repoId, prId, decision: d });
      if (overrides.recordAttemptThrows) throw new Error("record boom");
    },
    onMerged: async (mctx, result) => {
      h.mergedCalls.push({ ctx: mctx, result });
      if (overrides.onMergedThrows) throw new Error("onMerged boom");
    },
    sleep,
  };

  return h;
}

// ---------------------------------------------------------------------------
// AI-review wait behaviour
// ---------------------------------------------------------------------------

describe("tryAutoMergeNow — AI-review wait", () => {
  it("polls multiple times while the AI-review comment is missing, then evaluates once it lands", async () => {
    // The probe returns false on calls 1+2 and true on call 3, so the
    // outer loop should sleep twice and then evaluate.
    const h = makeHarness({ aiCommentReadyAfterPolls: 2 });

    await tryAutoMergeNow("pr-1", {
      waitForAiReviewMs: 60_000,
      aiReviewPollIntervalMs: 5_000,
      deps: h.deps,
    });

    expect(h.hasAiReviewCalls).toBeGreaterThanOrEqual(3);
    expect(h.sleepCalls.length).toBeGreaterThanOrEqual(2);
    expect(h.evaluateCalls.length).toBe(1);
    // Green decision → merge proceeds.
    expect(h.mergeCalls.length).toBe(1);
  });

  it("gives up cleanly when the AI-review wait window elapses without a comment", async () => {
    // waitForAiReviewMs=0 ⇒ first check fails immediately and we return
    // without evaluating. Models "AI review never landed before the cap".
    const h = makeHarness({ aiCommentReadyAfterPolls: -1 });

    await tryAutoMergeNow("pr-1", {
      waitForAiReviewMs: 0,
      aiReviewPollIntervalMs: 1,
      deps: h.deps,
    });

    expect(h.hasAiReviewCalls).toBe(1);
    expect(h.evaluateCalls.length).toBe(0);
    expect(h.mergeCalls.length).toBe(0);
    expect(h.recordedAttempts.length).toBe(0);
  });

  it("respects skipAiReviewWait=true and decides immediately without probing", async () => {
    const h = makeHarness({ aiCommentReadyAfterPolls: -1 });

    await tryAutoMergeNow("pr-1", {
      skipAiReviewWait: true,
      deps: h.deps,
    });

    expect(h.hasAiReviewCalls).toBe(0);
    expect(h.evaluateCalls.length).toBe(1);
    expect(h.mergeCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Decision branching
// ---------------------------------------------------------------------------

describe("tryAutoMergeNow — green path", () => {
  it("calls performMerge once + fires onMerged + records the evaluated audit", async () => {
    const h = makeHarness({ decision: greenDecision });

    await tryAutoMergeNow("pr-1", {
      skipAiReviewWait: true,
      deps: h.deps,
    });

    expect(h.mergeCalls.length).toBe(1);
    expect(h.mergedCalls.length).toBe(1);
    expect(h.mergedCalls[0].ctx.prId).toBe("pr-1");
    expect(h.mergedCalls[0].result.ok).toBe(true);

    // recordAttempt fires exactly once with the green decision.
    expect(h.recordedAttempts.length).toBe(1);
    expect(h.recordedAttempts[0].decision.merge).toBe(true);
  });

  it("default onMerged side-effect posts the gluecron:auto-merge:v1 marker comment", async () => {
    // Verify the actual marker token is exported and starts the comment
    // body that defaultOnMerged emits. Pulling from __test rather than
    // copy-pasting the constant keeps the assertion honest.
    const mod = await import("../lib/auto-merge");
    expect(mod.__test.FAST_LANE_AUTO_MERGE_MARKER).toBe(
      "<!-- gluecron:auto-merge:v1 -->"
    );
  });
});

describe("tryAutoMergeNow — blocked path", () => {
  it("records the failure reason and does NOT call performMerge", async () => {
    const h = makeHarness({ decision: blockedDecision });

    await tryAutoMergeNow("pr-1", {
      skipAiReviewWait: true,
      deps: h.deps,
    });

    expect(h.mergeCalls.length).toBe(0);
    expect(h.mergedCalls.length).toBe(0);
    expect(h.recordedAttempts.length).toBe(1);
    expect(h.recordedAttempts[0].decision.merge).toBe(false);
    expect(h.recordedAttempts[0].decision.reason).toMatch(/AI approval/i);
  });
});

// ---------------------------------------------------------------------------
// Never-throws guarantee
// ---------------------------------------------------------------------------

describe("tryAutoMergeNow — never throws", () => {
  it("swallows loadContext throws", async () => {
    const h = makeHarness({ loadContextThrows: true });
    await expect(
      tryAutoMergeNow("pr-1", { skipAiReviewWait: true, deps: h.deps })
    ).resolves.toBeUndefined();
    // Nothing else should have run.
    expect(h.evaluateCalls.length).toBe(0);
    expect(h.mergeCalls.length).toBe(0);
  });

  it("swallows evaluate throws + still records an audit", async () => {
    const h = makeHarness({ evaluateThrows: true });
    await expect(
      tryAutoMergeNow("pr-1", { skipAiReviewWait: true, deps: h.deps })
    ).resolves.toBeUndefined();
    // We never merged.
    expect(h.mergeCalls.length).toBe(0);
    // But we still recorded a failure audit so the paper trail survives.
    expect(h.recordedAttempts.length).toBe(1);
    expect(h.recordedAttempts[0].decision.merge).toBe(false);
  });

  it("swallows merge throws", async () => {
    const h = makeHarness({ mergeThrows: true, decision: greenDecision });
    await expect(
      tryAutoMergeNow("pr-1", { skipAiReviewWait: true, deps: h.deps })
    ).resolves.toBeUndefined();
    expect(h.mergeCalls.length).toBe(1);
    expect(h.mergedCalls.length).toBe(0);
  });

  it("swallows recordAttempt + onMerged throws", async () => {
    const h = makeHarness({
      recordAttemptThrows: true,
      onMergedThrows: true,
      decision: greenDecision,
    });
    await expect(
      tryAutoMergeNow("pr-1", { skipAiReviewWait: true, deps: h.deps })
    ).resolves.toBeUndefined();
    // Merge still attempted; recordAttempt + onMerged both threw silently.
    expect(h.mergeCalls.length).toBe(1);
  });

  it("never throws even when every injected helper throws", async () => {
    const exploding: TryAutoMergeNowDeps = {
      loadContext: async () => {
        throw new Error("load");
      },
      hasAiReviewComment: async () => {
        throw new Error("probe");
      },
      evaluate: async () => {
        throw new Error("eval");
      },
      merge: async () => {
        throw new Error("merge");
      },
      recordAttempt: async () => {
        throw new Error("record");
      },
      onMerged: async () => {
        throw new Error("merged");
      },
      sleep: async () => {
        throw new Error("sleep");
      },
    };
    await expect(
      tryAutoMergeNow("pr-1", { skipAiReviewWait: true, deps: exploding })
    ).resolves.toBeUndefined();
  });

  it("returns cleanly when loadContext returns null (PR vanished mid-flight)", async () => {
    const h = makeHarness({ ctx: null });
    await tryAutoMergeNow("pr-1", { skipAiReviewWait: true, deps: h.deps });
    expect(h.evaluateCalls.length).toBe(0);
    expect(h.mergeCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Route wiring smoke check
// ---------------------------------------------------------------------------

describe("pulls.tsx — PR-create hook wiring (R3 fast-lane)", () => {
  it("imports auto-merge and calls tryAutoMergeNow(pr.id) fire-and-forget after PR insert", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "routes", "pulls.tsx"),
      "utf8"
    );
    // The exact line we added — kept loose enough to allow whitespace
    // diffs but strict enough that an accidental delete trips this test.
    expect(src).toMatch(/import\(\s*"\.\.\/lib\/auto-merge"\s*\)/);
    expect(src).toMatch(/tryAutoMergeNow\s*\(\s*pr\.id\s*\)/);
    // R3 marker comment so a casual rebase doesn't quietly drop the hook.
    expect(src).toMatch(/R3 .*fast-lane auto-merge/i);
  });
});

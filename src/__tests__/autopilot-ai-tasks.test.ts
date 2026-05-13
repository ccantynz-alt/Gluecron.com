/**
 * Block K3 — autopilot AI-driver task tests.
 *
 * Uses the dependency-injection seams added in `src/lib/autopilot.ts`
 * (`runAutoMergeSweep`) and `src/lib/ai-build-tasks.ts`
 * (`runAiBuildTaskOnce`) so we never hit the DB or the AI client.
 *
 * Covers the contract called out in the K3 spec:
 *   - auto-merge-sweep skips drafts
 *   - auto-merge-sweep skips archived repos
 *   - auto-merge-sweep invokes merge exactly once per `merge:true` PR
 *   - ai-build dispatches against `ai:build`-labelled issues
 *   - ai-build skips an issue with a marker comment already present
 *   - both tasks no-op cleanly when AUTOPILOT_DISABLED=1
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startAutopilot,
  runAutoMergeSweep,
  type AutoMergeSweepDeps,
  type AutopilotTask,
} from "../lib/autopilot";
import {
  runAiBuildTaskOnce,
  AI_BUILD_MARKER,
  type AiBuildCandidate,
} from "../lib/ai-build-tasks";
import type {
  AutoMergeContext,
  AutoMergeDecision,
} from "../lib/auto-merge";
import type { PerformMergeResult } from "../lib/pr-merge";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

type Candidate = Parameters<NonNullable<AutoMergeSweepDeps["merge"]>>[0];

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    prId: "pr-1",
    prNumber: 42,
    prTitle: "Test PR",
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

const okMerge: PerformMergeResult = {
  ok: true,
  closedIssueNumbers: [],
  resolvedFiles: [],
};

const allowDecision: AutoMergeDecision = {
  merge: true,
  reason: "All auto-merge conditions met for 'main'.",
};

const blockDecision: AutoMergeDecision = {
  merge: false,
  reason: "blocked",
  blocking: ["draft"],
};

// ---------------------------------------------------------------------------
// auto-merge-sweep
// ---------------------------------------------------------------------------

describe("auto-merge-sweep", () => {
  it("skips drafts at the candidate-finder layer (drafts must never enter the loop)", async () => {
    // The default findCandidates filters drafts via SQL. We model that
    // contract here: when the caller supplies drafts, the sweep STILL
    // delegates the merge() call ONLY for non-draft PRs whose decision is
    // merge:true. Drafts that somehow leak through must surface as blocked
    // (decideAutoMerge will reject them).
    const draft = makeCandidate({ prId: "draft-1", isDraft: true });
    const open = makeCandidate({ prId: "open-1", isDraft: false });
    const mergeCalls: string[] = [];

    const summary = await runAutoMergeSweep({
      findCandidates: async () => [draft, open],
      // Simulate evaluateAutoMerge: drafts get blocked, opens get allowed.
      evaluate: async (ctx: AutoMergeContext) =>
        ctx.isDraft ? blockDecision : allowDecision,
      merge: async (cand) => {
        mergeCalls.push(cand.prId);
        return okMerge;
      },
      recordAttempt: async () => {},
      onMerged: async () => {},
      onMergeFailed: async () => {},
      shouldShortCircuitAi: async () => false,
    });

    expect(mergeCalls).toEqual(["open-1"]);
    expect(summary.evaluated).toBe(2);
    expect(summary.merged).toBe(1);
    expect(summary.blocked).toBe(1);
  });

  it("skips archived repos (no candidates surfaced from the finder)", async () => {
    // The default finder excludes archived repos in SQL. We simulate by
    // supplying an empty result and confirming a clean no-op summary.
    let findCalled = false;
    let mergeCalled = 0;
    const summary = await runAutoMergeSweep({
      findCandidates: async () => {
        findCalled = true;
        return [];
      },
      evaluate: async () => allowDecision,
      merge: async () => {
        mergeCalled += 1;
        return okMerge;
      },
      recordAttempt: async () => {},
      onMerged: async () => {},
      onMergeFailed: async () => {},
      shouldShortCircuitAi: async () => false,
    });
    expect(findCalled).toBe(true);
    expect(mergeCalled).toBe(0);
    expect(summary).toEqual({ evaluated: 0, merged: 0, blocked: 0 });
  });

  it("invokes the merge function exactly once per merge:true PR and records an evaluated audit per PR", async () => {
    const candidates = [
      makeCandidate({ prId: "a" }),
      makeCandidate({ prId: "b" }),
      makeCandidate({ prId: "c" }),
    ];
    const mergeCalls: string[] = [];
    const evaluatedAuditCalls: string[] = [];
    const mergedSuccessCalls: string[] = [];

    const summary = await runAutoMergeSweep({
      findCandidates: async () => candidates,
      // 'a' and 'c' are allowed, 'b' is blocked.
      evaluate: async (ctx) =>
        ctx.pullRequestId === "b" ? blockDecision : allowDecision,
      merge: async (cand) => {
        mergeCalls.push(cand.prId);
        return okMerge;
      },
      recordAttempt: async (_repoId, prId) => {
        evaluatedAuditCalls.push(prId);
      },
      onMerged: async (cand) => {
        mergedSuccessCalls.push(cand.prId);
      },
      onMergeFailed: async () => {},
      shouldShortCircuitAi: async () => false,
    });

    expect(mergeCalls).toEqual(["a", "c"]);
    expect(mergedSuccessCalls).toEqual(["a", "c"]);
    // recordAttempt fires for EVERY evaluation, not just successes.
    expect(evaluatedAuditCalls.sort()).toEqual(["a", "b", "c"]);
    expect(summary).toEqual({ evaluated: 3, merged: 2, blocked: 1 });
  });

  it("emits the merge_failed audit when performMerge returns ok=false (and does NOT emit merged audit)", async () => {
    const cand = makeCandidate({ prId: "x" });
    let mergedHits = 0;
    let failedHits = 0;

    const summary = await runAutoMergeSweep({
      findCandidates: async () => [cand],
      evaluate: async () => allowDecision,
      merge: async () => ({
        ok: false,
        error: "git update-ref failed: not a fast-forward",
        closedIssueNumbers: [],
        resolvedFiles: [],
      }),
      recordAttempt: async () => {},
      onMerged: async () => {
        mergedHits += 1;
      },
      onMergeFailed: async () => {
        failedHits += 1;
      },
      shouldShortCircuitAi: async () => false,
    });

    expect(mergedHits).toBe(0);
    expect(failedHits).toBe(1);
    expect(summary).toEqual({ evaluated: 1, merged: 0, blocked: 1 });
  });

  it("short-circuits AI-required rules when ANTHROPIC_API_KEY is unset (logged as blocked, not error)", async () => {
    const cand = makeCandidate({ prId: "ai-1" });
    let evaluateHits = 0;
    let mergeHits = 0;

    const summary = await runAutoMergeSweep({
      findCandidates: async () => [cand],
      shouldShortCircuitAi: async () => true,
      evaluate: async () => {
        evaluateHits += 1;
        return allowDecision;
      },
      merge: async () => {
        mergeHits += 1;
        return okMerge;
      },
      recordAttempt: async () => {},
      onMerged: async () => {},
      onMergeFailed: async () => {},
    });
    expect(evaluateHits).toBe(0); // never invoked
    expect(mergeHits).toBe(0); // never invoked
    expect(summary).toEqual({ evaluated: 1, merged: 0, blocked: 1 });
  });

  it("never throws even when the candidate-finder throws — returns zero summary", async () => {
    const summary = await runAutoMergeSweep({
      findCandidates: async () => {
        throw new Error("db blew up");
      },
      evaluate: async () => allowDecision,
      merge: async () => okMerge,
      recordAttempt: async () => {},
      onMerged: async () => {},
      onMergeFailed: async () => {},
      shouldShortCircuitAi: async () => false,
    });
    expect(summary).toEqual({ evaluated: 0, merged: 0, blocked: 0 });
  });

  it("isolates per-PR failures — a thrown merge() doesn't stop later PRs", async () => {
    const candidates = [
      makeCandidate({ prId: "first" }),
      makeCandidate({ prId: "second" }),
    ];
    const mergeCalls: string[] = [];
    const summary = await runAutoMergeSweep({
      findCandidates: async () => candidates,
      evaluate: async () => allowDecision,
      merge: async (cand) => {
        mergeCalls.push(cand.prId);
        if (cand.prId === "first") throw new Error("kaboom");
        return okMerge;
      },
      recordAttempt: async () => {},
      onMerged: async () => {},
      onMergeFailed: async () => {},
      shouldShortCircuitAi: async () => false,
    });
    expect(mergeCalls).toEqual(["first", "second"]);
    expect(summary.evaluated).toBe(2);
    expect(summary.merged).toBe(1);
    expect(summary.blocked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ai-build-from-issues
// ---------------------------------------------------------------------------

function makeAiBuildCandidate(
  overrides: Partial<AiBuildCandidate> = {}
): AiBuildCandidate {
  return {
    issueId: "issue-1",
    issueNumber: 7,
    issueTitle: "Add a sparkle button",
    issueBody: "Should sparkle when clicked.",
    repositoryId: "repo-1",
    authorUserId: "user-1",
    ownerUsername: "alice",
    repoName: "demo",
    defaultBranch: "main",
    ...overrides,
  };
}

describe("ai-build-from-issues", () => {
  it("dispatches the spec-to-PR pipeline for an ai:build-labelled issue", async () => {
    const dispatched: Array<{ repoId: string; spec: string; baseRef: string }> =
      [];
    const markersPosted: string[] = [];

    const summary = await runAiBuildTaskOnce({
      findCandidates: async () => [makeAiBuildCandidate()],
      hasDispatchMarker: async () => false,
      hasOpenLinkedPr: async () => false,
      dispatcher: async (args) => {
        dispatched.push({
          repoId: args.repoId,
          spec: args.spec,
          baseRef: args.baseRef,
        });
        return { ok: true, prNumber: 123 };
      },
      postMarkerComment: async (issueId) => {
        markersPosted.push(issueId);
      },
    });

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].repoId).toBe("repo-1");
    expect(dispatched[0].baseRef).toBe("main");
    // buildSpecFromIssue prefixes with "Implement:" and includes "Closes #N".
    expect(dispatched[0].spec).toContain("Implement: Add a sparkle button");
    expect(dispatched[0].spec).toContain("Closes #7");
    expect(markersPosted).toEqual(["issue-1"]);
    expect(summary).toEqual({ queued: 1, skipped: 0 });
  });

  it("skips an issue that already has the dispatch marker comment", async () => {
    const dispatched: string[] = [];
    const markersPosted: string[] = [];

    const summary = await runAiBuildTaskOnce({
      findCandidates: async () => [makeAiBuildCandidate({ issueId: "i-already" })],
      hasDispatchMarker: async (id) => id === "i-already",
      hasOpenLinkedPr: async () => false,
      dispatcher: async (args) => {
        dispatched.push(args.repoId);
        return { ok: true, prNumber: 1 };
      },
      postMarkerComment: async (id) => {
        markersPosted.push(id);
      },
    });

    expect(dispatched).toEqual([]);
    expect(markersPosted).toEqual([]);
    expect(summary).toEqual({ queued: 0, skipped: 1 });
  });

  it("skips an issue that already has an open PR closing it via close-keywords", async () => {
    let dispatcherHits = 0;
    const summary = await runAiBuildTaskOnce({
      findCandidates: async () => [makeAiBuildCandidate({ issueNumber: 42 })],
      hasDispatchMarker: async () => false,
      hasOpenLinkedPr: async (_repoId, n) => n === 42,
      dispatcher: async () => {
        dispatcherHits += 1;
        return { ok: true, prNumber: 1 };
      },
      postMarkerComment: async () => {},
    });
    expect(dispatcherHits).toBe(0);
    expect(summary).toEqual({ queued: 0, skipped: 1 });
  });

  it("swallows dispatcher failures without crashing the tick", async () => {
    let markerPosted = false;
    const summary = await runAiBuildTaskOnce({
      findCandidates: async () => [makeAiBuildCandidate()],
      hasDispatchMarker: async () => false,
      hasOpenLinkedPr: async () => false,
      dispatcher: async () => {
        throw new Error("anthropic 500");
      },
      postMarkerComment: async () => {
        markerPosted = true;
      },
    });
    // Marker still posted (idempotency takes priority over success).
    expect(markerPosted).toBe(true);
    // The issue counts as queued because we did our part — we don't retry.
    expect(summary.queued).toBe(1);
  });

  it("returns zero summary if findCandidates throws", async () => {
    const summary = await runAiBuildTaskOnce({
      findCandidates: async () => {
        throw new Error("db down");
      },
    });
    expect(summary).toEqual({ queued: 0, skipped: 0 });
  });

  it("uses the AI_BUILD_MARKER constant in the marker body", async () => {
    let receivedBody = "";
    await runAiBuildTaskOnce({
      findCandidates: async () => [makeAiBuildCandidate()],
      hasDispatchMarker: async () => false,
      hasOpenLinkedPr: async () => false,
      dispatcher: async () => ({ ok: true, prNumber: 1 }),
      postMarkerComment: async (_id, _author, body) => {
        receivedBody = body;
      },
    });
    expect(receivedBody.includes(AI_BUILD_MARKER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AUTOPILOT_DISABLED=1 — both tasks no-op when the parent loop never runs.
// ---------------------------------------------------------------------------

describe("autopilot disabled — neither AI task fires", () => {
  const originalDisabled = process.env.AUTOPILOT_DISABLED;
  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.AUTOPILOT_DISABLED;
    else process.env.AUTOPILOT_DISABLED = originalDisabled;
  });

  it("startAutopilot with AUTOPILOT_DISABLED=1 doesn't run injected AI tasks", async () => {
    process.env.AUTOPILOT_DISABLED = "1";
    let autoMergeRan = 0;
    let aiBuildRan = 0;
    const tasks: AutopilotTask[] = [
      {
        name: "auto-merge-sweep",
        run: async () => {
          autoMergeRan += 1;
        },
      },
      {
        name: "ai-build-from-issues",
        run: async () => {
          aiBuildRan += 1;
        },
      },
    ];
    const { stop } = startAutopilot({ intervalMs: 5, tasks });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(autoMergeRan).toBe(0);
    expect(aiBuildRan).toBe(0);
  });
});

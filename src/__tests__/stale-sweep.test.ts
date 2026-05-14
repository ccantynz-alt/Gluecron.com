/**
 * Block M5 — Stale PR/issue sweeper tests.
 *
 * Covers the contract from the M5 spec:
 *   - shouldPokePr: true when >7d stale + no recent poke, false otherwise
 *   - shouldClosePr: true when poke is older than 14d
 *   - runStalePrSweepOnce happy path: pokes the right PRs
 *   - Idempotency: re-running with the same fixtures + a now-stamped
 *     `hasPokeWithin=true` flag results in zero side-effects
 *   - Stage-2 close fires when poke is older than 14d
 *   - `auto_close_stale_prs=false` skips the close phase
 *   - Per-tick cap is respected
 *   - findCandidates throwing returns a clean zero summary
 *   - Mirror tests for issues (30d/60d windows + auto_close_stale_issues)
 *
 * All DB-touching surfaces are dependency-injected so this file never
 * hits Neon. Following the K3/L1 DI test pattern, NO `mock.module()` is
 * used here — keeps the file pollution-free.
 */

import { describe, it, expect } from "bun:test";
import {
  STALE_PR_POKE_MARKER,
  STALE_PR_CLOSE_MARKER,
  STALE_ISSUE_POKE_MARKER,
  STALE_ISSUE_CLOSE_MARKER,
  STALE_PR_POKE_DAYS,
  STALE_PR_CLOSE_DAYS,
  STALE_ISSUE_POKE_DAYS,
  STALE_ISSUE_CLOSE_DAYS,
  shouldPokePr,
  shouldClosePr,
  shouldPokeIssue,
  shouldCloseIssue,
  runStalePrSweepOnce,
  runStaleIssueSweepOnce,
  type StalePrCandidate,
  type StaleIssueCandidate,
} from "../lib/stale-sweep";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-13T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_DAY);

function makePrCand(overrides: Partial<StalePrCandidate> = {}): StalePrCandidate {
  return {
    prId: "pr-1",
    prNumber: 42,
    repositoryId: "repo-1",
    ownerUsername: "alice",
    repoName: "demo",
    authorUserId: "user-1",
    updatedAt: daysAgo(10), // 10 days stale → past 7-day poke threshold
    hasPokeWithin: false,
    lastPokedAt: null,
    autoCloseEnabled: true,
    ...overrides,
  };
}

function makeIssueCand(
  overrides: Partial<StaleIssueCandidate> = {}
): StaleIssueCandidate {
  return {
    issueId: "issue-1",
    issueNumber: 7,
    repositoryId: "repo-1",
    ownerUsername: "alice",
    repoName: "demo",
    authorUserId: "user-1",
    updatedAt: daysAgo(45), // 45 days → past 30-day issue poke threshold
    hasPokeWithin: false,
    lastPokedAt: null,
    autoCloseEnabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants — sanity-check the spec values are wired
// ---------------------------------------------------------------------------

describe("stale-sweep — constants", () => {
  it("uses the documented poke + close thresholds", () => {
    expect(STALE_PR_POKE_DAYS).toBe(7);
    expect(STALE_PR_CLOSE_DAYS).toBe(14);
    expect(STALE_ISSUE_POKE_DAYS).toBe(30);
    expect(STALE_ISSUE_CLOSE_DAYS).toBe(60);
  });

  it("exposes the four versioned markers verbatim", () => {
    expect(STALE_PR_POKE_MARKER).toBe("<!-- gluecron:stale-poke:v1 -->");
    expect(STALE_PR_CLOSE_MARKER).toBe("<!-- gluecron:stale-close:v1 -->");
    expect(STALE_ISSUE_POKE_MARKER).toBe(
      "<!-- gluecron:stale-issue-poke:v1 -->"
    );
    expect(STALE_ISSUE_CLOSE_MARKER).toBe(
      "<!-- gluecron:stale-issue-close:v1 -->"
    );
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — shouldPokePr / shouldClosePr
// ---------------------------------------------------------------------------

describe("shouldPokePr", () => {
  it("returns true when PR is older than 7 days and no recent poke exists", () => {
    expect(
      shouldPokePr({ updatedAt: daysAgo(10), hasPokeWithin: false }, NOW)
    ).toBe(true);
  });

  it("returns false when PR is younger than 7 days", () => {
    expect(
      shouldPokePr({ updatedAt: daysAgo(3), hasPokeWithin: false }, NOW)
    ).toBe(false);
  });

  it("returns false when a poke already exists within the 7-day window", () => {
    expect(
      shouldPokePr({ updatedAt: daysAgo(10), hasPokeWithin: true }, NOW)
    ).toBe(false);
  });

  it("returns true exactly at the 7-day boundary", () => {
    expect(
      shouldPokePr({ updatedAt: daysAgo(7), hasPokeWithin: false }, NOW)
    ).toBe(true);
  });
});

describe("shouldClosePr", () => {
  it("returns true when the last poke is older than 14 days", () => {
    expect(shouldClosePr({ lastPokedAt: daysAgo(15) }, NOW)).toBe(true);
  });

  it("returns false when the last poke is younger than 14 days", () => {
    expect(shouldClosePr({ lastPokedAt: daysAgo(13) }, NOW)).toBe(false);
  });

  it("returns false when no poke has ever been posted", () => {
    expect(shouldClosePr({ lastPokedAt: null }, NOW)).toBe(false);
  });

  it("returns true at exactly the 14-day boundary", () => {
    expect(shouldClosePr({ lastPokedAt: daysAgo(14) }, NOW)).toBe(true);
  });
});

describe("shouldPokeIssue + shouldCloseIssue", () => {
  it("issue poke fires at 30+ days", () => {
    expect(
      shouldPokeIssue({ updatedAt: daysAgo(31), hasPokeWithin: false }, NOW)
    ).toBe(true);
    expect(
      shouldPokeIssue({ updatedAt: daysAgo(29), hasPokeWithin: false }, NOW)
    ).toBe(false);
  });

  it("issue close fires at 60+ days post-poke", () => {
    expect(shouldCloseIssue({ lastPokedAt: daysAgo(61) }, NOW)).toBe(true);
    expect(shouldCloseIssue({ lastPokedAt: daysAgo(59) }, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runStalePrSweepOnce — happy path
// ---------------------------------------------------------------------------

describe("runStalePrSweepOnce — happy path", () => {
  it("pokes every candidate that's past 7 days with no recent poke (3 in → 3 pokes)", async () => {
    const candidates = [
      makePrCand({ prId: "a" }),
      makePrCand({ prId: "b" }),
      makePrCand({ prId: "c" }),
    ];
    const poked: string[] = [];
    const closed: string[] = [];
    const summary = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => candidates,
      pokePr: async (cand) => {
        poked.push(cand.prId);
      },
      closePr: async (cand) => {
        closed.push(cand.prId);
      },
    });
    expect(poked).toEqual(["a", "b", "c"]);
    expect(closed).toEqual([]);
    expect(summary).toEqual({ poked: 3, closed: 0 });
  });

  it("skips PRs that are not stale (updated_at too recent)", async () => {
    const candidates = [
      makePrCand({ prId: "fresh", updatedAt: daysAgo(2) }),
      makePrCand({ prId: "stale" }),
    ];
    const poked: string[] = [];
    const summary = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => candidates,
      pokePr: async (cand) => {
        poked.push(cand.prId);
      },
      closePr: async () => {},
    });
    expect(poked).toEqual(["stale"]);
    expect(summary).toEqual({ poked: 1, closed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Idempotency — re-running with `hasPokeWithin=true` doesn't re-poke
// ---------------------------------------------------------------------------

describe("runStalePrSweepOnce — idempotency", () => {
  it("does NOT re-poke a PR that already has a poke comment within the window", async () => {
    // Simulate "we poked this 2 days ago" → finder reports hasPokeWithin=true
    // and lastPokedAt 2d ago (so NOT yet close-eligible).
    const already = makePrCand({
      prId: "already-poked",
      hasPokeWithin: true,
      lastPokedAt: daysAgo(2),
    });
    let pokes = 0;
    let closes = 0;
    const summary = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => [already],
      pokePr: async () => {
        pokes += 1;
      },
      closePr: async () => {
        closes += 1;
      },
    });
    expect(pokes).toBe(0);
    expect(closes).toBe(0);
    expect(summary).toEqual({ poked: 0, closed: 0 });
  });

  it("re-running the same tick twice never double-pokes (state-machine round-trip)", async () => {
    // First tick: cand has no poke → gets one. Second tick: cand has poke
    // within window → skipped.
    let firstTickPokes = 0;
    let secondTickPokes = 0;

    const initial = makePrCand({ prId: "X" });
    const first = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => [initial],
      pokePr: async () => {
        firstTickPokes += 1;
      },
      closePr: async () => {},
    });
    expect(first).toEqual({ poked: 1, closed: 0 });
    expect(firstTickPokes).toBe(1);

    // Second tick: same PR but hasPokeWithin is now true.
    const followup = makePrCand({
      prId: "X",
      hasPokeWithin: true,
      lastPokedAt: NOW,
    });
    const second = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => [followup],
      pokePr: async () => {
        secondTickPokes += 1;
      },
      closePr: async () => {},
    });
    expect(second).toEqual({ poked: 0, closed: 0 });
    expect(secondTickPokes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stage-2 close
// ---------------------------------------------------------------------------

describe("runStalePrSweepOnce — stage-2 close", () => {
  it("auto-closes a PR whose poke is older than 14d when auto_close_stale_prs=true", async () => {
    const ripe = makePrCand({
      prId: "ripe",
      lastPokedAt: daysAgo(15),
      hasPokeWithin: false, // > 7d ago → not within window
      autoCloseEnabled: true,
    });
    const closed: string[] = [];
    const summary = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => [ripe],
      pokePr: async () => {},
      closePr: async (cand) => {
        closed.push(cand.prId);
      },
    });
    expect(closed).toEqual(["ripe"]);
    expect(summary).toEqual({ poked: 0, closed: 1 });
  });

  it("SKIPS the close phase when auto_close_stale_prs=false (no close, no re-poke)", async () => {
    const opted_out = makePrCand({
      prId: "opt-out",
      lastPokedAt: daysAgo(15),
      hasPokeWithin: false,
      autoCloseEnabled: false,
    });
    let pokes = 0;
    let closes = 0;
    const summary = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => [opted_out],
      pokePr: async () => {
        pokes += 1;
      },
      closePr: async () => {
        closes += 1;
      },
    });
    expect(pokes).toBe(0); // critical: must not re-poke either
    expect(closes).toBe(0);
    expect(summary).toEqual({ poked: 0, closed: 0 });
  });

  it("does NOT close until 14d have passed since the poke", async () => {
    const tooSoon = makePrCand({
      prId: "too-soon",
      lastPokedAt: daysAgo(10),
      hasPokeWithin: false,
      autoCloseEnabled: true,
    });
    let closes = 0;
    const summary = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => [tooSoon],
      pokePr: async () => {},
      closePr: async () => {
        closes += 1;
      },
    });
    expect(closes).toBe(0);
    expect(summary.closed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-tick cap + error isolation
// ---------------------------------------------------------------------------

describe("runStalePrSweepOnce — cap + isolation", () => {
  it("respects an explicit cap argument across BOTH poke and close phases", async () => {
    // 5 pokes + 5 closes available, cap=3 → first 3 actions only.
    const cands = [
      makePrCand({ prId: "p1" }),
      makePrCand({ prId: "p2" }),
      makePrCand({
        prId: "c1",
        lastPokedAt: daysAgo(20),
        autoCloseEnabled: true,
      }),
      makePrCand({ prId: "p3" }),
      makePrCand({
        prId: "c2",
        lastPokedAt: daysAgo(20),
        autoCloseEnabled: true,
      }),
    ];
    const acted: string[] = [];
    const summary = await runStalePrSweepOnce({
      now: NOW,
      cap: 3,
      findPrCandidates: async () => cands,
      pokePr: async (c) => {
        acted.push(`poke:${c.prId}`);
      },
      closePr: async (c) => {
        acted.push(`close:${c.prId}`);
      },
    });
    expect(acted.length).toBe(3);
    expect(summary.poked + summary.closed).toBe(3);
  });

  it("isolates per-PR failures — a throwing pokePr doesn't stop later PRs", async () => {
    const cands = [
      makePrCand({ prId: "first" }),
      makePrCand({ prId: "second" }),
    ];
    const ids: string[] = [];
    const summary = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => cands,
      pokePr: async (c) => {
        if (c.prId === "first") throw new Error("kaboom");
        ids.push(c.prId);
      },
      closePr: async () => {},
    });
    expect(ids).toEqual(["second"]);
    expect(summary.poked).toBe(1);
  });

  it("returns a zero summary when findCandidates throws (never propagates)", async () => {
    const summary = await runStalePrSweepOnce({
      now: NOW,
      findPrCandidates: async () => {
        throw new Error("db down");
      },
      pokePr: async () => {},
      closePr: async () => {},
    });
    expect(summary).toEqual({ poked: 0, closed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Mirror tests for issues
// ---------------------------------------------------------------------------

describe("runStaleIssueSweepOnce — pokes + closes", () => {
  it("pokes issues stale 30+ days with no recent poke", async () => {
    const cands = [makeIssueCand({ issueId: "i1" })];
    const poked: string[] = [];
    const summary = await runStaleIssueSweepOnce({
      now: NOW,
      findIssueCandidates: async () => cands,
      pokeIssue: async (c) => {
        poked.push(c.issueId);
      },
      closeIssue: async () => {},
    });
    expect(poked).toEqual(["i1"]);
    expect(summary).toEqual({ poked: 1, closed: 0 });
  });

  it("does NOT re-poke an issue with hasPokeWithin=true (idempotent)", async () => {
    const cands = [
      makeIssueCand({
        issueId: "i-already",
        hasPokeWithin: true,
        lastPokedAt: daysAgo(2),
      }),
    ];
    let pokes = 0;
    const summary = await runStaleIssueSweepOnce({
      now: NOW,
      findIssueCandidates: async () => cands,
      pokeIssue: async () => {
        pokes += 1;
      },
      closeIssue: async () => {},
    });
    expect(pokes).toBe(0);
    expect(summary).toEqual({ poked: 0, closed: 0 });
  });

  it("auto-closes an issue whose poke is older than 60d when auto_close_stale_issues=true", async () => {
    const ripe = makeIssueCand({
      issueId: "ripe",
      lastPokedAt: daysAgo(61),
      hasPokeWithin: false,
      autoCloseEnabled: true,
    });
    const closed: string[] = [];
    const summary = await runStaleIssueSweepOnce({
      now: NOW,
      findIssueCandidates: async () => [ripe],
      pokeIssue: async () => {},
      closeIssue: async (c) => {
        closed.push(c.issueId);
      },
    });
    expect(closed).toEqual(["ripe"]);
    expect(summary).toEqual({ poked: 0, closed: 1 });
  });

  it("SKIPS issue close phase when auto_close_stale_issues=false", async () => {
    const opted = makeIssueCand({
      lastPokedAt: daysAgo(61),
      autoCloseEnabled: false,
    });
    let closes = 0;
    let pokes = 0;
    const summary = await runStaleIssueSweepOnce({
      now: NOW,
      findIssueCandidates: async () => [opted],
      pokeIssue: async () => {
        pokes += 1;
      },
      closeIssue: async () => {
        closes += 1;
      },
    });
    expect(pokes).toBe(0);
    expect(closes).toBe(0);
    expect(summary).toEqual({ poked: 0, closed: 0 });
  });

  it("does NOT close an issue until 60d have passed since the poke", async () => {
    const tooSoon = makeIssueCand({
      lastPokedAt: daysAgo(45),
      autoCloseEnabled: true,
    });
    let closes = 0;
    const summary = await runStaleIssueSweepOnce({
      now: NOW,
      findIssueCandidates: async () => [tooSoon],
      pokeIssue: async () => {},
      closeIssue: async () => {
        closes += 1;
      },
    });
    expect(closes).toBe(0);
    expect(summary.closed).toBe(0);
  });

  it("returns zero summary when findCandidates throws", async () => {
    const summary = await runStaleIssueSweepOnce({
      now: NOW,
      findIssueCandidates: async () => {
        throw new Error("db down");
      },
      pokeIssue: async () => {},
      closeIssue: async () => {},
    });
    expect(summary).toEqual({ poked: 0, closed: 0 });
  });
});

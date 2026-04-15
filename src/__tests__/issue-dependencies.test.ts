/**
 * Block J14 — Issue dependencies. Pure helpers + route-auth smokes.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { __internal } from "../lib/issue-dependencies";

const { wouldCreateCycle, summariseBlockers } = __internal;

describe("issue-dependencies — wouldCreateCycle", () => {
  it("rejects self-references", () => {
    expect(wouldCreateCycle([], "a", "a")).toBe(true);
  });

  it("empty graph — no cycle", () => {
    expect(wouldCreateCycle([], "a", "b")).toBe(false);
  });

  it("detects a direct back-edge", () => {
    // b already blocks a → adding (a blocks b) would close the loop.
    const edges = [{ blockerIssueId: "b", blockedIssueId: "a" }];
    expect(wouldCreateCycle(edges, "a", "b")).toBe(true);
  });

  it("detects a transitive cycle (a → b → c, then c blocks a?)", () => {
    // Existing: a blocks b, b blocks c. Proposed: c blocks a → cycle.
    const edges = [
      { blockerIssueId: "a", blockedIssueId: "b" },
      { blockerIssueId: "b", blockedIssueId: "c" },
    ];
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true);
  });

  it("allows unrelated edges", () => {
    const edges = [
      { blockerIssueId: "a", blockedIssueId: "b" },
      { blockerIssueId: "c", blockedIssueId: "d" },
    ];
    expect(wouldCreateCycle(edges, "e", "f")).toBe(false);
    expect(wouldCreateCycle(edges, "a", "c")).toBe(false);
  });

  it("allows adding an edge that does not close any path", () => {
    // a blocks b. Adding b blocks c is fine — no cycle.
    const edges = [{ blockerIssueId: "a", blockedIssueId: "b" }];
    expect(wouldCreateCycle(edges, "b", "c")).toBe(false);
  });

  it("detects deeply transitive cycle (length 4)", () => {
    // a → b → c → d, then proposing d blocks a → cycle.
    const edges = [
      { blockerIssueId: "a", blockedIssueId: "b" },
      { blockerIssueId: "b", blockedIssueId: "c" },
      { blockerIssueId: "c", blockedIssueId: "d" },
    ];
    expect(wouldCreateCycle(edges, "d", "a")).toBe(true);
  });

  it("diamond shapes do not count as cycles", () => {
    // a blocks b, a blocks c, b blocks d, c blocks d. Adding e blocks a is fine.
    const edges = [
      { blockerIssueId: "a", blockedIssueId: "b" },
      { blockerIssueId: "a", blockedIssueId: "c" },
      { blockerIssueId: "b", blockedIssueId: "d" },
      { blockerIssueId: "c", blockedIssueId: "d" },
    ];
    expect(wouldCreateCycle(edges, "e", "a")).toBe(false);
  });
});

describe("issue-dependencies — summariseBlockers", () => {
  it("returns zeros for empty input", () => {
    expect(summariseBlockers([])).toEqual({ open: 0, closed: 0, total: 0 });
  });

  it("counts open and closed blockers", () => {
    expect(
      summariseBlockers([
        { blockerIssueId: "a", blockerState: "open" },
        { blockerIssueId: "b", blockerState: "closed" },
        { blockerIssueId: "c", blockerState: "open" },
      ])
    ).toEqual({ open: 2, closed: 1, total: 3 });
  });

  it("treats any non-open state as closed (defensive)", () => {
    expect(
      summariseBlockers([
        { blockerIssueId: "a", blockerState: "merged" },
        { blockerIssueId: "b", blockerState: "open" },
      ])
    ).toEqual({ open: 1, closed: 1, total: 2 });
  });
});

describe("issue-dependencies — routes", () => {
  it("POST /:o/:r/issues/:n/dependencies requires auth", async () => {
    const res = await app.request(
      "/alice/nope/issues/1/dependencies",
      { method: "POST", body: "blockerNumber=2" }
    );
    expect([302, 401].includes(res.status)).toBe(true);
  });

  it("POST remove route requires auth", async () => {
    const res = await app.request(
      "/alice/nope/issues/1/dependencies/blockers/xyz/remove",
      { method: "POST" }
    );
    expect([302, 401].includes(res.status)).toBe(true);
  });

  it("POST with invalid bearer → 401 JSON", async () => {
    const res = await app.request(
      "/alice/nope/issues/1/dependencies",
      {
        method: "POST",
        headers: { authorization: "Bearer glc_garbage" },
        body: "blockerNumber=2",
      }
    );
    expect(res.status).toBe(401);
  });
});

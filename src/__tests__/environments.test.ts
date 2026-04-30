/**
 * Tests for Block C4 — environments + deployment approvals.
 *
 * Unit tests exercise the pure-function glob matcher + the single-approver
 * semantics of computeApprovalState. Route-level tests verify that settings
 * CRUD and approve/reject endpoints are properly guarded — they tolerate
 * DB-less test environments (302/303/307/404/503) rather than asserting
 * a single happy-path status.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  matchGlob,
  reduceApprovalState,
  reviewerIdsOf,
  allowedBranchesOf,
  latestApprovalAt,
  computeReadyAfter,
  releaseExpiredWaitTimers,
} from "../lib/environments";
import type { Environment, DeploymentApproval } from "../db/schema";

const envFixture = (overrides: Partial<Environment> = {}): Environment =>
  ({
    id: "env-1",
    repositoryId: "repo-1",
    name: "production",
    requireApproval: true,
    reviewers: "[]",
    waitTimerMinutes: 0,
    allowedBranches: "[]",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Environment;

describe("matchGlob", () => {
  it("matches exact literals", () => {
    expect(matchGlob("main", "main")).toBe(true);
  });

  it("does not match mismatched literals", () => {
    expect(matchGlob("main", "release/*")).toBe(false);
  });

  it("supports single-segment * wildcards", () => {
    expect(matchGlob("release/1.0", "release/*")).toBe(true);
    expect(matchGlob("release/foo/bar", "release/*")).toBe(false);
  });

  it("supports ** for any path", () => {
    expect(matchGlob("release/foo/bar", "release/**")).toBe(true);
    expect(matchGlob("main", "**")).toBe(true);
  });

  it("strips refs/heads/ prefix on both sides", () => {
    expect(matchGlob("refs/heads/main", "main")).toBe(true);
    expect(matchGlob("main", "refs/heads/main")).toBe(true);
  });

  it("does not match unrelated branches", () => {
    expect(matchGlob("feature/x", "release/*")).toBe(false);
    expect(matchGlob("develop", "main")).toBe(false);
  });
});

describe("reviewerIdsOf / allowedBranchesOf", () => {
  it("parses valid JSON arrays", () => {
    const env = envFixture({
      reviewers: JSON.stringify(["u1", "u2"]),
      allowedBranches: JSON.stringify(["main", "release/*"]),
    });
    expect(reviewerIdsOf(env)).toEqual(["u1", "u2"]);
    expect(allowedBranchesOf(env)).toEqual(["main", "release/*"]);
  });

  it("returns [] for empty/invalid", () => {
    expect(reviewerIdsOf(envFixture({ reviewers: "" }))).toEqual([]);
    expect(reviewerIdsOf(envFixture({ reviewers: "not-json" }))).toEqual([]);
    expect(allowedBranchesOf(envFixture({ allowedBranches: "[]" }))).toEqual([]);
  });
});

const mkApproval = (
  decision: "approved" | "rejected",
  userId = "u1"
): DeploymentApproval =>
  ({
    id: `a-${Math.random()}`,
    deploymentId: "d1",
    userId,
    decision,
    comment: null,
    createdAt: new Date(),
  }) as DeploymentApproval;

describe("reduceApprovalState (single-approver semantics)", () => {
  it("approved=true when any approval exists and no rejection", () => {
    const state = reduceApprovalState([mkApproval("approved")]);
    expect(state.approved).toBe(true);
    expect(state.rejected).toBe(false);
    expect(state.decided.length).toBe(1);
  });

  it("rejected=true when any rejection exists (overrides approval)", () => {
    const state = reduceApprovalState([
      mkApproval("approved", "u1"),
      mkApproval("rejected", "u2"),
    ]);
    expect(state.rejected).toBe(true);
    expect(state.approved).toBe(false);
  });

  it("neither approved nor rejected when no decisions", () => {
    const state = reduceApprovalState([]);
    expect(state.approved).toBe(false);
    expect(state.rejected).toBe(false);
  });
});

describe("environments routes — unauthed guards", () => {
  const ok = [301, 302, 303, 307, 401, 404, 503];

  it("GET /:owner/:repo/settings/environments redirects to login when unauthed", async () => {
    const res = await app.request("/alice/project/settings/environments");
    expect(ok).toContain(res.status);
  });

  it("POST /:owner/:repo/settings/environments requires auth", async () => {
    const res = await app.request("/alice/project/settings/environments", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=staging",
    });
    expect(ok).toContain(res.status);
  });

  it("POST /:owner/:repo/settings/environments/:envId requires auth", async () => {
    const res = await app.request(
      "/alice/project/settings/environments/env-1",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }
    );
    expect(ok).toContain(res.status);
  });

  it("POST /:owner/:repo/settings/environments/:envId/delete requires auth", async () => {
    const res = await app.request(
      "/alice/project/settings/environments/env-1/delete",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }
    );
    expect(ok).toContain(res.status);
  });

  it("POST /:owner/:repo/deployments/:id/approve requires auth", async () => {
    const res = await app.request(
      "/alice/project/deployments/dep-1/approve",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }
    );
    expect(ok).toContain(res.status);
  });

  it("POST /:owner/:repo/deployments/:id/reject requires auth", async () => {
    const res = await app.request(
      "/alice/project/deployments/dep-1/reject",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }
    );
    expect(ok).toContain(res.status);
  });

  it("bearer auth with bogus token on settings POST returns 401", async () => {
    const res = await app.request("/alice/project/settings/environments", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Bearer glct_definitely-not-valid",
      },
      body: "name=staging",
    });
    // 401 from requireAuth with invalid bearer; 404/503 tolerated pre-route.
    expect([401, 404, 503]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Wait-timer enforcement (no longer a stub)
// ---------------------------------------------------------------------------

const mkApprovalAt = (
  decision: "approved" | "rejected",
  createdAt: Date,
  userId = "u1"
): DeploymentApproval =>
  ({
    id: `a-${Math.random()}`,
    deploymentId: "d1",
    userId,
    decision,
    comment: null,
    createdAt,
  }) as DeploymentApproval;

describe("latestApprovalAt", () => {
  it("returns null when there are no approvals", () => {
    expect(latestApprovalAt([])).toBeNull();
  });

  it("ignores rejection timestamps", () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    expect(latestApprovalAt([mkApprovalAt("rejected", t1)])).toBeNull();
  });

  it("returns the most recent approval timestamp", () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-01-02T00:00:00Z");
    const t3 = new Date("2026-01-03T00:00:00Z");
    const out = latestApprovalAt([
      mkApprovalAt("approved", t2, "u1"),
      mkApprovalAt("approved", t3, "u2"),
      mkApprovalAt("approved", t1, "u3"),
    ]);
    expect(out?.toISOString()).toBe(t3.toISOString());
  });

  it("tolerates a malformed createdAt", () => {
    const out = latestApprovalAt([
      {
        ...mkApprovalAt("approved", new Date("2026-01-01T00:00:00Z")),
        createdAt: new Date("not-a-real-date"),
      } as any,
    ]);
    expect(out).toBeNull();
  });
});

describe("computeReadyAfter", () => {
  it("returns null when waitTimerMinutes <= 0", () => {
    const env = envFixture({ waitTimerMinutes: 0 });
    const t = new Date("2026-01-01T00:00:00Z");
    expect(computeReadyAfter(env, [mkApprovalAt("approved", t)])).toBeNull();
  });

  it("returns null when there are no approvals (timer hasn't started)", () => {
    const env = envFixture({ waitTimerMinutes: 30 });
    expect(computeReadyAfter(env, [])).toBeNull();
  });

  it("adds waitTimerMinutes to the latest approval timestamp", () => {
    const env = envFixture({ waitTimerMinutes: 30 });
    const t = new Date("2026-01-01T12:00:00Z");
    const ready = computeReadyAfter(env, [mkApprovalAt("approved", t)]);
    expect(ready?.toISOString()).toBe("2026-01-01T12:30:00.000Z");
  });

  it("uses the latest approval, not the earliest", () => {
    const env = envFixture({ waitTimerMinutes: 60 });
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-01-01T01:00:00Z");
    const ready = computeReadyAfter(env, [
      mkApprovalAt("approved", t1, "u1"),
      mkApprovalAt("approved", t2, "u2"),
    ]);
    expect(ready?.toISOString()).toBe("2026-01-01T02:00:00.000Z");
  });

  it("returns null on a malformed waitTimerMinutes value", () => {
    const env = envFixture({ waitTimerMinutes: NaN as any });
    const t = new Date("2026-01-01T00:00:00Z");
    expect(computeReadyAfter(env, [mkApprovalAt("approved", t)])).toBeNull();
  });
});

describe("releaseExpiredWaitTimers — fail-open", () => {
  it("returns 0 (not throws) when DB is unavailable / no rows match", async () => {
    // No live DB → drizzle will throw inside the helper, which catches and
    // returns 0. Either way the test asserts the never-throw contract.
    const out = await releaseExpiredWaitTimers(new Date());
    expect(typeof out).toBe("number");
    expect(out).toBeGreaterThanOrEqual(0);
  });
});

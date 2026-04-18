/**
 * Block E6 — Required status checks matrix tests.
 *
 * Covers the pure protection-evaluator path (no DB) + route auth smoke.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { evaluateProtection } from "../lib/branch-protection";
import type { BranchProtection } from "../db/schema";

function rule(overrides: Partial<BranchProtection> = {}): BranchProtection {
  return {
    id: "rule-1",
    repositoryId: "repo-1",
    pattern: "main",
    requirePullRequest: true,
    requireGreenGates: true,
    requireAiApproval: false,
    requireHumanReview: false,
    requiredApprovals: 0,
    allowForcePush: false,
    allowDeletion: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as BranchProtection;
}

describe("evaluateProtection — required checks matrix", () => {
  const green = {
    aiApproved: true,
    humanApprovalCount: 1,
    gateResultGreen: true,
    hasFailedGates: false,
  };

  it("allows when no required checks are configured", () => {
    const d = evaluateProtection(rule(), green, []);
    expect(d.allowed).toBe(true);
    expect(d.reasons.length).toBe(0);
    expect(d.missingChecks).toBeUndefined();
  });

  it("allows when all required checks are in passingCheckNames", () => {
    const d = evaluateProtection(
      rule(),
      { ...green, passingCheckNames: ["GateTest", "AI Review", "CI"] },
      ["GateTest", "AI Review"]
    );
    expect(d.allowed).toBe(true);
    expect(d.missingChecks).toBeUndefined();
  });

  it("blocks when a required check is missing", () => {
    const d = evaluateProtection(
      rule(),
      { ...green, passingCheckNames: ["GateTest"] },
      ["GateTest", "AI Review"]
    );
    expect(d.allowed).toBe(false);
    expect(d.missingChecks).toEqual(["AI Review"]);
    expect(d.reasons.join(" ")).toContain("AI Review");
  });

  it("blocks when passingCheckNames is empty but checks are required", () => {
    const d = evaluateProtection(
      rule(),
      { ...green, passingCheckNames: [] },
      ["GateTest"]
    );
    expect(d.allowed).toBe(false);
    expect(d.missingChecks).toEqual(["GateTest"]);
  });

  it("still reports other failures alongside missing checks", () => {
    const d = evaluateProtection(
      rule({ requireAiApproval: true, requiredApprovals: 2 }),
      {
        aiApproved: false,
        humanApprovalCount: 0,
        gateResultGreen: true,
        hasFailedGates: false,
        passingCheckNames: [],
      },
      ["CI"]
    );
    expect(d.allowed).toBe(false);
    // 3 reasons: AI approval, required approvals, missing check
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
    expect(d.missingChecks).toEqual(["CI"]);
  });
});

describe("required-checks — route smoke", () => {
  it("GET protection/:id/checks without auth → 302 /login", async () => {
    const res = await app.request(
      "/any/repo/gates/protection/abc/checks"
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST protection/:id/checks without auth → 302 /login", async () => {
    const res = await app.request(
      "/any/repo/gates/protection/abc/checks",
      {
        method: "POST",
        body: new URLSearchParams({ checkName: "CI" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST protection/:id/checks/:cid/delete without auth → 302 /login", async () => {
    const res = await app.request(
      "/any/repo/gates/protection/abc/checks/xyz/delete",
      { method: "POST" }
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

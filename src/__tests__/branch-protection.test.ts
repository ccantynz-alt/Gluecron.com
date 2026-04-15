/**
 * Block D5 — branch-protection enforcement unit tests.
 * Covers `evaluateProtection` (pure) with various rule shapes + contexts.
 */

import { describe, expect, test } from "bun:test";
import { evaluateProtection } from "../lib/branch-protection";
import type { BranchProtection } from "../db/schema";

function rule(overrides: Partial<BranchProtection>): BranchProtection {
  return {
    id: "id",
    repositoryId: "repo",
    pattern: "main",
    requirePullRequest: true,
    requireGreenGates: false,
    requireAiApproval: false,
    requireHumanReview: false,
    requiredApprovals: 0,
    allowForcePush: false,
    allowDeletion: false,
    dismissStaleReviews: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as BranchProtection;
}

describe("evaluateProtection", () => {
  test("no rule → allowed with no reasons", () => {
    const r = evaluateProtection(null, {
      aiApproved: false,
      humanApprovalCount: 0,
      gateResultGreen: false,
      hasFailedGates: true,
    });
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  test("requireAiApproval blocks when not approved", () => {
    const r = evaluateProtection(
      rule({ requireAiApproval: true }),
      {
        aiApproved: false,
        humanApprovalCount: 0,
        gateResultGreen: true,
        hasFailedGates: false,
      }
    );
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]).toMatch(/AI approval/i);
  });

  test("requireAiApproval allows when approved", () => {
    const r = evaluateProtection(
      rule({ requireAiApproval: true }),
      {
        aiApproved: true,
        humanApprovalCount: 0,
        gateResultGreen: true,
        hasFailedGates: false,
      }
    );
    expect(r.allowed).toBe(true);
  });

  test("requireGreenGates blocks when failing", () => {
    const r = evaluateProtection(
      rule({ requireGreenGates: true }),
      {
        aiApproved: true,
        humanApprovalCount: 1,
        gateResultGreen: false,
        hasFailedGates: true,
      }
    );
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => /green gates/i.test(x))).toBe(true);
  });

  test("requireHumanReview blocks when 0 approvals", () => {
    const r = evaluateProtection(
      rule({ requireHumanReview: true }),
      {
        aiApproved: true,
        humanApprovalCount: 0,
        gateResultGreen: true,
        hasFailedGates: false,
      }
    );
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]).toMatch(/human review/i);
  });

  test("requiredApprovals=2 blocks when only 1", () => {
    const r = evaluateProtection(
      rule({ requiredApprovals: 2 }),
      {
        aiApproved: true,
        humanApprovalCount: 1,
        gateResultGreen: true,
        hasFailedGates: false,
      }
    );
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]).toMatch(/2 approvals/i);
  });

  test("requiredApprovals=2 allows when 2 reached", () => {
    const r = evaluateProtection(
      rule({ requiredApprovals: 2 }),
      {
        aiApproved: true,
        humanApprovalCount: 2,
        gateResultGreen: true,
        hasFailedGates: false,
      }
    );
    expect(r.allowed).toBe(true);
  });

  test("multiple rules combine into multiple reasons", () => {
    const r = evaluateProtection(
      rule({
        requireAiApproval: true,
        requireGreenGates: true,
        requireHumanReview: true,
      }),
      {
        aiApproved: false,
        humanApprovalCount: 0,
        gateResultGreen: false,
        hasFailedGates: true,
      }
    );
    expect(r.allowed).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

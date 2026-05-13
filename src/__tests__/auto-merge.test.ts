/**
 * Block K2 — AI-gated auto-merge evaluator tests.
 *
 * Drives the pure decision helper directly (no DB) so every branch is
 * deterministic. The DB-backed `evaluateAutoMerge` wrapper is exercised
 * indirectly via the same decision logic — its own integration is
 * trivial glue.
 */

import { describe, expect, test } from "bun:test";
import {
  __test,
  type AutoMergeDecision,
} from "../lib/auto-merge";
import type { BranchProtection } from "../db/schema";

const { decideAutoMerge, aiCommentLooksApproved } = __test;

function rule(overrides: Partial<BranchProtection> = {}): BranchProtection {
  return {
    id: "id-rule",
    repositoryId: "repo-1",
    pattern: "main",
    requirePullRequest: true,
    requireGreenGates: false,
    requireAiApproval: false,
    requireHumanReview: false,
    requiredApprovals: 0,
    allowForcePush: false,
    allowDeletion: false,
    dismissStaleReviews: true,
    enableAutoMerge: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as BranchProtection;
}

function happyArgs() {
  return {
    rule: rule(),
    isDraft: false,
    aiApproved: true,
    humanApprovalCount: 0,
    hasFailedGates: false,
    passingCheckNames: [] as string[],
    requiredCheckNames: [] as string[],
  };
}

function assertInvariant(d: AutoMergeDecision) {
  // The blocking list is non-empty iff merge=false.
  if (d.merge) {
    expect(d.blocking === undefined || d.blocking.length === 0).toBe(true);
  } else {
    expect(d.blocking && d.blocking.length > 0).toBe(true);
  }
}

describe("decideAutoMerge", () => {
  test("happy path: rule on, no draft, AI approved, gates green → merge", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      rule: rule({ requireAiApproval: true }),
      aiApproved: true,
    });
    expect(d.merge).toBe(true);
    assertInvariant(d);
  });

  test("default-deny when no branch_protection rule matches", () => {
    const d = decideAutoMerge({ ...happyArgs(), rule: null });
    expect(d.merge).toBe(false);
    expect(d.blocking?.[0]).toMatch(/default-deny/i);
    assertInvariant(d);
  });

  test("default-deny when enableAutoMerge=false on the matching rule", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      rule: rule({ enableAutoMerge: false }),
    });
    expect(d.merge).toBe(false);
    expect(d.blocking?.some((r) => /auto-merge enabled/i.test(r))).toBe(true);
    assertInvariant(d);
  });

  test("blocks when PR is draft", () => {
    const d = decideAutoMerge({ ...happyArgs(), isDraft: true });
    expect(d.merge).toBe(false);
    expect(d.blocking?.some((r) => /draft/i.test(r))).toBe(true);
    assertInvariant(d);
  });

  test("blocks when AI approval required but missing", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      rule: rule({ requireAiApproval: true }),
      aiApproved: false,
    });
    expect(d.merge).toBe(false);
    expect(d.blocking?.some((r) => /AI approval/i.test(r))).toBe(true);
    assertInvariant(d);
  });

  test("blocks on failing hard gate (requireGreenGates)", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      rule: rule({ requireGreenGates: true }),
      hasFailedGates: true,
    });
    expect(d.merge).toBe(false);
    expect(d.blocking?.some((r) => /green gates/i.test(r))).toBe(true);
    assertInvariant(d);
  });

  test("blocks on missing required check", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      requiredCheckNames: ["lint", "test"],
      passingCheckNames: ["lint"],
      hasFailedGates: true, // K3 caller would set this consistently
    });
    expect(d.merge).toBe(false);
    expect(d.blocking?.some((r) => /test/i.test(r))).toBe(true);
    assertInvariant(d);
  });

  test("allows when all required checks pass", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      requiredCheckNames: ["lint", "test"],
      passingCheckNames: ["lint", "test"],
      hasFailedGates: false,
    });
    expect(d.merge).toBe(true);
    assertInvariant(d);
  });

  test("blocks when human review required and not present", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      rule: rule({ requireHumanReview: true }),
      humanApprovalCount: 0,
    });
    expect(d.merge).toBe(false);
    expect(d.blocking?.some((r) => /human review/i.test(r))).toBe(true);
    assertInvariant(d);
  });

  test("size cap blocks when over limit", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      diffStats: { files: 50, lines: 5000 },
      caps: { maxChangedFiles: 10, maxChangedLines: 1000 },
    });
    expect(d.merge).toBe(false);
    expect(d.blocking?.length).toBeGreaterThanOrEqual(2);
    assertInvariant(d);
  });

  test("size cap does not block when under limit", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      diffStats: { files: 3, lines: 80 },
      caps: { maxChangedFiles: 10, maxChangedLines: 1000 },
    });
    expect(d.merge).toBe(true);
    assertInvariant(d);
  });

  test("size cap skipped when no caps provided even with big diff", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      diffStats: { files: 9999, lines: 9999 },
    });
    expect(d.merge).toBe(true);
    assertInvariant(d);
  });

  test("accumulates multiple blocking reasons", () => {
    const d = decideAutoMerge({
      ...happyArgs(),
      rule: rule({
        requireAiApproval: true,
        requireGreenGates: true,
        requireHumanReview: true,
      }),
      isDraft: true,
      aiApproved: false,
      humanApprovalCount: 0,
      hasFailedGates: true,
    });
    expect(d.merge).toBe(false);
    expect(d.blocking?.length).toBeGreaterThanOrEqual(4);
    assertInvariant(d);
  });

  test("invariant: blocking list non-empty iff merge=false (random shapes)", () => {
    const shapes = [
      happyArgs(),
      { ...happyArgs(), rule: null },
      { ...happyArgs(), isDraft: true },
      { ...happyArgs(), rule: rule({ enableAutoMerge: false }) },
    ];
    for (const s of shapes) {
      assertInvariant(decideAutoMerge(s));
    }
  });
});

describe("aiCommentLooksApproved", () => {
  test("approves a clean AI summary", () => {
    const body =
      "<!-- gluecron-ai-review:summary -->\n## AI Code Review\n\n**AI review:** no blocking issues found.\n\nLooks good.";
    expect(aiCommentLooksApproved(body)).toBe(true);
  });

  test("rejects when API was unavailable", () => {
    const body =
      "<!-- gluecron-ai-review:summary -->\n## AI review unavailable\n\nThe AI review attempt failed: timeout.";
    expect(aiCommentLooksApproved(body)).toBe(false);
  });

  test("rejects on severity: blocking marker (case-insensitive)", () => {
    const body =
      "<!-- gluecron-ai-review:summary -->\n## AI Code Review\n\nFindings:\n- Severity: BLOCKING — auth bypass at line 42.";
    expect(aiCommentLooksApproved(body)).toBe(false);
  });

  test("rejects when AI flagged items for human attention", () => {
    const body =
      "<!-- gluecron-ai-review:summary -->\n## AI Code Review\n\n**AI review:** flagged 3 item(s) for human attention.";
    expect(aiCommentLooksApproved(body)).toBe(false);
  });

  test("rejects empty body", () => {
    expect(aiCommentLooksApproved("")).toBe(false);
  });
});

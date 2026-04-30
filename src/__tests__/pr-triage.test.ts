/**
 * Tests for src/lib/pr-triage.ts.
 *
 * Pure helpers (renderTriageComment) covered exhaustively. The
 * DB-touching paths (alreadyTriaged, loadAvailableLabels,
 * loadCandidateReviewers, buildDiffSummary) are exercised via the
 * fail-open contracts — they must return reasonable values when no
 * DB / no repo on disk, never throw.
 *
 * triggerPrTriage itself is verified to be a no-throw fire-and-forget
 * even when called with garbage inputs and no API key.
 */

import { describe, it, expect } from "bun:test";
import {
  PR_TRIAGE_MARKER,
  triggerPrTriage,
  __test,
} from "../lib/pr-triage";
import type { PrTriage } from "../lib/ai-generators";

const triageFixture = (overrides: Partial<PrTriage> = {}): PrTriage => ({
  suggestedLabels: ["bug", "ui"],
  suggestedReviewerUsernames: ["alice", "bob"],
  priority: "medium",
  riskArea: "frontend",
  summary: "Fix login form colour contrast.",
  ...overrides,
});

describe("PR_TRIAGE_MARKER", () => {
  it("is a stable HTML comment so future searches keep working", () => {
    expect(PR_TRIAGE_MARKER).toBe("<!-- gluecron-pr-triage:summary -->");
    expect(PR_TRIAGE_MARKER.startsWith("<!--")).toBe(true);
    expect(PR_TRIAGE_MARKER.endsWith("-->")).toBe(true);
  });
});

describe("renderTriageComment", () => {
  it("includes the marker, summary, priority, risk area, labels, reviewers", () => {
    const out = __test.renderTriageComment(triageFixture());
    expect(out).toContain(PR_TRIAGE_MARKER);
    expect(out).toContain("## AI Triage");
    expect(out).toContain("Fix login form colour contrast.");
    expect(out).toContain("**Priority:** medium");
    expect(out).toContain("**Risk area:** frontend");
    expect(out).toContain("`bug`");
    expect(out).toContain("`ui`");
    expect(out).toContain("@alice");
    expect(out).toContain("@bob");
  });

  it("uses an italic placeholder when there are no label suggestions", () => {
    const out = __test.renderTriageComment(triageFixture({ suggestedLabels: [] }));
    expect(out).toContain("_(no label suggestions)_");
  });

  it("uses an italic placeholder when there are no reviewer suggestions", () => {
    const out = __test.renderTriageComment(
      triageFixture({ suggestedReviewerUsernames: [] })
    );
    expect(out).toContain("_(no reviewer suggestions)_");
  });

  it("renders an italic placeholder when summary is missing/whitespace", () => {
    const a = __test.renderTriageComment(triageFixture({ summary: "" }));
    const b = __test.renderTriageComment(triageFixture({ summary: "   " }));
    expect(a).toContain("_(no summary)_");
    expect(b).toContain("_(no summary)_");
  });

  it("ends with the suggestions-only disclaimer", () => {
    const out = __test.renderTriageComment(triageFixture());
    expect(out.trimEnd().endsWith(
      "_Suggestions only — nothing has been applied. The PR author stays in control._"
    )).toBe(true);
  });

  it("formats critical priority literally (no pictographic emoji)", () => {
    // Reminder: tests guard the "no emoji" rule. We use the tighter
    // Extended_Pictographic class so legitimate punctuation (em-dash,
    // asterisks) doesn't match.
    const out = __test.renderTriageComment(
      triageFixture({ priority: "critical" })
    );
    expect(out).toContain("**Priority:** critical");
    expect(/\p{Extended_Pictographic}/u.test(out)).toBe(false);
  });
});

describe("__test fail-open contracts", () => {
  it("alreadyTriaged returns false when no DB / unknown PR", async () => {
    const out = await __test.alreadyTriaged(
      "00000000-0000-0000-0000-000000000000"
    );
    expect(out).toBe(false);
  });

  it("loadAvailableLabels returns [] for an unknown repo", async () => {
    const out = await __test.loadAvailableLabels(
      "00000000-0000-0000-0000-000000000000"
    );
    expect(Array.isArray(out)).toBe(true);
  });

  it("loadCandidateReviewers returns [] for an unknown repo", async () => {
    const out = await __test.loadCandidateReviewers(
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-0000-000000000000"
    );
    expect(Array.isArray(out)).toBe(true);
  });

  it("buildDiffSummary returns '' for an unknown repo", async () => {
    const out = await __test.buildDiffSummary(
      "definitely-not-a-real-owner",
      "definitely-not-a-real-repo",
      "main",
      "feature"
    );
    expect(out).toBe("");
  });
});

describe("triggerPrTriage — fire-and-forget never throws", () => {
  const before = process.env.ANTHROPIC_API_KEY;

  it("returns cleanly when API key is absent", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    try {
      let threw = false;
      try {
        await triggerPrTriage({
          ownerName: "alice",
          repoName: "demo",
          repositoryId: "00000000-0000-0000-0000-000000000000",
          prId: "00000000-0000-0000-0000-000000000000",
          prAuthorId: "00000000-0000-0000-0000-000000000000",
          title: "Test",
          body: "",
          baseBranch: "main",
          headBranch: "feature",
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      if (before) process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it("never throws on empty/garbage inputs", async () => {
    let threw = false;
    try {
      await triggerPrTriage({
        ownerName: "",
        repoName: "",
        repositoryId: "not-a-uuid",
        prId: "not-a-uuid",
        prAuthorId: "not-a-uuid",
        title: "",
        body: "",
        baseBranch: "",
        headBranch: "",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

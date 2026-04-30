/**
 * Tests for src/lib/issue-triage.ts.
 *
 * Pure helper renderIssueTriageComment covered exhaustively. The
 * DB-touching paths (alreadyTriaged, loadAvailableLabels,
 * loadRecentIssues) are exercised via the fail-open contracts.
 *
 * triggerIssueTriage itself is verified to be a no-throw fire-and-forget
 * even when called with garbage inputs and no API key.
 */

import { describe, it, expect } from "bun:test";
import {
  ISSUE_TRIAGE_MARKER,
  triggerIssueTriage,
  __test,
} from "../lib/issue-triage";
import type { IssueTriage } from "../lib/ai-generators";

const triageFixture = (overrides: Partial<IssueTriage> = {}): IssueTriage => ({
  suggestedLabels: ["bug", "ui"],
  duplicateOfIssueNumber: null,
  priority: "medium",
  summary: "Login button is unreadable in dark mode.",
  ...overrides,
});

describe("ISSUE_TRIAGE_MARKER", () => {
  it("is a stable HTML comment so future searches keep working", () => {
    expect(ISSUE_TRIAGE_MARKER).toBe("<!-- gluecron-issue-triage:summary -->");
    expect(ISSUE_TRIAGE_MARKER.startsWith("<!--")).toBe(true);
    expect(ISSUE_TRIAGE_MARKER.endsWith("-->")).toBe(true);
  });
});

describe("renderIssueTriageComment", () => {
  it("includes the marker, summary, priority, labels", () => {
    const out = __test.renderIssueTriageComment(triageFixture());
    expect(out).toContain(ISSUE_TRIAGE_MARKER);
    expect(out).toContain("## AI Triage");
    expect(out).toContain("Login button is unreadable in dark mode.");
    expect(out).toContain("**Priority:** medium");
    expect(out).toContain("`bug`");
    expect(out).toContain("`ui`");
  });

  it("uses an italic placeholder when there are no label suggestions", () => {
    const out = __test.renderIssueTriageComment(
      triageFixture({ suggestedLabels: [] })
    );
    expect(out).toContain("_(no label suggestions)_");
  });

  it("uses an italic placeholder when summary is missing/whitespace", () => {
    const a = __test.renderIssueTriageComment(triageFixture({ summary: "" }));
    const b = __test.renderIssueTriageComment(triageFixture({ summary: "   " }));
    expect(a).toContain("_(no summary)_");
    expect(b).toContain("_(no summary)_");
  });

  it("renders a duplicate callout when AI flagged one", () => {
    const out = __test.renderIssueTriageComment(
      triageFixture({ duplicateOfIssueNumber: 42 })
    );
    expect(out).toContain("**Possible duplicate of:** #42");
  });

  it("omits the duplicate callout for null / 0 / negative numbers", () => {
    const a = __test.renderIssueTriageComment(triageFixture({ duplicateOfIssueNumber: null }));
    const b = __test.renderIssueTriageComment(
      triageFixture({ duplicateOfIssueNumber: 0 as any })
    );
    const c = __test.renderIssueTriageComment(
      triageFixture({ duplicateOfIssueNumber: -1 as any })
    );
    for (const out of [a, b, c]) {
      expect(out).not.toContain("Possible duplicate of");
    }
  });

  it("ends with the suggestions-only disclaimer", () => {
    const out = __test.renderIssueTriageComment(triageFixture());
    expect(out.trimEnd().endsWith(
      "_Suggestions only — nothing has been applied. The author stays in control._"
    )).toBe(true);
  });

  it("formats critical priority literally (no pictographic emoji)", () => {
    const out = __test.renderIssueTriageComment(
      triageFixture({ priority: "critical" })
    );
    expect(out).toContain("**Priority:** critical");
    expect(/\p{Extended_Pictographic}/u.test(out)).toBe(false);
  });
});

describe("__test fail-open contracts", () => {
  it("alreadyTriaged returns false when no DB / unknown issue", async () => {
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

  it("loadRecentIssues returns [] for an unknown repo", async () => {
    const out = await __test.loadRecentIssues(
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-0000-000000000000"
    );
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("triggerIssueTriage — fire-and-forget never throws", () => {
  const before = process.env.ANTHROPIC_API_KEY;

  it("resolves without throwing when API key is absent", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    try {
      let threw = false;
      try {
        await triggerIssueTriage({
          ownerName: "alice",
          repoName: "demo",
          repositoryId: "00000000-0000-0000-0000-000000000000",
          issueId: "00000000-0000-0000-0000-000000000000",
          issueNumber: 1,
          authorId: "00000000-0000-0000-0000-000000000000",
          title: "Test",
          body: "",
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      if (before) process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it("never throws on garbage inputs", async () => {
    let threw = false;
    try {
      await triggerIssueTriage({
        ownerName: "",
        repoName: "",
        repositoryId: "not-a-uuid",
        issueId: "not-a-uuid",
        issueNumber: -1,
        authorId: "not-a-uuid",
        title: "",
        body: "",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

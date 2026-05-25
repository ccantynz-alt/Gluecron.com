/**
 * Tests for src/lib/ai-commit-message.ts.
 *
 * We cover the pure / deterministic surface here (parsing, heuristics,
 * truncation, prompt shape). The Anthropic-calling path is exercised
 * indirectly via the heuristic fallback when ANTHROPIC_API_KEY is unset
 * (the default in CI).
 */

import { describe, it, expect } from "bun:test";
import {
  generateCommitMessage,
  truncateDiff,
  DIFF_BYTE_CAP,
  __test,
} from "../lib/ai-commit-message";

const { heuristicMessage, parseModelOutput, buildPrompt, CONVENTIONAL_TYPES } =
  __test;

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-old line
+new line
 unchanged
`;

const NEW_FILE_DIFF = `diff --git a/src/feature.ts b/src/feature.ts
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/src/feature.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return "world";
+}
`;

const DOCS_DIFF = `diff --git a/README.md b/README.md
index 1..2 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-Old
+New
`;

const TEST_DIFF = `diff --git a/src/__tests__/foo.test.ts b/src/__tests__/foo.test.ts
new file mode 100644
--- /dev/null
+++ b/src/__tests__/foo.test.ts
@@ -0,0 +1,1 @@
+test("hi", () => {});
`;

// ──────────────────────────── truncation ────────────────────────────

describe("truncateDiff", () => {
  it("returns the diff unchanged when under cap", () => {
    expect(truncateDiff("hello")).toBe("hello");
  });

  it("truncates to cap with a marker when over", () => {
    const big = "x".repeat(DIFF_BYTE_CAP + 1000);
    const out = truncateDiff(big);
    expect(out.length).toBeLessThanOrEqual(DIFF_BYTE_CAP);
    expect(out.endsWith("... (more)")).toBe(true);
  });

  it("respects a custom cap", () => {
    const big = "x".repeat(2000);
    const out = truncateDiff(big, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("... (more)")).toBe(true);
  });

  it("does not append marker when input exactly fits", () => {
    const exact = "x".repeat(50);
    expect(truncateDiff(exact, 50)).toBe(exact);
  });
});

// ──────────────────────────── heuristic ────────────────────────────

describe("heuristicMessage", () => {
  it("returns a chore message for empty input", () => {
    const m = heuristicMessage("");
    expect(m.subject).toBe("chore: update");
    expect(m.body).toBe("");
  });

  it("classifies docs-only diffs as docs:", () => {
    const m = heuristicMessage(DOCS_DIFF);
    expect(m.subject.startsWith("docs")).toBe(true);
  });

  it("classifies test-only diffs as test:", () => {
    const m = heuristicMessage(TEST_DIFF);
    expect(m.subject.startsWith("test")).toBe(true);
  });

  it("classifies new-file diffs as feat:", () => {
    const m = heuristicMessage(NEW_FILE_DIFF);
    expect(m.subject.startsWith("feat")).toBe(true);
  });

  it("extracts a scope when all paths share a top-level dir", () => {
    const m = heuristicMessage(NEW_FILE_DIFF);
    expect(m.subject).toMatch(/^feat\(src\):/);
  });

  it("includes touched files in the body", () => {
    const m = heuristicMessage(SAMPLE_DIFF);
    expect(m.body).toContain("src/foo.ts");
  });

  it("caps subject at 72 chars", () => {
    const longPaths = Array.from({ length: 50 }, (_, i) => `src/${i}/file${i}.ts`).join("\n");
    const big = longPaths
      .split("\n")
      .map((p) => `diff --git a/${p} b/${p}\n+++ b/${p}\n`)
      .join("");
    const m = heuristicMessage(big);
    expect(m.subject.length).toBeLessThanOrEqual(72);
  });

  it("supports plain style (no type prefix)", () => {
    const m = heuristicMessage(SAMPLE_DIFF, "plain");
    expect(m.subject).not.toMatch(/^(feat|fix|chore|docs|test|refactor):/);
    expect(m.subject[0]).toBe(m.subject[0].toUpperCase());
  });
});

// ──────────────────────────── parseModelOutput ────────────────────────────

describe("parseModelOutput", () => {
  it("parses well-formed JSON with subject + body", () => {
    const m = parseModelOutput(
      '{"subject": "feat(auth): add login", "body": "Because users need it."}'
    );
    expect(m.subject).toBe("feat(auth): add login");
    expect(m.body).toBe("Because users need it.");
  });

  it("strips a ```json code fence", () => {
    const text = '```json\n{"subject":"fix: bug","body":""}\n```';
    const m = parseModelOutput(text);
    expect(m.subject).toBe("fix: bug");
  });

  it("falls back to first-line/body parsing for plain text", () => {
    const m = parseModelOutput("feat(api): expose new endpoint\n\nDetails here.");
    expect(m.subject).toBe("feat(api): expose new endpoint");
    expect(m.body).toContain("Details here.");
  });

  it("strips quotes around the subject", () => {
    const m = parseModelOutput('"fix: oops"');
    expect(m.subject).toBe("fix: oops");
  });

  it("normalises non-conventional subjects when conventional style is requested", () => {
    const m = parseModelOutput("Add new feature", "conventional");
    expect(m.subject.startsWith("chore:")).toBe(true);
  });

  it("preserves conventional subjects unchanged", () => {
    const m = parseModelOutput("feat(x): do thing", "conventional");
    expect(m.subject).toBe("feat(x): do thing");
  });

  it("caps overly long subjects at 72 chars", () => {
    const long = "feat: " + "x".repeat(200);
    const m = parseModelOutput(long);
    expect(m.subject.length).toBeLessThanOrEqual(72);
    expect(m.subject.endsWith("...")).toBe(true);
  });

  it("returns a safe default for empty / garbage input", () => {
    const m = parseModelOutput("");
    expect(m.subject).toBe("chore: update");
  });
});

// ──────────────────────────── buildPrompt ────────────────────────────

describe("buildPrompt", () => {
  it("mentions every conventional-commit type", () => {
    const p = buildPrompt("(diff)", "conventional");
    for (const t of CONVENTIONAL_TYPES) {
      expect(p).toContain(t);
    }
  });

  it("requires JSON output", () => {
    const p = buildPrompt("(diff)", "conventional");
    expect(p).toContain("JSON");
    expect(p).toContain('"subject"');
    expect(p).toContain('"body"');
  });

  it("omits the type-list when plain style is requested", () => {
    const p = buildPrompt("(diff)", "plain");
    expect(p).toContain("plain-English");
    // The plain prompt should NOT list conventional types as required types.
    expect(p).not.toContain("MUST start with one of: feat");
  });

  it("includes the diff verbatim", () => {
    const p = buildPrompt("DIFF_MARKER", "conventional");
    expect(p).toContain("DIFF_MARKER");
  });
});

// ──────────────────────────── generateCommitMessage ────────────────────────────

describe("generateCommitMessage — fallback path", () => {
  it("returns a heuristic message when ANTHROPIC_API_KEY is missing", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const m = await generateCommitMessage(SAMPLE_DIFF);
      expect(m.subject.length).toBeGreaterThan(0);
      // Heuristic always emits Conventional style by default.
      expect(m.subject).toMatch(/^[a-z]+(\([^)]+\))?:/);
    } finally {
      if (before) process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it("returns an empty-commit placeholder for an empty diff", async () => {
    const m = await generateCommitMessage("");
    expect(m.subject).toContain("empty");
    expect(m.body).toBe("");
  });

  it("respects the plain style option in fallback mode", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const m = await generateCommitMessage(SAMPLE_DIFF, { style: "plain" });
      expect(m.subject).not.toMatch(/^[a-z]+:/);
    } finally {
      if (before) process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it("never throws on malformed input", async () => {
    let threw = false;
    try {
      await generateCommitMessage("not a real diff at all 🤷");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("handles a diff far over the truncation cap without crashing", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const big = "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n" + "+x\n".repeat(200_000);
      const m = await generateCommitMessage(big);
      expect(m.subject.length).toBeGreaterThan(0);
      expect(m.subject.length).toBeLessThanOrEqual(72);
    } finally {
      if (before) process.env.ANTHROPIC_API_KEY = before;
    }
  });
});

// ──────────────────────────── conventional format ────────────────────────────

describe("Conventional Commits format", () => {
  // Scope allows any non-paren chars — Conventional Commits' BNF
  // is permissive and our heuristic might surface a filename like
  // "README.md" as the scope.
  const CONVENTIONAL_RE = /^[a-z]+(\([^)]+\))?(!?): .+/;

  it("heuristic output for a code change matches conventional regex", () => {
    const m = heuristicMessage(SAMPLE_DIFF);
    expect(m.subject).toMatch(CONVENTIONAL_RE);
  });

  it("heuristic output for a new-file diff matches conventional regex", () => {
    const m = heuristicMessage(NEW_FILE_DIFF);
    expect(m.subject).toMatch(CONVENTIONAL_RE);
  });

  it("heuristic output for docs matches conventional regex", () => {
    const m = heuristicMessage(DOCS_DIFF);
    expect(m.subject).toMatch(CONVENTIONAL_RE);
  });

  it("parseModelOutput normalisation produces a conventional subject", () => {
    const m = parseModelOutput("Just a sentence with no type.", "conventional");
    expect(m.subject).toMatch(CONVENTIONAL_RE);
  });
});

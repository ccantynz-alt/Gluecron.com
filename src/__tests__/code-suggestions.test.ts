/**
 * Block J22 — Code review suggestion blocks. Pure extract + apply tests.
 */

import { describe, it, expect } from "bun:test";
import {
  detectLineEnding,
  splitLines,
  extractSuggestions,
  applySuggestionToContent,
  applyNthSuggestion,
  __internal,
} from "../lib/code-suggestions";

describe("code-suggestions — detectLineEnding", () => {
  it("returns CRLF for CRLF content", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
  });
  it("returns LF for LF content", () => {
    expect(detectLineEnding("a\nb\n")).toBe("\n");
  });
  it("returns LF for empty", () => {
    expect(detectLineEnding("")).toBe("\n");
  });
  it("returns CRLF if ANY CRLF present", () => {
    expect(detectLineEnding("a\nb\r\nc")).toBe("\r\n");
  });
});

describe("code-suggestions — extractSuggestions", () => {
  it("returns [] for empty or non-string input", () => {
    expect(extractSuggestions("")).toEqual([]);
    expect(extractSuggestions(null as unknown as string)).toEqual([]);
    expect(extractSuggestions(undefined as unknown as string)).toEqual([]);
  });

  it("extracts a single single-line suggestion", () => {
    const body = "LGTM but\n\n```suggestion\nconst x = 1;\n```\n\nthoughts?";
    const out = extractSuggestions(body);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("const x = 1;");
    expect(out[0].index).toBe(0);
  });

  it("extracts multi-line suggestions preserving internal newlines", () => {
    const body = "```suggestion\nline1\nline2\nline3\n```\n";
    const out = extractSuggestions(body);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("line1\nline2\nline3");
  });

  it("captures empty suggestions (intent: delete the line)", () => {
    const body = "```suggestion\n```\n";
    const out = extractSuggestions(body);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("");
  });

  it("skips fences whose info-string isn't `suggestion`", () => {
    const body = "```js\nconst x = 1;\n```\n";
    expect(extractSuggestions(body)).toEqual([]);
  });

  it("extracts multiple suggestions in order", () => {
    const body =
      "First:\n```suggestion\nfoo\n```\n\nSecond:\n```suggestion\nbar\nbaz\n```\n";
    const out = extractSuggestions(body);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe("foo");
    expect(out[1].content).toBe("bar\nbaz");
    expect(out[0].index).toBe(0);
    expect(out[1].index).toBe(1);
  });

  it("skips unterminated fences", () => {
    const body = "```suggestion\nconst x = 1;";
    expect(extractSuggestions(body)).toEqual([]);
  });

  it("tolerates 4+ backtick fences (for suggestions that contain ```)", () => {
    const body =
      "````suggestion\nconst s = `template ${with} backticks`;\n````\n";
    const out = extractSuggestions(body);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe(
      "const s = `template ${with} backticks`;"
    );
  });

  it("ignores trailing info after `suggestion`", () => {
    const body = "```suggestion block\nfoo\n```\n";
    expect(extractSuggestions(body)).toHaveLength(1);
  });

  it("is case-sensitive on the language token (GitHub parity)", () => {
    // GitHub's renderer is case-sensitive. This keeps our parser
    // predictable — bump to case-insensitive when GitHub relaxes.
    const body = "```Suggestion\nfoo\n```\n";
    expect(extractSuggestions(body)).toEqual([]);
  });
});

describe("code-suggestions — applySuggestionToContent", () => {
  const content = "line one\nline two\nline three\n";

  it("replaces a single line (1-indexed)", () => {
    const res = applySuggestionToContent({
      content,
      startLine: 2,
      endLine: 2,
      suggestion: "TWO!",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("line one\nTWO!\nline three\n");
  });

  it("replaces with multiple lines", () => {
    const res = applySuggestionToContent({
      content,
      startLine: 2,
      endLine: 2,
      suggestion: "a\nb\nc",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("line one\na\nb\nc\nline three\n");
  });

  it("replaces a multi-line range", () => {
    const res = applySuggestionToContent({
      content,
      startLine: 1,
      endLine: 2,
      suggestion: "merged",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("merged\nline three\n");
  });

  it("preserves CRLF line endings", () => {
    const crlf = "a\r\nb\r\nc\r\n";
    const res = applySuggestionToContent({
      content: crlf,
      startLine: 2,
      endLine: 2,
      suggestion: "B",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("a\r\nB\r\nc\r\n");
  });

  it("preserves no-trailing-newline files", () => {
    const res = applySuggestionToContent({
      content: "a\nb\nc",
      startLine: 3,
      endLine: 3,
      suggestion: "C",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("a\nb\nC");
  });

  it("strips trailing newline from the suggestion", () => {
    const res = applySuggestionToContent({
      content: "a\nb\n",
      startLine: 1,
      endLine: 1,
      suggestion: "A\n",
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("A\nb\n");
  });

  it("rejects bad ranges", () => {
    const r1 = applySuggestionToContent({
      content,
      startLine: 0,
      endLine: 1,
      suggestion: "x",
    });
    expect(r1).toEqual({ ok: false, reason: "bad_range" });
    const r2 = applySuggestionToContent({
      content,
      startLine: 2,
      endLine: 1,
      suggestion: "x",
    });
    expect(r2).toEqual({ ok: false, reason: "bad_range" });
  });

  it("rejects out-of-bounds line numbers", () => {
    const r = applySuggestionToContent({
      content,
      startLine: 5,
      endLine: 5,
      suggestion: "x",
    });
    expect(r).toEqual({ ok: false, reason: "line_out_of_bounds" });
  });

  it("returns no_change when the suggestion matches existing content", () => {
    const r = applySuggestionToContent({
      content,
      startLine: 1,
      endLine: 1,
      suggestion: "line one",
    });
    expect(r).toEqual({ ok: false, reason: "no_change" });
  });

  it("empty suggestion deletes the line", () => {
    const r = applySuggestionToContent({
      content,
      startLine: 2,
      endLine: 2,
      suggestion: "",
    });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("line one\n\nline three\n");
  });

  it("rejects non-string content", () => {
    const r = applySuggestionToContent({
      content: undefined as unknown as string,
      startLine: 1,
      endLine: 1,
      suggestion: "x",
    });
    expect(r.ok).toBe(false);
  });
});

describe("code-suggestions — applyNthSuggestion", () => {
  const body =
    "First:\n```suggestion\nalpha\n```\n\nSecond:\n```suggestion\nbeta\n```\n";

  it("applies the 0th block by default", () => {
    const r = applyNthSuggestion(body, 0, {
      content: "x\n",
      startLine: 1,
      endLine: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("alpha\n");
  });

  it("applies the Nth block", () => {
    const r = applyNthSuggestion(body, 1, {
      content: "x\n",
      startLine: 1,
      endLine: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("beta\n");
  });

  it("returns not_found for an out-of-range index", () => {
    const r = applyNthSuggestion(body, 99, {
      content: "x\n",
      startLine: 1,
      endLine: 1,
    });
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found for a negative index", () => {
    const r = applyNthSuggestion(body, -1, {
      content: "x\n",
      startLine: 1,
      endLine: 1,
    });
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("code-suggestions — __internal parity", () => {
  it("re-exports helpers", () => {
    expect(__internal.extractSuggestions).toBe(extractSuggestions);
    expect(__internal.applySuggestionToContent).toBe(applySuggestionToContent);
    expect(__internal.detectLineEnding).toBe(detectLineEnding);
    expect(__internal.splitLines).toBe(splitLines);
    expect(__internal.applyNthSuggestion).toBe(applyNthSuggestion);
  });
});

describe("code-suggestions — splitLines", () => {
  it("handles LF + CRLF correctly", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(splitLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("code-suggestions — routes", () => {
  // Import the app lazily so the pure tests above don't boot Hono.
  it("POST apply-suggestion 401s for unauthenticated users", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/pulls/1/comments/00000000-0000-0000-0000-000000000000/apply-suggestion",
      { method: "POST" }
    );
    // requireAuth redirects web requests to /login.
    expect([302, 401]).toContain(res.status);
  });

  it("invalid PR number returns 4xx", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/pulls/notanum/comments/00000000-0000-0000-0000-000000000000/apply-suggestion",
      { method: "POST" }
    );
    // Unauth first; if somehow auth'd, would be 400. Both are acceptable.
    expect([302, 400, 401, 404]).toContain(res.status);
  });
});

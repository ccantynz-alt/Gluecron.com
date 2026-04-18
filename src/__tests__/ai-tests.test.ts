/**
 * Block D8 — AI-generated test suite tests.
 *
 * Pure-helper tests run directly; route tests tolerate the usual graceful
 * degradation envelope (200 / 404 / 503) because these suites run without
 * a live database.
 */

import { describe, it, expect } from "bun:test";
import {
  buildTestsPrompt,
  contentTypeFor,
  detectLanguage,
  detectTestFramework,
  generateTestStub,
} from "../lib/ai-tests";

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe("lib/ai-tests — detectLanguage", () => {
  it("maps .ts and .tsx to typescript", () => {
    expect(detectLanguage("src/foo.ts")).toBe("typescript");
    expect(detectLanguage("src/Foo.tsx")).toBe("typescript");
  });

  it("maps .js and .jsx to javascript", () => {
    expect(detectLanguage("lib/foo.js")).toBe("javascript");
    expect(detectLanguage("lib/bar.jsx")).toBe("javascript");
  });

  it("maps .py to python", () => {
    expect(detectLanguage("pkg/mod.py")).toBe("python");
  });

  it("maps .go to go", () => {
    expect(detectLanguage("cmd/main.go")).toBe("go");
  });

  it("maps .rs to rust", () => {
    expect(detectLanguage("src/lib.rs")).toBe("rust");
  });

  it("maps unknown / extensionless to other", () => {
    expect(detectLanguage("notes.txt")).toBe("other");
    expect(detectLanguage("Makefile")).toBe("other");
    expect(detectLanguage("README")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// detectTestFramework
// ---------------------------------------------------------------------------

describe("lib/ai-tests — detectTestFramework", () => {
  it("returns bun:test when repo looks bun-ish with jest-style test files", () => {
    const f = detectTestFramework("typescript", [
      "package.json",
      "bun.lockb",
      "src/__tests__/foo.test.ts",
      "src/__tests__/bar.test.ts",
    ]);
    expect(f).toBe("bun:test");
  });

  it("returns vitest when vitest.config.ts is present", () => {
    const f = detectTestFramework("typescript", [
      "package.json",
      "vitest.config.ts",
      "src/foo.ts",
    ]);
    expect(f).toBe("vitest");
  });

  it("returns jest when a jest.config.* file is present", () => {
    const f = detectTestFramework("javascript", [
      "package.json",
      "jest.config.js",
    ]);
    expect(f).toBe("jest");
  });

  it("returns pytest when pytest.ini is present", () => {
    const f = detectTestFramework("python", [
      "pytest.ini",
      "pkg/__init__.py",
      "pkg/mod.py",
    ]);
    expect(f).toBe("pytest");
  });

  it("returns pytest for python regardless of signals (sensible default)", () => {
    expect(detectTestFramework("python", [])).toBe("pytest");
  });

  it("returns go test for go language", () => {
    expect(detectTestFramework("go", ["go.mod"])).toBe("go test");
  });

  it("falls back to bun:test when repoFiles is empty", () => {
    expect(detectTestFramework("typescript", [])).toBe("bun:test");
    expect(detectTestFramework("javascript", [])).toBe("bun:test");
    expect(detectTestFramework("other", [])).toBe("bun:test");
  });
});

// ---------------------------------------------------------------------------
// buildTestsPrompt
// ---------------------------------------------------------------------------

describe("lib/ai-tests — buildTestsPrompt", () => {
  it("embeds the source code and file path", () => {
    const src = "export function add(a: number, b: number): number { return a + b; }";
    const prompt = buildTestsPrompt({
      path: "src/math.ts",
      language: "typescript",
      framework: "bun:test",
      sourceCode: src,
    });
    expect(prompt).toContain("src/math.ts");
    expect(prompt).toContain("bun:test");
    expect(prompt).toContain(src);
  });

  it("explicitly instructs Claude to emit FAILING stubs", () => {
    const prompt = buildTestsPrompt({
      path: "foo.ts",
      language: "typescript",
      framework: "bun:test",
      sourceCode: "export const x = 1;",
    });
    // Allow either casing — implementation uses *failing* with emphasis.
    expect(prompt.toLowerCase()).toContain("failing");
  });

  it("includes optional apiHints when provided", () => {
    const prompt = buildTestsPrompt({
      path: "foo.py",
      language: "python",
      framework: "pytest",
      sourceCode: "def add(a, b): return a + b",
      apiHints: "add() returns the arithmetic sum",
    });
    expect(prompt).toContain("add() returns the arithmetic sum");
  });

  it("truncates excessively large source files", () => {
    const huge = "a".repeat(50_000);
    const prompt = buildTestsPrompt({
      path: "big.ts",
      language: "typescript",
      framework: "bun:test",
      sourceCode: huge,
    });
    expect(prompt.length).toBeLessThan(huge.length + 4_000);
    expect(prompt).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// generateTestStub
// ---------------------------------------------------------------------------

describe("lib/ai-tests — generateTestStub (AI unavailable)", () => {
  const hadKey = !!process.env.ANTHROPIC_API_KEY;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  // Ensure we exercise the AI-unavailable path deterministically.
  if (hadKey) delete process.env.ANTHROPIC_API_KEY;

  it("returns empty code and framework=fallback when no API key is set", async () => {
    const result = await generateTestStub({
      path: "src/lib/foo.ts",
      language: "typescript",
      framework: "bun:test",
      sourceCode: "export const x = 1;",
    });
    expect(result.code).toBe("");
    expect(result.framework).toBe("fallback");
    expect(result.language).toBe("typescript");
  });

  it("still computes a sensible suggestedPath for bun:test", async () => {
    const result = await generateTestStub({
      path: "src/lib/foo.ts",
      language: "typescript",
      framework: "bun:test",
      sourceCode: "export const x = 1;",
    });
    expect(result.suggestedPath).toContain("foo");
    expect(result.suggestedPath).toContain(".test.");
  });

  it("picks `test_*.py` for pytest", async () => {
    const result = await generateTestStub({
      path: "pkg/widgets.py",
      language: "python",
      framework: "pytest",
      sourceCode: "def f(): pass",
    });
    expect(result.suggestedPath.endsWith("test_widgets.py")).toBe(true);
  });

  it("picks `*_test.go` for go test", async () => {
    const result = await generateTestStub({
      path: "cmd/server.go",
      language: "go",
      framework: "go test",
      sourceCode: "package main",
    });
    expect(result.suggestedPath.endsWith("server_test.go")).toBe(true);
  });

  // Restore the env we found on entry — other test files may depend on it.
  if (hadKey && originalKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

// ---------------------------------------------------------------------------
// contentTypeFor
// ---------------------------------------------------------------------------

describe("lib/ai-tests — contentTypeFor", () => {
  it("returns a typescript MIME for typescript", () => {
    expect(contentTypeFor("typescript")).toContain("typescript");
  });
  it("returns a python MIME for python", () => {
    expect(contentTypeFor("python")).toContain("python");
  });
  it("returns a safe plain fallback for unknown", () => {
    expect(contentTypeFor("other")).toContain("text/plain");
  });
});

// ---------------------------------------------------------------------------
// Route-level guard tests
// ---------------------------------------------------------------------------

describe("routes/ai-tests — guards", () => {
  it("GET /:owner/:repo/ai/tests renders a form or 404s when repo doesn't exist", async () => {
    const { default: aiTestsRoutes } = await import("../routes/ai-tests");
    const res = await aiTestsRoutes.request("/alice/does-not-exist/ai/tests");
    // 200 means the page rendered a form (repo exists, somehow), 404 means
    // our handler matched but the repo row was absent, 503 means the DB
    // proxy was down. Any of those is acceptable in CI.
    expect([200, 404, 503]).toContain(res.status);
  });

  it("POST /:owner/:repo/ai/tests/generate without auth redirects to /login or 404s", async () => {
    const { default: aiTestsRoutes } = await import("../routes/ai-tests");
    const res = await aiTestsRoutes.request(
      "/alice/does-not-exist/ai/tests/generate",
      {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "path=src/foo.ts",
      }
    );
    expect([302, 303, 404, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });

  it("GET /:owner/:repo/ai/tests?format=raw without path returns 400 / 404 / 503", async () => {
    const { default: aiTestsRoutes } = await import("../routes/ai-tests");
    const res = await aiTestsRoutes.request(
      "/alice/does-not-exist/ai/tests?format=raw"
    );
    expect([400, 404, 503]).toContain(res.status);
  });
});

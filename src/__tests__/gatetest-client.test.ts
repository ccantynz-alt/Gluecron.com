/**
 * Block K — Gatetest client tests.
 *
 * Exercises the env-driven configuration toggle, the auth header builder,
 * and the offline short-circuits. When a key is present, we mock
 * globalThis.fetch with a 500 to confirm graceful degradation to the
 * offline result shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildAuthHeaders,
  healSuite,
  isConfigured,
  runAndRepair,
  stackTraceToTest,
} from "../lib/gatetest-client";

const ENV_KEYS = ["GATETEST_API_KEY", "GATETEST_BASE_URL"] as const;

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Start every test with a clean slate.
  for (const k of ENV_KEYS) delete process.env[k];
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = savedFetch;
});

// ---------------------------------------------------------------------------
// isConfigured
// ---------------------------------------------------------------------------

describe("gatetest-client — isConfigured", () => {
  it("returns false when no API key is set", () => {
    expect(isConfigured()).toBe(false);
  });

  it("returns true once GATETEST_API_KEY is set", () => {
    process.env.GATETEST_API_KEY = "sk-test-abc";
    expect(isConfigured()).toBe(true);
  });

  it("flips back to false when the key is removed mid-process", () => {
    process.env.GATETEST_API_KEY = "sk-test-abc";
    expect(isConfigured()).toBe(true);
    delete process.env.GATETEST_API_KEY;
    expect(isConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAuthHeaders
// ---------------------------------------------------------------------------

describe("gatetest-client — buildAuthHeaders", () => {
  it("returns only Content-Type when no key is present", () => {
    const h = buildAuthHeaders();
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBeUndefined();
  });

  it("includes a Bearer token when the key is present", () => {
    process.env.GATETEST_API_KEY = "sk-live-xyz";
    const h = buildAuthHeaders();
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBe("Bearer sk-live-xyz");
  });
});

// ---------------------------------------------------------------------------
// runAndRepair
// ---------------------------------------------------------------------------

describe("gatetest-client — runAndRepair", () => {
  it("returns offline result with zeros when no API key is set", async () => {
    // No fetch mock — the method MUST short-circuit.
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called in offline mode");
    }) as unknown as typeof fetch;
    const result = await runAndRepair({ repo: "o/r", ref: "main" });
    expect(result.offline).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.totalTests).toBe(0);
    expect(result.failedBefore).toBe(0);
    expect(result.failedAfter).toBe(0);
    expect(result.repairs).toEqual([]);
    expect(result.unfixable).toEqual([]);
    expect(result.durationMs).toBe(0);
  });

  it("falls back to offline on a 500 response", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const result = await runAndRepair({ repo: "o/r", ref: "main" });
    expect(result.offline).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.totalTests).toBe(0);
  });

  it("parses a healthy 200 response into a structured result", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    const payload = {
      passed: true,
      totalTests: 42,
      failedBefore: 3,
      failedAfter: 0,
      repairs: [
        { file: "a.ts", before: "x", after: "y", reason: "flake" },
      ],
      unfixable: [],
      durationMs: 12345,
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await runAndRepair({
      repo: "o/r",
      ref: "main",
      targetGlob: "src/**",
    });
    expect(result.offline).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.totalTests).toBe(42);
    expect(result.repairs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stackTraceToTest
// ---------------------------------------------------------------------------

describe("gatetest-client — stackTraceToTest", () => {
  it("returns a deterministic offline stub when no key is set", async () => {
    const result = await stackTraceToTest({
      repo: "o/r",
      stackTrace: "TypeError: cannot read 'x' of undefined\n  at foo",
      language: "typescript",
    });
    expect(result.offline).toBe(true);
    expect(result.framework).toBe("fallback");
    expect(result.testCode).toContain("TODO");
    expect(result.suggestedPath.endsWith(".test.ts")).toBe(true);
  });

  it("picks a pytest path for python offline stubs", async () => {
    const result = await stackTraceToTest({
      repo: "o/r",
      stackTrace: "AttributeError: foo",
      language: "python",
    });
    expect(result.offline).toBe(true);
    expect(result.suggestedPath.endsWith(".py")).toBe(true);
    expect(result.testCode).toContain("def test_");
  });

  it("falls back to offline on a 500 response", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response("down", { status: 500 })) as unknown as typeof fetch;
    const result = await stackTraceToTest({
      repo: "o/r",
      stackTrace: "boom",
    });
    expect(result.offline).toBe(true);
    expect(result.framework).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// healSuite
// ---------------------------------------------------------------------------

describe("gatetest-client — healSuite", () => {
  it("returns offline zeros when no key is set", async () => {
    const result = await healSuite({ repo: "o/r" });
    expect(result.offline).toBe(true);
    expect(result.flakyFound).toBe(0);
    expect(result.deadFound).toBe(0);
    expect(result.coverageGapsFound).toBe(0);
    expect(result.prDraftBranch).toBeNull();
  });

  it("falls back to offline on a 500 response", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response("fail", { status: 500 })) as unknown as typeof fetch;
    const result = await healSuite({ repo: "o/r" });
    expect(result.offline).toBe(true);
    expect(result.flakyFound).toBe(0);
  });

  it("falls back to offline when fetch itself throws (network down)", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await healSuite({ repo: "o/r" });
    expect(result.offline).toBe(true);
    expect(result.prDraftBranch).toBeNull();
  });

  it("parses a healthy 200 response", async () => {
    process.env.GATETEST_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          flakyFound: 2,
          deadFound: 1,
          coverageGapsFound: 4,
          prDraftBranch: "gatetest/heal-42",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;
    const result = await healSuite({ repo: "o/r" });
    expect(result.offline).toBe(false);
    expect(result.flakyFound).toBe(2);
    expect(result.prDraftBranch).toBe("gatetest/heal-42");
  });
});

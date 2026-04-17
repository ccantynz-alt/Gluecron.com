/**
 * Block K — Gatetest HTTP client.
 *
 * Typed tool primitives that K-agents call to drive Gatetest (external
 * testing / test-repair platform). Each primitive hits the documented
 * endpoint when `GATETEST_API_KEY` is set and falls back to a deterministic
 * offline mode otherwise. No method throws — callers get a well-formed
 * result with `offline: true` on any failure.
 *
 * Env vars (read lazily via getters so tests can flip them per-case):
 *   GATETEST_API_KEY   — bearer token for the Gatetest API (required)
 *   GATETEST_BASE_URL  — override base URL (default `https://gatetest.ai`)
 *
 * Endpoint shapes assumed (documented for the Gatetest team):
 *   POST {base}/api/v2/run-and-repair
 *     body: { repo, ref, targetGlob? }
 *     200 -> {
 *       passed: boolean,
 *       totalTests: number,
 *       failedBefore: number,
 *       failedAfter: number,
 *       repairs: [{ file, before, after, reason }],
 *       unfixable: [{ file, reason }],
 *       durationMs: number
 *     }
 *   POST {base}/api/v2/stack-to-test
 *     body: { repo, stackTrace, language? }
 *     200 -> { testCode, framework, suggestedPath }
 *   POST {base}/api/v2/heal-suite
 *     body: { repo }
 *     200 -> {
 *       flakyFound: number,
 *       deadFound: number,
 *       coverageGapsFound: number,
 *       prDraftBranch: string | null
 *     }
 */

// ---------------------------------------------------------------------------
// Env getters — read process.env at access time so tests can mutate freely.
// ---------------------------------------------------------------------------

export const gatetestEnv = {
  get apiKey(): string {
    return process.env.GATETEST_API_KEY || "";
  },
  get baseUrl(): string {
    return (process.env.GATETEST_BASE_URL || "https://gatetest.ai").replace(
      /\/+$/,
      ""
    );
  },
};

export function isConfigured(): boolean {
  return !!gatetestEnv.apiKey;
}

export function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = gatetestEnv.apiKey;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GatetestRepair = {
  file: string;
  before: string;
  after: string;
  reason: string;
};

export type GatetestUnfixable = {
  file: string;
  reason: string;
};

export type RunAndRepairResult = {
  passed: boolean;
  totalTests: number;
  failedBefore: number;
  failedAfter: number;
  repairs: GatetestRepair[];
  unfixable: GatetestUnfixable[];
  durationMs: number;
  offline: boolean;
};

export type StackTraceToTestResult = {
  testCode: string;
  framework: string;
  suggestedPath: string;
  offline: boolean;
};

export type HealSuiteResult = {
  flakyFound: number;
  deadFound: number;
  coverageGapsFound: number;
  prDraftBranch: string | null;
  offline: boolean;
};

// ---------------------------------------------------------------------------
// Offline defaults
// ---------------------------------------------------------------------------

function offlineRunAndRepair(): RunAndRepairResult {
  return {
    passed: false,
    totalTests: 0,
    failedBefore: 0,
    failedAfter: 0,
    repairs: [],
    unfixable: [],
    durationMs: 0,
    offline: true,
  };
}

function offlineHealSuite(): HealSuiteResult {
  return {
    flakyFound: 0,
    deadFound: 0,
    coverageGapsFound: 0,
    prDraftBranch: null,
    offline: true,
  };
}

function offlineStackToTest(
  stackTrace: string,
  language?: string
): StackTraceToTestResult {
  // Deterministic stub test. Intentionally decoupled from ai-tests.ts —
  // we're an offline fallback, not an AI-driven generator.
  const firstLine = (stackTrace || "").split("\n")[0]?.trim() || "error";
  const escaped = firstLine.replace(/[`\\]/g, "").slice(0, 200);
  const lang = (language || "typescript").toLowerCase();
  let suggestedPath = "tests/reproduce.test.ts";
  let testCode = "";
  if (lang === "python") {
    suggestedPath = "tests/test_reproduce.py";
    testCode =
      `# TODO: Gatetest is offline — replace this stub with a real reproducer.\n` +
      `# Seed stack-trace: ${escaped}\n` +
      `def test_reproduce():\n` +
      `    assert False, "offline stub: paste stack trace + repro here"\n`;
  } else if (lang === "go") {
    suggestedPath = "reproduce_test.go";
    testCode =
      `// TODO: Gatetest is offline — replace this stub with a real reproducer.\n` +
      `// Seed stack-trace: ${escaped}\n` +
      `package main\n\nimport "testing"\n\n` +
      `func TestReproduce(t *testing.T) {\n` +
      `\tt.Fatal("offline stub: paste stack trace + repro here")\n` +
      `}\n`;
  } else {
    testCode =
      `// TODO: Gatetest is offline — replace this stub with a real reproducer.\n` +
      `// Seed stack-trace: ${escaped}\n` +
      `import { test, expect } from "bun:test";\n\n` +
      `test("reproduce", () => {\n` +
      `  expect.unreachable("offline stub: paste stack trace + repro here");\n` +
      `});\n`;
  }
  return {
    testCode,
    framework: "fallback",
    suggestedPath,
    offline: true,
  };
}

// ---------------------------------------------------------------------------
// Shared fetch-with-timeout helper. Never throws — returns null on any
// failure so callers can flip to the offline branch.
// ---------------------------------------------------------------------------

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildAuthHeaders(),
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public primitives
// ---------------------------------------------------------------------------

export async function runAndRepair(params: {
  repo: string;
  ref: string;
  targetGlob?: string;
}): Promise<RunAndRepairResult> {
  if (!isConfigured()) return offlineRunAndRepair();
  const url = `${gatetestEnv.baseUrl}/api/v2/run-and-repair`;
  const data = (await postJson(url, params, 5 * 60 * 1000)) as
    | Partial<RunAndRepairResult>
    | null;
  if (!data || typeof data !== "object") return offlineRunAndRepair();
  return {
    passed: !!data.passed,
    totalTests: Number(data.totalTests || 0),
    failedBefore: Number(data.failedBefore || 0),
    failedAfter: Number(data.failedAfter || 0),
    repairs: Array.isArray(data.repairs) ? (data.repairs as GatetestRepair[]) : [],
    unfixable: Array.isArray(data.unfixable)
      ? (data.unfixable as GatetestUnfixable[])
      : [],
    durationMs: Number(data.durationMs || 0),
    offline: false,
  };
}

export async function stackTraceToTest(params: {
  repo: string;
  stackTrace: string;
  language?: string;
}): Promise<StackTraceToTestResult> {
  if (!isConfigured()) {
    return offlineStackToTest(params.stackTrace, params.language);
  }
  const url = `${gatetestEnv.baseUrl}/api/v2/stack-to-test`;
  const data = (await postJson(url, params, 60 * 1000)) as
    | Partial<StackTraceToTestResult>
    | null;
  if (!data || typeof data !== "object" || typeof data.testCode !== "string") {
    return offlineStackToTest(params.stackTrace, params.language);
  }
  return {
    testCode: data.testCode,
    framework: typeof data.framework === "string" ? data.framework : "unknown",
    suggestedPath:
      typeof data.suggestedPath === "string"
        ? data.suggestedPath
        : "tests/reproduce.test.ts",
    offline: false,
  };
}

export async function healSuite(params: {
  repo: string;
}): Promise<HealSuiteResult> {
  if (!isConfigured()) return offlineHealSuite();
  const url = `${gatetestEnv.baseUrl}/api/v2/heal-suite`;
  const data = (await postJson(url, params, 10 * 60 * 1000)) as
    | Partial<HealSuiteResult>
    | null;
  if (!data || typeof data !== "object") return offlineHealSuite();
  return {
    flakyFound: Number(data.flakyFound || 0),
    deadFound: Number(data.deadFound || 0),
    coverageGapsFound: Number(data.coverageGapsFound || 0),
    prDraftBranch:
      typeof data.prDraftBranch === "string" ? data.prDraftBranch : null,
    offline: false,
  };
}

export const __internal = {
  offlineRunAndRepair,
  offlineHealSuite,
  offlineStackToTest,
  postJson,
};

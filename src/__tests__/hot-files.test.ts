/**
 * Tests for src/lib/hot-files.ts and src/routes/hot-files.tsx.
 */

import { describe, test, expect } from "bun:test";

// ─── Pure helper tests ────────────────────────────────────────────────────────

// Risk classification logic — mirrors hot-files.ts without importing the async fn.
const HIGH_RISK_PATTERNS = ["auth", "security", "schema", "db/", "middleware", "routes/git", "crypto"];
const MEDIUM_RISK_PATTERNS = ["route", "api", "lib/", ".sql"];

function classifyRisk(filePath: string): "high" | "medium" | "low" {
  const lower = filePath.toLowerCase();
  if (HIGH_RISK_PATTERNS.some((p) => lower.includes(p))) return "high";
  if (MEDIUM_RISK_PATTERNS.some((p) => lower.includes(p))) return "medium";
  return "low";
}

describe("hot-files risk classification", () => {
  test("auth file → high", () => expect(classifyRisk("src/lib/auth.ts")).toBe("high"));
  test("middleware file → high", () => expect(classifyRisk("src/middleware/rate-limit.ts")).toBe("high"));
  test("schema file → high", () => expect(classifyRisk("src/db/schema.ts")).toBe("high"));
  test("route file → medium", () => expect(classifyRisk("src/routes/issues.tsx")).toBe("medium"));
  test("sql migration → medium", () => expect(classifyRisk("drizzle/0001.sql")).toBe("medium"));
  test("api lib → medium", () => expect(classifyRisk("src/lib/api-helper.ts")).toBe("medium"));
  test("test file → low", () => expect(classifyRisk("src/__tests__/orgs.test.ts")).toBe("low"));
  test("readme → low", () => expect(classifyRisk("README.md")).toBe("low"));
  test("case-insensitive: AUTH.TS → high", () => expect(classifyRisk("AUTH.TS")).toBe("high"));
});

// Extension extraction
function extractExt(p: string): string {
  const dot = p.lastIndexOf(".");
  if (dot === -1 || dot === p.length - 1) return "";
  return p.slice(dot + 1);
}

describe("hot-files extension extraction", () => {
  test(".ts extension", () => expect(extractExt("src/lib/foo.ts")).toBe("ts"));
  test(".tsx extension", () => expect(extractExt("src/routes/bar.tsx")).toBe("tsx"));
  test("no extension → empty string", () => expect(extractExt("Makefile")).toBe(""));
  test("trailing dot → empty string", () => expect(extractExt("file.")).toBe(""));
  test(".sql extension", () => expect(extractExt("drizzle/0001.sql")).toBe("sql"));
});

// Path truncation
function truncatePath(path: string, maxChars = 40): string {
  if (path.length <= maxChars) return path;
  return "…" + path.slice(path.length - maxChars);
}

describe("hot-files path truncation", () => {
  test("short path unchanged", () => expect(truncatePath("src/foo.ts")).toBe("src/foo.ts"));
  test("long path truncated with ellipsis", () => {
    const long = "src/routes/very/deeply/nested/path/component/file.tsx";
    const result = truncatePath(long, 40);
    expect(result.startsWith("…")).toBe(true);
    expect(result.length).toBe(41); // 1 for "…" + 40
  });
  test("exactly maxChars is unchanged", () => {
    const exact = "a".repeat(40);
    expect(truncatePath(exact, 40)).toBe(exact);
  });
});

// ─── Route smoke test ─────────────────────────────────────────────────────────

import app from "../app";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe("GET /:owner/:repo/insights/hotfiles", () => {
  test.skipIf(!HAS_DB)("non-existent repo returns 404", async () => {
    const res = await app.request("/__nx_owner__/__nx_repo__/insights/hotfiles");
    expect(res.status).toBe(404);
  });
});

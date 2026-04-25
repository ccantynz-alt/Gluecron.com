/**
 * Pure-function tests for the AI flywheel layer.
 * recordAi/persist exercise the DB; covered by integration smoke elsewhere.
 */

import { describe, it, expect } from "bun:test";
import { __test } from "../lib/ai-flywheel";

const { redact, clamp, clampInt } = __test;

describe("ai-flywheel — redact", () => {
  it("strips bearer tokens", () => {
    const out = redact("Authorization: Bearer abcdef.ghijkl");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("abcdef");
  });

  it("strips Anthropic-style sk- keys", () => {
    const out = redact("error sk-ant-api01-AAAA-BBBB-CCCC");
    expect(out).toContain("[REDACTED]");
  });

  it("strips gluecron PATs", () => {
    const out = redact("token glc_abcd1234efgh5678 leaked");
    expect(out).toContain("[REDACTED]");
  });

  it("returns the input unchanged when nothing matches", () => {
    const out = redact("plain message with no secret");
    expect(out).toBe("plain message with no secret");
  });
});

describe("ai-flywheel — clamp", () => {
  it("returns input untouched when short", () => {
    expect(clamp("hello", 100)).toBe("hello");
  });
  it("truncates with ellipsis when too long", () => {
    const result = clamp("a".repeat(50), 10);
    expect(result.length).toBe(10);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("ai-flywheel — clampInt", () => {
  it("clamps below lo", () => {
    expect(clampInt(-5, 1, 100)).toBe(1);
  });
  it("clamps above hi", () => {
    expect(clampInt(500, 1, 100)).toBe(100);
  });
  it("floors fractional", () => {
    expect(clampInt(2.7, 1, 100)).toBe(2);
  });
  it("passes through valid values", () => {
    expect(clampInt(42, 1, 100)).toBe(42);
  });
});

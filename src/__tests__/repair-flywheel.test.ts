/**
 * Tests for the deterministic parts of the flywheel: failure normalisation
 * and fingerprinting. The DB-touching functions are exercised in higher-
 * level integration tests against a live Postgres.
 *
 * Goal: prove that failures with the same root cause but different variable
 * bits (line numbers, paths, timestamps, hashes) collapse to the same
 * signature. That's the property that makes the cache work.
 */
import { describe, expect, it } from "bun:test";
import { fingerprint, normaliseFailure } from "../lib/repair-flywheel";

describe("normaliseFailure", () => {
  it("strips line + column numbers", () => {
    const a = normaliseFailure("Error at /opt/app/src/foo.ts:42:13");
    const b = normaliseFailure("Error at /opt/app/src/foo.ts:1099:7");
    expect(a).toBe(b);
  });

  it("strips ISO-8601 timestamps", () => {
    const a = normaliseFailure("Failed at 2026-05-08T22:14:15.123Z");
    const b = normaliseFailure("Failed at 2025-01-01T00:00:00Z");
    expect(a).toBe(b);
  });

  it("strips full SHA-1 commit hashes", () => {
    const a = normaliseFailure("revert b0a3ba2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80");
    const b = normaliseFailure("revert deadbeefcafebabedeadbeefcafebabedeadbeef");
    expect(a).toBe(b);
  });

  it("strips UUIDs", () => {
    const a = normaliseFailure(
      "request-id 550e8400-e29b-41d4-a716-446655440000 failed",
    );
    const b = normaliseFailure(
      "request-id 6ba7b810-9dad-11d1-80b4-00c04fd430c8 failed",
    );
    expect(a).toBe(b);
  });

  it("strips absolute paths on linux + windows", () => {
    const a = normaliseFailure("ENOENT /home/runner/work/foo/bar.ts");
    const b = normaliseFailure("ENOENT /tmp/runner/zzz/bar.ts");
    const c = normaliseFailure("ENOENT C:\\Users\\runner\\bar.ts");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("strips ANSI colour codes", () => {
    const a = normaliseFailure("\x1b[31merror:\x1b[0m lockfile mismatch");
    const b = normaliseFailure("error: lockfile mismatch");
    expect(a).toBe(b);
  });

  it("strips quoted strings (often contain user data)", () => {
    const a = normaliseFailure(`expected 'alice@example.com' to match pattern`);
    const b = normaliseFailure(`expected 'bob@other.com' to match pattern`);
    expect(a).toBe(b);
  });

  it("collapses whitespace + lowercases", () => {
    const a = normaliseFailure("ERROR:    Lockfile out of sync");
    const b = normaliseFailure("error: lockfile out of sync");
    expect(a).toBe(b);
  });

  it("does NOT collapse genuinely different errors", () => {
    const a = normaliseFailure("error: lockfile is out of sync");
    const b = normaliseFailure("TypeError: cannot read property of undefined");
    expect(a).not.toBe(b);
  });
});

describe("fingerprint", () => {
  it("produces a 32-char hex string", () => {
    const sig = fingerprint("any failure text");
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is stable across calls", () => {
    const text = "error: bun install failed: lockfile mismatch at line 42";
    expect(fingerprint(text)).toBe(fingerprint(text));
  });

  it("collapses semantically-identical failures to one signature", () => {
    const a = fingerprint(
      "TypeError at /home/runner/work/proj/src/foo.ts:42:13 in commit b0a3ba2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80",
    );
    const b = fingerprint(
      "TypeError at /tmp/build/x/src/foo.ts:9999:1 in commit deadbeefcafebabedeadbeefcafebabedeadbeef",
    );
    expect(a).toBe(b);
  });

  it("differs for genuinely different failures", () => {
    const a = fingerprint("error: lockfile is out of sync");
    const b = fingerprint("TypeError: cannot read property of undefined");
    expect(a).not.toBe(b);
  });
});

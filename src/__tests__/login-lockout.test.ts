import { describe, expect, test } from "bun:test";
import {
  evaluateLockout,
  retryAfterMinutes,
  LOGIN_FAIL_LIMIT,
  LOGIN_LOCKOUT_MS,
} from "../lib/login-lockout";

const NOW = new Date("2026-06-12T12:00:00Z");

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60_000);
}

describe("evaluateLockout", () => {
  test("not locked with zero failures", () => {
    const s = evaluateLockout({ failureCount: 0, newestFailureAt: null, now: NOW });
    expect(s.locked).toBe(false);
    expect(s.retryAfterMs).toBe(0);
  });

  test("not locked below the failure limit", () => {
    const s = evaluateLockout({
      failureCount: LOGIN_FAIL_LIMIT - 1,
      newestFailureAt: minutesAgo(1),
      now: NOW,
    });
    expect(s.locked).toBe(false);
  });

  test("locked at the limit with a fresh failure", () => {
    const s = evaluateLockout({
      failureCount: LOGIN_FAIL_LIMIT,
      newestFailureAt: minutesAgo(1),
      now: NOW,
    });
    expect(s.locked).toBe(true);
    expect(s.retryAfterMs).toBe(LOGIN_LOCKOUT_MS - 60_000);
  });

  test("lockout EXPIRES 15 minutes after the newest failure", () => {
    // This is the regression case: previously the lockout never expired
    // because blocked attempts were recorded as new failures.
    const s = evaluateLockout({
      failureCount: LOGIN_FAIL_LIMIT + 5,
      newestFailureAt: minutesAgo(16),
      now: NOW,
    });
    expect(s.locked).toBe(false);
    expect(s.retryAfterMs).toBe(0);
  });

  test("boundary: exactly LOCKOUT_MS after newest failure is unlocked", () => {
    const s = evaluateLockout({
      failureCount: LOGIN_FAIL_LIMIT,
      newestFailureAt: new Date(NOW.getTime() - LOGIN_LOCKOUT_MS),
      now: NOW,
    });
    expect(s.locked).toBe(false);
  });

  test("many failures but missing newest timestamp fails open", () => {
    const s = evaluateLockout({
      failureCount: 100,
      newestFailureAt: null,
      now: NOW,
    });
    expect(s.locked).toBe(false);
  });
});

describe("retryAfterMinutes", () => {
  test("rounds up and is at least 1", () => {
    expect(
      retryAfterMinutes({ locked: true, failureCount: 10, retryAfterMs: 61_000 })
    ).toBe(2);
    expect(
      retryAfterMinutes({ locked: true, failureCount: 10, retryAfterMs: 1 })
    ).toBe(1);
    expect(
      retryAfterMinutes({ locked: false, failureCount: 0, retryAfterMs: 0 })
    ).toBe(1);
  });
});

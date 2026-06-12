/**
 * Login lockout policy (SOC 2 CC6.1) — pure evaluator.
 *
 * Semantics:
 *   - An account email is locked when it has accumulated at least
 *     `LOGIN_FAIL_LIMIT` failed attempts inside the trailing
 *     `LOGIN_FAIL_WINDOW_MS`, AND the most recent failure is younger than
 *     `LOGIN_LOCKOUT_MS`. The lockout therefore expires 15 minutes after
 *     the last *genuine* failed password attempt.
 *   - Attempts made while locked must NOT be recorded as failures —
 *     otherwise the lockout window rolls forward forever and a user
 *     retrying their (correct) password can never get back in. This was
 *     the production bug that made "Account temporarily locked … try again
 *     in 15 minutes" permanent.
 *   - A successful login clears the failure history for that email so a
 *     later single typo can't instantly re-trip a stale window.
 *
 * Kept pure (no DB access) so the policy is unit-testable; the route layer
 * supplies the aggregate counts.
 */

export const LOGIN_FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const LOGIN_FAIL_LIMIT = 10;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface LockoutInput {
  /** Failed attempts for this email inside the trailing window. */
  failureCount: number;
  /** Timestamp of the most recent failed attempt, or null if none. */
  newestFailureAt: Date | null;
  /** Injectable clock for tests; defaults to now. */
  now?: Date;
}

export interface LockoutState {
  locked: boolean;
  failureCount: number;
  /** Milliseconds until the lockout lifts (0 when not locked). */
  retryAfterMs: number;
}

export function evaluateLockout(input: LockoutInput): LockoutState {
  const now = input.now ?? new Date();
  const count = Math.max(0, input.failureCount);
  if (count < LOGIN_FAIL_LIMIT || !input.newestFailureAt) {
    return { locked: false, failureCount: count, retryAfterMs: 0 };
  }
  const sinceNewest = now.getTime() - input.newestFailureAt.getTime();
  if (sinceNewest >= LOGIN_LOCKOUT_MS) {
    return { locked: false, failureCount: count, retryAfterMs: 0 };
  }
  return {
    locked: true,
    failureCount: count,
    retryAfterMs: LOGIN_LOCKOUT_MS - sinceNewest,
  };
}

/** Human-friendly "try again in N minutes" figure, always at least 1. */
export function retryAfterMinutes(state: LockoutState): number {
  return Math.max(1, Math.ceil(state.retryAfterMs / 60_000));
}

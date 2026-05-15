/**
 * In-memory rate limiter middleware.
 *
 * Provides per-IP rate limiting with sliding window counters.
 * For production, replace with Redis-based implementation.
 */

import { createMiddleware } from "hono/factory";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 60 seconds
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, 60_000);

interface RateLimitOptions {
  /**
   * Endpoints that should never count against the bucket. Compared against
   * c.req.path with .startsWith(). Used for high-frequency dashboard
   * plumbing (e.g. `/api/version` is polled every 15s by the layout) so
   * normal navigation doesn't exhaust an admin's `/api/*` budget.
   */
  skipPaths?: string[];
  /**
   * Multiplier applied when c.get("user") is set by an upstream softAuth.
   * 1 = anonymous limit. Default 4 so an authed user gets 4x the bucket
   * (admins doing admin work shouldn't hit /api/* limits during normal
   * navigation; anonymous traffic still gets the strict cap).
   */
  authedMultiplier?: number;
}

/**
 * Create a rate limiter middleware.
 * @param maxRequests Maximum requests per window for ANONYMOUS callers
 * @param windowMs Window duration in milliseconds
 * @param keyPrefix Prefix for the rate limit key (allows different limits per route group)
 * @param opts Optional skip-paths and authed multiplier.
 */
export function rateLimit(
  maxRequests: number,
  windowMs: number,
  keyPrefix = "global",
  opts: RateLimitOptions = {}
) {
  const skipPaths = opts.skipPaths || [];
  const authedMultiplier = opts.authedMultiplier ?? 4;
  return createMiddleware(async (c, next) => {
    // In test env, expose informational rate-limit headers but do not actually
    // enforce limits — the shared in-memory store leaks across test files and
    // would push requests into 429 once accumulated.
    //
    // Belt-and-braces: refuse to disable enforcement when NODE_ENV=production
    // even if BUN_ENV/NODE_ENV are also somehow set to "test". A misconfigured
    // production container with a leaked test env var must not silently drop
    // rate limiting.
    const isTestEnv =
      process.env.NODE_ENV !== "production" &&
      (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test");
    if (isTestEnv) {
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", String(maxRequests));
      c.header("X-RateLimit-Reset", String(Math.ceil((Date.now() + windowMs) / 1000)));
      return next();
    }

    // Skip-path exemption — applied to dashboard plumbing endpoints that the
    // layout polls on a fixed cadence and that we don't want consuming an
    // authenticated user's per-IP budget.
    const path = c.req.path;
    for (const prefix of skipPaths) {
      if (path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?")) {
        return next();
      }
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    // Effective cap: authed users get a multiplier so a logged-in admin
    // clicking around doesn't share the anonymous limit. We DON'T key the
    // bucket per-user — keeping it per-IP is the strongest defence against
    // a stolen-session bot — but a logged-in session signals "human at the
    // keyboard", so we lift the ceiling.
    const user = c.get("user" as never) as { id?: string } | null | undefined;
    const effectiveMax = user ? maxRequests * authedMultiplier : maxRequests;

    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers (report the effective cap so clients see the
    // bucket they're actually subject to).
    c.header("X-RateLimit-Limit", String(effectiveMax));
    c.header("X-RateLimit-Remaining", String(Math.max(0, effectiveMax - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > effectiveMax) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json(
        {
          error: "Rate limit exceeded",
          retryAfter: Math.ceil((entry.resetAt - now) / 1000),
        },
        429
      );
    }

    return next();
  });
}

/**
 * Pre-configured rate limiters for different route groups.
 */
export function clearRateLimitStore() {
  store.clear();
}

export const apiRateLimit = rateLimit(100, 60_000, "api"); // 100 req/min
export const authRateLimit = rateLimit(10, 60_000, "auth"); // 10 req/min (login/register)
export const gitRateLimit = rateLimit(60, 60_000, "git"); // 60 req/min
export const searchRateLimit = rateLimit(30, 60_000, "search"); // 30 req/min

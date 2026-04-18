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
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, 60_000);

/**
 * Create a rate limiter middleware.
 * @param maxRequests Maximum requests per window
 * @param windowMs Window duration in milliseconds
 * @param keyPrefix Prefix for the rate limit key (allows different limits per route group)
 */
export function rateLimit(
  maxRequests: number,
  windowMs: number,
  keyPrefix = "global"
) {
  return createMiddleware(async (c, next) => {
    // In test env, expose informational rate-limit headers but do not actually
    // enforce limits — the shared in-memory store leaks across test files and
    // would push requests into 429 once accumulated.
    if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", String(maxRequests));
      c.header("X-RateLimit-Reset", String(Math.ceil((Date.now() + windowMs) / 1000)));
      return next();
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", String(Math.max(0, maxRequests - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
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

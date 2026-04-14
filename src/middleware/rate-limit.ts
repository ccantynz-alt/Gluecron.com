/**
 * Rate limiter — in-memory fixed-window counter keyed by IP (or token).
 *
 * Simple on purpose. For multi-node deployments swap the Map for the
 * `rate_limit_buckets` Postgres table (schema is already there).
 */

import { createMiddleware } from "hono/factory";

interface Bucket {
  count: number;
  windowStart: number;
}

const store = new Map<string, Bucket>();

function clientKey(c: any, prefix: string): string {
  const auth = c.req.header("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return `${prefix}:token:${auth.slice(7, 20)}`;
  }
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    c.env?.ip ||
    "unknown";
  return `${prefix}:ip:${ip}`;
}

export function rateLimit(opts: { windowMs: number; max: number; prefix?: string }) {
  const prefix = opts.prefix || "rl";
  return createMiddleware(async (c, next) => {
    const key = clientKey(c, prefix);
    const now = Date.now();
    const bucket = store.get(key);
    let count = 1;
    if (!bucket || now - bucket.windowStart > opts.windowMs) {
      store.set(key, { count: 1, windowStart: now });
    } else {
      bucket.count++;
      count = bucket.count;
      if (bucket.count > opts.max) {
        const retryMs = opts.windowMs - (now - bucket.windowStart);
        return c.json(
          { error: "Too many requests", retryAfterMs: retryMs },
          429,
          {
            "Retry-After": String(Math.ceil(retryMs / 1000)),
            "X-RateLimit-Limit": String(opts.max),
            "X-RateLimit-Remaining": "0",
          }
        );
      }
    }
    // Periodic sweep (every 5 min worth of requests)
    if (store.size > 10_000) {
      for (const [k, b] of store) {
        if (now - b.windowStart > opts.windowMs * 2) store.delete(k);
      }
    }
    await next();
    // Set rate-limit headers on the final response (persists even if handler errored)
    if (c.res) {
      c.res.headers.set("X-RateLimit-Limit", String(opts.max));
      c.res.headers.set(
        "X-RateLimit-Remaining",
        String(Math.max(0, opts.max - count))
      );
    }
  });
}

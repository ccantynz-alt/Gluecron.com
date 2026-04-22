/**
 * Health + metrics endpoints for load-balancer + observability.
 *
 *   GET /healthz   — liveness (always 200 if process alive)
 *   GET /readyz    — readiness (checks DB is reachable)
 *   GET /metrics   — basic in-process counters
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db";

const health = new Hono();

const started = Date.now();
const counters = {
  requests: 0,
  errors: 0,
};

// Count every request that reaches any health route
health.use("*", async (c, next) => {
  counters.requests++;
  await next();
});

health.get("/healthz", (c) => {
  return c.json({
    status: "ok",
    ok: true,
    uptimeMs: Date.now() - started,
  });
});

health.get("/readyz", async (c) => {
  try {
    await db.execute(sql`SELECT 1`);
    return c.json({ ok: true, db: "up" });
  } catch (err) {
    counters.errors++;
    return c.json(
      { ok: false, db: "down", error: (err as Error).message },
      503
    );
  }
});

health.get("/metrics", (c) => {
  const mem = process.memoryUsage();
  return c.json({
    uptimeMs: Date.now() - started,
    requests: counters.requests,
    errors: counters.errors,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    nodeVersion: process.version,
  });
});

export default health;

/**
 * Block L4 — Public stats API endpoint.
 *
 *   GET /api/v2/stats
 *
 * Public, no auth, CORS-open (inherits `/api/*` cors from `app.tsx`).
 * Returns the same `PublicStats` JSON shape rendered on the marketing
 * landing page. Cached at the lib layer (5 min in-memory LRU); the
 * response carries `Cache-Control: public, max-age=300` so CDN /
 * browser caches can hold it too.
 *
 * The handler never throws — `computePublicStats` degrades to all-zeros
 * on DB error, so a 200 with zeros is the worst case here.
 */

import { Hono } from "hono";
import { computePublicStats } from "../lib/public-stats";

const publicStats = new Hono();

publicStats.get("/api/v2/stats", async (c) => {
  const stats = await computePublicStats();
  c.header("cache-control", "public, max-age=300");
  return c.json({
    ...stats,
    asOf: stats.asOf.toISOString(),
  });
});

export default publicStats;

/**
 * /api/version — public build-info endpoint.
 *
 * Returns the running process's commit SHA, branch, boot time, and uptime
 * as a tiny JSON payload. Used by:
 *   - The client-side auto-update banner (polls every 15s, prompts reload
 *     when sha changes)
 *   - Operators sanity-checking 'did my push actually deploy?'
 *   - Monitoring (latency to seeing a new sha = end-to-end deploy time)
 *
 * Cache-control: no-store. Must be live, never cached.
 *
 * Block S3 (2026-05-14): additively reports the 5 most recently applied
 * migrations from the live DB so the post-deploy smoke suite can verify
 * the latest drizzle/*.sql file actually landed in the running schema.
 * The migrations field is best-effort: if the DB query fails or the
 * connection isn't configured the field is omitted, never throws.
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getBuildInfo } from "../lib/build-info";
import { db } from "../db";

const version = new Hono();

// In-process cache for the migrations list. /api/version is polled
// every 15s by the auto-update banner — re-querying _migrations on
// every hit would be wasteful. 10s TTL is a reasonable compromise: a
// fresh deploy's new migration will show up in the smoke check within
// at most 10s of when migrate.ts inserted the row.
const MIGRATIONS_CACHE_TTL_MS = 10_000;
let _migrationsCache: { at: number; names: string[] } | null = null;

async function readRecentMigrations(): Promise<string[] | null> {
  const now = Date.now();
  if (_migrationsCache && now - _migrationsCache.at < MIGRATIONS_CACHE_TTL_MS) {
    return _migrationsCache.names;
  }
  try {
    // _migrations is created on first migration run; if the table doesn't
    // exist (very first boot before migrate.ts has ever run) we degrade
    // silently to an empty list.
    const rows = (await db.execute(
      sql`SELECT name FROM _migrations ORDER BY applied_at DESC LIMIT 5`
    )) as unknown as Array<{ name: string }>;
    const names = (rows ?? []).map((r) => r.name).filter(Boolean);
    _migrationsCache = { at: now, names };
    return names;
  } catch {
    // _migrations table missing, DB down, etc. — return null so the
    // endpoint can omit the field without 500ing.
    return null;
  }
}

/**
 * Test seam: lets `src/__tests__/post-deploy-smoke.test.ts` reset the
 * cache between assertions. Not part of the public API.
 */
export const __test = {
  clearMigrationsCache: () => {
    _migrationsCache = null;
  },
};

version.get("/api/version", async (c) => {
  c.header("cache-control", "no-store, no-cache, must-revalidate");
  c.header("pragma", "no-cache");
  const build = getBuildInfo();
  const migrations = await readRecentMigrations();
  if (migrations !== null) {
    return c.json({ ...build, migrations });
  }
  return c.json(build);
});

// Block S2 — minimal `/version` alias used by the service-worker cache
// bust + external uptime/deploy monitors. Kept additive (single new
// handler, no edits to existing shape) so the S1+S3 smoke-suite agent's
// edits to this file can land alongside without merge conflicts.
//
// S3 (2026-05-14): mirror the migrations field here so the smoke
// suite can check either endpoint.
version.get("/version", async (c) => {
  c.header("cache-control", "no-store, no-cache, must-revalidate");
  c.header("pragma", "no-cache");
  const migrations = await readRecentMigrations();
  const body: Record<string, unknown> = {
    sha: process.env.BUILD_SHA || "dev",
    buildAt: process.env.BUILD_TIME || null,
  };
  if (migrations !== null) body.migrations = migrations;
  return c.json(body);
});

export default version;

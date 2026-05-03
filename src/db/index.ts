/**
 * Drizzle DB connection — dual-driver, auto-detected from DATABASE_URL.
 *
 * - Neon serverless (HTTPS over fetch)  — for *.neon.tech hosts
 * - postgres.js (TCP)                   — for localhost / self-hosted Postgres
 *
 * Lets the same codebase run on Neon's hosted DB AND on a local Postgres
 * sitting next to the bun process on a single VPS. Picks the right driver
 * by inspecting the URL host once, at first access.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { config } from "../lib/config";

type AnyDb = NeonHttpDatabase<typeof schema> | PostgresJsDatabase<typeof schema>;

let _db: AnyDb | null = null;

/**
 * Returns true when the URL points at Neon's serverless HTTPS endpoint.
 * Anything else (localhost, RDS, Supabase TCP, plain Postgres) goes through
 * the postgres.js driver.
 */
export function isNeonUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)neon\.tech$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function getDb(): AnyDb {
  if (_db) return _db;

  if (!config.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Set it in your environment or .env file."
    );
  }

  const url = config.databaseUrl;

  if (isNeonUrl(url)) {
    const sql = neon(url);
    _db = drizzleNeon(sql, { schema });
  } else {
    // postgres.js — TCP driver for self-hosted / non-Neon Postgres.
    // max=10 keeps the connection pool modest on small VPS deployments.
    const client = postgres(url, { max: 10, prepare: false });
    _db = drizzlePg(client, { schema });
  }

  return _db;
}

// Re-export as `db` for convenience — proxies to the chosen driver lazily.
// Will throw on first access if DATABASE_URL is unset.
export const db = new Proxy({} as AnyDb, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver) as unknown;
  },
});

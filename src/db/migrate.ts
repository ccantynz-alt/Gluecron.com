/**
 * Migration runner — executes every `drizzle/*.sql` file in order.
 * Tracks applied migrations in a dedicated table so repeat runs are idempotent.
 *
 * Dual-driver: uses Neon HTTP for *.neon.tech URLs, postgres.js TCP for
 * everything else (localhost, RDS, Supabase, plain Postgres).
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { neon } from "@neondatabase/serverless";
import postgres from "postgres";
import { config } from "../lib/config";
import { isNeonUrl } from "./index";

type Exec = (query: string, params?: unknown[]) => Promise<unknown>;

async function runMigrations() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  let exec: Exec;
  let cleanup: (() => Promise<void>) | null = null;

  if (isNeonUrl(config.databaseUrl)) {
    const neonSql = neon(config.databaseUrl);
    exec = (q, p = []) => neonSql(q, p);
  } else {
    const client = postgres(config.databaseUrl, { max: 1, prepare: false });
    exec = (q, p) =>
      p && p.length > 0 ? client.unsafe(q, p as never[]) : client.unsafe(q);
    cleanup = async () => {
      await client.end({ timeout: 5 });
    };
  }

  try {
    // Ensure tracking table exists
    await exec(`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "name" text PRIMARY KEY,
        "applied_at" timestamp DEFAULT now() NOT NULL
      )
    `);

    const appliedRows = (await exec(`SELECT name FROM _migrations`)) as Array<{
      name: string;
    }>;
    const appliedSet = new Set(appliedRows.map((r) => r.name));

    const migrationsDir = join(process.cwd(), "drizzle");
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("No migration files found.");
      return;
    }

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[migrate] ${file} — already applied, skipping`);
        continue;
      }

      console.log(`[migrate] applying ${file}...`);
      const content = await readFile(join(migrationsDir, file), "utf8");

      // Split on the drizzle breakpoint marker. Each chunk is one statement.
      const statements = content
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const raw of statements) {
        const stripped = raw
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim();
        if (!stripped) continue;

        try {
          await exec(stripped);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes("already exists") ||
            msg.includes("duplicate_column") ||
            msg.includes("duplicate_object")
          ) {
            console.warn(
              `[migrate] ${file}: ${msg.slice(0, 120)} (treated as applied)`
            );
            continue;
          }
          console.error(
            `[migrate] ${file} failed on statement:\n${stripped.slice(0, 500)}\n\n${msg}`
          );
          throw err;
        }
      }

      await exec(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
      console.log(`[migrate] ${file} applied`);
    }

    console.log("[migrate] all migrations complete");
  } finally {
    if (cleanup) await cleanup();
  }
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

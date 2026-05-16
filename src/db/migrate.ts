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

/**
 * Split a migration file into individual SQL statements.
 *
 * Two formats are supported:
 *   1. Drizzle-generated migrations use `--> statement-breakpoint` markers
 *      between statements. Detect and split on those.
 *   2. Hand-written migrations (like `0000_init.sql`) just have multiple
 *      `CREATE TABLE` etc statements separated by `;`. Detect when the
 *      drizzle marker isn't present and fall back to a semicolon split
 *      that's safe for our schemas (no PL/pgSQL `$$...$$` blocks today).
 *
 * Comment-only lines (`--`) are stripped before splitting so a `;`
 * inside a comment doesn't trigger a false split. Empty fragments are
 * dropped. Trailing semicolons are removed.
 */
function splitMigrationStatements(content: string): string[] {
  if (/-->\s*statement-breakpoint/.test(content)) {
    return content
      .split(/-->\s*statement-breakpoint/)
      .map((s) =>
        s
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim()
      )
      .filter((s) => s.length > 0);
  }
  // No breakpoint markers — split on `;` at end of (logical) line. Strip
  // pure-comment lines first.
  const stripped = content
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;\s*$/, "").trim())
    .filter((s) => s.length > 0);
}

async function runMigrations() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  let exec: Exec;
  let cleanup: (() => Promise<void>) | null = null;

  if (isNeonUrl(config.databaseUrl)) {
    // @neondatabase/serverless 1.x: the tagged-template factory only accepts
    // a TemplateStringsArray. Use the .query(string, params) helper for the
    // dynamic-string flow this migration runner needs.
    const neonSql = neon(config.databaseUrl);
    exec = (q, p = []) => neonSql.query(q, p);
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
      const statements = splitMigrationStatements(content);

      for (const stripped of statements) {
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

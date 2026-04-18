/**
 * Migration runner — executes every `drizzle/*.sql` file in order.
 * Tracks applied migrations in a dedicated table so repeat runs are idempotent.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { neon } from "@neondatabase/serverless";
import { config } from "../lib/config";

async function runMigrations() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const sql = neon(config.databaseUrl);

  // Ensure tracking table exists
  await sql`
    CREATE TABLE IF NOT EXISTS "_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamp DEFAULT now() NOT NULL
    )
  `;

  const applied = await sql`SELECT name FROM _migrations`;
  const appliedSet = new Set(
    (applied as Array<{ name: string }>).map((r) => r.name)
  );

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
        await sql(stripped);
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

    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
    console.log(`[migrate] ${file} applied`);
  }

  console.log("[migrate] all migrations complete");
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

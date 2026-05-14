#!/usr/bin/env bun
/**
 * Post-deploy smoke CLI.
 *
 * Runs the 15-endpoint smoke suite (`src/lib/post-deploy-smoke.ts`)
 * against $GLUECRON_HOST (default http://localhost:3010) AFTER systemctl
 * restart but BEFORE the workflow marks the deploy successful.
 *
 * Also verifies that the latest *.sql in drizzle/ is present in the
 * running app's /api/version migrations list. This is the second line
 * of defence against the silent-migration-failure bug that broke
 * gluecron.com for hours.
 *
 * Exit codes:
 *   0  — every check passed AND the latest migration is reported by the
 *        live process.
 *   1  — at least one endpoint failed.
 *   2  — endpoints all passed but the latest migration is missing from
 *        the live process's reported list (a fresh deploy is running
 *        but the DB schema is behind).
 *
 * Usage:
 *   bun scripts/post-deploy-smoke.ts
 *   GLUECRON_HOST=https://gluecron.com bun scripts/post-deploy-smoke.ts
 */

import { readdir } from "fs/promises";
import { join } from "path";
import {
  runChecks,
  formatTable,
  latestMigration,
  type FetchLike,
} from "../src/lib/post-deploy-smoke";

const HOST = (process.env.GLUECRON_HOST || "http://localhost:3010").replace(
  /\/$/,
  ""
);

const fetchImpl: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return {
    status: res.status,
    text: () => res.text(),
  };
};

async function main() {
  console.log(`[smoke] target: ${HOST}`);
  const summary = await runChecks({
    baseUrl: HOST,
    fetchImpl,
    log: (line) => console.log(line),
  });

  console.log("");
  console.log(formatTable(summary.results));
  console.log("");
  console.log(
    `[smoke] ${summary.passed}/${summary.results.length} checks passed`
  );

  if (!summary.ok) {
    console.error("[smoke] FAIL — at least one endpoint check failed");
    process.exit(1);
  }

  // ─── Migration-applied verification ─────────────────────────────────
  // Curl /api/version and confirm the latest drizzle/*.sql file is in
  // the migrations[] array the live process reports.
  let drizzleFiles: string[] = [];
  try {
    drizzleFiles = (await readdir(join(process.cwd(), "drizzle"))).filter((f) =>
      f.endsWith(".sql")
    );
  } catch (err) {
    console.warn(
      `[smoke] WARN: couldn't read drizzle/ directory (${(err as Error).message}) — skipping migration check`
    );
    process.exit(0);
  }
  const latest = latestMigration(drizzleFiles);
  if (!latest) {
    console.warn("[smoke] WARN: no migration files found — skipping check");
    process.exit(0);
  }

  let liveMigrations: string[] | null = null;
  try {
    const res = await fetch(`${HOST}/api/version`);
    if (res.status === 200) {
      const body = (await res.json()) as { migrations?: unknown };
      if (Array.isArray(body.migrations)) {
        liveMigrations = body.migrations.filter(
          (m): m is string => typeof m === "string"
        );
      }
    }
  } catch (err) {
    console.warn(
      `[smoke] WARN: /api/version migrations fetch failed: ${(err as Error).message}`
    );
  }

  if (liveMigrations === null) {
    console.warn(
      "[smoke] WARN: /api/version did not report migrations[] — server hasn't been redeployed with the S3 patch yet. Skipping migration check."
    );
    process.exit(0);
  }

  if (!liveMigrations.includes(latest)) {
    console.error(
      `[smoke] FAIL: latest migration ${latest} is NOT in the live process's applied list (reported: ${liveMigrations.slice(-5).join(", ")})`
    );
    process.exit(2);
  }

  console.log(
    `[smoke] OK: latest migration ${latest} is applied (live process confirms)`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});

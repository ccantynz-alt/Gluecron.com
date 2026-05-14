/**
 * Block N1 — Auto-merge readiness preflight.
 *
 * Operator runs this BEFORE `enable-auto-merge.ts` to make sure the box
 * is actually in a state where flipping the switch will produce useful
 * behaviour. Exits 0 when every check is green, 1 when any check fails.
 *
 * Checks:
 *   1. Migration 0040 has been applied (`branch_protection.enable_auto_merge`
 *      column exists). The bootstrap script depends on this column.
 *   2. `ANTHROPIC_API_KEY` is set on the box — without it the AI approval
 *      gate degrades to "AI review unavailable", which is treated as
 *      not-approved, and every auto-merge candidate gets blocked.
 *   3. The autopilot is running — `AUTOPILOT_DISABLED` is not `"1"`.
 *      The K3 sweep task is the only thing that actually performs the
 *      merge; if the autopilot is off, opt-in does nothing.
 *   4. The K3 `auto-merge-sweep` task is registered in `defaultTasks()`.
 *      Guards against someone removing the task name during a refactor.
 *
 * Pure-ish: each check is a small async function that returns a Result
 * record. The runner just iterates them and prints a checklist. Tests
 * drive the pure helpers directly.
 */

import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types + pretty printers
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  reason?: string;
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function icon(s: CheckStatus): string {
  return s === "pass" ? `${GREEN}v${RESET}` : `${RED}x${RESET}`;
}

// ---------------------------------------------------------------------------
// Pure check helpers
// ---------------------------------------------------------------------------

/**
 * Test the `ANTHROPIC_API_KEY` env var. Pure function over the supplied
 * env object so tests don't have to mutate `process.env`.
 */
export function checkAnthropicKey(env: NodeJS.ProcessEnv): CheckResult {
  const key = env.ANTHROPIC_API_KEY;
  if (!key || key.length < 10) {
    return {
      name: "ANTHROPIC_API_KEY set",
      status: "fail",
      reason:
        "ANTHROPIC_API_KEY is missing — AI approval gate will block every auto-merge candidate.",
    };
  }
  return { name: "ANTHROPIC_API_KEY set", status: "pass" };
}

/**
 * Confirm the autopilot ticker is enabled. `AUTOPILOT_DISABLED=1` turns
 * the K3 sweep off, which means opt-in does nothing useful.
 */
export function checkAutopilotEnabled(env: NodeJS.ProcessEnv): CheckResult {
  if (env.AUTOPILOT_DISABLED === "1") {
    return {
      name: "Autopilot enabled (AUTOPILOT_DISABLED != 1)",
      status: "fail",
      reason:
        "AUTOPILOT_DISABLED=1 — unset (or set to 0) to let the K3 sweep run.",
    };
  }
  return {
    name: "Autopilot enabled (AUTOPILOT_DISABLED != 1)",
    status: "pass",
  };
}

/**
 * Confirm the K3 sweep task is registered. We accept any iterable that
 * yields objects with a `.name` so tests don't have to import the real
 * autopilot module.
 */
export function checkAutoMergeSweepRegistered(
  tasks: Array<{ name: string }>
): CheckResult {
  const found = tasks.some((t) => t.name === "auto-merge-sweep");
  if (!found) {
    return {
      name: "K3 auto-merge-sweep task registered",
      status: "fail",
      reason:
        "defaultTasks() does not include 'auto-merge-sweep' — the K3 sweep is missing.",
    };
  }
  return {
    name: "K3 auto-merge-sweep task registered",
    status: "pass",
  };
}

/**
 * Verify migration 0040 has landed by probing for the
 * `branch_protection.enable_auto_merge` column. Pure-ish: takes the
 * runner as a callback so tests can stub it.
 */
export async function checkMigration0040(
  runner: () => Promise<{ exists: boolean; error?: string }>
): Promise<CheckResult> {
  try {
    const { exists, error } = await runner();
    if (error) {
      return {
        name: "Migration 0040 applied",
        status: "fail",
        reason: `column probe failed: ${error}`,
      };
    }
    if (!exists) {
      return {
        name: "Migration 0040 applied",
        status: "fail",
        reason:
          "branch_protection.enable_auto_merge column missing — run `bun run db:migrate`.",
      };
    }
    return { name: "Migration 0040 applied", status: "pass" };
  } catch (err) {
    return {
      name: "Migration 0040 applied",
      status: "fail",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// CLI driver
// ---------------------------------------------------------------------------

async function probeAutoMergeColumn(): Promise<{ exists: boolean; error?: string }> {
  try {
    const { db } = await import("../src/db");
    // Pull the column out of information_schema. Works on Postgres and
    // is safe to run on a healthy migrated DB.
    const rows = await db.execute(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'branch_protection'
            AND column_name = 'enable_auto_merge'
          LIMIT 1`
    );
    const list =
      (rows as any).rows ?? (Array.isArray(rows) ? rows : []);
    return { exists: list.length > 0 };
  } catch (err) {
    return {
      exists: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getDefaultTasks(): Promise<Array<{ name: string }>> {
  try {
    const mod = await import("../src/lib/autopilot");
    return mod.defaultTasks();
  } catch {
    return [];
  }
}

async function main() {
  console.log(
    `${DIM}gluecron auto-merge readiness — ${new Date().toISOString()}${RESET}`
  );

  const results: CheckResult[] = [];

  results.push(
    await checkMigration0040(probeAutoMergeColumn)
  );
  results.push(checkAnthropicKey(process.env));
  results.push(checkAutopilotEnabled(process.env));
  results.push(checkAutoMergeSweepRegistered(await getDefaultTasks()));

  for (const r of results) {
    const tail = r.reason ? ` — ${r.reason}` : "";
    console.log(`  ${icon(r.status)} ${r.name}${tail}`);
  }

  const failed = results.filter((r) => r.status === "fail").length;
  console.log("");
  if (failed > 0) {
    console.log(
      `${RED}readiness FAILED — fix the items above before running enable-auto-merge.ts${RESET}`
    );
    process.exit(1);
  }
  console.log(
    `${GREEN}readiness clean — safe to run enable-auto-merge.ts${RESET}`
  );
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

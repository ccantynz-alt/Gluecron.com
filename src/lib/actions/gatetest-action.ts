/**
 * `gluecron/gatetest@v1` — runs the external GateTest scanner against the
 * current commit and surfaces its pass/fail as the step exit code.
 *
 * Wraps `runGateTestScan` from `src/lib/gate.ts` (owned by another agent —
 * read-only import here). In dev where `GATETEST_URL` isn't configured the
 * step short-circuits with exitCode 0 so workflows don't fail spuriously.
 *
 * `with:` inputs are accepted but only a subset are honored in v1:
 *   url, apiKey, timeout — reserved for future overrides. Today the action
 *   always uses the process-wide config. The inputs are parsed defensively
 *   so user typos don't break the run.
 */

import { eq } from "drizzle-orm";
import type { ActionHandler } from "../action-registry";
import { db } from "../../db";
import { repositories, users } from "../../db/schema";
import { runGateTestScan } from "../gate";

async function lookupOwnerAndRepo(
  repoId: string
): Promise<{ owner: string; repo: string } | null> {
  try {
    const [row] = await db
      .select({
        name: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);
    if (!row) return null;

    const [u] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, row.ownerId))
      .limit(1);
    if (!u) return null;

    return { owner: u.username, repo: row.name };
  } catch {
    return null;
  }
}

export const gatetestAction: ActionHandler = {
  name: "gluecron/gatetest",
  version: "v1",
  async run(ctx): Promise<import("../action-registry").ActionResult> {
    try {
      // Dev-mode short-circuit: when the operator hasn't opted into GateTest
      // by setting GATETEST_URL, skip quietly. We read the env var directly
      // (not via `config`) because `config.gatetestUrl` falls back to a
      // default URL, which would defeat the intent of "unset = skip".
      if (!process.env.GATETEST_URL) {
        return {
          exitCode: 0,
          stdout: "GateTest not configured — skipping",
          outputs: { status: "skipped" },
        };
      }

      const lookup = await lookupOwnerAndRepo(ctx.repoId);
      if (!lookup) {
        return {
          exitCode: 1,
          stderr: `GateTest: unable to resolve repository ${ctx.repoId}`,
        };
      }

      const ref = ctx.ref || "refs/heads/main";
      const sha = ctx.commitSha || "";
      const result = await runGateTestScan(lookup.owner, lookup.repo, ref, sha);

      const stdout = `GateTest: ${result.passed ? "PASS" : "FAIL"} — ${result.details}`;
      return {
        exitCode: result.passed || result.skipped ? 0 : 1,
        stdout,
        outputs: {
          status: result.skipped
            ? "skipped"
            : result.passed
              ? "passed"
              : "failed",
          details: result.details,
        },
      };
    } catch (err) {
      return {
        exitCode: 1,
        stderr:
          "GateTest action error: " +
          (err instanceof Error ? err.message : String(err)),
      };
    }
  },
};

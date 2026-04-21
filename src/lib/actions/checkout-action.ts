/**
 * `gluecron/checkout@v1` — idiomatic no-op.
 *
 * The runner (Agent 5) has already checked out the repo into `ctx.workspace`
 * before any `uses:` step executes. This action exists so users can write
 * the familiar `- uses: gluecron/checkout@v1` line without surprise. It
 * records the resolved commit sha as an output so downstream steps can
 * reference it via `steps.<id>.outputs.sha`.
 */

import type { ActionHandler } from "../action-registry";

export const checkoutAction: ActionHandler = {
  name: "gluecron/checkout",
  version: "v1",
  async run(ctx) {
    try {
      const sha = ctx.commitSha || "";
      return {
        exitCode: 0,
        outputs: { sha },
        stdout: `Checked out ${sha || "HEAD"} at ${ctx.workspace}`,
      };
    } catch (err) {
      return {
        exitCode: 1,
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

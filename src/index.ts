import { mkdir } from "fs/promises";
import app from "./app";
import { config } from "./lib/config";
import { startWorker } from "./lib/workflow-runner";
import { startAutopilot } from "./lib/autopilot";

// Ensure repos directory exists
await mkdir(config.gitReposPath, { recursive: true });

// Start the Actions-equivalent workflow worker (Block C1). Polls
// workflow_runs for queued rows and executes them sequentially.
startWorker();

// Autopilot: periodic mirror sync, merge-queue progress, weekly digests,
// advisory rescans. No-op when AUTOPILOT_DISABLED=1.
startAutopilot();

console.log(`
  gluecron v0.1.0
  ──────────────────────
  http://localhost:${config.port}
  repos: ${config.gitReposPath}
`);

export default {
  port: config.port,
  fetch: app.fetch,
};

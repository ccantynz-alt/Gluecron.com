import { mkdir } from "fs/promises";
import app from "./app";
import { config } from "./lib/config";
import { startWorker } from "./lib/workflow-runner";
import { startAutopilot } from "./lib/autopilot";
import { ensureDemoContent } from "./lib/demo-seed";
import { ensureDemoActivity } from "./lib/demo-activity-seed";
import { ensureEnvSiteAdmin } from "./lib/admin-bootstrap";
import { maybeSelfBootstrap } from "./lib/self-bootstrap";
import { notifySystemdReady } from "./lib/systemd-notify";

// Ensure repos directory exists
await mkdir(config.gitReposPath, { recursive: true });

// Self-bootstrap: if Gluecron's own canonical repo (`ccantynz/Gluecron.com.git`
// by default) doesn't exist on disk yet, initialize it from the GitHub mirror
// and install the post-receive hook. This is the platform's self-healing path
// — once it runs successfully on a host, future deploys flow through Gluecron
// itself with no external CI tooling. Fire-and-forget; never blocks startup.
void maybeSelfBootstrap().catch((err) => {
  console.warn(`[self-bootstrap] swallowed: ${(err as Error).message}`);
});

// Start the Actions-equivalent workflow worker (Block C1). Polls
// workflow_runs for queued rows and executes them sequentially.
startWorker();

// Autopilot: periodic mirror sync, merge-queue progress, weekly digests,
// advisory rescans. No-op when AUTOPILOT_DISABLED=1.
startAutopilot();

// Site-admin bootstrap from env (SITE_ADMIN_USERNAME). Idempotent — if the
// user exists, they get a row in site_admins; if not, logged and retried
// on next boot. Background-fired so a slow DB doesn't block startup.
void ensureEnvSiteAdmin().catch(() => {});

// Opt-in demo content seed on boot (DEMO_SEED_ON_BOOT=1). Idempotent, never
// throws — safe to run on every start. Block L3 layers extra activity (more
// issues, an open + merged PR on todo-api, AI-review comment, auto-merge
// audit row) so the live /demo page has content out of the box.
if (process.env.DEMO_SEED_ON_BOOT === "1") {
  void (async () => {
    try {
      await ensureDemoContent();
      await ensureDemoActivity();
    } catch {
      /* never throw out of boot */
    }
  })();
}

console.log(`
  gluecron v0.1.0
  ──────────────────────
  http://localhost:${config.port}
  repos: ${config.gitReposPath}
`);

// BLOCK N2 — tell systemd we're ready. No-op when NOTIFY_SOCKET is unset
// (dev / non-systemd hosts). Fire-and-forget; never throws.
void notifySystemdReady().catch(() => {});

export default {
  port: config.port,
  fetch: app.fetch,
};

import { mkdir } from "fs/promises";
import app from "./app";
import { config } from "./lib/config";
import { startWorker } from "./lib/workflow-runner";
import { startWebhookDeliveryWorker } from "./lib/webhook-delivery";
import { startAutopilot } from "./lib/autopilot";
import { ensureDemoContent } from "./lib/demo-seed";
import { ensureDemoActivity } from "./lib/demo-activity-seed";
import { ensureEnvSiteAdmin } from "./lib/admin-bootstrap";
import { ensureMarketplaceSeed } from "./lib/agent-marketplace-seed";
import { maybeSelfBootstrap } from "./lib/self-bootstrap";
import { notifySystemdReady } from "./lib/systemd-notify";
import { loadConfigIntoEnv } from "./lib/system-config";

// Ensure repos directory exists
await mkdir(config.gitReposPath, { recursive: true });

// /admin/integrations boot hook — pull saved integration secrets out of the
// system_config table and into process.env BEFORE anything else reads them.
// This is the magic that lets the existing synchronous config getters
// (config.anthropicApiKey, config.resendApiKey, …) transparently pick up
// values an admin saved through the UI, with no restart needed. If the DB
// is unreachable at boot, env vars stay as the fallback — never blocks
// startup.
try {
  const n = await loadConfigIntoEnv();
  if (n > 0) console.log(`[system-config] loaded ${n} key(s) from DB into env`);
} catch (err) {
  console.warn(
    "[system-config] boot load failed (env vars remain authoritative):",
    err instanceof Error ? err.message : err
  );
}

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

// Reliable webhook delivery worker (migration 0056). Polls
// webhook_deliveries for pending rows whose next_attempt_at <= now() and
// retries with exponential backoff before dead-lettering.
startWebhookDeliveryWorker();

// Autopilot: periodic mirror sync, merge-queue progress, weekly digests,
// advisory rescans. No-op when AUTOPILOT_DISABLED=1.
startAutopilot();

// Site-admin bootstrap from env (SITE_ADMIN_USERNAME). Idempotent — if the
// user exists, they get a row in site_admins; if not, logged and retried
// on next boot. Background-fired so a slow DB doesn't block startup.
void ensureEnvSiteAdmin().catch((err) => {
  console.warn(
    "[admin-bootstrap] ensureEnvSiteAdmin failed:",
    err instanceof Error ? err.message : err
  );
});

// Agent marketplace seed. Idempotent — inserts the 4 canonical example
// listings only if they don't already exist. Background-fired with a small
// delay so the admin-bootstrap path lands first (the seed lists the
// publisher as the bootstrap admin).
void (async () => {
  try {
    await new Promise((r) => setTimeout(r, 1500));
    await ensureMarketplaceSeed();
  } catch (err) {
    console.warn(
      "[agent-marketplace-seed] failed:",
      err instanceof Error ? err.message : err
    );
  }
})();

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
void notifySystemdReady().catch((err) => {
  console.warn(
    "[systemd] notifySystemdReady failed:",
    err instanceof Error ? err.message : err
  );
});

export default {
  port: config.port,
  fetch: app.fetch,
};

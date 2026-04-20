import { Hono } from "hono";

const PRODUCT = "gluecron" as const;
const VERSION = process.env.APP_VERSION ?? "dev";
const COMMIT = process.env.GIT_COMMIT ?? "unknown";

const SIBLINGS = {
  crontech: "https://crontech.ai/api/platform-status",
  gluecron: "https://gluecron.com/api/platform-status",
  gatetest: "https://gatetest.io/api/platform-status",
} as const;

export const platformStatus = new Hono();

platformStatus.get("/", (c) => {
  c.header("cache-control", "no-store");
  c.header("access-control-allow-origin", "*");
  return c.json({
    product: PRODUCT,
    version: VERSION,
    commit: COMMIT,
    healthy: true,
    timestamp: new Date().toISOString(),
    siblings: SIBLINGS,
  });
});

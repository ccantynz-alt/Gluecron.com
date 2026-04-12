import { mkdir } from "fs/promises";
import app from "./app";
import { config } from "./lib/config";

// Ensure repos directory exists
await mkdir(config.gitReposPath, { recursive: true });

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

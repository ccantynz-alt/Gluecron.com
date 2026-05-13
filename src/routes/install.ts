/**
 * Block L2 — one-command install.
 *
 *   GET /install   -> the bash installer (scripts/install.sh).
 *
 * Curl-able: `curl -sSL https://gluecron.com/install | bash`.
 *
 * The script is read from disk once at module load and cached in memory; we
 * also serve it with `Cache-Control: public, max-age=300` so any CDN in front
 * of us can absorb the load. Mirrors the static-string pattern used by
 * `src/routes/pwa.ts`.
 */

import { Hono } from "hono";
import { readFileSync } from "fs";
import { join } from "path";

const install = new Hono();

// Resolve at module-load time. We try the on-disk script first; if anything
// goes sideways (missing file in a stripped container image, weird CWD, etc.)
// we fall back to a stub that points the user at the canonical URL so the
// endpoint always returns *something* shell-safe.
const FALLBACK_SCRIPT = `#!/usr/bin/env bash
echo "Gluecron install script unavailable on this host." >&2
echo "Fetch it directly from https://gluecron.com/install" >&2
exit 1
`;

function loadScript(): string {
  // Walk a few candidate locations so this works in dev, tests, and the
  // fly.io container where CWD may be /app.
  const candidates = [
    join(process.cwd(), "scripts", "install.sh"),
    join(import.meta.dir, "..", "..", "scripts", "install.sh"),
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p, "utf8");
      if (buf && buf.length > 0) return buf;
    } catch {
      // try the next candidate
    }
  }
  return FALLBACK_SCRIPT;
}

export const INSTALL_SCRIPT_SRC = loadScript();

install.get("/install", (c) => {
  c.header("content-type", "text/x-shellscript; charset=utf-8");
  c.header("cache-control", "public, max-age=300");
  // Make `curl https://gluecron.com/install -o install.sh` give a sensible
  // default filename without forcing it for piped installs.
  c.header("content-disposition", 'inline; filename="install.sh"');
  return c.body(INSTALL_SCRIPT_SRC);
});

export default install;

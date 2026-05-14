/**
 * BLOCK Q1 — Claude Desktop (.dxt) extension download endpoint.
 *
 *   GET /gluecron.dxt → serves public/gluecron.dxt
 *
 * The `.dxt` bundle is built by `scripts/build-dxt.sh`. If the build hasn't
 * been run (file missing), we return a friendly 404 JSON payload pointing
 * at the build step + the curl-pipe install fallback — never crash the
 * page or 500.
 *
 * Coexists with `scripts/install.sh` (Block L2). The .dxt is the GUI sibling
 * for non-CLI users; the install.sh path remains for terminal users.
 */

import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const dxt = new Hono();

const DXT_PATH = join(process.cwd(), "public", "gluecron.dxt");

dxt.get("/gluecron.dxt", (c) => {
  if (!existsSync(DXT_PATH)) {
    return c.json(
      {
        error: "extension_not_built",
        message:
          "Gluecron .dxt bundle has not been built on this server yet. Run `bash scripts/build-dxt.sh` or install via the CLI fallback: `curl -sSL https://gluecron.com/install | bash`.",
        fallback: "https://gluecron.com/install",
      },
      404
    );
  }

  const stat = statSync(DXT_PATH);
  const file = Bun.file(DXT_PATH);

  return new Response(file.stream(), {
    headers: {
      // .dxt is a registered extension, but Anthropic has not (yet) published
      // a canonical MIME type. octet-stream is the safe default — the
      // Content-Disposition forces the OS to treat it as a file download
      // which Claude Desktop's "Open With" hook can then claim.
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="gluecron.dxt"',
      "Content-Length": String(stat.size),
      // Short cache window so deploys-with-new-bundle propagate within an
      // hour. Public so CDNs / browser caches can hold it.
      "Cache-Control": "public, max-age=3600",
    },
  });
});

export default dxt;

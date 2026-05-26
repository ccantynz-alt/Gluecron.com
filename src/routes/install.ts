/**
 * Block L2 — one-command install.
 *
 *   GET /install         -> the bash installer (scripts/install.sh).
 *   GET /install/vscode  -> a tiny HTML landing for the VS Code extension
 *                           with install instructions and a .vsix link if
 *                           one has been uploaded to `public/`.
 *
 * Curl-able: `curl -sSL https://gluecron.com/install | bash`.
 *
 * The script is read from disk once at module load and cached in memory; we
 * also serve it with `Cache-Control: public, max-age=300` so any CDN in front
 * of us can absorb the load. Mirrors the static-string pattern used by
 * `src/routes/pwa.ts`.
 */

import { Hono } from "hono";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join } from "path";

const install = new Hono();

// ─── Self-host installer (curl gluecron.com/install-server | bash) ─────────
//
// Parallel to the Claude Desktop / MCP installer above, but ships a single
// portable binary for the FULL server. The script is loaded once at module
// load and we rewrite the `GLUECRON_HOST` default to whatever host the
// request was served from, so installs from staging / dev / mirror sites
// download binaries from the same origin instead of the prod default.

const FALLBACK_SELF_HOST_SCRIPT = `#!/usr/bin/env bash
echo "Gluecron self-host install script unavailable on this host." >&2
echo "Fetch it directly from https://gluecron.com/install-server" >&2
exit 1
`;

function loadSelfHostScript(): string {
  const candidates = [
    join(process.cwd(), "scripts", "install-self-host.sh"),
    join(import.meta.dir, "..", "..", "scripts", "install-self-host.sh"),
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p, "utf8");
      if (buf && buf.length > 0) return buf;
    } catch {
      // try next
    }
  }
  return FALLBACK_SELF_HOST_SCRIPT;
}

export const SELF_HOST_SCRIPT_SRC = loadSelfHostScript();

// Rewrite the default `${GLUECRON_HOST:-https://gluecron.com}` so a curl
// from a custom host downloads binaries from the same origin without the
// operator having to set the env var manually.
function selfHostScriptForOrigin(origin: string): string {
  const safeOrigin = origin.replace(/[`$"\\]/g, "");
  return SELF_HOST_SCRIPT_SRC.replace(
    /HOST="\$\{GLUECRON_HOST:-https:\/\/gluecron\.com\}"/,
    `HOST="\${GLUECRON_HOST:-${safeOrigin}}"`
  );
}

install.get("/install-server", (c) => {
  // Derive the canonical origin from the inbound request so the script
  // pulls binaries from the same host the user just curled.
  const url = new URL(c.req.url);
  // Trust forwarded headers if a reverse proxy set them (Crontech /
  // Caddy / Fly all do). Falls back to the raw URL origin.
  const proto =
    c.req.header("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") || url.host;
  const origin = `${proto}://${host}`;

  c.header("content-type", "text/x-shellscript; charset=utf-8");
  c.header("cache-control", "public, max-age=300");
  c.header(
    "content-disposition",
    'inline; filename="install-self-host.sh"'
  );
  return c.body(selfHostScriptForOrigin(origin));
});

// ─── /dist/:filename — serve compiled binaries + manifest ──────────────────
//
// Built by `scripts/build-self-host-binary.sh`. The installer above fetches
// `/dist/SHA256SUMS` then `/dist/gluecron-server-<plat>-<arch>` from this
// endpoint. We never list the directory; only filenames present in
// `dist/` resolve, and any path-traversal attempt 404s.

const DIST_DIR_CANDIDATES = [
  join(process.cwd(), "dist"),
  join(import.meta.dir, "..", "..", "dist"),
];

function resolveDistRoot(): string | null {
  for (const d of DIST_DIR_CANDIDATES) {
    if (existsSync(d)) return d;
  }
  return null;
}

function contentTypeFor(name: string): string {
  if (name.endsWith(".sha256")) return "text/plain; charset=utf-8";
  if (name === "SHA256SUMS" || name === "VERSION" || name === "MANIFEST.txt") {
    return "text/plain; charset=utf-8";
  }
  if (name === "env.example") return "text/plain; charset=utf-8";
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    return "application/gzip";
  }
  return "application/octet-stream";
}

install.get("/dist/:filename", async (c) => {
  const filename = c.req.param("filename");
  // Hard-reject any path component or traversal characters. Filenames
  // produced by the build script are alphanumerics + dash + dot only.
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
    return c.json({ error: "invalid_filename" }, 404);
  }
  const root = resolveDistRoot();
  if (!root) {
    return c.json(
      {
        error: "dist_not_built",
        hint: "Run scripts/build-self-host-binary.sh on this host.",
      },
      404
    );
  }
  const path = join(root, filename);
  if (!existsSync(path)) {
    return c.json({ error: "not_found", filename }, 404);
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    return c.json({ error: "not_a_file", filename }, 404);
  }
  const file = Bun.file(path);
  return new Response(file.stream(), {
    headers: {
      "Content-Type": contentTypeFor(filename),
      "Content-Length": String(stat.size),
      "Cache-Control": "public, max-age=3600",
      // Make the browser save the file with a sensible filename when a
      // user visits the URL directly; doesn't break `curl -o` either.
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

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

// ─── VS Code extension landing ──────────────────────────────────────────────
//
// We don't (yet) have a marketplace listing, so this page shows install
// instructions and — if a .vsix has been dropped into `public/` — a
// download link. The page is intentionally minimalist: it does NOT pull
// in the main app layout so a misbehaving CSS change can't break the
// install funnel.

const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/items?itemName=gluecron.gluecron-vscode";

function findVsix(): { name: string; size: number } | null {
  // Look under `public/` so the file is served by the static handler
  // (Bun's `Bun.file` route at /:filename). Keep it deterministic —
  // largest-version sorted last after lexicographic sort works for our
  // semver naming.
  const candidates = [
    join(process.cwd(), "public"),
    join(import.meta.dir, "..", "..", "public"),
  ];
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith(".vsix"));
      if (files.length === 0) continue;
      files.sort();
      const pick = files[files.length - 1];
      const st = statSync(join(dir, pick));
      return { name: pick, size: st.size };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function vscodeLandingHtml(vsix: { name: string; size: number } | null): string {
  const vsixBlock = vsix
    ? `
    <p>
      <a class="cta" href="/${encodeURIComponent(vsix.name)}" download>
        Download ${vsix.name} (${formatBytes(vsix.size)})
      </a>
    </p>
    <pre><code>code --install-extension ${vsix.name}</code></pre>`
    : `
    <p class="muted">
      No <code>.vsix</code> uploaded yet — build one yourself:
    </p>
    <pre><code>git clone https://gluecron.com/ccantynz/Gluecron.com
cd Gluecron.com/editor-extensions/vscode
npm install
npm run compile
npx vsce package
code --install-extension gluecron-vscode-0.1.0.vsix</code></pre>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Gluecron for VS Code</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark light; }
  body { font: 15px/1.55 system-ui, sans-serif; max-width: 640px; margin: 5rem auto; padding: 0 1rem; }
  h1 { margin-top: 0; font-size: 1.6rem; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; background: #2c2c2c; color: #fff; font-size: 13px; text-decoration: none; }
  .cta { display: inline-block; padding: 8px 14px; border-radius: 6px; background: #1f6feb; color: #fff; text-decoration: none; font-weight: 600; }
  pre { background: #0e1116; color: #e6edf3; padding: 12px; border-radius: 6px; overflow-x: auto; }
  code { font: 13px ui-monospace, monospace; }
  .muted { opacity: 0.75; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
  <h1>Gluecron for VS Code</h1>
  <p>
    Chat with this repo, ship PRs, run specs, voice-to-PR, and let Claude write
    your commit messages — without leaving the editor.
  </p>
  <p>
    <a class="badge" href="${MARKETPLACE_URL}" rel="nofollow">
      Marketplace listing (coming soon)
    </a>
  </p>
  <h2>Install</h2>
  ${vsixBlock}
  <h2>What you get</h2>
  <ul>
    <li>Sidebar <strong>repo chat</strong> grounded in the current repository</li>
    <li>One-click <strong>AI commit messages</strong> in the SCM title bar</li>
    <li><strong>Open in Gluecron</strong> deep-links for the active file / line</li>
    <li>Embedded <strong>pull requests</strong>, <strong>issues</strong>, and <strong>AI standups</strong></li>
    <li><strong>Ship spec</strong> + <strong>voice-to-PR</strong> shortcuts</li>
  </ul>
  <p class="muted">Source: <a href="/ccantynz/Gluecron.com/tree/main/editor-extensions/vscode">editor-extensions/vscode</a></p>
</body>
</html>`;
}

install.get("/install/vscode", (c) => {
  const vsix = findVsix();
  c.header("content-type", "text/html; charset=utf-8");
  c.header("cache-control", "public, max-age=300");
  return c.body(vscodeLandingHtml(vsix));
});

export default install;

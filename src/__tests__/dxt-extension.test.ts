/**
 * BLOCK Q1 — Claude Desktop (.dxt) extension tests.
 *
 * Covers:
 *   - extension/gluecron.dxt/manifest.json is valid JSON
 *   - Manifest declares all 15 tools (cross-checked against
 *     src/lib/mcp-tools.ts's defaultTools() exports)
 *   - server.endpoint contains the templated host placeholder
 *   - GET /gluecron.dxt returns 200 + correct Content-Type when the
 *     pre-built bundle exists in public/
 *   - GET /gluecron.dxt returns 404 with friendly JSON when missing
 *   - Landing page renders the "Add to Claude Desktop" CTA
 *
 * Static-content surface — no DB stubs, no mocks needed. The 404 case is
 * exercised by temporarily renaming the bundle out of the way and
 * restoring it before the next test.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import app from "../app";
import { defaultTools } from "../lib/mcp-tools";

const ROOT = join(import.meta.dir, "..", "..");
const MANIFEST_PATH = join(ROOT, "extension", "gluecron.dxt", "manifest.json");
const BUNDLE_PATH = join(ROOT, "public", "gluecron.dxt");

type Manifest = {
  dxt_version: string;
  name: string;
  display_name: string;
  version: string;
  server: {
    type: string;
    endpoint: string;
    headers?: Record<string, string>;
  };
  user_config: Record<string, { required?: boolean; sensitive?: boolean }>;
  tools: Array<{ name: string; description: string }>;
};

function loadManifest(): Manifest {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as Manifest;
}

describe("Block Q1 — .dxt manifest", () => {
  it("extension/gluecron.dxt/manifest.json is valid JSON", () => {
    expect(() => loadManifest()).not.toThrow();
    const m = loadManifest();
    expect(m.name).toBe("gluecron");
    expect(m.display_name).toBe("Gluecron");
  });

  it("declares server.type=http with the templated host placeholder", () => {
    const m = loadManifest();
    expect(m.server.type).toBe("http");
    expect(m.server.endpoint).toContain("${user_config.gluecron_host}/mcp");
    expect(m.server.headers?.Authorization).toContain(
      "${user_config.gluecron_pat}"
    );
  });

  it("declares both user_config prompts (host + PAT, PAT marked sensitive)", () => {
    const m = loadManifest();
    expect(m.user_config.gluecron_host).toBeDefined();
    expect(m.user_config.gluecron_host.required).toBe(true);
    expect(m.user_config.gluecron_pat).toBeDefined();
    expect(m.user_config.gluecron_pat.required).toBe(true);
    expect(m.user_config.gluecron_pat.sensitive).toBe(true);
  });

  it("does not embed any sensitive default values", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    // PAT prefixes — these must never be hard-coded into the manifest.
    expect(raw).not.toMatch(/glc_[A-Za-z0-9_-]+/);
    expect(raw).not.toMatch(/glct_[A-Za-z0-9_-]+/);
  });

  it("declares all 15 MCP tools, cross-checked against defaultTools()", () => {
    const m = loadManifest();
    const manifestNames = new Set(m.tools.map((t) => t.name));
    const handlerNames = new Set(Object.keys(defaultTools()));

    // Every handler MUST appear in the manifest.
    for (const name of handlerNames) {
      expect(manifestNames.has(name)).toBe(true);
    }
    // ... and vice versa — no orphan declarations.
    for (const name of manifestNames) {
      expect(handlerNames.has(name)).toBe(true);
    }
    // Lock the count at 15 so a future tool addition forces this test
    // (and therefore the manifest) to be updated in lockstep.
    expect(manifestNames.size).toBe(15);
    expect(handlerNames.size).toBe(15);
  });
});

describe("Block Q1 — GET /gluecron.dxt", () => {
  // The build script writes public/gluecron.dxt. If a prior test (or a
  // local dev session) has already produced it we use that; otherwise we
  // build it on the fly via the same script so the route can be exercised.
  beforeAll(async () => {
    if (!existsSync(BUNDLE_PATH)) {
      const proc = Bun.spawn(["bash", join(ROOT, "scripts", "build-dxt.sh")], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    }
  });

  it("returns 200 + octet-stream + Content-Disposition when bundle exists", async () => {
    expect(existsSync(BUNDLE_PATH)).toBe(true);
    const res = await app.request("/gluecron.dxt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("content-disposition") || "").toContain(
      'filename="gluecron.dxt"'
    );
    // Cache-Control must be set so CDNs can cache the download.
    expect(res.headers.get("cache-control") || "").toContain("max-age=3600");
    // Body must be a non-trivial ZIP — first 2 bytes are the PK signature.
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
  });

  it("returns 404 JSON with a friendly message when the bundle is missing", async () => {
    // Move the file out of the way, hit the route, restore it.
    const stash = `${BUNDLE_PATH}.test-stash`;
    let movedAway = false;
    try {
      if (existsSync(BUNDLE_PATH)) {
        renameSync(BUNDLE_PATH, stash);
        movedAway = true;
      }
      const res = await app.request("/gluecron.dxt");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") || "").toContain("application/json");
      const body = (await res.json()) as {
        error: string;
        message: string;
        fallback: string;
      };
      expect(body.error).toBe("extension_not_built");
      expect(body.message).toContain("scripts/build-dxt.sh");
      expect(body.fallback).toContain("/install");
    } finally {
      if (movedAway && existsSync(stash)) renameSync(stash, BUNDLE_PATH);
    }
  });
});

describe("Block Q1 — landing CTA", () => {
  it("GET / renders the 'Add to Claude Desktop' CTA pointing at /gluecron.dxt", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Add to Claude Desktop");
    expect(body).toContain('href="/gluecron.dxt"');
    // The CTA carries the test hook + the download attribute so browsers
    // know to save rather than navigate.
    expect(body).toContain('data-testid="cta-dxt"');
  });
});

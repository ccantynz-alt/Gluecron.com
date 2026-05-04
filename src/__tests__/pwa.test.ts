/**
 * Block G1 — PWA route smoke tests.
 *
 * Verifies manifest/icon/service-worker endpoints serve the right content
 * types + the manifest parses as JSON with the required install-prompt fields.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { MANIFEST, SERVICE_WORKER_SRC, PWA_REGISTER_SNIPPET } from "../routes/pwa";

describe("pwa — manifest", () => {
  it("GET /manifest.webmanifest → 200 JSON", async () => {
    const res = await app.request("/manifest.webmanifest");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("application/manifest+json");
    const body = await res.json();
    expect(body.name).toBe("Gluecron");
    expect(body.start_url).toBe("/");
    expect(body.display).toBe("standalone");
    expect(Array.isArray(body.icons)).toBe(true);
    expect(body.icons.length).toBeGreaterThan(0);
  });

  it("MANIFEST constant has required install-prompt fields", () => {
    expect(MANIFEST.name).toBeDefined();
    expect(MANIFEST.short_name).toBeDefined();
    expect(MANIFEST.start_url).toBeDefined();
    expect(MANIFEST.icons.length).toBeGreaterThan(0);
    expect(MANIFEST.display).toBe("standalone");
  });
});

describe("pwa — service worker", () => {
  it("GET /sw.js → 200 JavaScript", async () => {
    const res = await app.request("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain(
      "application/javascript"
    );
    expect(res.headers.get("service-worker-allowed")).toBe("/");
  });

  it("v4 self-nuke service worker installs + activates + unregisters", () => {
    expect(SERVICE_WORKER_SRC).toContain("addEventListener('install'");
    expect(SERVICE_WORKER_SRC).toContain("addEventListener('activate'");
    expect(SERVICE_WORKER_SRC).toContain("self.registration.unregister");
    expect(SERVICE_WORKER_SRC).toContain("caches.delete");
  });

  it("v4 service worker has no fetch handler — every request hits network", () => {
    expect(SERVICE_WORKER_SRC).not.toContain("addEventListener('fetch'");
  });
});

describe("pwa — icon", () => {
  it("GET /icon.svg → 200 SVG", async () => {
    const res = await app.request("/icon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("image/svg+xml");
    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain("</svg>");
  });
});

describe("pwa — register snippet", () => {
  it("registers a service worker when available", () => {
    expect(PWA_REGISTER_SNIPPET).toContain("serviceWorker");
    expect(PWA_REGISTER_SNIPPET).toContain("'/sw.js'");
  });
});

describe("pwa — layout wiring", () => {
  it("home page includes the manifest link", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain('rel="manifest"');
    expect(body).toContain("/manifest.webmanifest");
  });

  it("home page registers the service worker", async () => {
    const res = await app.request("/");
    const body = await res.text();
    // JSX entity-escapes quotes inside <script>; just check the SW path is wired.
    expect(body).toContain("serviceWorker.register");
    expect(body).toContain("/sw.js");
  });
});

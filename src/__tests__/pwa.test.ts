/**
 * PWA route smoke tests — post-rip-out (2026-05-16).
 *
 * The PWA layer was removed because it produced recurring reload-loop
 * bugs (admin dashboard, deploy pill, admin-screen flash). The routes
 * still exist but serve self-unregister bodies so any browser with the
 * old SW installed auto-recovers. The layout no longer registers a SW.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { MANIFEST, SERVICE_WORKER_SRC, PWA_REGISTER_SNIPPET } from "../routes/pwa";

describe("pwa — manifest (kept for any pre-existing install)", () => {
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

describe("pwa — service worker (self-unregister edition)", () => {
  it("GET /sw.js → 200 JavaScript", async () => {
    const res = await app.request("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain(
      "application/javascript"
    );
    expect(res.headers.get("service-worker-allowed")).toBe("/");
  });

  it("served SW body unregisters itself on activate", async () => {
    const res = await app.request("/sw.js");
    const body = await res.text();
    expect(body).toContain("self.registration.unregister");
  });

  it("served SW body has no fetch handler", async () => {
    const res = await app.request("/sw.js");
    const body = await res.text();
    expect(body).not.toContain('addEventListener("fetch"');
    expect(body).not.toContain("addEventListener('fetch'");
  });

  it("locked SERVICE_WORKER_SRC constant kept for back-compat tests", () => {
    expect(SERVICE_WORKER_SRC).toContain("addEventListener('install'");
    expect(SERVICE_WORKER_SRC).toContain("addEventListener('activate'");
    expect(SERVICE_WORKER_SRC).toContain("self.registration.unregister");
    expect(SERVICE_WORKER_SRC).toContain("caches.delete");
  });

  it("locked SERVICE_WORKER_SRC has no fetch handler", () => {
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

describe("pwa — register snippet (legacy, no longer used by layout)", () => {
  it("snippet still references serviceWorker for legacy callers", () => {
    expect(PWA_REGISTER_SNIPPET).toContain("serviceWorker");
    expect(PWA_REGISTER_SNIPPET).toContain("'/sw.js'");
  });
});

describe("pwa — layout no longer registers a service worker", () => {
  // 2026-05-16 — PWA ripped out. The layout used to inject manifest +
  // SW registration scripts; now it injects a kill-switch that
  // unregisters any pre-existing SW. These tests pin the new contract.
  it("home page does NOT include the manifest link", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).not.toContain('rel="manifest"');
  });

  it("home page does NOT call serviceWorker.register", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).not.toContain("serviceWorker.register");
  });

  it("home page includes the kill-switch (unregisters legacy SWs)", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("getRegistrations");
    expect(body).toContain("reg.unregister");
  });
});

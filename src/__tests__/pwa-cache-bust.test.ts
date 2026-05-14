/**
 * Block S2 — service worker cache-bust pinned to deploy SHA.
 *
 * Covers the `/sw.js` handler extension that injects `const SW_VERSION`
 * derived from `process.env.BUILD_SHA` (with a `dev-<pid>` fallback) and
 * the cache-prefix invalidation logic that purges previous-version
 * caches on activate.
 *
 * No mock pollution: this suite only manipulates `process.env.BUILD_SHA`
 * via `beforeEach` / `afterEach` save+restore so the rest of the test
 * run sees the original env. No DB stubs needed — the handler is pure.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import app from "../app";
import {
  buildSwVersion,
  buildVersionedServiceWorker,
  _resetSwShaWarningForTests,
} from "../routes/pwa";

describe("pwa cache-bust (S2) — GET /sw.js", () => {
  let _savedSha: string | undefined;

  beforeEach(() => {
    _savedSha = process.env.BUILD_SHA;
    delete process.env.BUILD_SHA;
    _resetSwShaWarningForTests();
  });

  afterEach(() => {
    if (_savedSha === undefined) delete process.env.BUILD_SHA;
    else process.env.BUILD_SHA = _savedSha;
    _resetSwShaWarningForTests();
  });

  it("returns 200 + Cache-Control: no-store", async () => {
    const res = await app.request("/sw.js");
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") || "";
    expect(cc).toContain("no-store");
  });

  it("response body contains a non-empty SW_VERSION literal", async () => {
    const res = await app.request("/sw.js");
    const body = await res.text();
    const m = body.match(/const SW_VERSION = "([^"]+)"/);
    expect(m).not.toBeNull();
    expect((m as RegExpMatchArray)[1].length).toBeGreaterThan(0);
  });

  it("body calls self.skipWaiting() on install", async () => {
    const res = await app.request("/sw.js");
    const body = await res.text();
    expect(body).toContain("self.skipWaiting()");
  });

  it("body calls clients.claim() on activate", async () => {
    const res = await app.request("/sw.js");
    const body = await res.text();
    expect(body).toContain("clients.claim()");
  });

  it("body purges stale gluecron-* caches via caches.delete(...)", async () => {
    const res = await app.request("/sw.js");
    const body = await res.text();
    expect(body).toContain("caches.delete");
    expect(body).toContain("CACHE_PREFIX");
    expect(body).toContain('"gluecron-"');
  });

  it("when BUILD_SHA is set, that exact value appears as SW_VERSION", async () => {
    process.env.BUILD_SHA = "abc123deadbeef";
    const res = await app.request("/sw.js");
    const body = await res.text();
    expect(body).toContain('const SW_VERSION = "abc123deadbeef"');
  });

  it("when BUILD_SHA is unset, falls back to a non-empty dev-mode string", () => {
    delete process.env.BUILD_SHA;
    const v = buildSwVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
    expect(v.startsWith("dev-")).toBe(true);
  });

  it("buildVersionedServiceWorker pins CURRENT_CACHE to SW_VERSION", () => {
    const src = buildVersionedServiceWorker("v9");
    expect(src).toContain('const SW_VERSION = "v9"');
    expect(src).toContain("const CURRENT_CACHE = CACHE_PREFIX + SW_VERSION");
  });

  it("buildVersionedServiceWorker escapes quotes + backslashes safely", () => {
    const src = buildVersionedServiceWorker('weird"version\\stuff');
    // The literal in the output must round-trip via the JS string parser —
    // i.e. the embedded quote is backslash-escaped, no raw close on the
    // string would prematurely terminate the version constant.
    expect(src).toContain('const SW_VERSION = "weird\\"version\\\\stuff"');
  });

  it("content-type stays application/javascript", async () => {
    const res = await app.request("/sw.js");
    expect(res.headers.get("content-type") || "").toContain(
      "application/javascript"
    );
  });

  it("service-worker-allowed header is /", async () => {
    const res = await app.request("/sw.js");
    expect(res.headers.get("service-worker-allowed")).toBe("/");
  });
});

describe("pwa cache-bust (S2) — /version alias", () => {
  let _savedSha: string | undefined;
  let _savedTime: string | undefined;

  beforeEach(() => {
    _savedSha = process.env.BUILD_SHA;
    _savedTime = process.env.BUILD_TIME;
  });

  afterEach(() => {
    if (_savedSha === undefined) delete process.env.BUILD_SHA;
    else process.env.BUILD_SHA = _savedSha;
    if (_savedTime === undefined) delete process.env.BUILD_TIME;
    else process.env.BUILD_TIME = _savedTime;
  });

  it("returns {sha, buildAt} with BUILD_SHA + BUILD_TIME echoed", async () => {
    process.env.BUILD_SHA = "deadbeef1234";
    process.env.BUILD_TIME = "2026-05-14T00:00:00Z";
    const res = await app.request("/version");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sha).toBe("deadbeef1234");
    expect(body.buildAt).toBe("2026-05-14T00:00:00Z");
  });

  it("falls back to {sha: 'dev', buildAt: null} when env unset", async () => {
    delete process.env.BUILD_SHA;
    delete process.env.BUILD_TIME;
    const res = await app.request("/version");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sha).toBe("dev");
    expect(body.buildAt).toBeNull();
  });
});

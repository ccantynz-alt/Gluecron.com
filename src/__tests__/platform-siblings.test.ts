/**
 * Cross-product platform-status aggregator + admin widget smoke tests.
 *
 * The real siblings (crontech.ai, gluecron.com, gatetest.io) aren't
 * reachable in test, so we stub `globalThis.fetch` to exercise the three
 * branches: healthy JSON, non-2xx, and outright failure. Each branch must
 * resolve — a sibling being down never crashes the widget.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import app from "../app";
import {
  getSiblingStatuses,
  siblingUrls,
  __resetSiblingCache,
} from "../lib/platform-siblings";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetSiblingCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetSiblingCache();
  delete process.env.CRONTECH_STATUS_URL;
  delete process.env.GLUECRON_STATUS_URL;
  delete process.env.GATETEST_STATUS_URL;
});

describe("platform-siblings — siblingUrls", () => {
  it("returns defaults pointing at production hosts", () => {
    const urls = siblingUrls();
    expect(urls.crontech).toBe("https://crontech.ai/api/platform-status");
    expect(urls.gluecron).toBe("https://gluecron.com/api/platform-status");
    expect(urls.gatetest).toBe("https://gatetest.io/api/platform-status");
  });

  it("honours env var overrides", () => {
    process.env.CRONTECH_STATUS_URL = "https://example.com/ct";
    process.env.GLUECRON_STATUS_URL = "https://example.com/gl";
    process.env.GATETEST_STATUS_URL = "https://example.com/gt";
    const urls = siblingUrls();
    expect(urls.crontech).toBe("https://example.com/ct");
    expect(urls.gluecron).toBe("https://example.com/gl");
    expect(urls.gatetest).toBe("https://example.com/gt");
  });
});

describe("platform-siblings — getSiblingStatuses", () => {
  it("reports healthy when sibling returns healthy JSON", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          product: "x",
          version: "1.2.3",
          commit: "abcdef1234567",
          healthy: true,
          timestamp: "2026-04-20T00:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const rows = await getSiblingStatuses({ force: true });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.reachable).toBe(true);
      expect(r.healthy).toBe(true);
      expect(r.version).toBe("1.2.3");
      expect(r.commit).toBe("abcdef1234567");
      expect(r.error).toBeNull();
      expect(typeof r.latencyMs).toBe("number");
    }
  });

  it("reports degraded (reachable but unhealthy) on non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;

    const rows = await getSiblingStatuses({ force: true });
    for (const r of rows) {
      expect(r.reachable).toBe(true);
      expect(r.healthy).toBe(false);
      expect(r.error).toBe("HTTP 503");
    }
  });

  it("reports unreachable on fetch error, never throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const rows = await getSiblingStatuses({ force: true });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.reachable).toBe(false);
      expect(r.healthy).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });

  it("serves a cached result on the second call", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ healthy: true, version: "v", commit: "c" }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await getSiblingStatuses({ force: true });
    expect(calls).toBe(3);
    await getSiblingStatuses();
    expect(calls).toBe(3);
  });
});

describe("platform-status endpoint", () => {
  it("GET /api/platform-status returns our own health JSON", async () => {
    const res = await app.request("/api/platform-status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.product).toBe("gluecron");
    expect(body.healthy).toBe(true);
    expect(typeof body.timestamp).toBe("string");
    expect(body.siblings).toBeDefined();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("admin platform widget — auth gate", () => {
  it("GET /admin/platform without auth → 302 /login", async () => {
    const res = await app.request("/admin/platform");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

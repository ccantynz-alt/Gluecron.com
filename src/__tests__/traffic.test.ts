/**
 * Block F1 — Traffic analytics tests.
 *
 * Pure bucketDaily tests + route auth smoke.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { bucketDaily } from "../lib/traffic";

describe("traffic — bucketDaily", () => {
  it("returns empty array for no events", () => {
    expect(bucketDaily([])).toEqual([]);
  });

  it("buckets views and clones separately", () => {
    const buckets = bucketDaily([
      { createdAt: "2026-04-14T10:00:00Z", kind: "view" },
      { createdAt: "2026-04-14T12:00:00Z", kind: "view" },
      { createdAt: "2026-04-14T15:00:00Z", kind: "clone" },
      { createdAt: "2026-04-15T09:00:00Z", kind: "view" },
    ]);
    expect(buckets).toEqual([
      { day: "2026-04-14", views: 2, clones: 1 },
      { day: "2026-04-15", views: 1, clones: 0 },
    ]);
  });

  it("counts UI kind as views", () => {
    const buckets = bucketDaily([
      { createdAt: "2026-04-14T00:00:00Z", kind: "ui" },
    ]);
    expect(buckets).toEqual([{ day: "2026-04-14", views: 1, clones: 0 }]);
  });

  it("ignores api kind in view/clone buckets", () => {
    const buckets = bucketDaily([
      { createdAt: "2026-04-14T00:00:00Z", kind: "api" },
    ]);
    expect(buckets).toEqual([{ day: "2026-04-14", views: 0, clones: 0 }]);
  });

  it("sorts buckets by day ascending", () => {
    const buckets = bucketDaily([
      { createdAt: "2026-04-15T00:00:00Z", kind: "view" },
      { createdAt: "2026-04-14T00:00:00Z", kind: "view" },
      { createdAt: "2026-04-16T00:00:00Z", kind: "view" },
    ]);
    expect(buckets.map((b) => b.day)).toEqual([
      "2026-04-14",
      "2026-04-15",
      "2026-04-16",
    ]);
  });
});

describe("traffic — route smoke", () => {
  it("GET /:owner/:repo/traffic without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/traffic");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

describe("traffic — lib exports", () => {
  it("exports track + helpers", async () => {
    const mod = await import("../lib/traffic");
    expect(typeof mod.track).toBe("function");
    expect(typeof mod.trackView).toBe("function");
    expect(typeof mod.trackClone).toBe("function");
    expect(typeof mod.trackByName).toBe("function");
    expect(typeof mod.summarise).toBe("function");
    expect(typeof mod.bucketDaily).toBe("function");
  });
});

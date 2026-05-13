/**
 * Block L3 — public /demo page + JSON endpoint smoke tests.
 *
 * Exercises route status codes + content-type + cache headers, plus the
 * pure-helper behaviour of the activity module (returns `[]` on DB
 * unavailability) and idempotency of `ensureDemoActivity()`.
 *
 * No DB writes from the test — when the test process has no usable
 * `DATABASE_URL`, the helpers fail-soft and we assert that they still
 * return shaped data rather than crashing.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  listRecentAutoMerges,
  listRecentAiReviews,
  listQueuedAiBuildIssues,
  listDemoActivityFeed,
  countAiReviewsSince,
  __test as activityTest,
} from "../lib/demo-activity";
import { ensureDemoActivity } from "../lib/demo-activity-seed";

describe("GET /demo (Block L3 landing page)", () => {
  it("returns 200 HTML", async () => {
    const res = await app.request("/demo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/html");
  });

  it("body mentions 'demo' (page is self-describing)", async () => {
    const res = await app.request("/demo");
    const body = await res.text();
    // Lower-cased substring check — the page mentions the demo repos,
    // the demo user, and the word "demo" multiple times.
    expect(body.toLowerCase()).toContain("demo");
  });

  it("body contains all three tile headings", async () => {
    const res = await app.request("/demo");
    const body = await res.text();
    expect(body).toContain("Issues queued for AI build");
    expect(body).toContain("PRs auto-merged in the last 24h");
    expect(body).toContain("AI reviews posted today");
  });

  it("body contains the sign-up CTA", async () => {
    const res = await app.request("/demo");
    const body = await res.text();
    expect(body).toContain("Sign up free");
    expect(body).toContain('href="/register"');
  });

  it("body contains the live activity feed section", async () => {
    const res = await app.request("/demo");
    const body = await res.text();
    expect(body).toContain("Live activity");
    expect(body).toContain('id="demo-feed-list"');
  });
});

describe("GET /api/v2/demo/activity", () => {
  it("returns 200 JSON with Cache-Control: public, max-age=30", async () => {
    const res = await app.request("/api/v2/demo/activity");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("application/json");
    const cc = res.headers.get("cache-control") || "";
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=30");
    const body = await res.json();
    expect(body).toHaveProperty("entries");
    expect(Array.isArray(body.entries)).toBe(true);
  });
});

describe("GET /api/v2/demo/queued", () => {
  it("returns 200 JSON with items array", async () => {
    const res = await app.request("/api/v2/demo/queued");
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") || "";
    expect(cc).toContain("max-age=30");
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("GET /api/v2/demo/merges", () => {
  it("returns 200 JSON with items array", async () => {
    const res = await app.request("/api/v2/demo/merges");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("GET /api/v2/demo/reviews", () => {
  it("returns 200 JSON with count + items", async () => {
    const res = await app.request("/api/v2/demo/reviews");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("count");
    expect(typeof body.count).toBe("number");
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("demo-activity helpers — graceful on DB error", () => {
  it("listRecentAutoMerges returns an array", async () => {
    activityTest.demoActivityCache.clear();
    const r = await listRecentAutoMerges();
    expect(Array.isArray(r)).toBe(true);
  });

  it("listRecentAiReviews returns an array", async () => {
    activityTest.demoActivityCache.clear();
    const r = await listRecentAiReviews();
    expect(Array.isArray(r)).toBe(true);
  });

  it("listQueuedAiBuildIssues returns an array", async () => {
    activityTest.demoActivityCache.clear();
    const r = await listQueuedAiBuildIssues();
    expect(Array.isArray(r)).toBe(true);
  });

  it("listDemoActivityFeed returns an array", async () => {
    activityTest.demoActivityCache.clear();
    const r = await listDemoActivityFeed();
    expect(Array.isArray(r)).toBe(true);
  });

  it("countAiReviewsSince returns a number", async () => {
    activityTest.demoActivityCache.clear();
    const n = await countAiReviewsSince();
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe("ensureDemoActivity — idempotency", () => {
  it("never throws on repeated calls", async () => {
    let first: unknown = null;
    let second: unknown = null;
    let firstErr: unknown = null;
    let secondErr: unknown = null;
    try {
      first = await ensureDemoActivity();
    } catch (e) {
      firstErr = e;
    }
    try {
      second = await ensureDemoActivity();
    } catch (e) {
      secondErr = e;
    }
    expect(firstErr).toBeNull();
    expect(secondErr).toBeNull();
    // Both calls return a result shape.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first && typeof first === "object" && "added" in first) {
      const r2 = second as { added: { issues: number; prs: number; auditRows: number } };
      // Second run added either zero rows (idempotent) or the same DB
      // simply isn't reachable; either way, second pass must not add MORE
      // than first.
      const f = first as { added: { issues: number; prs: number; auditRows: number } };
      expect(r2.added.issues).toBeLessThanOrEqual(f.added.issues);
      expect(r2.added.prs).toBeLessThanOrEqual(f.added.prs);
      expect(r2.added.auditRows).toBeLessThanOrEqual(f.added.auditRows);
    }
  });
});

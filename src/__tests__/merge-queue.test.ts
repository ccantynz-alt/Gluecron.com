/**
 * Block E5 — Merge queue smoke tests.
 *
 * Integration paths (enqueue → process-next → merge) need a seeded test DB
 * + a real bare repo on disk. Here we cover:
 *  - helper shape (types + default values)
 *  - route-level auth guards (302 redirects to /login for write actions)
 *  - 404 for missing repo on read path
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("merge-queue — route smoke", () => {
  it("GET /:owner/:repo/queue on missing repo → 404 HTML", async () => {
    const res = await app.request("/nobody/missing/queue");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.toLowerCase()).toContain("not found");
  });

  it("POST /:owner/:repo/pulls/1/enqueue without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/pulls/1/enqueue", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /:owner/:repo/queue/abc/dequeue without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/queue/abc/dequeue", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /:owner/:repo/queue/process-next without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/queue/process-next", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

describe("merge-queue — helper exports", () => {
  it("exports enqueuePr, dequeueEntry, listQueue, peekHead, completeEntry", async () => {
    const mod = await import("../lib/merge-queue");
    expect(typeof mod.enqueuePr).toBe("function");
    expect(typeof mod.dequeueEntry).toBe("function");
    expect(typeof mod.listQueue).toBe("function");
    expect(typeof mod.peekHead).toBe("function");
    expect(typeof mod.completeEntry).toBe("function");
    expect(typeof mod.markHeadRunning).toBe("function");
    expect(typeof mod.isQueued).toBe("function");
    expect(typeof mod.queueDepth).toBe("function");
    expect(typeof mod.listQueueWithPrs).toBe("function");
  });
});

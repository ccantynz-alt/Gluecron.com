/**
 * Smoke tests for GET /live-events/:topic — primarily the topic
 * grammar. The full streaming path needs a live DB (read-gate), so we
 * focus on:
 *   - 400 on invalid topics (single-letter, missing kind, bad chars)
 *   - non-400 on the valid forms (single-segment `kind:id`, multi-
 *     segment `kind:id:scope1:scope2`).
 *
 * The route uses softAuth; no cookie required.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

const NON_400_OK = [200, 301, 302, 303, 307, 401, 403, 404, 503];

describe("GET /live-events/:topic — topic grammar", () => {
  it("rejects an empty path beyond the prefix", async () => {
    const res = await app.request("/live-events/", { redirect: "manual" });
    // 404 for "no param" (Hono path doesn't match) is acceptable.
    expect([400, 404]).toContain(res.status);
  });

  it("rejects a kind-only topic (no id)", async () => {
    const res = await app.request("/live-events/repo");
    expect([400, 404]).toContain(res.status);
  });

  it("rejects topics with disallowed characters", async () => {
    const res = await app.request(
      "/live-events/" + encodeURIComponent("repo:has spaces")
    );
    expect(res.status).toBe(400);
  });

  it("rejects topics with embedded slash", async () => {
    const res = await app.request(
      "/live-events/" + encodeURIComponent("repo:foo/bar")
    );
    expect(res.status).toBe(400);
  });

  it("accepts the canonical single-segment form (repo:<uuid>)", async () => {
    const uuid = "00000000-0000-0000-0000-000000000000";
    const res = await app.request(`/live-events/repo:${uuid}`, {
      redirect: "manual",
    });
    // Either 404 (repo not found in DB) or some auth response — but
    // critically not 400. The grammar must accept this shape.
    expect(res.status).not.toBe(400);
    expect(NON_400_OK).toContain(res.status);
  });

  it("accepts a multi-segment topic (repo:<uuid>:issue:7)", async () => {
    const uuid = "00000000-0000-0000-0000-000000000000";
    const res = await app.request(
      `/live-events/repo:${uuid}:issue:7`,
      { redirect: "manual" }
    );
    expect(res.status).not.toBe(400);
    expect(NON_400_OK).toContain(res.status);
  });

  it("accepts a multi-segment PR topic (repo:<uuid>:pr:9)", async () => {
    const uuid = "00000000-0000-0000-0000-000000000000";
    const res = await app.request(
      `/live-events/repo:${uuid}:pr:9`,
      { redirect: "manual" }
    );
    expect(res.status).not.toBe(400);
    expect(NON_400_OK).toContain(res.status);
  });

  it("accepts a non-repo kind (passes the read-gate)", async () => {
    // `user:42` is not a repo so the auth-gate is bypassed; should
    // open a stream (200 + text/event-stream) or fail later.
    const res = await app.request(`/live-events/user:42`, {
      redirect: "manual",
    });
    expect(res.status).not.toBe(400);
  });
});

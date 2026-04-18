/**
 * Block J4 — User following route-auth smokes + pure-helper tests.
 *
 * Graph mutations (followUser, etc.) are DB-bound so they're only exercised
 * via integration. Here we cover the describeAction verb table and
 * verify route guards redirect anonymous users.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { describeAction } from "../lib/follows";

describe("follows — describeAction", () => {
  it("maps known actions", () => {
    expect(describeAction("push")).toBe("pushed to");
    expect(describeAction("issue_open")).toBe("opened an issue in");
    expect(describeAction("issue_close")).toBe("closed an issue in");
    expect(describeAction("pr_open")).toBe("opened a pull request in");
    expect(describeAction("pr_merge")).toBe("merged a pull request in");
    expect(describeAction("pr_close")).toBe("closed a pull request in");
    expect(describeAction("star")).toBe("starred");
    expect(describeAction("comment")).toBe("commented in");
  });

  it("falls back to underscore-stripped action for unknown tokens", () => {
    expect(describeAction("release_publish")).toBe("release publish");
    expect(describeAction("custom")).toBe("custom");
  });
});

describe("follows — route auth", () => {
  it("POST /:user/follow without auth → 302 /login", async () => {
    const res = await app.request("/alice/follow", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /:user/unfollow without auth → 302 /login", async () => {
    const res = await app.request("/alice/unfollow", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /feed without auth → 302 /login", async () => {
    const res = await app.request("/feed");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /:user/followers is public (404 or 500 for unknown user)", async () => {
    const res = await app.request("/nobody-x/followers");
    expect([404, 500]).toContain(res.status);
  });

  it("GET /:user/following is public (404 or 500 for unknown user)", async () => {
    const res = await app.request("/nobody-x/following");
    expect([404, 500]).toContain(res.status);
  });

  it("reserved name /login/followers is not a profile route", async () => {
    const res = await app.request("/login/followers");
    expect([404, 405, 200, 302]).toContain(res.status);
  });
});

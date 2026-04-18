/**
 * Block E3 — Wikis smoke tests.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { slugifyTitle } from "../routes/wikis";

describe("wikis — slugifyTitle", () => {
  it("lowercases and dashes simple titles", () => {
    expect(slugifyTitle("Home")).toBe("home");
    expect(slugifyTitle("Getting Started")).toBe("getting-started");
  });

  it("strips punctuation", () => {
    expect(slugifyTitle("Hello, World!")).toBe("hello-world");
    expect(slugifyTitle("What's up?")).toBe("whats-up");
  });

  it("collapses consecutive spaces/dashes", () => {
    expect(slugifyTitle("a  b")).toBe("a-b");
    expect(slugifyTitle("a---b")).toBe("a-b");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugifyTitle("  hi  ")).toBe("hi");
    expect(slugifyTitle("-hi-")).toBe("hi");
  });

  it("returns empty string when nothing usable", () => {
    expect(slugifyTitle("")).toBe("");
    expect(slugifyTitle("***")).toBe("");
  });
});

describe("wikis — route smoke", () => {
  it("GET /:owner/:repo/wiki on missing repo → 404", async () => {
    const res = await app.request("/nobody/missing/wiki");
    expect(res.status).toBe(404);
  });

  it("GET /:owner/:repo/wiki/new without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/wiki/new");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /:owner/:repo/wiki without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/wiki", {
      method: "POST",
      body: new URLSearchParams({ title: "Home", body: "welcome" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST edit without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/wiki/home/edit", {
      method: "POST",
      body: new URLSearchParams({ title: "x", body: "y" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST delete without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/wiki/home/delete", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST revert without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/wiki/home/revert/1", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });
});

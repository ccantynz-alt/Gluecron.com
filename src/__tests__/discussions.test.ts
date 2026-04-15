/**
 * Block E2 — Discussions smoke tests.
 *
 * Route integration paths against a real repo would require a seeded test DB;
 * we stick to category validation + public route behaviour (anon access,
 * auth redirects) which exercise middleware + mounting.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { isValidCategory } from "../routes/discussions";

describe("discussions — isValidCategory", () => {
  it("accepts the five canonical categories", () => {
    expect(isValidCategory("general")).toBe(true);
    expect(isValidCategory("q-and-a")).toBe(true);
    expect(isValidCategory("ideas")).toBe(true);
    expect(isValidCategory("announcements")).toBe(true);
    expect(isValidCategory("show-and-tell")).toBe(true);
  });

  it("rejects unknown categories", () => {
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory("random")).toBe(false);
    expect(isValidCategory("Q-AND-A")).toBe(false);
    expect(isValidCategory("sql injection'--")).toBe(false);
  });
});

describe("discussions — route smoke", () => {
  it("GET /:owner/:repo/discussions on missing repo → 404 HTML", async () => {
    const res = await app.request("/nobody/missing/discussions");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Repository not found");
  });

  it("GET /:owner/:repo/discussions/new without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/discussions/new");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /:owner/:repo/discussions without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/discussions", {
      method: "POST",
      body: new URLSearchParams({ title: "x", body: "y" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /:owner/:repo/discussions/1/comment without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/discussions/1/comment", {
      method: "POST",
      body: new URLSearchParams({ body: "hi" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /:owner/:repo/discussions/1/lock without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/discussions/1/lock", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

/**
 * Block E4 — Gists smoke tests.
 *
 * Full CRUD integration paths require a seeded test DB; we stick to pure
 * helpers (`generateSlug`, `snapshotOf`) + public route behaviour
 * (auth redirects, 404s) which exercise middleware + mounting.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { generateSlug, snapshotOf } from "../routes/gists";

describe("gists — generateSlug", () => {
  it("returns an 8-char lowercase hex string", () => {
    const s = generateSlug();
    expect(s).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns different values across calls", () => {
    const a = generateSlug();
    const b = generateSlug();
    expect(a).not.toBe(b);
  });
});

describe("gists — snapshotOf", () => {
  it("JSON-encodes filename → content map", () => {
    const snap = snapshotOf([
      { filename: "a.ts", content: "export const a = 1;" },
      { filename: "b.md", content: "# hello" },
    ]);
    const parsed = JSON.parse(snap);
    expect(parsed["a.ts"]).toBe("export const a = 1;");
    expect(parsed["b.md"]).toBe("# hello");
  });

  it("handles empty input", () => {
    expect(snapshotOf([])).toBe("{}");
  });

  it("last duplicate filename wins", () => {
    const snap = snapshotOf([
      { filename: "x", content: "first" },
      { filename: "x", content: "second" },
    ]);
    expect(JSON.parse(snap).x).toBe("second");
  });
});

describe("gists — route smoke", () => {
  it("GET /gists → 200 HTML", async () => {
    const res = await app.request("/gists");
    expect(res.status).toBe(200);
  });

  it("GET /gists/new without auth → 302 /login", async () => {
    const res = await app.request("/gists/new");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /gists without auth → 302 /login", async () => {
    const res = await app.request("/gists", {
      method: "POST",
      body: new URLSearchParams({ description: "x" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("GET /gists/nonexistent → 404", async () => {
    const res = await app.request("/gists/ffffffff");
    expect(res.status).toBe(404);
  });

  it("GET /gists/xxx/edit without auth → 302 /login", async () => {
    const res = await app.request("/gists/abc12345/edit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /gists/xxx/delete without auth → 302 /login", async () => {
    const res = await app.request("/gists/abc12345/delete", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /gists/xxx/star without auth → 302 /login", async () => {
    const res = await app.request("/gists/abc12345/star", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });
});

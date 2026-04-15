/**
 * Block E1 — Projects / kanban smoke tests.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("projects — route smoke", () => {
  it("GET /:owner/:repo/projects on missing repo → 404", async () => {
    const res = await app.request("/nobody/missing/projects");
    expect(res.status).toBe(404);
  });

  it("GET /:owner/:repo/projects/new without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/projects/new");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /:owner/:repo/projects without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/projects", {
      method: "POST",
      body: new URLSearchParams({ title: "x" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /:owner/:repo/projects/1/columns without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/projects/1/columns", {
      method: "POST",
      body: new URLSearchParams({ name: "Later" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /:owner/:repo/projects/1/items without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/projects/1/items", {
      method: "POST",
      body: new URLSearchParams({ column_id: "x", title: "card" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST close without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/projects/1/close", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });
});

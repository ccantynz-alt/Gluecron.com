/**
 * Block I1+I2+I3 — Archive, template, transfer route auth smoke.
 * Also asserts the command palette payload is injected into Layout output.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { Layout } from "../views/layout";

describe("repo-lifecycle — archive", () => {
  it("POST /:owner/:repo/settings/archive without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/archive", {
      method: "POST",
      body: new URLSearchParams({ archive: "1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

describe("repo-lifecycle — template", () => {
  it("POST /:owner/:repo/settings/template without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/template", {
      method: "POST",
      body: new URLSearchParams({ template: "1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /:owner/:repo/use-template without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/use-template", {
      method: "POST",
      body: new URLSearchParams({ name: "new-repo" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

describe("repo-lifecycle — transfer", () => {
  it("POST /:owner/:repo/settings/transfer without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/transfer", {
      method: "POST",
      body: new URLSearchParams({ new_owner: "bob" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

describe("command palette — Layout markup", () => {
  it("renders cmdk-backdrop + cmdk-panel + cmdk-input in every layout", () => {
    const vnode = Layout({ title: "Test", children: "x" } as any);
    // vnode.toString() renders JSX to HTML in Hono's JSX runtime
    const html = String(vnode);
    expect(html).toContain("cmdk-backdrop");
    expect(html).toContain("cmdk-panel");
    expect(html).toContain("cmdk-input");
    expect(html).toContain("cmdk-list");
  });

  it("command palette script registers COMMANDS list", () => {
    const vnode = Layout({ title: "Test", children: "x" } as any);
    const html = String(vnode);
    // Script body should mention some canonical destinations
    expect(html).toContain("Go to Dashboard");
    expect(html).toContain("Marketplace");
    expect(html).toContain("GraphQL explorer");
  });
});

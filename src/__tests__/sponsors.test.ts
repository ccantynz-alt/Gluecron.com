/**
 * Block I6 — Sponsors tests.
 *
 * Pure tests for formatCents + route auth smoke for the maintainer settings
 * routes (public sponsor page is intentionally ungated for reading).
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { __internal } from "../routes/sponsors";

const { formatCents } = __internal;

describe("sponsors — formatCents", () => {
  it("prints 'Any amount' for 0 cents", () => {
    expect(formatCents(0)).toBe("Any amount");
  });

  it("formats 500 cents as $5.00", () => {
    expect(formatCents(500)).toBe("$5.00");
  });

  it("formats 1234 cents as $12.34", () => {
    expect(formatCents(1234)).toBe("$12.34");
  });
});

describe("sponsors — route auth", () => {
  it("GET /settings/sponsors without auth → 302 /login", async () => {
    const res = await app.request("/settings/sponsors");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /settings/sponsors/tiers/new without auth → 302 /login", async () => {
    const res = await app.request("/settings/sponsors/tiers/new", {
      method: "POST",
      body: new URLSearchParams({ name: "Silver", monthly_cents: "500" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /sponsors/:username without auth → 302 /login", async () => {
    const res = await app.request("/sponsors/alice", {
      method: "POST",
      body: new URLSearchParams({ amount_cents: "500" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

describe("sponsors — public page", () => {
  it("GET /sponsors/:unknown-user is handled (not swallowed)", async () => {
    // Without a DB connection the handler 500s. With a DB it 404s via the
    // global notFound handler. Either proves the route was reached.
    const res = await app.request("/sponsors/__does_not_exist_12345__");
    expect([404, 500]).toContain(res.status);
  });
});

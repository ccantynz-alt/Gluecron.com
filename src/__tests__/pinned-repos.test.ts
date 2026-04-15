/**
 * Block J13 — Pinned repos. Pure helpers + route smoke.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { MAX_PINS, __internal } from "../lib/pinned-repos";

describe("pinned-repos — MAX_PINS", () => {
  it("is capped at 6 (GitHub parity)", () => {
    expect(MAX_PINS).toBe(6);
  });
});

describe("pinned-repos — sanitisePinIds", () => {
  const { sanitisePinIds } = __internal;

  it("returns empty for no input", () => {
    expect(sanitisePinIds([])).toEqual([]);
  });

  it("drops null / undefined / empty / whitespace-only", () => {
    expect(sanitisePinIds([null, undefined, "", "   ", "a"])).toEqual(["a"]);
  });

  it("preserves first-seen order and de-dupes", () => {
    expect(sanitisePinIds(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("clamps to MAX_PINS", () => {
    const many = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    const out = sanitisePinIds(many);
    expect(out.length).toBe(MAX_PINS);
    expect(out[0]).toBe("id-0");
    expect(out[MAX_PINS - 1]).toBe(`id-${MAX_PINS - 1}`);
  });

  it("trims whitespace but preserves interior case", () => {
    expect(sanitisePinIds(["  Abc  ", "abc"])).toEqual(["Abc", "abc"]);
  });
});

describe("pinned-repos — routes", () => {
  it("GET /settings/pins requires auth (redirects)", async () => {
    const res = await app.request("/settings/pins");
    expect([302, 401].includes(res.status)).toBe(true);
  });

  it("POST /settings/pins requires auth", async () => {
    const res = await app.request("/settings/pins", {
      method: "POST",
      body: "",
    });
    expect([302, 401].includes(res.status)).toBe(true);
  });

  it("POST with invalid bearer → 401", async () => {
    const res = await app.request("/settings/pins", {
      method: "POST",
      headers: { authorization: "Bearer glc_garbage" },
      body: "",
    });
    expect(res.status).toBe(401);
  });
});

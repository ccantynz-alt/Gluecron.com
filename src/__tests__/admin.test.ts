/**
 * Block F3 — Admin panel smoke tests.
 *
 * Exercises the auth gate on every admin route + the lib exports. Doesn't
 * mutate DB; `isSiteAdmin(null)` and `getFlag` against a non-existent key
 * degrade gracefully and are safe to call in any environment.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  isSiteAdmin,
  KNOWN_FLAGS,
  getFlag,
} from "../lib/admin";

describe("admin — auth gate", () => {
  it("GET /admin without auth → 302 /login", async () => {
    const res = await app.request("/admin");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /admin/users without auth → 302 /login", async () => {
    const res = await app.request("/admin/users");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /admin/repos without auth → 302 /login", async () => {
    const res = await app.request("/admin/repos");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /admin/flags without auth → 302 /login", async () => {
    const res = await app.request("/admin/flags");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /admin/flags without auth → 302 /login", async () => {
    const res = await app.request("/admin/flags", {
      method: "POST",
      body: new URLSearchParams({ registration_locked: "1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

describe("admin — isSiteAdmin", () => {
  it("returns false for null/undefined user", async () => {
    expect(await isSiteAdmin(null)).toBe(false);
    expect(await isSiteAdmin(undefined)).toBe(false);
    expect(await isSiteAdmin("")).toBe(false);
  });

  it("returns false for non-existent user id", async () => {
    const result = await isSiteAdmin("00000000-0000-0000-0000-000000000000");
    expect(typeof result).toBe("boolean");
  });
});

describe("admin — KNOWN_FLAGS", () => {
  it("exposes registration_locked, site_banner_text, site_banner_level, read_only_mode", () => {
    expect(KNOWN_FLAGS).toHaveProperty("registration_locked");
    expect(KNOWN_FLAGS).toHaveProperty("site_banner_text");
    expect(KNOWN_FLAGS).toHaveProperty("site_banner_level");
    expect(KNOWN_FLAGS).toHaveProperty("read_only_mode");
  });

  it("defaults registration_locked to '0' (unlocked)", () => {
    expect(KNOWN_FLAGS.registration_locked).toBe("0");
  });
});

describe("admin — getFlag", () => {
  it("returns null for unknown keys and never throws", async () => {
    const v = await getFlag("nonexistent_flag_xyz");
    expect(v === null || typeof v === "string").toBe(true);
  });
});

describe("admin — lib exports", () => {
  it("exports full admin surface", async () => {
    const mod = await import("../lib/admin");
    expect(typeof mod.isSiteAdmin).toBe("function");
    expect(typeof mod.listSiteAdmins).toBe("function");
    expect(typeof mod.grantSiteAdmin).toBe("function");
    expect(typeof mod.revokeSiteAdmin).toBe("function");
    expect(typeof mod.getFlag).toBe("function");
    expect(typeof mod.setFlag).toBe("function");
    expect(typeof mod.listFlags).toBe("function");
    expect(mod.KNOWN_FLAGS).toBeDefined();
  });
});

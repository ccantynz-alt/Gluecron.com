/**
 * Block H — Marketplace + app identities tests.
 *
 * Pure helpers (slugify, botUsername, normalisePermissions, parsePermissions,
 * hasPermission, generateBearerToken, hashBearer, permissionsSubset) + route
 * auth smoke. DB-dependent helpers (createApp, installApp, verifyInstallToken)
 * are exercised via type/shape checks only — real integration happens on the
 * live server.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  KNOWN_PERMISSIONS,
  KNOWN_EVENTS,
  botUsername,
  generateBearerToken,
  hasPermission,
  hashBearer,
  normalisePermissions,
  parsePermissions,
  permissionsSubset,
  slugify,
} from "../lib/marketplace";

describe("marketplace — slugify", () => {
  it("lowercases + replaces spaces with dashes", () => {
    expect(slugify("My Cool App")).toBe("my-cool-app");
  });

  it("strips non-alphanumeric", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("---foo---")).toBe("foo");
  });

  it("caps at 40 characters", () => {
    const s = slugify("a".repeat(100));
    expect(s.length).toBeLessThanOrEqual(40);
  });

  it("collapses consecutive separators", () => {
    expect(slugify("foo   bar")).toBe("foo-bar");
  });
});

describe("marketplace — botUsername", () => {
  it("appends [bot] suffix", () => {
    expect(botUsername("my-app")).toBe("my-app[bot]");
  });
});

describe("marketplace — permissions", () => {
  it("KNOWN_PERMISSIONS includes contents + issues + pulls + checks", () => {
    expect(KNOWN_PERMISSIONS).toContain("contents:read");
    expect(KNOWN_PERMISSIONS).toContain("contents:write");
    expect(KNOWN_PERMISSIONS).toContain("issues:write");
    expect(KNOWN_PERMISSIONS).toContain("pulls:write");
    expect(KNOWN_PERMISSIONS).toContain("checks:write");
  });

  it("KNOWN_EVENTS includes push + pull_request + issues", () => {
    expect(KNOWN_EVENTS).toContain("push");
    expect(KNOWN_EVENTS).toContain("pull_request");
    expect(KNOWN_EVENTS).toContain("issues");
  });

  it("normalisePermissions drops unknown values", () => {
    const perms = normalisePermissions([
      "contents:read",
      "bogus:thing",
      "issues:write",
    ]);
    expect(perms).toEqual(["contents:read", "issues:write"]);
  });

  it("normalisePermissions de-duplicates", () => {
    const perms = normalisePermissions([
      "contents:read",
      "contents:read",
      "contents:read",
    ]);
    expect(perms.length).toBe(1);
  });

  it("parsePermissions reads JSON array out of DB column", () => {
    const raw = JSON.stringify(["contents:read", "issues:write"]);
    expect(parsePermissions(raw)).toEqual(["contents:read", "issues:write"]);
  });

  it("parsePermissions handles null/empty/invalid JSON", () => {
    expect(parsePermissions(null)).toEqual([]);
    expect(parsePermissions(undefined)).toEqual([]);
    expect(parsePermissions("")).toEqual([]);
    expect(parsePermissions("not json")).toEqual([]);
    expect(parsePermissions("{}")).toEqual([]);
  });

  it("hasPermission direct match", () => {
    expect(hasPermission(["issues:read"], "issues:read")).toBe(true);
  });

  it("hasPermission: write implies read", () => {
    expect(hasPermission(["issues:write"], "issues:read")).toBe(true);
    expect(hasPermission(["contents:write"], "contents:read")).toBe(true);
  });

  it("hasPermission: read does NOT imply write", () => {
    expect(hasPermission(["issues:read"], "issues:write")).toBe(false);
  });

  it("hasPermission: empty grant fails", () => {
    expect(hasPermission([], "issues:read")).toBe(false);
  });

  it("permissionsSubset checks containment", () => {
    expect(
      permissionsSubset(["contents:read"], ["contents:read", "issues:read"])
    ).toBe(true);
    expect(
      permissionsSubset(
        ["contents:read", "admin:god"],
        ["contents:read"]
      )
    ).toBe(false);
  });
});

describe("marketplace — bearer tokens", () => {
  it("generateBearerToken produces ghi_ prefix + hex body", () => {
    const { token, hash } = generateBearerToken();
    expect(token.startsWith("ghi_")).toBe(true);
    expect(token.length).toBeGreaterThan(10);
    expect(hash.length).toBe(64); // sha256 hex
  });

  it("generateBearerToken yields unique tokens", () => {
    const a = generateBearerToken();
    const b = generateBearerToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hashBearer is deterministic", () => {
    const t = "ghi_deadbeef";
    expect(hashBearer(t)).toBe(hashBearer(t));
  });

  it("hashBearer of generated token matches returned hash", () => {
    const { token, hash } = generateBearerToken();
    expect(hashBearer(token)).toBe(hash);
  });
});

describe("marketplace — route smoke", () => {
  it("GET /marketplace → 200 (public)", async () => {
    const res = await app.request("/marketplace");
    expect(res.status).toBe(200);
  });

  it("GET /marketplace?q=foo → 200", async () => {
    const res = await app.request("/marketplace?q=foo");
    expect(res.status).toBe(200);
  });

  it("GET /marketplace/unknown-slug → 404", async () => {
    const res = await app.request(
      "/marketplace/this-app-does-not-exist-abcdef"
    );
    expect(res.status).toBe(404);
  });

  it("POST /marketplace/:slug/install without auth → 302 /login", async () => {
    const res = await app.request("/marketplace/foo/install", {
      method: "POST",
      body: new URLSearchParams({}),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /settings/apps without auth → 302 /login", async () => {
    const res = await app.request("/settings/apps");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /developer/apps-new without auth → 302 /login", async () => {
    const res = await app.request("/developer/apps-new");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /developer/apps-new without auth → 302 /login", async () => {
    const res = await app.request("/developer/apps-new", {
      method: "POST",
      body: new URLSearchParams({ name: "My App" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /developer/apps/:slug/manage without auth → 302 /login", async () => {
    const res = await app.request("/developer/apps/foo/manage");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

describe("marketplace — lib exports", () => {
  it("exports the full surface", async () => {
    const mod = await import("../lib/marketplace");
    expect(typeof mod.slugify).toBe("function");
    expect(typeof mod.botUsername).toBe("function");
    expect(typeof mod.normalisePermissions).toBe("function");
    expect(typeof mod.parsePermissions).toBe("function");
    expect(typeof mod.hasPermission).toBe("function");
    expect(typeof mod.permissionsSubset).toBe("function");
    expect(typeof mod.generateBearerToken).toBe("function");
    expect(typeof mod.hashBearer).toBe("function");
    expect(typeof mod.listPublicApps).toBe("function");
    expect(typeof mod.getAppBySlug).toBe("function");
    expect(typeof mod.createApp).toBe("function");
    expect(typeof mod.installApp).toBe("function");
    expect(typeof mod.uninstallApp).toBe("function");
    expect(typeof mod.issueInstallToken).toBe("function");
    expect(typeof mod.verifyInstallToken).toBe("function");
    expect(typeof mod.listInstallationsForApp).toBe("function");
    expect(typeof mod.listInstallationsForTarget).toBe("function");
    expect(typeof mod.listEventsForApp).toBe("function");
    expect(typeof mod.countInstalls).toBe("function");
    expect(Array.isArray(mod.KNOWN_PERMISSIONS)).toBe(true);
    expect(Array.isArray(mod.KNOWN_EVENTS)).toBe(true);
  });
});

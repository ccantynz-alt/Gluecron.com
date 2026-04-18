/**
 * Block E7 — Protected tags tests.
 *
 * Covers pure `matchGlob`-based matching behaviour on a fake rule set + route
 * auth smoke. We don't hit the DB — instead, a small wrapper reimplements the
 * matching logic the lib uses (identical semantics).
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { matchGlob } from "../lib/environments";

/**
 * Mirrors the matching logic in `matchProtectedTag` so we can exercise it
 * without a DB. Keep in sync with src/lib/protected-tags.ts.
 */
function matchPatternLocal(
  patterns: string[],
  tagName: string
): string | null {
  const name = tagName.startsWith("refs/tags/")
    ? tagName.slice("refs/tags/".length)
    : tagName;
  const exact = patterns.find(
    (p) => (p.startsWith("refs/tags/") ? p.slice(10) : p) === name
  );
  if (exact) return exact;
  const globs = patterns
    .filter((p) => p.includes("*"))
    .sort((a, b) => a.localeCompare(b));
  for (const p of globs) {
    if (matchGlob(name, p)) return p;
  }
  return null;
}

describe("protected-tags — pattern matching", () => {
  it("matches exact tag names", () => {
    expect(matchPatternLocal(["v1.0.0"], "v1.0.0")).toBe("v1.0.0");
    expect(matchPatternLocal(["v1.0.0"], "v1.0.1")).toBe(null);
  });

  it("matches glob prefixes", () => {
    expect(matchPatternLocal(["v*"], "v1.2.3")).toBe("v*");
    expect(matchPatternLocal(["release-*"], "release-2024")).toBe("release-*");
    expect(matchPatternLocal(["release-*"], "feature-x")).toBe(null);
  });

  it("strips refs/tags/ prefix before matching", () => {
    expect(matchPatternLocal(["v*"], "refs/tags/v2.0.0")).toBe("v*");
  });

  it("returns null when no pattern matches", () => {
    expect(matchPatternLocal(["v*", "release-*"], "main")).toBe(null);
    expect(matchPatternLocal([], "v1.0.0")).toBe(null);
  });

  it("exact match wins over glob", () => {
    // Either order — exact match should be preferred.
    expect(matchPatternLocal(["v*", "v1.0.0"], "v1.0.0")).toBe("v1.0.0");
    expect(matchPatternLocal(["v1.0.0", "v*"], "v1.0.0")).toBe("v1.0.0");
  });
});

describe("protected-tags — route smoke", () => {
  it("GET /settings/protected-tags without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/settings/protected-tags");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /settings/protected-tags without auth → 302 /login", async () => {
    const res = await app.request("/any/repo/settings/protected-tags", {
      method: "POST",
      body: new URLSearchParams({ pattern: "v*" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /settings/protected-tags/:id/delete without auth → 302 /login", async () => {
    const res = await app.request(
      "/any/repo/settings/protected-tags/abc/delete",
      { method: "POST" }
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

describe("protected-tags — lib exports", () => {
  it("exports matchProtectedTag, isProtectedTag, list/add/remove + canBypass", async () => {
    const mod = await import("../lib/protected-tags");
    expect(typeof mod.matchProtectedTag).toBe("function");
    expect(typeof mod.isProtectedTag).toBe("function");
    expect(typeof mod.canBypassProtectedTag).toBe("function");
    expect(typeof mod.listProtectedTags).toBe("function");
    expect(typeof mod.addProtectedTag).toBe("function");
    expect(typeof mod.removeProtectedTag).toBe("function");
    expect(typeof mod.userIdFromUsername).toBe("function");
  });
});

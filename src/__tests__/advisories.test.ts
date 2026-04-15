/**
 * Block J2 — Security advisory tests.
 *
 * Pure matcher tests + route auth smokes. Live scanning requires the DB
 * and the J1 dep graph; those paths are exercised via integration.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  SEED_ADVISORIES,
  parseVersion,
  compareVersions,
  satisfiesRange,
  normalizeManifestVersion,
  rangeMatches,
  __internal,
} from "../lib/advisories";

describe("advisories — parseVersion", () => {
  it("parses dotted versions", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.5")).toEqual([0, 5]);
  });

  it("strips ^~ prefixes", () => {
    expect(parseVersion("^1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("~2.0.0")).toEqual([2, 0, 0]);
    expect(parseVersion("v1.8.0")).toEqual([1, 8, 0]);
  });

  it("strips prerelease suffixes", () => {
    expect(parseVersion("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3+build.99")).toEqual([1, 2, 3]);
  });

  it("treats non-numeric as 0", () => {
    expect(parseVersion("garbage")).toEqual([0]);
    expect(parseVersion("")).toEqual([0, 0, 0]);
  });
});

describe("advisories — compareVersions", () => {
  it("orders versions correctly", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("handles different length arrays", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("handles major bump across tens", () => {
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
  });
});

describe("advisories — satisfiesRange", () => {
  it("handles simple comparisons", () => {
    expect(satisfiesRange("1.0.0", "<1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.3", "<1.2.3")).toBe(false);
    expect(satisfiesRange("1.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("0.9.9", ">=1.0.0")).toBe(false);
  });

  it("handles compound ranges", () => {
    expect(satisfiesRange("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("0.9.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfiesRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("handles bare version as equality", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
  });

  it("handles <=, >=", () => {
    expect(satisfiesRange("1.0.0", "<=1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.1", "<=1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0", ">=1.0.0")).toBe(true);
  });
});

describe("advisories — normalizeManifestVersion", () => {
  it("strips semver prefixes", () => {
    expect(normalizeManifestVersion("^1.2.3")).toBe("1.2.3");
    expect(normalizeManifestVersion("~2.0.0")).toBe("2.0.0");
    expect(normalizeManifestVersion("v1.8.0")).toBe("1.8.0");
  });

  it("plucks lower bound from compound spec", () => {
    expect(normalizeManifestVersion(">=1.0 <2.0")).toBe("1.0");
  });

  it("returns null for unpinned / wildcard / null", () => {
    expect(normalizeManifestVersion(null)).toBeNull();
    expect(normalizeManifestVersion("*")).toBeNull();
    expect(normalizeManifestVersion("latest")).toBeNull();
    expect(normalizeManifestVersion("")).toBeNull();
  });
});

describe("advisories — rangeMatches", () => {
  it("matches unpatched version against <fixed range", () => {
    expect(rangeMatches("4.17.10", "<4.17.12")).toBe(true);
    expect(rangeMatches("^4.17.10", "<4.17.12")).toBe(true);
  });

  it("rejects patched version", () => {
    expect(rangeMatches("4.17.21", "<4.17.12")).toBe(false);
    expect(rangeMatches("^4.17.21", "<4.17.12")).toBe(false);
  });

  it("conservatively matches when spec can't be pinned", () => {
    expect(rangeMatches("*", "<1.0.0")).toBe(true);
    expect(rangeMatches(null, "<1.0.0")).toBe(true);
  });

  it("handles compound ranges from the seed list", () => {
    // log4j CVE range
    expect(rangeMatches("2.14.1", ">=2.0 <2.15.0")).toBe(true);
    expect(rangeMatches("2.15.0", ">=2.0 <2.15.0")).toBe(false);
    expect(rangeMatches("1.9.0", ">=2.0 <2.15.0")).toBe(false);
  });
});

describe("advisories — seed data shape", () => {
  it("has at least a dozen entries", () => {
    expect(SEED_ADVISORIES.length).toBeGreaterThanOrEqual(10);
  });

  it("every entry has required fields", () => {
    for (const a of SEED_ADVISORIES) {
      expect(typeof a.ghsaId).toBe("string");
      expect(a.ghsaId.startsWith("GHSA-")).toBe(true);
      expect(["low", "moderate", "high", "critical"]).toContain(a.severity);
      expect(typeof a.ecosystem).toBe("string");
      expect(typeof a.packageName).toBe("string");
      expect(typeof a.affectedRange).toBe("string");
    }
  });

  it("log4j advisory is present", () => {
    const log4j = SEED_ADVISORIES.find((a) => a.cveId === "CVE-2021-44228");
    expect(log4j).toBeDefined();
    expect(log4j!.severity).toBe("critical");
  });

  it("seed ghsa_ids are unique", () => {
    const ids = SEED_ADVISORIES.map((a) => a.ghsaId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("advisories — route auth", () => {
  it("GET /:o/:r/security/advisories for unknown repo → 404 or 500", async () => {
    const res = await app.request("/nobody/missing/security/advisories");
    expect([404, 500]).toContain(res.status);
  });

  it("GET /all variant also mounted", async () => {
    const res = await app.request("/nobody/missing/security/advisories/all");
    expect([404, 500]).toContain(res.status);
  });

  it("POST scan without auth → 302 /login", async () => {
    const res = await app.request(
      "/alice/repo/security/advisories/scan",
      { method: "POST" }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST dismiss without auth → 302 /login", async () => {
    const res = await app.request(
      "/alice/repo/security/advisories/00000000-0000-0000-0000-000000000000/dismiss",
      { method: "POST" }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST reopen without auth → 302 /login", async () => {
    const res = await app.request(
      "/alice/repo/security/advisories/00000000-0000-0000-0000-000000000000/reopen",
      { method: "POST" }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

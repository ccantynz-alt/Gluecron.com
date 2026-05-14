/**
 * Block S1+S3 — post-deploy smoke suite tests.
 *
 * Covers the pure layer of `src/lib/post-deploy-smoke.ts`:
 *   - CHECKS array shape (every check has name + url + at least one
 *     expectation)
 *   - assertion helpers (assertStatus / assertKey / assertContains)
 *   - the runner returns ok=false when ANY check fails, ok=true when all
 *     green
 *   - missingMigrations + latestMigration helpers
 *
 * No real network, no mock pollution: every test supplies its own
 * fetch impl via DI.
 */

import { describe, it, expect } from "bun:test";
import {
  CHECKS,
  assertStatus,
  assertKey,
  assertContains,
  runChecks,
  formatTable,
  missingMigrations,
  latestMigration,
  type Check,
  type FetchLike,
} from "../lib/post-deploy-smoke";

// ─── helpers ────────────────────────────────────────────────────────

function res(status: number, body: string): { status: number; text: () => Promise<string> } {
  return { status, text: async () => body };
}

function jsonRes(status: number, obj: unknown) {
  return res(status, JSON.stringify(obj));
}

function alwaysOkFetch(): FetchLike {
  return async (url) => {
    // Default-OK responses that pass every shipped check in CHECKS.
    if (url.endsWith("/healthz"))
      return jsonRes(200, { ok: true, uptimeMs: 1 });
    if (url.endsWith("/readyz")) return jsonRes(200, { ok: true });
    if (url.endsWith("/api/version"))
      return jsonRes(200, { sha: "abcdef0", branch: "main", builtAt: "x", uptimeMs: 1 });
    if (url.endsWith("/login"))
      return res(200, "<html><body><h2>Sign in</h2></body></html>");
    if (url.endsWith("/register"))
      return res(200, "<html><body><h2>Create account</h2></body></html>");
    if (url.endsWith("/mcp"))
      return jsonRes(200, { serverInfo: { name: "gluecron" } });
    if (url.endsWith("/api/v2/healthz")) return res(404, "not found");
    if (url.endsWith("/demo")) return res(302, "");
    return res(200, "<html></html>");
  };
}

// ─── CHECKS array shape ─────────────────────────────────────────────

describe("CHECKS array shape", () => {
  it("has at least the 15 critical endpoints the owner specified", () => {
    expect(CHECKS.length).toBeGreaterThanOrEqual(15);
  });

  it("every check has a non-empty name + url + at least one expectation", () => {
    for (const c of CHECKS) {
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.url).toBe("string");
      expect(c.url.startsWith("/")).toBe(true);
      // expectStatus is required; either expectKey or expectContains may
      // additionally be supplied but a check is valid with just status.
      expect(c.expectStatus !== undefined).toBe(true);
    }
  });

  it("covers the specific endpoints the spec called out", () => {
    const names = CHECKS.map((c) => c.name);
    for (const required of [
      "healthz",
      "readyz",
      "version",
      "login renders",
      "register renders",
      "landing renders",
      "explore renders",
      "demo renders",
      "pricing renders",
      "status renders",
      "api v2 health",
      "mcp discovery",
      "manifest",
      "sw",
      "dxt download",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("api v2 health accepts 200 OR 404 (route is optional)", () => {
    const v2 = CHECKS.find((c) => c.name === "api v2 health");
    expect(v2).toBeDefined();
    expect(Array.isArray(v2!.expectStatus)).toBe(true);
    expect((v2!.expectStatus as number[]).sort()).toEqual([200, 404]);
  });
});

// ─── Assertion helpers ──────────────────────────────────────────────

describe("assertStatus", () => {
  it("returns null when the actual status matches a single expected", () => {
    expect(assertStatus(200, 200)).toBeNull();
  });

  it("returns null when the actual status matches one of an array", () => {
    expect(assertStatus(404, [200, 404])).toBeNull();
    expect(assertStatus(200, [200, 404])).toBeNull();
  });

  it("returns a descriptive error when the status doesn't match", () => {
    const err = assertStatus(500, 200);
    expect(err).not.toBeNull();
    expect(err!).toContain("200");
    expect(err!).toContain("500");
  });

  it("returns an error including all acceptable codes when given an array", () => {
    const err = assertStatus(500, [200, 404]);
    expect(err!).toContain("200");
    expect(err!).toContain("404");
  });
});

describe("assertKey", () => {
  it("returns null when the JSON has the key", () => {
    expect(assertKey(`{"ok":true}`, "ok")).toBeNull();
    expect(assertKey(`{"sha":"abc","x":1}`, "sha")).toBeNull();
  });

  it("returns null even when the key's value is null/0/empty (presence-only)", () => {
    expect(assertKey(`{"ok":null}`, "ok")).toBeNull();
    expect(assertKey(`{"ok":0}`, "ok")).toBeNull();
    expect(assertKey(`{"ok":""}`, "ok")).toBeNull();
  });

  it("returns an error when the body isn't JSON", () => {
    expect(assertKey("<html></html>", "ok")).not.toBeNull();
  });

  it("returns an error when the body is JSON but lacks the key", () => {
    expect(assertKey(`{"other":1}`, "ok")).not.toBeNull();
  });

  it("returns an error when the body is a JSON array (not an object)", () => {
    expect(assertKey(`[1,2,3]`, "ok")).not.toBeNull();
  });

  it("doesn't fall for prototype-pollution lookups", () => {
    // `__proto__` is not an own property of {}, so the helper must
    // treat it as missing. (Object.prototype.hasOwnProperty.call is the
    // implementation choice.)
    expect(assertKey(`{}`, "toString")).not.toBeNull();
    expect(assertKey(`{}`, "__proto__")).not.toBeNull();
  });
});

describe("assertContains", () => {
  it("returns null when the body contains the substring", () => {
    expect(assertContains("hello world", "world")).toBeNull();
  });

  it("returns an error including the missing substring", () => {
    const err = assertContains("hello", "world");
    expect(err).not.toBeNull();
    expect(err!).toContain("world");
  });

  it("is case-sensitive (matches the production check exactly)", () => {
    expect(assertContains("Sign In", "Sign in")).not.toBeNull();
  });
});

// ─── runChecks runner ───────────────────────────────────────────────

describe("runChecks", () => {
  it("returns ok=true and failed=0 when every check passes", async () => {
    const summary = await runChecks({
      baseUrl: "http://localhost:3010",
      fetchImpl: alwaysOkFetch(),
    });
    expect(summary.ok).toBe(true);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(summary.results.length);
    expect(summary.results.length).toBe(CHECKS.length);
  });

  it("returns ok=false and failed>=1 when any check fails", async () => {
    const fetchImpl: FetchLike = async (url) => {
      // Break /readyz specifically. Everything else passes.
      if (url.endsWith("/readyz")) return res(503, "db down");
      return alwaysOkFetch()(url);
    };
    const summary = await runChecks({
      baseUrl: "http://localhost:3010",
      fetchImpl,
    });
    expect(summary.ok).toBe(false);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    const readyzResult = summary.results.find((r) => r.name === "readyz")!;
    expect(readyzResult.ok).toBe(false);
    expect(readyzResult.status).toBe(503);
    expect(readyzResult.error).toContain("503");
  });

  it("records a failure when the fetch impl itself throws", async () => {
    const checks: Check[] = [{ name: "x", url: "/x", expectStatus: 200 }];
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const summary = await runChecks({
      baseUrl: "http://localhost:3010",
      checks,
      fetchImpl,
    });
    expect(summary.ok).toBe(false);
    expect(summary.results[0].error).toContain("fetch failed");
    expect(summary.results[0].error).toContain("ECONNREFUSED");
  });

  it("fails a check that expects a JSON key when the body is HTML", async () => {
    const checks: Check[] = [
      { name: "x", url: "/x", expectStatus: 200, expectKey: "sha" },
    ];
    const fetchImpl: FetchLike = async () => res(200, "<html>not json</html>");
    const summary = await runChecks({
      baseUrl: "http://localhost:3010",
      checks,
      fetchImpl,
    });
    expect(summary.ok).toBe(false);
    expect(summary.results[0].error).toContain("JSON");
  });

  it("fails a check that expects a substring when the body lacks it", async () => {
    const checks: Check[] = [
      {
        name: "x",
        url: "/x",
        expectStatus: 200,
        expectContains: "Sign in",
      },
    ];
    const fetchImpl: FetchLike = async () => res(200, "<html>Welcome</html>");
    const summary = await runChecks({
      baseUrl: "http://localhost:3010",
      checks,
      fetchImpl,
    });
    expect(summary.ok).toBe(false);
    expect(summary.results[0].error).toContain("Sign in");
  });

  it("hits checks sequentially in declared order", async () => {
    const calls: string[] = [];
    const checks: Check[] = [
      { name: "a", url: "/a", expectStatus: 200 },
      { name: "b", url: "/b", expectStatus: 200 },
      { name: "c", url: "/c", expectStatus: 200 },
    ];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return res(200, "");
    };
    await runChecks({ baseUrl: "http://x", checks, fetchImpl });
    expect(calls).toEqual(["http://x/a", "http://x/b", "http://x/c"]);
  });

  it("records a duration_ms field on every result using the injected clock", async () => {
    let t = 0;
    const checks: Check[] = [{ name: "x", url: "/x", expectStatus: 200 }];
    const fetchImpl: FetchLike = async () => res(200, "");
    const summary = await runChecks({
      baseUrl: "http://x",
      checks,
      fetchImpl,
      now: () => (t += 17),
    });
    expect(summary.results[0].durationMs).toBe(17);
  });
});

// ─── formatTable ────────────────────────────────────────────────────

describe("formatTable", () => {
  it("renders a header row with all four columns", () => {
    const table = formatTable([
      { name: "x", url: "/x", status: 200, durationMs: 5, ok: true },
    ]);
    expect(table).toContain("name");
    expect(table).toContain("status");
    expect(table).toContain("duration_ms");
    expect(table).toContain("result");
    expect(table).toContain("PASS");
  });

  it("renders FAIL with the error message for failed rows", () => {
    const table = formatTable([
      {
        name: "x",
        url: "/x",
        status: 500,
        durationMs: 5,
        ok: false,
        error: "expected status 200, got 500",
      },
    ]);
    expect(table).toContain("FAIL");
    expect(table).toContain("500");
  });
});

// ─── Migration verification helpers ─────────────────────────────────

describe("missingMigrations", () => {
  it("returns [] when every file is applied", () => {
    const files = ["0001_init.sql", "0002_users.sql", "0003_repos.sql"];
    const applied = ["0001_init.sql", "0002_users.sql", "0003_repos.sql"];
    expect(missingMigrations(files, applied)).toEqual([]);
  });

  it("returns the unapplied files sorted", () => {
    const files = [
      "0001_init.sql",
      "0002_users.sql",
      "0050_a.sql",
      "0051_b.sql",
      "0053_c.sql",
    ];
    const applied = ["0001_init.sql", "0002_users.sql", "0050_a.sql"];
    expect(missingMigrations(files, applied)).toEqual([
      "0051_b.sql",
      "0053_c.sql",
    ]);
  });

  it("ignores non-sql files", () => {
    const files = ["0001_init.sql", "README.md", "0002_x.sql"];
    const applied: string[] = [];
    expect(missingMigrations(files, applied)).toEqual([
      "0001_init.sql",
      "0002_x.sql",
    ]);
  });

  it("returns [] when the file list is empty", () => {
    expect(missingMigrations([], ["any.sql"])).toEqual([]);
  });

  it("treats the applied list as a set (duplicates don't matter)", () => {
    const files = ["0001.sql", "0002.sql"];
    const applied = ["0001.sql", "0001.sql", "0002.sql"];
    expect(missingMigrations(files, applied)).toEqual([]);
  });
});

describe("latestMigration", () => {
  it("returns the lexicographic max .sql", () => {
    expect(
      latestMigration(["0001_init.sql", "0050_x.sql", "0010_y.sql"])
    ).toBe("0050_x.sql");
  });

  it("returns null on empty input", () => {
    expect(latestMigration([])).toBeNull();
  });

  it("ignores non-sql files", () => {
    expect(latestMigration(["0001_init.sql", "README.md", "z.txt"])).toBe(
      "0001_init.sql"
    );
  });

  it("returns null when only non-sql files are present", () => {
    expect(latestMigration(["README.md", "z.txt"])).toBeNull();
  });
});

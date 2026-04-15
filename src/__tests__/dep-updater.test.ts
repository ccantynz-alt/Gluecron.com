/**
 * Block D2 — AI dependency updater tests.
 *
 * Pure-function helpers are covered exhaustively. Route-level tests use
 * the standalone depUpdater router (the app-level mount is performed by
 * the main thread in `src/app.tsx`). They therefore tolerate the whole
 * class of graceful-degradation responses (302 / 404 / 503) that appear
 * when auth redirects or the DB isn't reachable.
 */

import { describe, it, expect } from "bun:test";
import {
  parseManifest,
  planUpdates,
  applyBumps,
} from "../lib/dep-updater";
import depUpdater from "../routes/dep-updater";

describe("parseManifest", () => {
  it("parses a valid package.json", () => {
    const json = JSON.stringify({
      name: "demo",
      dependencies: { hono: "^4.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    });
    const m = parseManifest(json);
    expect(m.name).toBe("demo");
    expect(m.dependencies.hono).toBe("^4.0.0");
    expect(m.devDependencies.typescript).toBe("^5.0.0");
  });

  it("returns empty structures on invalid JSON", () => {
    const m = parseManifest("{ not valid ]");
    expect(m.dependencies).toEqual({});
    expect(m.devDependencies).toEqual({});
  });

  it("returns empty structures for empty input", () => {
    const m = parseManifest("");
    expect(m.dependencies).toEqual({});
    expect(m.devDependencies).toEqual({});
  });

  it("handles missing dependencies key gracefully", () => {
    const m = parseManifest(JSON.stringify({ name: "x" }));
    expect(m.dependencies).toEqual({});
    expect(m.devDependencies).toEqual({});
    expect(m.name).toBe("x");
  });

  it("ignores non-string dependency values", () => {
    const m = parseManifest(
      JSON.stringify({
        dependencies: { a: "1.0.0", b: 42, c: null, d: { foo: 1 } } as any,
      })
    );
    expect(m.dependencies.a).toBe("1.0.0");
    expect(m.dependencies.b).toBeUndefined();
    expect(m.dependencies.c).toBeUndefined();
    expect(m.dependencies.d).toBeUndefined();
  });
});

describe("planUpdates", () => {
  it("produces bumps for outdated packages", async () => {
    const fetchLatest = async (name: string) => {
      const map: Record<string, string> = {
        hono: "4.5.0",
        typescript: "5.4.2",
      };
      return map[name] ?? null;
    };
    const bumps = await planUpdates(
      {
        dependencies: { hono: "^4.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      },
      { fetchLatest }
    );
    expect(bumps).toHaveLength(2);
    const hono = bumps.find((b) => b.name === "hono")!;
    expect(hono.from).toBe("^4.0.0");
    expect(hono.to).toBe("4.5.0");
    expect(hono.kind).toBe("dep");
    expect(hono.major).toBe(false);
    const ts = bumps.find((b) => b.name === "typescript")!;
    expect(ts.kind).toBe("dev");
  });

  it("no-ops when current version matches latest", async () => {
    const bumps = await planUpdates(
      {
        dependencies: { react: "^18.2.0" },
        devDependencies: {},
      },
      { fetchLatest: async () => "18.2.0" }
    );
    expect(bumps).toHaveLength(0);
  });

  it("skips downgrades", async () => {
    const bumps = await planUpdates(
      {
        dependencies: { foo: "^3.0.0" },
        devDependencies: {},
      },
      { fetchLatest: async () => "2.9.0" }
    );
    expect(bumps).toHaveLength(0);
  });

  it("skips non-semver ranges", async () => {
    const bumps = await planUpdates(
      {
        dependencies: {
          a: "workspace:*",
          b: "github:foo/bar",
          c: "file:./local",
          d: "*",
          e: "latest",
          f: "https://example.com/foo.tgz",
        },
        devDependencies: {},
      },
      { fetchLatest: async () => "9.9.9" }
    );
    expect(bumps).toHaveLength(0);
  });

  it("skips packages the registry doesn't return for", async () => {
    const bumps = await planUpdates(
      {
        dependencies: { missing: "^1.0.0" },
        devDependencies: {},
      },
      { fetchLatest: async () => null }
    );
    expect(bumps).toHaveLength(0);
  });

  it("flags major bumps", async () => {
    const bumps = await planUpdates(
      {
        dependencies: { hono: "^3.9.0" },
        devDependencies: {},
      },
      { fetchLatest: async () => "4.0.1" }
    );
    expect(bumps).toHaveLength(1);
    expect(bumps[0].major).toBe(true);
  });

  it("does not flag minor bumps as major", async () => {
    const bumps = await planUpdates(
      {
        dependencies: { hono: "^4.0.0" },
        devDependencies: {},
      },
      { fetchLatest: async () => "4.5.0" }
    );
    expect(bumps[0].major).toBe(false);
  });
});

describe("applyBumps", () => {
  it("rewrites the version of a single dep", () => {
    const input = `{
  "name": "demo",
  "dependencies": {
    "hono": "^4.0.0",
    "zod": "^3.22.0"
  }
}
`;
    const out = applyBumps(input, [
      { name: "hono", to: "4.5.0", kind: "dep" },
    ]);
    expect(out).toContain(`"hono": "^4.5.0"`);
    expect(out).toContain(`"zod": "^3.22.0"`);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("preserves trailing newline exactly", () => {
    const input = `{"dependencies":{"a":"1.0.0"}}\n`;
    const out = applyBumps(input, [
      { name: "a", to: "1.0.1", kind: "dep" },
    ]);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain(`"a":"1.0.1"`);
  });

  it("preserves absence of trailing newline", () => {
    const input = `{"dependencies":{"a":"1.0.0"}}`;
    const out = applyBumps(input, [
      { name: "a", to: "1.0.1", kind: "dep" },
    ]);
    expect(out.endsWith("\n")).toBe(false);
  });

  it("does not touch devDependencies when bumping a dep", () => {
    const input = `{
  "dependencies": { "a": "^1.0.0" },
  "devDependencies": { "a": "^9.0.0" }
}
`;
    const out = applyBumps(input, [
      { name: "a", to: "1.5.0", kind: "dep" },
    ]);
    expect(out).toContain(`"dependencies": { "a": "^1.5.0" }`);
    expect(out).toContain(`"devDependencies": { "a": "^9.0.0" }`);
  });

  it("rewrites devDependencies when kind is dev", () => {
    const input = `{
  "dependencies": { "a": "^1.0.0" },
  "devDependencies": { "a": "^9.0.0" }
}
`;
    const out = applyBumps(input, [
      { name: "a", to: "9.5.0", kind: "dev" },
    ]);
    expect(out).toContain(`"dependencies": { "a": "^1.0.0" }`);
    expect(out).toContain(`"devDependencies": { "a": "^9.5.0" }`);
  });

  it("preserves the version prefix (^, ~, exact)", () => {
    const input = `{"dependencies":{"caret":"^1.0.0","tilde":"~2.0.0","exact":"3.0.0"}}\n`;
    const out = applyBumps(input, [
      { name: "caret", to: "1.5.0", kind: "dep" },
      { name: "tilde", to: "2.5.0", kind: "dep" },
      { name: "exact", to: "3.5.0", kind: "dep" },
    ]);
    expect(out).toContain(`"caret":"^1.5.0"`);
    expect(out).toContain(`"tilde":"~2.5.0"`);
    expect(out).toContain(`"exact":"3.5.0"`);
    expect(out).not.toContain(`"exact":"^3.5.0"`);
  });

  it("handles scoped package names", () => {
    const input = `{"dependencies":{"@scope/pkg":"^1.0.0"}}\n`;
    const out = applyBumps(input, [
      { name: "@scope/pkg", to: "1.1.0", kind: "dep" },
    ]);
    expect(out).toContain(`"@scope/pkg":"^1.1.0"`);
  });

  it("is a no-op when the stanza is missing", () => {
    const input = `{"name":"x"}\n`;
    const out = applyBumps(input, [
      { name: "nothing", to: "1.0.0", kind: "dep" },
    ]);
    expect(out).toBe(input);
  });
});

describe("routes/dep-updater", () => {
  it("GET without auth redirects to /login", async () => {
    const res = await depUpdater.request(
      "/alice/demo/settings/dep-updater",
      { redirect: "manual" }
    );
    // No session cookie + no bearer -> requireAuth redirects.
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login");
  });

  it("POST run without auth redirects to /login", async () => {
    const res = await depUpdater.request(
      "/alice/demo/settings/dep-updater/run",
      { method: "POST", redirect: "manual" }
    );
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login");
  });

  it("GET for a non-existent repo returns redirect or 404", async () => {
    const res = await depUpdater.request(
      "/nobody/nothing/settings/dep-updater",
      { redirect: "manual" }
    );
    // Unauthenticated -> redirect; authed-but-missing -> 404; DB down -> 503.
    expect([302, 303, 404, 503]).toContain(res.status);
  });
});

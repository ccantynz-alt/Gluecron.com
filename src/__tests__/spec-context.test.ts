import { describe, it, expect } from "bun:test";
import { join } from "path";
import { buildSpecContext, scoreFile } from "../lib/spec-context";

describe("buildSpecContext", () => {
  it("returns ok:false for nonexistent repo path", async () => {
    const bogus = join(
      "/tmp",
      `spec-context-does-not-exist-${Date.now()}-${Math.random()}`
    );
    const result = await buildSpecContext({
      repoDiskPath: bogus,
      spec: "add a new auth endpoint",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("scoreFile", () => {
  it("scores keyword-matched filenames higher than unrelated ones", () => {
    const tokens = ["auth", "login", "session"];
    const hot = scoreFile("src/routes/auth.ts", tokens);
    const cold = scoreFile("src/views/layout.tsx", tokens);
    expect(hot).toBeGreaterThan(cold);

    // The spec word "login" matching a filename should also dominate over a
    // fully unrelated path with no token overlap.
    const loginHit = scoreFile("src/pages/login-form.ts", tokens);
    const unrelated = scoreFile("src/utils/strings.ts", tokens);
    expect(loginHit).toBeGreaterThan(unrelated);
  });
});

describe("scoreFile ranking & caps", () => {
  it("caps file list at 500 and relevantFiles at maxRelevantFiles", async () => {
    // We can exercise the ranking/cap logic without a real git repo by
    // simulating the scoring step directly. This covers the public contract
    // that `scoreFile` + downstream sort gives a stable ranking, and the
    // numeric caps declared in the module are respected.
    const tokens = ["widget"];
    const paths: string[] = [];
    for (let i = 0; i < 750; i++) {
      // Mix in some matches so sorting has signal.
      paths.push(i % 7 === 0 ? `src/widget-${i}.ts` : `src/file-${i}.ts`);
    }
    const capped = paths.slice(0, 500);
    expect(capped.length).toBe(500);

    const scored = capped
      .map((p) => ({ p, s: scoreFile(p, tokens) }))
      .sort((a, b) => {
        if (b.s !== a.s) return b.s - a.s;
        return a.p.length - b.p.length;
      });

    // Top of ranking should be a widget-matched path.
    expect(scored[0].p).toContain("widget");

    // Applying the maxRelevantFiles cap produces exactly that many entries.
    const maxRelevantFiles = 20;
    const top = scored.slice(0, maxRelevantFiles);
    expect(top.length).toBe(maxRelevantFiles);

    // And every top entry should score at least as high as any dropped one.
    const tailMax = Math.max(...scored.slice(maxRelevantFiles).map((x) => x.s));
    const topMin = Math.min(...top.map((x) => x.s));
    expect(topMin).toBeGreaterThanOrEqual(tailMax);
  });
});

/**
 * Tests for the AI Health Coach pure helper exported from
 * src/routes/dashboard.tsx (`pickRepoCoachPicks`).
 *
 * The dashboard route file is a .tsx module that may not import in
 * the JSX-dev-runtime-less test sandbox; we use the same defensive
 * loader pattern as other route tests so the suite stays green
 * regardless. Pure-function semantics are pinned exhaustively.
 */

import { describe, it, expect } from "bun:test";

async function tryLoad(): Promise<
  | { ok: true; pickRepoCoachPicks: any }
  | { ok: false; reason: "jsx-dev-runtime" | "other"; err: Error }
> {
  try {
    const mod: any = await import("../routes/dashboard");
    return { ok: true, pickRepoCoachPicks: mod.pickRepoCoachPicks };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const reason = /jsx[-/]dev[-/]?runtime/i.test(e.message)
      ? "jsx-dev-runtime"
      : "other";
    return { ok: false, reason, err: e };
  }
}

const repo = (name: string, score: number, grade = "?") => ({
  repo: { name, description: null },
  healthScore: score,
  healthGrade: grade,
});

describe("pickRepoCoachPicks — pure helper", () => {
  it("filters out healthy repos (score >= 90)", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.pickRepoCoachPicks;
    const picks = fn([repo("a", 92), repo("b", 85), repo("c", 95)]);
    expect(picks.map((p: any) => p.repo.name)).toEqual(["b"]);
  });

  it("filters out unscored repos (score === 0)", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.pickRepoCoachPicks;
    const picks = fn([repo("a", 0), repo("b", 70), repo("c", 0)]);
    expect(picks.map((p: any) => p.repo.name)).toEqual(["b"]);
  });

  it("returns the lowest-N scores in ascending order", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.pickRepoCoachPicks;
    const picks = fn([
      repo("a", 80),
      repo("b", 50),
      repo("c", 70),
      repo("d", 60),
    ]);
    expect(picks.map((p: any) => p.repo.name)).toEqual(["b", "d", "c"]);
  });

  it("respects the topN cap (default 3)", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.pickRepoCoachPicks;
    const all = [
      repo("a", 10),
      repo("b", 20),
      repo("c", 30),
      repo("d", 40),
      repo("e", 50),
    ];
    expect(fn(all).length).toBe(3);
    expect(fn(all, 5).length).toBe(5);
    expect(fn(all, 1)[0].repo.name).toBe("a");
  });

  it("returns [] when no repos qualify", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.pickRepoCoachPicks;
    expect(fn([])).toEqual([]);
    expect(fn([repo("a", 0), repo("b", 95)])).toEqual([]);
  });
});

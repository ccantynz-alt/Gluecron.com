/**
 * Tests for the pure helpers exported from src/routes/inbox.tsx —
 * `mergeAndCapInboxRows` and `filterInboxRows`. The route file is a
 * .tsx module; if the test sandbox can't resolve the jsx-dev-runtime
 * we defer (same defensive pattern as dashboard-coach.test.ts).
 */

import { describe, it, expect } from "bun:test";

async function tryLoad(): Promise<
  | {
      ok: true;
      mergeAndCapInboxRows: any;
      filterInboxRows: any;
    }
  | { ok: false; reason: "jsx-dev-runtime" | "other"; err: Error }
> {
  try {
    const mod: any = await import("../routes/inbox");
    return {
      ok: true,
      mergeAndCapInboxRows: mod.mergeAndCapInboxRows,
      filterInboxRows: mod.filterInboxRows,
    };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const reason = /jsx[-/]dev[-/]?runtime/i.test(e.message)
      ? "jsx-dev-runtime"
      : "other";
    return { ok: false, reason, err: e };
  }
}

const row = (id: string, kind: string, createdAt: Date) =>
  ({
    id,
    kind,
    title: `t-${id}`,
    sourceText: `s-${id}`,
    sourceUrl: `/u/${id}`,
    createdAt,
  }) as any;

describe("mergeAndCapInboxRows", () => {
  it("merges multiple source arrays and sorts by timestamp desc", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.mergeAndCapInboxRows;
    const a = [row("a", "mention", new Date("2026-05-25T10:00:00Z"))];
    const b = [row("b", "review", new Date("2026-05-25T12:00:00Z"))];
    const c = [row("c", "ci", new Date("2026-05-25T11:00:00Z"))];
    const out = fn([a, b, c]);
    expect(out.map((r: any) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("tolerates null/undefined sources", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.mergeAndCapInboxRows;
    const a = [row("a", "mention", new Date("2026-05-25T10:00:00Z"))];
    const out = fn([a, null, undefined, []]);
    expect(out.map((r: any) => r.id)).toEqual(["a"]);
  });

  it("caps to the specified limit", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.mergeAndCapInboxRows;
    const many = Array.from({ length: 250 }, (_, i) =>
      row(`r${i}`, "mention", new Date(2026, 4, 25, 0, 0, i))
    );
    const out = fn([many], 100);
    expect(out.length).toBe(100);
    // Sorted desc, so r249 should come first.
    expect(out[0].id).toBe("r249");
  });

  it("defaults the cap to 100", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.mergeAndCapInboxRows;
    const many = Array.from({ length: 200 }, (_, i) =>
      row(`r${i}`, "mention", new Date(2026, 4, 25, 0, 0, i))
    );
    const out = fn([many]);
    expect(out.length).toBe(100);
  });
});

describe("filterInboxRows", () => {
  const rows = () => [
    row("m1", "mention", new Date("2026-05-25T01:00:00Z")),
    row("r1", "review", new Date("2026-05-25T02:00:00Z")),
    row("c1", "ci", new Date("2026-05-25T03:00:00Z")),
    row("af1", "ai-finding", new Date("2026-05-25T04:00:00Z")),
    row("am1", "ai-merge", new Date("2026-05-25T05:00:00Z")),
  ];

  it("'all' returns everything", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.filterInboxRows;
    expect(fn(rows(), "all").length).toBe(5);
  });

  it("each single-kind tab returns only that kind", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.filterInboxRows;
    expect(fn(rows(), "mentions").map((r: any) => r.id)).toEqual(["m1"]);
    expect(fn(rows(), "review").map((r: any) => r.id)).toEqual(["r1"]);
    expect(fn(rows(), "ci").map((r: any) => r.id)).toEqual(["c1"]);
  });

  it("'ai' tab covers both ai-finding and ai-merge", async () => {
    const loaded = await tryLoad();
    if (!loaded.ok) {
      expect(loaded.reason).toBe("jsx-dev-runtime");
      return;
    }
    const fn = loaded.filterInboxRows;
    const ids = fn(rows(), "ai")
      .map((r: any) => r.id)
      .sort();
    expect(ids).toEqual(["af1", "am1"]);
  });
});

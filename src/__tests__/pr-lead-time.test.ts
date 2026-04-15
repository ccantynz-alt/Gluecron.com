/**
 * Block J29 — PR lead-time metric. Pure rollup tests.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_WINDOW_DAYS,
  VALID_WINDOWS,
  parseWindow,
  formatDuration,
  computeLeadTime,
  computePrStats,
  summariseLeadTimes,
  bucketLeadTimes,
  buildLeadTimeReport,
  __internal,
  type PrLeadTimeInput,
  type PrLeadTimeStat,
} from "../lib/pr-lead-time";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("pr-lead-time — re-exports from J25", () => {
  it("parseWindow accepts the canonical windows", () => {
    expect(parseWindow("0")).toBe(0);
    expect(parseWindow("7")).toBe(7);
    expect(parseWindow("30")).toBe(30);
    expect(parseWindow(undefined)).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindow("garbage")).toBe(DEFAULT_WINDOW_DAYS);
  });
  it("formatDuration still formats", () => {
    expect(formatDuration(null)).toBe("\u2014");
    expect(formatDuration(HOUR)).toBe("1h");
  });
  it("VALID_WINDOWS includes the default", () => {
    expect(VALID_WINDOWS).toContain(DEFAULT_WINDOW_DAYS);
    expect(VALID_WINDOWS).toContain(0);
  });
});

describe("pr-lead-time — computeLeadTime", () => {
  it("returns null when not merged", () => {
    expect(
      computeLeadTime({ createdAt: new Date(), mergedAt: null })
    ).toBeNull();
    expect(
      computeLeadTime({ createdAt: new Date(), mergedAt: undefined })
    ).toBeNull();
  });
  it("returns merged - created", () => {
    expect(
      computeLeadTime({
        createdAt: new Date("2025-01-01T00:00:00Z"),
        mergedAt: new Date("2025-01-01T01:00:00Z"),
      })
    ).toBe(HOUR);
  });
  it("clamps negative deltas to 0", () => {
    expect(
      computeLeadTime({
        createdAt: new Date("2025-01-02T00:00:00Z"),
        mergedAt: new Date("2025-01-01T00:00:00Z"),
      })
    ).toBe(0);
  });
  it("accepts ISO strings", () => {
    expect(
      computeLeadTime({
        createdAt: "2025-01-01T00:00:00Z",
        mergedAt: "2025-01-01T02:30:00Z",
      })
    ).toBe(2 * HOUR + 30 * 60 * 1000);
  });
  it("returns null on unparseable input", () => {
    expect(
      computeLeadTime({ createdAt: "not-a-date", mergedAt: new Date() })
    ).toBeNull();
    expect(
      computeLeadTime({ createdAt: new Date(), mergedAt: "also-bad" })
    ).toBeNull();
  });
});

describe("pr-lead-time — computePrStats + window filter", () => {
  const now = new Date("2025-04-01T00:00:00Z").getTime();
  const prs: PrLeadTimeInput[] = [
    {
      id: "a",
      number: 1,
      title: "recent merged",
      state: "merged",
      createdAt: new Date(now - 2 * DAY),
      mergedAt: new Date(now - 2 * DAY + 3 * HOUR),
    },
    {
      id: "b",
      number: 2,
      title: "old merged",
      state: "merged",
      createdAt: new Date(now - 60 * DAY),
      mergedAt: new Date(now - 60 * DAY + DAY),
    },
    {
      id: "c",
      number: 3,
      title: "open",
      state: "open",
      createdAt: new Date(now - 3 * DAY),
    },
    {
      id: "d",
      number: 4,
      title: "draft",
      state: "open",
      isDraft: true,
      createdAt: new Date(now - 5 * DAY),
    },
    {
      id: "e",
      number: 5,
      title: "closed",
      state: "closed",
      createdAt: new Date(now - 10 * DAY),
    },
    {
      id: "f",
      number: 6,
      title: "bogus",
      state: "open",
      createdAt: "not-a-date",
    },
  ];

  it("filters to the window (30 days)", () => {
    const out = computePrStats(prs, 30, now);
    expect(out.map((s) => s.id).sort()).toEqual(["a", "c", "d", "e"]);
  });

  it("window=0 keeps everything (except unparseable)", () => {
    const out = computePrStats(prs, 0, now);
    expect(out.map((s) => s.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("populates leadMs only for merged", () => {
    const out = computePrStats(prs, 0, now);
    const a = out.find((s) => s.id === "a")!;
    const c = out.find((s) => s.id === "c")!;
    expect(a.leadMs).toBe(3 * HOUR);
    expect(c.leadMs).toBeNull();
  });

  it("populates inFlightMs only for open non-merged", () => {
    const out = computePrStats(prs, 0, now);
    const c = out.find((s) => s.id === "c")!;
    const e = out.find((s) => s.id === "e")!;
    const a = out.find((s) => s.id === "a")!;
    expect(c.inFlightMs).toBe(3 * DAY);
    expect(e.inFlightMs).toBeNull();
    expect(a.inFlightMs).toBeNull();
  });

  it("anchors merged window on mergedAt", () => {
    // PR merged 6 days ago, created 60 days ago → keep in a 30d window
    const far: PrLeadTimeInput = {
      id: "z",
      number: 99,
      title: "old created, recent merge",
      state: "merged",
      createdAt: new Date(now - 60 * DAY),
      mergedAt: new Date(now - 6 * DAY),
    };
    const out = computePrStats([far], 30, now);
    expect(out).toHaveLength(1);
  });
});

describe("pr-lead-time — summariseLeadTimes", () => {
  it("zero stats", () => {
    const s = summariseLeadTimes([]);
    expect(s.total).toBe(0);
    expect(s.merged).toBe(0);
    expect(s.medianMs).toBeNull();
    expect(s.p90Ms).toBeNull();
    expect(s.fastestMs).toBeNull();
    expect(s.slowestMs).toBeNull();
  });

  it("single merged PR", () => {
    const stats: PrLeadTimeStat[] = [
      {
        id: "a",
        number: 1,
        title: "t",
        state: "merged",
        isDraft: false,
        createdAt: 0,
        mergedAt: HOUR,
        leadMs: HOUR,
        inFlightMs: null,
      },
    ];
    const s = summariseLeadTimes(stats);
    expect(s.merged).toBe(1);
    expect(s.medianMs).toBe(HOUR);
    expect(s.p90Ms).toBe(HOUR);
  });

  it("classifies open vs draft vs closed-unmerged separately", () => {
    const mk = (
      over: Partial<PrLeadTimeStat> & { id: string }
    ): PrLeadTimeStat => ({
      id: over.id,
      number: 1,
      title: "x",
      state: "open",
      isDraft: false,
      createdAt: 0,
      mergedAt: null,
      leadMs: null,
      inFlightMs: 1,
      ...over,
    });
    const stats = [
      mk({ id: "openA", state: "open", isDraft: false }),
      mk({ id: "draftA", state: "open", isDraft: true }),
      mk({ id: "closedA", state: "closed", isDraft: false, inFlightMs: null }),
    ];
    const s = summariseLeadTimes(stats);
    expect(s.openNonDraft).toBe(1);
    expect(s.openDraft).toBe(1);
    expect(s.closedUnmerged).toBe(1);
    expect(s.merged).toBe(0);
  });

  it("inclusive-method median + p90 over 1..10h", () => {
    const stats: PrLeadTimeStat[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
      id: String(n),
      number: n,
      title: "t",
      state: "merged",
      isDraft: false,
      createdAt: 0,
      mergedAt: n * HOUR,
      leadMs: n * HOUR,
      inFlightMs: null,
    }));
    const s = summariseLeadTimes(stats);
    expect(s.medianMs).toBe(Math.round(5.5 * HOUR));
    expect(s.meanMs).toBe(Math.round(5.5 * HOUR));
    expect(s.p90Ms).toBe(Math.round(9.1 * HOUR));
    expect(s.fastestMs).toBe(HOUR);
    expect(s.slowestMs).toBe(10 * HOUR);
  });
});

describe("pr-lead-time — bucketLeadTimes", () => {
  it("distributes into four buckets", () => {
    const mk = (leadMs: number | null, id: string): PrLeadTimeStat => ({
      id,
      number: 1,
      title: "t",
      state: leadMs === null ? "open" : "merged",
      isDraft: false,
      createdAt: 0,
      mergedAt: leadMs,
      leadMs,
      inFlightMs: null,
    });
    const b = bucketLeadTimes([
      mk(30 * 60 * 1000, "a"),
      mk(HOUR, "b"), // ≤ 1h (boundary)
      mk(2 * HOUR, "c"),
      mk(25 * HOUR, "d"),
      mk(8 * DAY, "e"),
      mk(null, "n"),
    ]);
    expect(b.within1h).toBe(2);
    expect(b.within1d).toBe(1);
    expect(b.within1w).toBe(1);
    expect(b.over1w).toBe(1);
  });
});

describe("pr-lead-time — buildLeadTimeReport", () => {
  const now = new Date("2025-04-01T00:00:00Z").getTime();

  it("builds a full report", () => {
    const prs: PrLeadTimeInput[] = [
      {
        id: "m",
        number: 1,
        title: "merged",
        state: "merged",
        createdAt: new Date(now - DAY),
        mergedAt: new Date(now - 12 * HOUR),
      },
      {
        id: "o",
        number: 2,
        title: "open",
        state: "open",
        createdAt: new Date(now - 5 * DAY),
      },
      {
        id: "d",
        number: 3,
        title: "draft",
        state: "open",
        isDraft: true,
        createdAt: new Date(now - 7 * DAY),
      },
    ];
    const r = buildLeadTimeReport({ prs, windowDays: 30, now });
    expect(r.windowDays).toBe(30);
    expect(r.now).toBe(now);
    expect(r.perPr).toHaveLength(3);
    expect(r.summary.merged).toBe(1);
    expect(r.summary.openNonDraft).toBe(1);
    expect(r.summary.openDraft).toBe(1);
    expect(r.oldestOpenIds).toEqual(["o"]); // drafts excluded
  });

  it("sorts oldestOpenIds oldest-first", () => {
    const prs: PrLeadTimeInput[] = [
      {
        id: "younger",
        number: 1,
        title: "y",
        state: "open",
        createdAt: new Date(now - DAY),
      },
      {
        id: "older",
        number: 2,
        title: "o",
        state: "open",
        createdAt: new Date(now - 5 * DAY),
      },
    ];
    const r = buildLeadTimeReport({ prs, windowDays: 30, now });
    expect(r.oldestOpenIds).toEqual(["older", "younger"]);
  });

  it("defaults now to Date.now when omitted", () => {
    const before = Date.now();
    const r = buildLeadTimeReport({ prs: [], windowDays: 30 });
    const after = Date.now();
    expect(r.now).toBeGreaterThanOrEqual(before);
    expect(r.now).toBeLessThanOrEqual(after);
  });
});

describe("pr-lead-time — routes", () => {
  it("GET /:o/:r/insights/lead-time returns 2xx or 404 (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/insights/lead-time");
    expect([200, 404]).toContain(res.status);
  });
  it("ignores bogus window values", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/insights/lead-time?window=garbage"
    );
    expect([200, 404]).toContain(res.status);
  });
});

describe("pr-lead-time — __internal parity", () => {
  it("re-exports helpers", () => {
    expect(__internal.parseWindow).toBe(parseWindow);
    expect(__internal.formatDuration).toBe(formatDuration);
    expect(__internal.computeLeadTime).toBe(computeLeadTime);
    expect(__internal.computePrStats).toBe(computePrStats);
    expect(__internal.summariseLeadTimes).toBe(summariseLeadTimes);
    expect(__internal.bucketLeadTimes).toBe(bucketLeadTimes);
    expect(__internal.buildLeadTimeReport).toBe(buildLeadTimeReport);
    expect(typeof __internal.toTime).toBe("function");
    expect(__internal.DEFAULT_WINDOW_DAYS).toBe(DEFAULT_WINDOW_DAYS);
    expect(__internal.VALID_WINDOWS).toBe(VALID_WINDOWS);
  });
});

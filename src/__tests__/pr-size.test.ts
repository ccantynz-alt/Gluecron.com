/**
 * Block J32 — PR size distribution metric. Pure rollup tests.
 */

import { describe, it, expect } from "bun:test";
import {
  PR_SIZE_CLASSES,
  DEFAULT_TOP_N,
  DEFAULT_WINDOW_DAYS,
  VALID_WINDOWS,
  parseWindow,
  classifyPrSize,
  computePrSizeStats,
  summarisePrSizes,
  bucketPrSizes,
  topLargestPrs,
  buildPrSizeReport,
  __internal,
  type PrSizeInput,
  type PrSizeStat,
} from "../lib/pr-size";

const DAY = 24 * 60 * 60 * 1000;

describe("pr-size — re-exports from J25", () => {
  it("parseWindow accepts canonical windows", () => {
    expect(parseWindow("7")).toBe(7);
    expect(parseWindow(undefined)).toBe(DEFAULT_WINDOW_DAYS);
  });
  it("VALID_WINDOWS includes the default", () => {
    expect(VALID_WINDOWS).toContain(DEFAULT_WINDOW_DAYS);
  });
});

describe("pr-size — classifyPrSize", () => {
  it("maps to the five classes by boundary", () => {
    expect(classifyPrSize(0)).toBe("xs");
    expect(classifyPrSize(10)).toBe("xs"); // inclusive
    expect(classifyPrSize(11)).toBe("s");
    expect(classifyPrSize(50)).toBe("s"); // inclusive
    expect(classifyPrSize(51)).toBe("m");
    expect(classifyPrSize(250)).toBe("m");
    expect(classifyPrSize(251)).toBe("l");
    expect(classifyPrSize(1000)).toBe("l");
    expect(classifyPrSize(1001)).toBe("xl");
    expect(classifyPrSize(99_999)).toBe("xl");
  });
  it("defaults bogus values to xs", () => {
    expect(classifyPrSize(Number.NaN)).toBe("xs");
    expect(classifyPrSize(-5)).toBe("xs");
  });
  it("has exactly five ordered classes", () => {
    expect(PR_SIZE_CLASSES).toHaveLength(5);
    expect(PR_SIZE_CLASSES.map((c) => c.key)).toEqual([
      "xs",
      "s",
      "m",
      "l",
      "xl",
    ]);
  });
});

describe("pr-size — computePrSizeStats + window", () => {
  const now = new Date("2025-04-01T00:00:00Z").getTime();
  const prs: PrSizeInput[] = [
    {
      id: "m",
      number: 1,
      title: "merged recent",
      state: "merged",
      createdAt: new Date(now - 60 * DAY),
      mergedAt: new Date(now - 5 * DAY), // anchors on mergedAt
      additions: 30,
      deletions: 10,
      files: 3,
    },
    {
      id: "o",
      number: 2,
      title: "open recent",
      state: "open",
      createdAt: new Date(now - 3 * DAY),
      additions: 300,
      deletions: 50,
      files: 10,
    },
    {
      id: "old",
      number: 3,
      title: "old open",
      state: "open",
      createdAt: new Date(now - 90 * DAY),
      additions: 5,
      deletions: 5,
      files: 1,
    },
    {
      id: "bogus",
      number: 4,
      title: "bad date",
      state: "open",
      createdAt: "not-a-date",
      additions: 10,
      deletions: 10,
      files: 1,
    },
  ];

  it("filters to the window", () => {
    const out = computePrSizeStats(prs, 30, now);
    expect(out.map((s) => s.id).sort()).toEqual(["m", "o"]);
  });

  it("computes linesChanged + sizeClass", () => {
    const out = computePrSizeStats(prs, 0, now);
    const m = out.find((s) => s.id === "m")!;
    const o = out.find((s) => s.id === "o")!;
    expect(m.linesChanged).toBe(40);
    expect(m.sizeClass).toBe("s");
    expect(o.linesChanged).toBe(350);
    expect(o.sizeClass).toBe("l");
  });

  it("window=0 keeps everything parseable", () => {
    const out = computePrSizeStats(prs, 0, now);
    expect(out.map((s) => s.id).sort()).toEqual(["m", "o", "old"]);
  });

  it("drops PRs with unparseable createdAt", () => {
    const out = computePrSizeStats(prs, 0, now);
    expect(out.some((s) => s.id === "bogus")).toBe(false);
  });

  it("anchors merged PRs on mergedAt so recent merges with old createdAt land in window", () => {
    const far: PrSizeInput = {
      id: "z",
      number: 99,
      title: "ancient PR, recent merge",
      state: "merged",
      createdAt: new Date(now - 365 * DAY),
      mergedAt: new Date(now - 2 * DAY),
      additions: 100,
      deletions: 0,
      files: 1,
    };
    const out = computePrSizeStats([far], 7, now);
    expect(out).toHaveLength(1);
  });

  it("treats negative / NaN line counts as zero", () => {
    const pr: PrSizeInput = {
      id: "neg",
      number: 1,
      title: "garbage numbers",
      state: "open",
      createdAt: new Date(now),
      additions: -10,
      deletions: Number.NaN,
      files: 2,
    };
    const [stat] = computePrSizeStats([pr], 0, now);
    expect(stat!.linesChanged).toBe(0);
    expect(stat!.sizeClass).toBe("xs");
  });
});

describe("pr-size — summarisePrSizes", () => {
  it("zero stats", () => {
    const s = summarisePrSizes([]);
    expect(s.total).toBe(0);
    expect(s.medianLines).toBe(0);
    expect(s.p90Lines).toBe(0);
    expect(s.smallPrRatio).toBe(0);
  });

  it("computes percentiles over a uniform series", () => {
    const stats: PrSizeStat[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
      id: String(n),
      number: n,
      title: "t",
      state: "merged",
      isDraft: false,
      createdAt: new Date(),
      additions: n,
      deletions: 0,
      files: 1,
      linesChanged: n,
      sizeClass: "xs",
    }));
    const s = summarisePrSizes(stats);
    expect(s.total).toBe(10);
    expect(s.medianLines).toBe(6); // round(5.5)
    expect(s.meanLines).toBe(6); // round(5.5)
    expect(s.p90Lines).toBe(9); // round(9.1)
    expect(s.largestLines).toBe(10);
    expect(s.smallestLines).toBe(1);
    expect(s.smallPrRatio).toBe(100); // all xs
  });

  it("classifies merged / open / draft separately", () => {
    const mk = (
      over: Partial<PrSizeStat> & { id: string }
    ): PrSizeStat => ({
      id: over.id,
      number: 1,
      title: "t",
      state: "open",
      isDraft: false,
      createdAt: new Date(),
      additions: 5,
      deletions: 5,
      files: 1,
      linesChanged: 10,
      sizeClass: "xs",
      ...over,
    });
    const stats = [
      mk({ id: "merged", state: "merged" }),
      mk({ id: "open", state: "open", isDraft: false }),
      mk({ id: "draft", state: "open", isDraft: true }),
      mk({ id: "closed", state: "closed" }),
    ];
    const s = summarisePrSizes(stats);
    expect(s.merged).toBe(1);
    expect(s.open).toBe(1); // draft excluded
  });

  it("smallPrRatio rounds to one decimal", () => {
    // 1 small PR, 2 large PRs → ratio = 33.3%
    const mk = (linesChanged: number, cls: any): PrSizeStat => ({
      id: String(linesChanged),
      number: linesChanged,
      title: "t",
      state: "merged",
      isDraft: false,
      createdAt: new Date(),
      additions: linesChanged,
      deletions: 0,
      files: 1,
      linesChanged,
      sizeClass: cls,
    });
    const s = summarisePrSizes([
      mk(5, "xs"),
      mk(500, "l"),
      mk(500, "l"),
    ]);
    expect(s.smallPrRatio).toBe(33.3);
  });
});

describe("pr-size — bucketPrSizes", () => {
  it("distributes into the five class buckets with zero-count defaults", () => {
    const mk = (
      id: string,
      linesChanged: number,
      sizeClass: any
    ): PrSizeStat => ({
      id,
      number: 1,
      title: "t",
      state: "merged",
      isDraft: false,
      createdAt: new Date(),
      additions: linesChanged,
      deletions: 0,
      files: 1,
      linesChanged,
      sizeClass,
    });
    const stats = [
      mk("a", 5, "xs"),
      mk("b", 20, "s"),
      mk("c", 100, "m"),
      mk("d", 500, "l"),
      mk("e", 2000, "xl"),
      mk("f", 2, "xs"),
    ];
    const b = bucketPrSizes(stats);
    const by = Object.fromEntries(b.map((x) => [x.key, x]));
    expect(by.xs!.count).toBe(2);
    expect(by.s!.count).toBe(1);
    expect(by.m!.count).toBe(1);
    expect(by.l!.count).toBe(1);
    expect(by.xl!.count).toBe(1);
    expect(by.xs!.bytes).toBe(7);
  });

  it("returns all five buckets for empty input", () => {
    const b = bucketPrSizes([]);
    expect(b).toHaveLength(5);
    expect(b.every((x) => x.count === 0 && x.bytes === 0)).toBe(true);
  });
});

describe("pr-size — topLargestPrs", () => {
  const mk = (
    id: string,
    linesChanged: number,
    number: number
  ): PrSizeStat => ({
    id,
    number,
    title: "t",
    state: "merged",
    isDraft: false,
    createdAt: new Date(),
    additions: linesChanged,
    deletions: 0,
    files: 1,
    linesChanged,
    sizeClass: "xs",
  });

  it("returns sorted-desc by linesChanged", () => {
    const out = topLargestPrs([
      mk("a", 10, 1),
      mk("b", 1000, 2),
      mk("c", 50, 3),
    ]);
    expect(out.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("tie-breaks by PR number descending", () => {
    const out = topLargestPrs([
      mk("older", 100, 1),
      mk("newer", 100, 2),
    ]);
    expect(out[0]!.id).toBe("newer");
    expect(out[1]!.id).toBe("older");
  });

  it("honours limit", () => {
    const stats = Array.from({ length: 50 }, (_, i) => mk(String(i), i, i));
    expect(topLargestPrs(stats, 5)).toHaveLength(5);
  });

  it("defaults invalid limits to DEFAULT_TOP_N", () => {
    const stats = Array.from({ length: 50 }, (_, i) => mk(String(i), i, i));
    expect(topLargestPrs(stats, 0)).toHaveLength(DEFAULT_TOP_N);
    expect(topLargestPrs(stats, -5)).toHaveLength(DEFAULT_TOP_N);
  });

  it("never mutates input", () => {
    const stats = [mk("a", 10, 1), mk("b", 1000, 2)];
    const copy = [...stats];
    topLargestPrs(stats);
    expect(stats).toEqual(copy);
  });
});

describe("pr-size — buildPrSizeReport", () => {
  const now = new Date("2025-04-01T00:00:00Z").getTime();
  const prs: PrSizeInput[] = [
    {
      id: "a",
      number: 1,
      title: "tiny",
      state: "merged",
      createdAt: new Date(now - DAY),
      mergedAt: new Date(now - DAY),
      additions: 2,
      deletions: 1,
      files: 1,
    },
    {
      id: "b",
      number: 2,
      title: "huge",
      state: "merged",
      createdAt: new Date(now - 2 * DAY),
      mergedAt: new Date(now - 2 * DAY),
      additions: 800,
      deletions: 400,
      files: 50,
    },
    {
      id: "c",
      number: 3,
      title: "open",
      state: "open",
      createdAt: new Date(now - 3 * DAY),
      additions: 40,
      deletions: 0,
      files: 2,
    },
  ];

  it("builds a full report", () => {
    const r = buildPrSizeReport({ prs, windowDays: 30, now });
    expect(r.windowDays).toBe(30);
    expect(r.now).toBe(now);
    expect(r.perPr).toHaveLength(3);
    expect(r.summary.total).toBe(3);
    expect(r.summary.merged).toBe(2);
    expect(r.summary.open).toBe(1);
    expect(r.buckets).toHaveLength(5);
    expect(r.largest[0]!.id).toBe("b");
  });

  it("defaults now to Date.now when omitted", () => {
    const before = Date.now();
    const r = buildPrSizeReport({ prs: [], windowDays: 30 });
    const after = Date.now();
    expect(r.now).toBeGreaterThanOrEqual(before);
    expect(r.now).toBeLessThanOrEqual(after);
  });

  it("defaults windowDays to DEFAULT_WINDOW_DAYS when omitted", () => {
    const r = buildPrSizeReport({ prs: [] });
    expect(r.windowDays).toBe(DEFAULT_WINDOW_DAYS);
  });

  it("honours topN", () => {
    const r = buildPrSizeReport({ prs, windowDays: 30, now, topN: 1 });
    expect(r.largest).toHaveLength(1);
    expect(r.largest[0]!.id).toBe("b");
  });
});

describe("pr-size — routes", () => {
  it("GET /:o/:r/insights/pr-size returns 200 or 404 (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/insights/pr-size");
    expect([200, 404]).toContain(res.status);
  });
  it("ignores bogus window values", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/insights/pr-size?window=abc&top=xyz"
    );
    expect([200, 404]).toContain(res.status);
  });
});

describe("pr-size — __internal parity", () => {
  it("re-exports every helper", () => {
    expect(__internal.PR_SIZE_CLASSES).toBe(PR_SIZE_CLASSES);
    expect(__internal.DEFAULT_TOP_N).toBe(DEFAULT_TOP_N);
    expect(__internal.classifyPrSize).toBe(classifyPrSize);
    expect(__internal.computePrSizeStats).toBe(computePrSizeStats);
    expect(__internal.summarisePrSizes).toBe(summarisePrSizes);
    expect(__internal.bucketPrSizes).toBe(bucketPrSizes);
    expect(__internal.topLargestPrs).toBe(topLargestPrs);
    expect(__internal.buildPrSizeReport).toBe(buildPrSizeReport);
    expect(typeof __internal.toTime).toBe("function");
    expect(typeof __internal.anchorTime).toBe("function");
    expect(typeof __internal.percentile).toBe("function");
    expect(typeof __internal.safeLines).toBe("function");
  });
});

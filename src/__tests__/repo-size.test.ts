/**
 * Block J31 — Repository size audit. Pure helper tests.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_TOP_N,
  SIZE_CLASSES,
  topLevelDir,
  classifyFileSize,
  summariseSize,
  bucketBySize,
  topLargestFiles,
  summariseByTopDir,
  buildSizeReport,
  __internal,
  type RepoSizeEntry,
} from "../lib/repo-size";

const KB = 1024;
const MB = 1024 * 1024;

describe("repo-size — topLevelDir", () => {
  it("extracts the first segment", () => {
    expect(topLevelDir("src/app.ts")).toBe("src");
    expect(topLevelDir("apps/web/main.ts")).toBe("apps");
  });
  it("returns '.' for root-level files", () => {
    expect(topLevelDir("README.md")).toBe(".");
    expect(topLevelDir("package.json")).toBe(".");
  });
  it("handles leading slash", () => {
    expect(topLevelDir("/src/app.ts")).toBe("src");
    expect(topLevelDir("/README.md")).toBe(".");
  });
  it("handles empty / non-string", () => {
    expect(topLevelDir("")).toBe(".");
    // @ts-expect-error
    expect(topLevelDir(null)).toBe(".");
    // @ts-expect-error
    expect(topLevelDir(undefined)).toBe(".");
  });
});

describe("repo-size — classifyFileSize", () => {
  it("maps to the five classes by boundary", () => {
    expect(classifyFileSize(0)).toBe("tiny");
    expect(classifyFileSize(KB - 1)).toBe("tiny");
    expect(classifyFileSize(KB)).toBe("small");
    expect(classifyFileSize(50 * KB)).toBe("small");
    expect(classifyFileSize(100 * KB)).toBe("medium");
    expect(classifyFileSize(500 * KB)).toBe("medium");
    expect(classifyFileSize(MB)).toBe("large");
    expect(classifyFileSize(5 * MB)).toBe("large");
    expect(classifyFileSize(10 * MB)).toBe("xlarge");
    expect(classifyFileSize(50 * MB)).toBe("xlarge");
  });
  it("defaults bogus values to tiny", () => {
    expect(classifyFileSize(Number.NaN)).toBe("tiny");
    expect(classifyFileSize(-5)).toBe("tiny");
  });
  it("has exactly five ordered classes", () => {
    expect(SIZE_CLASSES).toHaveLength(5);
    expect(SIZE_CLASSES.map((c) => c.key)).toEqual([
      "tiny",
      "small",
      "medium",
      "large",
      "xlarge",
    ]);
  });
});

describe("repo-size — summariseSize", () => {
  it("aggregates bytes and computes mean/median", () => {
    const entries: RepoSizeEntry[] = [
      { path: "a", size: 100 },
      { path: "b", size: 200 },
      { path: "c", size: 300 },
      { path: "d", size: 400 },
    ];
    const s = summariseSize(entries);
    expect(s.totalBytes).toBe(1000);
    expect(s.totalFiles).toBe(4);
    expect(s.countedFiles).toBe(4);
    expect(s.averageBytes).toBe(250);
    expect(s.medianBytes).toBe(250); // (200+300)/2
    expect(s.largestBytes).toBe(400);
    expect(s.smallestBytes).toBe(100);
  });
  it("median picks middle of odd-length series", () => {
    const s = summariseSize([
      { path: "a", size: 10 },
      { path: "b", size: 50 },
      { path: "c", size: 500 },
    ]);
    expect(s.medianBytes).toBe(50);
  });
  it("drops invalid entries but keeps totalFiles on raw count", () => {
    const s = summariseSize([
      { path: "a", size: 100 },
      // @ts-expect-error
      { path: 42, size: 100 },
      { path: "b", size: Number.NaN },
      { path: "c", size: -5 },
      { path: "d", size: 900 },
    ]);
    expect(s.totalFiles).toBe(5);
    expect(s.countedFiles).toBe(2);
    expect(s.totalBytes).toBe(1000);
  });
  it("handles empty input", () => {
    const s = summariseSize([]);
    expect(s.totalBytes).toBe(0);
    expect(s.totalFiles).toBe(0);
    expect(s.countedFiles).toBe(0);
    expect(s.averageBytes).toBe(0);
    expect(s.medianBytes).toBe(0);
    expect(s.largestBytes).toBe(0);
    expect(s.smallestBytes).toBe(0);
  });
});

describe("repo-size — bucketBySize", () => {
  it("distributes into five class buckets", () => {
    const entries: RepoSizeEntry[] = [
      { path: "a", size: 500 }, // tiny
      { path: "b", size: 10 * KB }, // small
      { path: "c", size: 500 * KB }, // medium
      { path: "d", size: 5 * MB }, // large
      { path: "e", size: 20 * MB }, // xlarge
      { path: "f", size: 5 * KB }, // small
    ];
    const b = bucketBySize(entries);
    const by = Object.fromEntries(b.map((x) => [x.key, x]));
    expect(by.tiny!.fileCount).toBe(1);
    expect(by.small!.fileCount).toBe(2);
    expect(by.medium!.fileCount).toBe(1);
    expect(by.large!.fileCount).toBe(1);
    expect(by.xlarge!.fileCount).toBe(1);
    expect(by.small!.bytes).toBe(10 * KB + 5 * KB);
  });
  it("returns all zero buckets for empty input", () => {
    const b = bucketBySize([]);
    expect(b).toHaveLength(5);
    expect(b.every((x) => x.fileCount === 0 && x.bytes === 0)).toBe(true);
  });
});

describe("repo-size — topLargestFiles", () => {
  const entries: RepoSizeEntry[] = [
    { path: "src/a.ts", size: 100 },
    { path: "src/b.ts", size: 500 },
    { path: "bundle.js", size: 10_000 },
    { path: "img.png", size: 2_000 },
    { path: "tiny.md", size: 10 },
  ];

  it("returns sorted-desc by size", () => {
    const out = topLargestFiles(entries);
    expect(out.map((f) => f.path)).toEqual([
      "bundle.js",
      "img.png",
      "src/b.ts",
      "src/a.ts",
      "tiny.md",
    ]);
  });

  it("respects limit", () => {
    const out = topLargestFiles(entries, { limit: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]!.path).toBe("bundle.js");
    expect(out[1]!.path).toBe("img.png");
  });

  it("applies minBytes floor", () => {
    const out = topLargestFiles(entries, { minBytes: 1_000 });
    expect(out.map((f) => f.path)).toEqual(["bundle.js", "img.png"]);
  });

  it("percentages sum to 100 across all returned files when limit is generous", () => {
    const out = topLargestFiles(entries, { limit: 99 });
    const sum = out.reduce((acc, f) => acc + f.percent, 0);
    expect(Math.round(sum)).toBe(100);
  });

  it("tie-breaks by path alphabetical", () => {
    const same: RepoSizeEntry[] = [
      { path: "zebra.bin", size: 100 },
      { path: "alpha.bin", size: 100 },
    ];
    const out = topLargestFiles(same);
    expect(out[0]!.path).toBe("alpha.bin");
    expect(out[1]!.path).toBe("zebra.bin");
  });

  it("populates topDir", () => {
    const out = topLargestFiles(entries);
    expect(out.find((f) => f.path === "src/b.ts")!.topDir).toBe("src");
    expect(out.find((f) => f.path === "bundle.js")!.topDir).toBe(".");
  });

  it("does not mutate the input array", () => {
    const copy = [...entries];
    topLargestFiles(entries);
    expect(entries).toEqual(copy);
  });

  it("returns [] for empty input", () => {
    expect(topLargestFiles([])).toEqual([]);
  });

  it("defaults limit to DEFAULT_TOP_N when missing or invalid", () => {
    const many: RepoSizeEntry[] = Array.from({ length: 100 }, (_, i) => ({
      path: `f${i}.bin`,
      size: i + 1,
    }));
    expect(topLargestFiles(many)).toHaveLength(DEFAULT_TOP_N);
    expect(topLargestFiles(many, { limit: 0 })).toHaveLength(DEFAULT_TOP_N);
    expect(topLargestFiles(many, { limit: -5 })).toHaveLength(DEFAULT_TOP_N);
  });
});

describe("repo-size — summariseByTopDir", () => {
  const entries: RepoSizeEntry[] = [
    { path: "src/a.ts", size: 100 },
    { path: "src/sub/b.ts", size: 400 },
    { path: "tests/t.ts", size: 50 },
    { path: "README.md", size: 10 },
    { path: "package.json", size: 40 },
  ];

  it("groups by first segment", () => {
    const out = summariseByTopDir(entries);
    const by = Object.fromEntries(out.map((d) => [d.name, d]));
    expect(by.src!.bytes).toBe(500);
    expect(by.src!.fileCount).toBe(2);
    expect(by.tests!.bytes).toBe(50);
    expect(by["."]!.bytes).toBe(50);
    expect(by["."]!.fileCount).toBe(2);
  });

  it("sorts by bytes desc", () => {
    const out = summariseByTopDir(entries);
    expect(out.map((d) => d.name)).toEqual(["src", "tests", "."]);
  });

  it("percentages sum to 100", () => {
    const out = summariseByTopDir(entries);
    const sum = out.reduce((acc, d) => acc + d.percent, 0);
    expect(Math.round(sum)).toBe(100);
  });

  it("root bucket sorts last on byte ties", () => {
    const tied: RepoSizeEntry[] = [
      { path: "src/a.ts", size: 100 },
      { path: "README.md", size: 100 },
    ];
    const out = summariseByTopDir(tied);
    expect(out.map((d) => d.name)).toEqual(["src", "."]);
  });

  it("empty input gives empty array", () => {
    expect(summariseByTopDir([])).toEqual([]);
  });
});

describe("repo-size — buildSizeReport", () => {
  const entries: RepoSizeEntry[] = [
    { path: "src/a.ts", size: 100 },
    { path: "src/big.bin", size: 5 * MB },
    { path: "docs/readme.md", size: 800 },
  ];

  it("assembles summary + buckets + directories + largest", () => {
    const r = buildSizeReport({ entries });
    expect(r.summary.countedFiles).toBe(3);
    expect(r.summary.totalBytes).toBe(100 + 5 * MB + 800);
    expect(r.buckets).toHaveLength(5);
    expect(r.directories.map((d) => d.name)).toEqual(["src", "docs"]);
    expect(r.largest[0]!.path).toBe("src/big.bin");
  });

  it("honours topN", () => {
    const r = buildSizeReport({ entries, topN: 1 });
    expect(r.largest).toHaveLength(1);
    expect(r.largest[0]!.path).toBe("src/big.bin");
  });

  it("honours minBytesForLargest", () => {
    const r = buildSizeReport({
      entries,
      minBytesForLargest: 1000,
    });
    expect(r.largest.map((f) => f.path)).toEqual(["src/big.bin"]);
  });
});

describe("repo-size — routes", () => {
  it("GET /:o/:r/insights/size returns 200 or 404 (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/insights/size");
    expect([200, 404]).toContain(res.status);
  });
  it("ignores bogus query params", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/insights/size?top=wow&min=nope"
    );
    expect([200, 404]).toContain(res.status);
  });
});

describe("repo-size — __internal parity", () => {
  it("re-exports every helper", () => {
    expect(__internal.SIZE_CLASSES).toBe(SIZE_CLASSES);
    expect(__internal.DEFAULT_TOP_N).toBe(DEFAULT_TOP_N);
    expect(__internal.topLevelDir).toBe(topLevelDir);
    expect(__internal.classifyFileSize).toBe(classifyFileSize);
    expect(__internal.summariseSize).toBe(summariseSize);
    expect(__internal.bucketBySize).toBe(bucketBySize);
    expect(__internal.topLargestFiles).toBe(topLargestFiles);
    expect(__internal.summariseByTopDir).toBe(summariseByTopDir);
    expect(__internal.buildSizeReport).toBe(buildSizeReport);
    expect(typeof __internal.median).toBe("function");
    expect(typeof __internal.validEntries).toBe("function");
  });
});

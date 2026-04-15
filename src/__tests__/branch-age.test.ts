/**
 * Block J27 — Branch staleness / age report. Pure rollup tests.
 */

import { describe, it, expect } from "bun:test";
import {
  DAY_MS,
  VALID_THRESHOLDS,
  VALID_SORTS,
  DEFAULT_THRESHOLD,
  DEFAULT_SORT,
  parseThreshold,
  parseSort,
  computeDaysOld,
  classifyBranchAge,
  computeBranchRow,
  bucketBranches,
  filterByThreshold,
  summariseBranches,
  sortBranchRows,
  buildBranchReport,
  categoryLabel,
  thresholdLabel,
  sortLabel,
  __internal,
  type BranchInputRow,
  type BranchReportRow,
} from "../lib/branch-age";

const NOW = new Date("2025-04-15T00:00:00Z").getTime();

function row(overrides: Partial<BranchReportRow> = {}): BranchReportRow {
  return {
    name: "feat/x",
    tipSha: "abc",
    tipDate: new Date(NOW - 10 * DAY_MS),
    tipAuthor: "alice",
    tipMessage: "msg",
    ahead: 0,
    behind: 0,
    isDefault: false,
    daysOld: 10,
    category: "fresh",
    merged: true,
    ...overrides,
  };
}

describe("branch-age — parseThreshold", () => {
  it("returns default for null/undefined/empty", () => {
    expect(parseThreshold(null)).toBe(DEFAULT_THRESHOLD);
    expect(parseThreshold(undefined)).toBe(DEFAULT_THRESHOLD);
    expect(parseThreshold("")).toBe(DEFAULT_THRESHOLD);
  });
  it("accepts the allow-listed values", () => {
    for (const v of VALID_THRESHOLDS) {
      expect(parseThreshold(String(v))).toBe(v);
    }
  });
  it("rejects non-listed numbers", () => {
    expect(parseThreshold("14")).toBe(DEFAULT_THRESHOLD);
    expect(parseThreshold("-5")).toBe(DEFAULT_THRESHOLD);
  });
  it("rejects garbage", () => {
    expect(parseThreshold("hello")).toBe(DEFAULT_THRESHOLD);
  });
});

describe("branch-age — parseSort", () => {
  it("returns default for unknown/bad input", () => {
    expect(parseSort(null)).toBe(DEFAULT_SORT);
    expect(parseSort("")).toBe(DEFAULT_SORT);
    expect(parseSort("weird")).toBe(DEFAULT_SORT);
    expect(parseSort(42)).toBe(DEFAULT_SORT);
  });
  it("accepts all VALID_SORTS", () => {
    for (const s of VALID_SORTS) {
      expect(parseSort(s)).toBe(s);
    }
  });
});

describe("branch-age — computeDaysOld", () => {
  it("null when missing/unparseable", () => {
    expect(computeDaysOld(null, NOW)).toBeNull();
    expect(computeDaysOld(undefined, NOW)).toBeNull();
    expect(computeDaysOld("not-a-date", NOW)).toBeNull();
    expect(computeDaysOld(new Date("invalid"), NOW)).toBeNull();
    expect(computeDaysOld(42 as unknown as Date, NOW)).toBeNull();
  });
  it("accepts Date and ISO string", () => {
    expect(computeDaysOld(new Date(NOW - 10 * DAY_MS), NOW)).toBe(10);
    expect(
      computeDaysOld(new Date(NOW - 10 * DAY_MS).toISOString(), NOW)
    ).toBe(10);
  });
  it("clamps future timestamps to 0", () => {
    expect(computeDaysOld(new Date(NOW + DAY_MS), NOW)).toBe(0);
  });
  it("uses floor for partial days", () => {
    expect(computeDaysOld(new Date(NOW - (10 * DAY_MS + 3600 * 1000)), NOW)).toBe(
      10
    );
  });
});

describe("branch-age — classifyBranchAge", () => {
  it("buckets correctly", () => {
    expect(classifyBranchAge(0)).toBe("fresh");
    expect(classifyBranchAge(29)).toBe("fresh");
    expect(classifyBranchAge(30)).toBe("aging");
    expect(classifyBranchAge(59)).toBe("aging");
    expect(classifyBranchAge(60)).toBe("stale");
    expect(classifyBranchAge(89)).toBe("stale");
    expect(classifyBranchAge(90)).toBe("abandoned");
    expect(classifyBranchAge(365)).toBe("abandoned");
  });
  it("null → abandoned", () => {
    expect(classifyBranchAge(null)).toBe("abandoned");
  });
});

describe("branch-age — computeBranchRow", () => {
  const input: BranchInputRow = {
    name: "feat/x",
    tipSha: "abc",
    tipDate: new Date(NOW - 45 * DAY_MS),
    tipAuthor: "alice",
    tipMessage: "hi",
    ahead: 3,
    behind: 1,
    isDefault: false,
  };

  it("populates daysOld + category + merged", () => {
    const r = computeBranchRow(input, NOW);
    expect(r.daysOld).toBe(45);
    expect(r.category).toBe("aging");
    expect(r.merged).toBe(false);
  });

  it("merged = true when ahead=0 and not default", () => {
    const r = computeBranchRow({ ...input, ahead: 0 }, NOW);
    expect(r.merged).toBe(true);
  });

  it("default branch is never flagged as merged", () => {
    const r = computeBranchRow({ ...input, ahead: 0, isDefault: true }, NOW);
    expect(r.merged).toBe(false);
  });

  it("coerces negative ahead/behind to 0", () => {
    const r = computeBranchRow({ ...input, ahead: -5, behind: -2 }, NOW);
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
  });

  it("null tipDate still yields a row with category=abandoned", () => {
    const r = computeBranchRow({ ...input, tipDate: null }, NOW);
    expect(r.daysOld).toBeNull();
    expect(r.category).toBe("abandoned");
  });
});

describe("branch-age — bucketBranches", () => {
  it("ignores default branch + distributes others", () => {
    const rows = [
      row({ name: "d", isDefault: true, category: "fresh" }),
      row({ name: "a", category: "fresh" }),
      row({ name: "b", category: "aging" }),
      row({ name: "c", category: "stale" }),
      row({ name: "e", category: "abandoned" }),
      row({ name: "f", category: "abandoned" }),
    ];
    const b = bucketBranches(rows);
    expect(b).toEqual({ fresh: 1, aging: 1, stale: 1, abandoned: 2 });
  });
  it("empty input → all zeros", () => {
    expect(bucketBranches([])).toEqual({
      fresh: 0,
      aging: 0,
      stale: 0,
      abandoned: 0,
    });
  });
});

describe("branch-age — filterByThreshold", () => {
  const rows = [
    row({ name: "main", isDefault: true, daysOld: 1 }),
    row({ name: "a", daysOld: 10 }),
    row({ name: "b", daysOld: 45 }),
    row({ name: "c", daysOld: 120 }),
    row({ name: "d", daysOld: null }),
  ];

  it("threshold 0 returns everything", () => {
    expect(filterByThreshold(rows, 0).map((r) => r.name)).toEqual([
      "main",
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("threshold 30 drops fresh + null + default", () => {
    expect(filterByThreshold(rows, 30).map((r) => r.name)).toEqual(["b", "c"]);
  });

  it("threshold 90 drops everything except ≥90", () => {
    expect(filterByThreshold(rows, 90).map((r) => r.name)).toEqual(["c"]);
  });
});

describe("branch-age — summariseBranches", () => {
  it("empty", () => {
    const s = summariseBranches([]);
    expect(s.total).toBe(0);
    expect(s.nonDefault).toBe(0);
    expect(s.merged).toBe(0);
    expect(s.unmerged).toBe(0);
    expect(s.oldestName).toBeNull();
    expect(s.oldestDaysOld).toBeNull();
    expect(s.averageAgeDays).toBeNull();
    expect(s.medianAgeDays).toBeNull();
  });

  it("excludes default from the aggregates", () => {
    const rows = [
      row({ name: "main", isDefault: true, daysOld: 500 }),
      row({ name: "a", daysOld: 10, merged: true, ahead: 0 }),
      row({ name: "b", daysOld: 20, merged: false, ahead: 2 }),
    ];
    const s = summariseBranches(rows);
    expect(s.total).toBe(3);
    expect(s.nonDefault).toBe(2);
    expect(s.merged).toBe(1);
    expect(s.unmerged).toBe(1);
    expect(s.oldestName).toBe("b");
    expect(s.oldestDaysOld).toBe(20);
    expect(s.averageAgeDays).toBe(15);
    expect(s.medianAgeDays).toBe(15);
  });

  it("counts rows without a tipDate separately", () => {
    const rows = [
      row({ name: "a", daysOld: null }),
      row({ name: "b", daysOld: 10 }),
    ];
    const s = summariseBranches(rows);
    expect(s.withoutTip).toBe(1);
    expect(s.oldestName).toBe("b");
    expect(s.oldestDaysOld).toBe(10);
  });
});

describe("branch-age — sortBranchRows", () => {
  const base: BranchReportRow[] = [
    row({ name: "feat/b", daysOld: 10, ahead: 1, behind: 0 }),
    row({ name: "feat/a", daysOld: 100, ahead: 5, behind: 3 }),
    row({ name: "feat/c", daysOld: null, ahead: 2, behind: 10 }),
  ];

  it("name sorts alphabetically", () => {
    expect(sortBranchRows(base, "name").map((r) => r.name)).toEqual([
      "feat/a",
      "feat/b",
      "feat/c",
    ]);
  });

  it("age-desc sinks null to the bottom", () => {
    expect(sortBranchRows(base, "age-desc").map((r) => r.name)).toEqual([
      "feat/a",
      "feat/b",
      "feat/c",
    ]);
  });

  it("age-asc sinks null to the bottom", () => {
    expect(sortBranchRows(base, "age-asc").map((r) => r.name)).toEqual([
      "feat/b",
      "feat/a",
      "feat/c",
    ]);
  });

  it("ahead-desc", () => {
    expect(sortBranchRows(base, "ahead-desc").map((r) => r.name)).toEqual([
      "feat/a",
      "feat/c",
      "feat/b",
    ]);
  });

  it("behind-desc", () => {
    expect(sortBranchRows(base, "behind-desc").map((r) => r.name)).toEqual([
      "feat/c",
      "feat/a",
      "feat/b",
    ]);
  });

  it("never mutates input", () => {
    const snap = base.map((r) => r.name).join(",");
    sortBranchRows(base, "name");
    sortBranchRows(base, "age-desc");
    expect(base.map((r) => r.name).join(",")).toBe(snap);
  });

  it("uses stable name tie-break", () => {
    const rows: BranchReportRow[] = [
      row({ name: "z", ahead: 5 }),
      row({ name: "a", ahead: 5 }),
    ];
    expect(sortBranchRows(rows, "ahead-desc").map((r) => r.name)).toEqual([
      "a",
      "z",
    ]);
  });
});

describe("branch-age — buildBranchReport", () => {
  const inputs: BranchInputRow[] = [
    {
      name: "main",
      tipSha: "1",
      tipDate: new Date(NOW - 1 * DAY_MS),
      tipAuthor: "alice",
      tipMessage: "latest",
      ahead: 0,
      behind: 0,
      isDefault: true,
    },
    {
      name: "feat/a",
      tipSha: "2",
      tipDate: new Date(NOW - 10 * DAY_MS),
      tipAuthor: "alice",
      tipMessage: "feat",
      ahead: 3,
      behind: 1,
      isDefault: false,
    },
    {
      name: "feat/b",
      tipSha: "3",
      tipDate: new Date(NOW - 120 * DAY_MS),
      tipAuthor: "bob",
      tipMessage: "old",
      ahead: 0,
      behind: 5,
      isDefault: false,
    },
    {
      name: "feat/c",
      tipSha: "4",
      tipDate: null,
      tipAuthor: null,
      tipMessage: null,
      ahead: 2,
      behind: 2,
      isDefault: false,
    },
  ];

  it("builds the one-shot report", () => {
    const r = buildBranchReport({
      branches: inputs,
      defaultBranch: "main",
      now: NOW,
    });
    expect(r.now).toBe(NOW);
    expect(r.threshold).toBe(DEFAULT_THRESHOLD);
    expect(r.sort).toBe(DEFAULT_SORT);
    expect(r.defaultBranch).toBe("main");
    expect(r.rows).toHaveLength(4);
    expect(r.buckets).toEqual({ fresh: 1, aging: 0, stale: 0, abandoned: 2 });
    expect(r.summary.nonDefault).toBe(3);
    expect(r.summary.merged).toBe(1); // feat/b (ahead=0)
    expect(r.summary.unmerged).toBe(2);
    expect(r.summary.oldestName).toBe("feat/b");
    expect(r.summary.oldestDaysOld).toBe(120);
  });

  it("applies threshold + sort", () => {
    const r = buildBranchReport({
      branches: inputs,
      defaultBranch: "main",
      now: NOW,
      threshold: 30,
      sort: "age-desc",
    });
    expect(r.filtered.map((row) => row.name)).toEqual(["feat/b"]);
  });

  it("threshold=0 keeps every sorted row", () => {
    const r = buildBranchReport({
      branches: inputs,
      defaultBranch: "main",
      now: NOW,
      threshold: 0,
      sort: "name",
    });
    expect(r.filtered.map((row) => row.name)).toEqual([
      "feat/a",
      "feat/b",
      "feat/c",
      "main",
    ]);
  });

  it("defaults `now` to Date.now when omitted", () => {
    const before = Date.now();
    const r = buildBranchReport({ branches: [], defaultBranch: null });
    const after = Date.now();
    expect(r.now).toBeGreaterThanOrEqual(before);
    expect(r.now).toBeLessThanOrEqual(after);
  });
});

describe("branch-age — labels", () => {
  it("categoryLabel covers all categories", () => {
    expect(categoryLabel("fresh")).toBe("Fresh");
    expect(categoryLabel("aging")).toBe("Aging");
    expect(categoryLabel("stale")).toBe("Stale");
    expect(categoryLabel("abandoned")).toBe("Abandoned");
  });
  it("thresholdLabel", () => {
    expect(thresholdLabel(0)).toBe("All branches");
    expect(thresholdLabel(30)).toBe("≥ 30 days old");
    expect(thresholdLabel(180)).toBe("≥ 180 days old");
  });
  it("sortLabel covers every sort", () => {
    expect(sortLabel("age-desc")).toBe("Oldest first");
    expect(sortLabel("age-asc")).toBe("Newest first");
    expect(sortLabel("name")).toBe("Name A–Z");
    expect(sortLabel("ahead-desc")).toBe("Most ahead");
    expect(sortLabel("behind-desc")).toBe("Most behind");
  });
});

describe("branch-age — routes", () => {
  it("GET /:o/:r/branches/age returns 2xx or 404 (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/branches/age");
    expect([200, 404]).toContain(res.status);
  });

  it("ignores bogus thresholds + sort keys", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/branches/age?threshold=xyz&sort=weird"
    );
    expect([200, 404]).toContain(res.status);
  });
});

describe("branch-age — __internal parity", () => {
  it("re-exports", () => {
    expect(__internal.DAY_MS).toBe(DAY_MS);
    expect(__internal.parseThreshold).toBe(parseThreshold);
    expect(__internal.parseSort).toBe(parseSort);
    expect(__internal.computeDaysOld).toBe(computeDaysOld);
    expect(__internal.classifyBranchAge).toBe(classifyBranchAge);
    expect(__internal.computeBranchRow).toBe(computeBranchRow);
    expect(__internal.bucketBranches).toBe(bucketBranches);
    expect(__internal.filterByThreshold).toBe(filterByThreshold);
    expect(__internal.summariseBranches).toBe(summariseBranches);
    expect(__internal.sortBranchRows).toBe(sortBranchRows);
    expect(__internal.buildBranchReport).toBe(buildBranchReport);
    expect(__internal.categoryLabel).toBe(categoryLabel);
    expect(__internal.thresholdLabel).toBe(thresholdLabel);
    expect(__internal.sortLabel).toBe(sortLabel);
  });
});

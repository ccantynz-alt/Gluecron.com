/**
 * Block J9 — Contribution heatmap tests. All pure; no DB.
 */

import { describe, it, expect } from "bun:test";
import {
  buildHeatmap,
  formatDateKey,
  levelFor,
  startOfUtcDay,
  daysBetween,
  __internal,
} from "../lib/contribution-heatmap";

describe("heatmap — levelFor", () => {
  it("0 count → level 0 regardless of max", () => {
    expect(levelFor(0, 0)).toBe(0);
    expect(levelFor(0, 10)).toBe(0);
  });

  it("max=0 keeps everything at 0", () => {
    expect(levelFor(5, 0)).toBe(0);
  });

  it("buckets by quartile of max", () => {
    expect(levelFor(1, 10)).toBe(1); // 10%
    expect(levelFor(3, 10)).toBe(2); // 30%
    expect(levelFor(6, 10)).toBe(3); // 60%
    expect(levelFor(9, 10)).toBe(4); // 90%
  });

  it("edge — exactly 25% → level 1", () => {
    expect(levelFor(25, 100)).toBe(1);
    expect(levelFor(26, 100)).toBe(2);
  });
});

describe("heatmap — formatDateKey + startOfUtcDay", () => {
  it("formats YYYY-MM-DD in UTC", () => {
    const d = new Date("2026-01-02T23:59:59Z");
    expect(formatDateKey(d)).toBe("2026-01-02");
  });

  it("strips time to 00:00:00 UTC", () => {
    const d = startOfUtcDay(new Date("2026-03-15T18:30:00Z"));
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(formatDateKey(d)).toBe("2026-03-15");
  });

  it("__internal re-exports match", () => {
    expect(__internal.formatDateKey).toBe(formatDateKey);
    expect(__internal.startOfUtcDay).toBe(startOfUtcDay);
  });
});

describe("heatmap — daysBetween", () => {
  it("returns 0 for same UTC day regardless of time", () => {
    const a = new Date("2026-01-02T00:00:00Z");
    const b = new Date("2026-01-02T23:59:59Z");
    expect(daysBetween(a, b)).toBe(0);
  });

  it("returns positive delta for later end", () => {
    expect(
      daysBetween(new Date("2026-01-01Z"), new Date("2026-01-05Z"))
    ).toBe(4);
  });
});

describe("heatmap — buildHeatmap", () => {
  const TODAY = new Date("2026-12-15T12:00:00Z"); // Tuesday

  it("empty activity → zero totals, no levels above 0", () => {
    const h = buildHeatmap([], 365, TODAY);
    expect(h.totalContributions).toBe(0);
    expect(h.maxDayCount).toBe(0);
    expect(h.longestStreak).toBe(0);
    expect(h.currentStreak).toBe(0);
    for (const w of h.weeks) {
      for (const d of w.days) {
        if (d) expect(d.level).toBe(0);
      }
    }
  });

  it("sums contributions on the same day", () => {
    const h = buildHeatmap(
      [
        { createdAt: "2026-12-10T10:00:00Z" },
        { createdAt: "2026-12-10T11:00:00Z" },
        { createdAt: "2026-12-10T23:59:59Z" },
      ],
      30,
      TODAY
    );
    expect(h.totalContributions).toBe(3);
    expect(h.maxDayCount).toBe(3);
  });

  it("drops activity outside the window", () => {
    const h = buildHeatmap(
      [
        { createdAt: "2025-01-01T00:00:00Z" }, // way outside
        { createdAt: "2026-12-14T00:00:00Z" }, // inside
      ],
      30,
      TODAY
    );
    expect(h.totalContributions).toBe(1);
  });

  it("computes longest + current streaks", () => {
    // 3-day streak ending on 2026-12-15 (today)
    const h = buildHeatmap(
      [
        { createdAt: "2026-12-13T00:00:00Z" },
        { createdAt: "2026-12-14T00:00:00Z" },
        { createdAt: "2026-12-15T00:00:00Z" },
      ],
      30,
      TODAY
    );
    expect(h.longestStreak).toBe(3);
    expect(h.currentStreak).toBe(3);
  });

  it("currentStreak is 0 when today has no activity", () => {
    const h = buildHeatmap(
      [
        { createdAt: "2026-12-13T00:00:00Z" },
        { createdAt: "2026-12-14T00:00:00Z" },
      ],
      30,
      TODAY
    );
    expect(h.longestStreak).toBe(2);
    expect(h.currentStreak).toBe(0);
  });

  it("weeks are Sunday-aligned with 7 entries each", () => {
    const h = buildHeatmap([], 30, TODAY);
    for (const w of h.weeks) {
      expect(w.days.length).toBe(7);
    }
    // Every non-null day's dow matches its index in the week array.
    for (const w of h.weeks) {
      w.days.forEach((d, idx) => {
        if (d) expect(d.dow).toBe(idx);
      });
    }
  });

  it("start/end dates reflect the window", () => {
    const h = buildHeatmap([], 10, TODAY);
    expect(h.endDate).toBe("2026-12-15");
    expect(h.startDate).toBe("2026-12-06");
  });

  it("tolerates invalid createdAt entries", () => {
    const h = buildHeatmap(
      [
        { createdAt: "not a date" },
        { createdAt: "2026-12-14T00:00:00Z" },
      ],
      30,
      TODAY
    );
    expect(h.totalContributions).toBe(1);
  });

  it("grid covers entire window continuously", () => {
    const h = buildHeatmap([], 14, TODAY);
    const nonNull: string[] = [];
    for (const w of h.weeks) {
      for (const d of w.days) {
        if (d) nonNull.push(d.date);
      }
    }
    // 14-day window → 14 non-null cells.
    expect(nonNull.length).toBe(14);
    // Dates are strictly increasing.
    for (let i = 1; i < nonNull.length; i++) {
      expect(nonNull[i] > nonNull[i - 1]).toBe(true);
    }
  });
});

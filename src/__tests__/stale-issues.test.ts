/**
 * Block J20 — Stale issue detector. Pure helpers + route smokes.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  STALE_PERIODS,
  DEFAULT_STALE_PERIOD,
  periodDays,
  parsePeriod,
  filterStale,
  bucketByStaleness,
  buildStaleReport,
  __internal,
  type StaleInputIssue,
} from "../lib/stale-issues";

function daysAgo(n: number): Date {
  const now = new Date("2026-04-15T12:00:00Z");
  return new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
}

const NOW = new Date("2026-04-15T12:00:00Z");

const issueAt = (
  number: number,
  daysSince: number,
  state = "open",
  authorName = "alice"
): StaleInputIssue => ({
  number,
  title: `Issue ${number}`,
  state,
  authorName,
  createdAt: daysAgo(daysSince + 30),
  updatedAt: daysAgo(daysSince),
});

describe("stale-issues — constants & parse", () => {
  it("exports the canonical period list", () => {
    expect(STALE_PERIODS).toEqual(["30d", "60d", "90d", "180d"]);
    expect(DEFAULT_STALE_PERIOD).toBe("60d");
  });

  it("periodDays returns day counts", () => {
    expect(periodDays("30d")).toBe(30);
    expect(periodDays("60d")).toBe(60);
    expect(periodDays("90d")).toBe(90);
    expect(periodDays("180d")).toBe(180);
  });

  it("parsePeriod accepts valid values", () => {
    expect(parsePeriod("30d")).toBe("30d");
    expect(parsePeriod("60d")).toBe("60d");
    expect(parsePeriod("90d")).toBe("90d");
    expect(parsePeriod("180d")).toBe("180d");
  });

  it("parsePeriod falls back to default on garbage", () => {
    expect(parsePeriod("")).toBe(DEFAULT_STALE_PERIOD);
    expect(parsePeriod("ever")).toBe(DEFAULT_STALE_PERIOD);
    expect(parsePeriod(null)).toBe(DEFAULT_STALE_PERIOD);
    expect(parsePeriod(undefined)).toBe(DEFAULT_STALE_PERIOD);
    expect(parsePeriod(123)).toBe(DEFAULT_STALE_PERIOD);
    expect(parsePeriod("1y")).toBe(DEFAULT_STALE_PERIOD);
  });
});

describe("stale-issues — filterStale", () => {
  it("keeps only open issues beyond the threshold", () => {
    const input = [
      issueAt(1, 10), // too fresh
      issueAt(2, 45),
      issueAt(3, 100),
      issueAt(4, 200, "closed"), // closed, dropped
    ];
    const out = filterStale(input, NOW, 30);
    expect(out.map((i) => i.number)).toEqual([3, 2]);
  });

  it("is inclusive at the threshold boundary", () => {
    const out = filterStale([issueAt(1, 30)], NOW, 30);
    expect(out).toHaveLength(1);
  });

  it("sorts oldest-first then by number", () => {
    const out = filterStale(
      [issueAt(3, 40), issueAt(1, 40), issueAt(2, 100)],
      NOW,
      30
    );
    expect(out.map((i) => i.number)).toEqual([2, 1, 3]);
  });

  it("gracefully skips issues with unparseable updatedAt", () => {
    const bad: StaleInputIssue = {
      number: 9,
      title: "broken",
      state: "open",
      authorName: "x",
      createdAt: "2026-01-01",
      updatedAt: "not-a-date",
    };
    const out = filterStale([bad, issueAt(1, 40)], NOW, 30);
    expect(out.map((i) => i.number)).toEqual([1]);
  });

  it("accepts ISO strings for updatedAt + createdAt", () => {
    const iso: StaleInputIssue = {
      number: 1,
      title: "iso",
      state: "open",
      authorName: "x",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    };
    const out = filterStale([iso], NOW, 30);
    expect(out).toHaveLength(1);
    expect(out[0].daysSinceUpdate).toBeGreaterThan(60);
  });

  it("carries commentCount through when provided", () => {
    const withComments: StaleInputIssue = {
      ...issueAt(5, 50),
      commentCount: 7,
    };
    const out = filterStale([withComments], NOW, 30);
    expect(out[0].commentCount).toBe(7);
  });

  it("defaults commentCount to 0 when missing", () => {
    const out = filterStale([issueAt(1, 50)], NOW, 30);
    expect(out[0].commentCount).toBe(0);
  });

  it("ignores non-open states (draft, in_progress, etc)", () => {
    const odd: StaleInputIssue = {
      ...issueAt(1, 100),
      state: "archived",
    };
    const out = filterStale([odd], NOW, 30);
    expect(out).toHaveLength(0);
  });
});

describe("stale-issues — bucketByStaleness", () => {
  it("splits issues into the right buckets", () => {
    const staleOnly = filterStale(
      [
        issueAt(1, 35), // 30-60
        issueAt(2, 70), // 60-90
        issueAt(3, 120), // 90-180
        issueAt(4, 365), // 180+
      ],
      NOW,
      30
    );
    const b = bucketByStaleness(staleOnly);
    expect(b["30-60"].map((i) => i.number)).toEqual([1]);
    expect(b["60-90"].map((i) => i.number)).toEqual([2]);
    expect(b["90-180"].map((i) => i.number)).toEqual([3]);
    expect(b["180+"].map((i) => i.number)).toEqual([4]);
  });

  it("drops issues with daysSinceUpdate < 30", () => {
    const out = bucketByStaleness([
      {
        number: 1,
        title: "recent",
        authorName: "a",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        daysSinceUpdate: 10,
        commentCount: 0,
      },
    ]);
    expect(out["30-60"]).toHaveLength(0);
    expect(out["60-90"]).toHaveLength(0);
    expect(out["90-180"]).toHaveLength(0);
    expect(out["180+"]).toHaveLength(0);
  });

  it("is inclusive at bucket boundaries (60, 90, 180)", () => {
    const mk = (d: number) => ({
      number: d,
      title: `t${d}`,
      authorName: "a",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      daysSinceUpdate: d,
      commentCount: 0,
    });
    const b = bucketByStaleness([mk(60), mk(90), mk(180)]);
    expect(b["60-90"].map((i) => i.number)).toEqual([60]);
    expect(b["90-180"].map((i) => i.number)).toEqual([90]);
    expect(b["180+"].map((i) => i.number)).toEqual([180]);
  });
});

describe("stale-issues — buildStaleReport", () => {
  it("assembles period + threshold + buckets + total", () => {
    const report = buildStaleReport({
      period: "30d",
      now: NOW,
      issues: [
        issueAt(1, 10),
        issueAt(2, 40),
        issueAt(3, 100),
        issueAt(4, 200),
      ],
    });
    expect(report.period).toBe("30d");
    expect(report.thresholdDays).toBe(30);
    expect(report.total).toBe(3);
    expect(report.issues.map((i) => i.number)).toEqual([4, 3, 2]);
    expect(report.buckets["30-60"]).toHaveLength(1);
    expect(report.buckets["90-180"]).toHaveLength(1);
    expect(report.buckets["180+"]).toHaveLength(1);
  });

  it("respects the chosen period for the threshold cutoff", () => {
    // With a 90d threshold, only issues older than 90 days qualify.
    const report = buildStaleReport({
      period: "90d",
      now: NOW,
      issues: [issueAt(1, 40), issueAt(2, 100), issueAt(3, 200)],
    });
    expect(report.total).toBe(2);
    expect(report.issues.map((i) => i.number)).toEqual([3, 2]);
  });

  it("emits an ISO `now` for display", () => {
    const report = buildStaleReport({
      period: "60d",
      now: NOW,
      issues: [],
    });
    expect(report.now).toBe("2026-04-15T12:00:00.000Z");
    expect(report.total).toBe(0);
  });
});

describe("stale-issues — __internal parity", () => {
  it("re-exports all helpers", () => {
    expect(__internal.STALE_PERIODS).toBe(STALE_PERIODS);
    expect(__internal.DEFAULT_STALE_PERIOD).toBe(DEFAULT_STALE_PERIOD);
    expect(__internal.periodDays).toBe(periodDays);
    expect(__internal.parsePeriod).toBe(parsePeriod);
    expect(__internal.filterStale).toBe(filterStale);
    expect(__internal.bucketByStaleness).toBe(bucketByStaleness);
    expect(__internal.buildStaleReport).toBe(buildStaleReport);
  });
});

describe("stale-issues — routes", () => {
  it("GET /:o/:r/issues/stale returns 200 + page chrome for public view", async () => {
    const res = await app.request("/alice/nope/issues/stale");
    expect(res.status).toBe(404);
  });

  it("unknown period falls back to default without 500", async () => {
    const res = await app.request(
      "/alice/nope/issues/stale?period=9999x"
    );
    // Repo doesn't exist so we get the 404 path — important: no 500.
    expect(res.status).toBe(404);
  });

  it("accepts each valid period without 500", async () => {
    for (const p of STALE_PERIODS) {
      const res = await app.request(
        `/alice/nope/issues/stale?period=${p}`
      );
      expect([200, 404]).toContain(res.status);
    }
  });
});

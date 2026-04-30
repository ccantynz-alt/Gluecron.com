/**
 * Tests for src/lib/cron.ts.
 *
 * Pure module — no DB, no clock side effects. We exhaustively cover:
 *   - Field parser edge cases (literals, ranges, steps, lists, wildcards)
 *   - Whole-expression parser (5-field shape, errors)
 *   - cronMatches per-minute logic
 *   - cronFiredBetween interval semantics
 *   - POSIX OR semantics for dom & dow
 */

import { describe, it, expect } from "bun:test";
import {
  parseCron,
  cronMatches,
  cronFiredBetween,
  __test,
} from "../lib/cron";

const at = (iso: string) => new Date(iso);

describe("parseField", () => {
  const f = __test.parseField;

  it("expands * to the full range", () => {
    expect(f("*", 0, 4)).toEqual([0, 1, 2, 3, 4]);
  });

  it("parses literals", () => {
    expect(f("3", 0, 59)).toEqual([3]);
  });

  it("parses ranges", () => {
    expect(f("2-5", 0, 23)).toEqual([2, 3, 4, 5]);
  });

  it("parses steps with wildcard base", () => {
    expect(f("*/15", 0, 59)).toEqual([0, 15, 30, 45]);
  });

  it("parses steps with range base", () => {
    expect(f("0-10/2", 0, 59)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("parses comma-separated lists with mixed forms", () => {
    expect(f("0,15,30-32,*/30", 0, 59)).toEqual([0, 15, 30, 31, 32]);
  });

  it("rejects out-of-range values", () => {
    expect(f("60", 0, 59)).toBeNull();
    expect(f("-1", 0, 59)).toBeNull();
  });

  it("rejects bogus syntax", () => {
    expect(f("a", 0, 59)).toBeNull();
    expect(f("1-", 0, 59)).toBeNull();
    expect(f("/5", 0, 59)).toBeNull();
    expect(f("1/0", 0, 59)).toBeNull();
  });

  it("rejects literal+step combinations (1/5 makes no sense)", () => {
    expect(f("5/2", 0, 59)).toBeNull();
  });

  it("rejects descending ranges", () => {
    expect(f("5-3", 0, 59)).toBeNull();
  });
});

describe("parseCron — error paths", () => {
  it("rejects empty input", () => {
    expect(parseCron("")).toEqual({ ok: false, error: "empty cron expression" });
  });

  it("rejects @-aliases", () => {
    const r = parseCron("@hourly");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not supported");
  });

  it("rejects unsupported chars (L W # ?)", () => {
    const r = parseCron("0 0 L * *");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsupported characters");
  });

  it("rejects wrong number of fields", () => {
    expect(parseCron("0 0 *").ok).toBe(false);
    expect(parseCron("0 0 * * * *").ok).toBe(false);
  });

  it("collapses whitespace before counting fields", () => {
    expect(parseCron("0   *   *   *   *").ok).toBe(true);
  });
});

describe("parseCron — happy path", () => {
  it("every minute → all minutes/hours/dows/etc full", () => {
    const r = parseCron("* * * * *");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron.minute.length).toBe(60);
    expect(r.cron.hour.length).toBe(24);
    expect(r.cron.dom.length).toBe(31);
    expect(r.cron.month.length).toBe(12);
    expect(r.cron.dow.length).toBe(7);
  });

  it("normalises dow=7 to dow=0", () => {
    const r = parseCron("0 0 * * 7");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron.dow).toEqual([0]);
  });

  it("dedupes (e.g. 0,0,0)", () => {
    const r = parseCron("0,0,0 * * * *");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron.minute).toEqual([0]);
  });
});

describe("cronMatches", () => {
  it("matches every-minute cron at any timestamp", () => {
    const r = parseCron("* * * * *");
    if (!r.ok) throw new Error("setup");
    expect(cronMatches(r.cron, at("2026-04-30T12:34:56Z"))).toBe(true);
  });

  it("matches a specific minute only at that minute", () => {
    const r = parseCron("0 * * * *");
    if (!r.ok) throw new Error("setup");
    expect(cronMatches(r.cron, at("2026-04-30T12:00:00Z"))).toBe(true);
    expect(cronMatches(r.cron, at("2026-04-30T12:01:00Z"))).toBe(false);
  });

  it("matches a specific hour:minute (daily)", () => {
    const r = parseCron("30 9 * * *");
    if (!r.ok) throw new Error("setup");
    expect(cronMatches(r.cron, at("2026-04-30T09:30:00Z"))).toBe(true);
    expect(cronMatches(r.cron, at("2026-04-30T09:00:00Z"))).toBe(false);
    expect(cronMatches(r.cron, at("2026-04-30T10:30:00Z"))).toBe(false);
  });

  it("matches by day-of-week (Mondays at 09:00)", () => {
    const r = parseCron("0 9 * * 1");
    if (!r.ok) throw new Error("setup");
    // 2026-04-27 was a Monday. (Verified via UTC.)
    expect(cronMatches(r.cron, at("2026-04-27T09:00:00Z"))).toBe(true);
    // 2026-04-28 Tuesday
    expect(cronMatches(r.cron, at("2026-04-28T09:00:00Z"))).toBe(false);
  });

  it("uses POSIX OR for dom + dow when both are restricted", () => {
    // "Run on the 1st of the month OR every Friday at 12:00"
    const r = parseCron("0 12 1 * 5");
    if (!r.ok) throw new Error("setup");
    // 2026-04-01 was a Wednesday (1st of April) → dom matches → fire.
    expect(cronMatches(r.cron, at("2026-04-01T12:00:00Z"))).toBe(true);
    // 2026-04-03 was a Friday → dow matches → fire.
    expect(cronMatches(r.cron, at("2026-04-03T12:00:00Z"))).toBe(true);
    // 2026-04-04 Saturday, not 1st → no fire.
    expect(cronMatches(r.cron, at("2026-04-04T12:00:00Z"))).toBe(false);
  });

  it("matches every 15 minutes (*/15)", () => {
    const r = parseCron("*/15 * * * *");
    if (!r.ok) throw new Error("setup");
    for (const min of [0, 15, 30, 45]) {
      expect(
        cronMatches(r.cron, at(`2026-04-30T08:${String(min).padStart(2, "0")}:00Z`))
      ).toBe(true);
    }
    for (const min of [1, 16, 31, 46]) {
      expect(
        cronMatches(r.cron, at(`2026-04-30T08:${String(min).padStart(2, "0")}:00Z`))
      ).toBe(false);
    }
  });
});

describe("cronFiredBetween", () => {
  it("returns true when at least one minute in (since, until] matches", () => {
    const r = parseCron("0 * * * *");
    if (!r.ok) throw new Error("setup");
    // since 12:30, until 13:05 — 13:00 lies in (since, until], should fire.
    const fired = cronFiredBetween(
      r.cron,
      at("2026-04-30T12:30:00Z"),
      at("2026-04-30T13:05:00Z")
    );
    expect(fired).toBe(true);
  });

  it("returns false when no matching minute in the interval", () => {
    const r = parseCron("0 * * * *");
    if (!r.ok) throw new Error("setup");
    const fired = cronFiredBetween(
      r.cron,
      at("2026-04-30T12:01:00Z"),
      at("2026-04-30T12:30:00Z")
    );
    expect(fired).toBe(false);
  });

  it("excludes the `since` boundary (half-open)", () => {
    const r = parseCron("0 * * * *");
    if (!r.ok) throw new Error("setup");
    // since exactly at 12:00 — must not fire that same minute, only the
    // next 12:00 would (which is an hour later). Until = 12:30 → false.
    expect(
      cronFiredBetween(r.cron, at("2026-04-30T12:00:00Z"), at("2026-04-30T12:30:00Z"))
    ).toBe(false);
  });

  it("includes the `until` boundary (half-open at the right)", () => {
    const r = parseCron("30 * * * *");
    if (!r.ok) throw new Error("setup");
    expect(
      cronFiredBetween(r.cron, at("2026-04-30T12:00:00Z"), at("2026-04-30T12:30:00Z"))
    ).toBe(true);
  });

  it("returns false on a zero/negative interval", () => {
    const r = parseCron("* * * * *");
    if (!r.ok) throw new Error("setup");
    expect(
      cronFiredBetween(r.cron, at("2026-04-30T12:00:00Z"), at("2026-04-30T11:00:00Z"))
    ).toBe(false);
  });

  it("caps the lookback at 1 day so a misconfigured `since` cannot blow up", () => {
    const r = parseCron("* * * * *");
    if (!r.ok) throw new Error("setup");
    // since in 2020, until now — should still return true (every-minute
    // cron always fires) without iterating millions of minutes.
    const start = Date.now();
    expect(
      cronFiredBetween(r.cron, at("2020-01-01T00:00:00Z"), new Date())
    ).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

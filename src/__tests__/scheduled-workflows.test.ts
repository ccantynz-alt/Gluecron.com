/**
 * Tests for src/lib/scheduled-workflows.ts (pure helpers + the
 * parser-side schedule extractor in workflow-parser.ts).
 *
 * The DB-touching pipeline (runScheduledWorkflowsTick) is exercised
 * indirectly by the autopilot smoke test — here we focus on the
 * pure decisions that drive it.
 */

import { describe, it, expect } from "bun:test";
import {
  schedulesFromParsedJson,
  firstCronToFire,
  runScheduledWorkflowsTick,
  MAX_RUNS_PER_TICK,
} from "../lib/scheduled-workflows";
import { __test as parserTest } from "../lib/workflow-parser";

describe("schedulesFromParsedJson", () => {
  it("returns [] for empty / malformed input", () => {
    expect(schedulesFromParsedJson("")).toEqual([]);
    expect(schedulesFromParsedJson("{}")).toEqual([]);
    expect(schedulesFromParsedJson("not json")).toEqual([]);
  });

  it("returns [] when schedules is missing or wrong type", () => {
    expect(schedulesFromParsedJson('{"on":["push"]}')).toEqual([]);
    expect(schedulesFromParsedJson('{"schedules":"0 * * * *"}')).toEqual([]);
    expect(schedulesFromParsedJson('{"schedules":42}')).toEqual([]);
  });

  it("extracts a non-empty schedules array", () => {
    const json = '{"schedules":["0 * * * *","30 9 * * 1"]}';
    expect(schedulesFromParsedJson(json)).toEqual(["0 * * * *", "30 9 * * 1"]);
  });

  it("filters out non-string and empty entries", () => {
    const json = '{"schedules":["0 * * * *","",42,null,"15 14 * * *"]}';
    expect(schedulesFromParsedJson(json)).toEqual(["0 * * * *", "15 14 * * *"]);
  });
});

describe("workflow-parser extractSchedules", () => {
  const ex = parserTest.extractSchedules;

  it("returns [] for non-mapping triggers", () => {
    expect(ex("push")).toEqual([]);
    expect(ex(["push"])).toEqual([]);
    expect(ex(null)).toEqual([]);
    expect(ex(undefined)).toEqual([]);
  });

  it("returns [] when the mapping has no schedule key", () => {
    expect(ex({ push: { branches: ["main"] } })).toEqual([]);
  });

  it("extracts a single schedule entry (object form)", () => {
    expect(ex({ schedule: { cron: "0 * * * *" } })).toEqual(["0 * * * *"]);
  });

  it("extracts an array of schedule entries", () => {
    expect(
      ex({ schedule: [{ cron: "0 * * * *" }, { cron: "30 12 * * 5" }] })
    ).toEqual(["0 * * * *", "30 12 * * 5"]);
  });

  it("tolerates a bare string in schedule", () => {
    expect(ex({ schedule: "0 * * * *" })).toEqual(["0 * * * *"]);
    expect(ex({ schedule: ["0 * * * *", "30 9 * * 1"] })).toEqual([
      "0 * * * *",
      "30 9 * * 1",
    ]);
  });

  it("ignores entries that are missing or non-string cron", () => {
    expect(ex({ schedule: [{ cron: "" }, { cron: 42 }, {}] })).toEqual([]);
  });
});

describe("firstCronToFire", () => {
  const since = new Date("2026-04-30T12:00:00Z");
  const until = new Date("2026-04-30T13:05:00Z");

  it("returns null when schedules is empty", () => {
    expect(firstCronToFire([], since, until)).toBeNull();
  });

  it("returns the first cron that fires in the window", () => {
    // 0 13 * * *  fires at 13:00 — in (12:00, 13:05]
    expect(firstCronToFire(["0 13 * * *"], since, until)).toBe("0 13 * * *");
  });

  it("returns null when no cron in the list fires", () => {
    // 0 23 fires at 23:00; not in our 12:00–13:05 window
    expect(firstCronToFire(["0 23 * * *"], since, until)).toBeNull();
  });

  it("skips invalid cron strings without crashing", () => {
    expect(
      firstCronToFire(["@hourly", "0 13 * * *"], since, until)
    ).toBe("0 13 * * *");
  });

  it("returns the first matching cron, not all of them", () => {
    expect(
      firstCronToFire(["0 13 * * *", "30 13 * * *"], since, until)
    ).toBe("0 13 * * *");
  });
});

describe("runScheduledWorkflowsTick — fail-open", () => {
  it("returns a result object with the expected keys, never throws", async () => {
    const r = await runScheduledWorkflowsTick(new Date("2026-04-30T13:00:00Z"));
    expect(typeof r.considered).toBe("number");
    expect(typeof r.fired).toBe("number");
    expect(typeof r.errors).toBe("number");
    expect(r.considered).toBeGreaterThanOrEqual(0);
    expect(r.fired).toBeGreaterThanOrEqual(0);
    expect(r.errors).toBeGreaterThanOrEqual(0);
  });

  it("MAX_RUNS_PER_TICK is a safe positive integer", () => {
    expect(MAX_RUNS_PER_TICK).toBeGreaterThan(0);
    expect(MAX_RUNS_PER_TICK).toBeLessThanOrEqual(1000);
  });
});

/**
 * Autopilot — unit tests.
 *
 * Uses the injected-tasks shape so the tick never touches the DB. Real
 * helpers (syncAllDue, sendDigestsToAll, scanRepositoryForAlerts, peekHead)
 * are covered by their own suites — here we only test the loop itself.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startAutopilot,
  runAutopilotTick,
  __test,
  type AutopilotTask,
} from "../lib/autopilot";

describe("autopilot — startAutopilot", () => {
  const originalDisabled = process.env.AUTOPILOT_DISABLED;
  const originalInterval = process.env.AUTOPILOT_INTERVAL_MS;

  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.AUTOPILOT_DISABLED;
    else process.env.AUTOPILOT_DISABLED = originalDisabled;
    if (originalInterval === undefined) delete process.env.AUTOPILOT_INTERVAL_MS;
    else process.env.AUTOPILOT_INTERVAL_MS = originalInterval;
  });

  it("is a no-op when AUTOPILOT_DISABLED=1 and does not schedule a tick", async () => {
    process.env.AUTOPILOT_DISABLED = "1";
    let ran = 0;
    const tasks: AutopilotTask[] = [
      { name: "probe", run: async () => { ran++; } },
    ];
    const { stop } = startAutopilot({ intervalMs: 5, tasks });
    // Wait long enough that any scheduled tick would have fired.
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(ran).toBe(0);
  });

  it("does not run the first tick synchronously (boot stays fast)", () => {
    delete process.env.AUTOPILOT_DISABLED;
    let ran = 0;
    const tasks: AutopilotTask[] = [
      { name: "probe", run: async () => { ran++; } },
    ];
    const { stop } = startAutopilot({ intervalMs: 60_000, tasks });
    // Synchronously — the interval has not elapsed.
    expect(ran).toBe(0);
    stop();
  });

  it("stop() clears the interval so no further ticks run", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    let ran = 0;
    const tasks: AutopilotTask[] = [
      { name: "probe", run: async () => { ran++; } },
    ];
    const { stop } = startAutopilot({ intervalMs: 10, tasks });
    await new Promise((r) => setTimeout(r, 45));
    stop();
    const snapshot = ran;
    await new Promise((r) => setTimeout(r, 40));
    // Allow for one tick that was already in flight at stop(), but not more.
    expect(ran - snapshot).toBeLessThanOrEqual(1);
    expect(snapshot).toBeGreaterThan(0);
  });
});

describe("autopilot — runAutopilotTick", () => {
  it("returns the expected shape with startedAt/finishedAt/tasks", async () => {
    const tasks: AutopilotTask[] = [
      { name: "a", run: async () => {} },
      { name: "b", run: async () => {} },
    ];
    const result = await runAutopilotTick({ tasks });
    expect(typeof result.startedAt).toBe("string");
    expect(typeof result.finishedAt).toBe("string");
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks.length).toBe(2);
    expect(result.tasks[0]).toMatchObject({ name: "a", ok: true });
    expect(result.tasks[1]).toMatchObject({ name: "b", ok: true });
    expect(typeof result.tasks[0].durationMs).toBe("number");
  });

  it("catches a throwing task and reports { ok:false, error } without crashing the tick", async () => {
    let secondRan = false;
    const tasks: AutopilotTask[] = [
      {
        name: "boom",
        run: async () => {
          throw new Error("kaboom");
        },
      },
      {
        name: "after",
        run: async () => {
          secondRan = true;
        },
      },
    ];
    const result = await runAutopilotTick({ tasks });
    expect(result.tasks.length).toBe(2);
    expect(result.tasks[0].ok).toBe(false);
    expect(result.tasks[0].error).toBe("kaboom");
    expect(result.tasks[1].ok).toBe(true);
    expect(secondRan).toBe(true);
  });

  it("handles non-Error throws gracefully", async () => {
    const tasks: AutopilotTask[] = [
      {
        name: "string-throw",
        run: async () => {
          throw "bad-thing" as unknown as Error;
        },
      },
    ];
    const result = await runAutopilotTick({ tasks });
    expect(result.tasks[0].ok).toBe(false);
    expect(result.tasks[0].error).toBe("bad-thing");
  });
});

describe("autopilot — resolveIntervalMs", () => {
  const originalInterval = process.env.AUTOPILOT_INTERVAL_MS;

  afterEach(() => {
    if (originalInterval === undefined) delete process.env.AUTOPILOT_INTERVAL_MS;
    else process.env.AUTOPILOT_INTERVAL_MS = originalInterval;
  });

  it("prefers explicit opts over env", () => {
    process.env.AUTOPILOT_INTERVAL_MS = "1234";
    expect(__test.resolveIntervalMs(42)).toBe(42);
  });

  it("falls back to env when opts is missing", () => {
    process.env.AUTOPILOT_INTERVAL_MS = "9999";
    expect(__test.resolveIntervalMs()).toBe(9999);
  });

  it("falls back to the default when neither is set", () => {
    delete process.env.AUTOPILOT_INTERVAL_MS;
    expect(__test.resolveIntervalMs()).toBe(__test.DEFAULT_INTERVAL_MS);
  });

  it("ignores non-positive env values", () => {
    process.env.AUTOPILOT_INTERVAL_MS = "-1";
    expect(__test.resolveIntervalMs()).toBe(__test.DEFAULT_INTERVAL_MS);
  });
});

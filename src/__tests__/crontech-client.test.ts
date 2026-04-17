/**
 * Block K — Crontech client tests.
 *
 * Exercises config toggle, auth headers, and offline short-circuits. When a
 * key is present, we mock globalThis.fetch to confirm graceful degradation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildAuthHeaders,
  getDeploymentForCommit,
  isConfigured,
  rollbackDeployment,
  triggerRedeploy,
  watchDeployment,
} from "../lib/crontech-client";

const ENV_KEYS = ["CRONTECH_API_KEY", "CRONTECH_BASE_URL"] as const;

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = savedFetch;
});

// ---------------------------------------------------------------------------
// isConfigured + buildAuthHeaders
// ---------------------------------------------------------------------------

describe("crontech-client — config", () => {
  it("isConfigured is false when no API key is set", () => {
    expect(isConfigured()).toBe(false);
  });

  it("isConfigured flips true once CRONTECH_API_KEY is set", () => {
    process.env.CRONTECH_API_KEY = "ct-test";
    expect(isConfigured()).toBe(true);
  });

  it("buildAuthHeaders omits Authorization when no key is present", () => {
    const h = buildAuthHeaders();
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBeUndefined();
  });

  it("buildAuthHeaders includes a Bearer token when the key is present", () => {
    process.env.CRONTECH_API_KEY = "ct-live";
    const h = buildAuthHeaders();
    expect(h["Authorization"]).toBe("Bearer ct-live");
  });
});

// ---------------------------------------------------------------------------
// getDeploymentForCommit
// ---------------------------------------------------------------------------

describe("crontech-client — getDeploymentForCommit", () => {
  it("returns null in offline mode (no key)", async () => {
    globalThis.fetch = (() => {
      throw new Error("fetch must not run offline");
    }) as unknown as typeof fetch;
    const result = await getDeploymentForCommit({
      repo: "o/r",
      commitSha: "deadbeef",
    });
    expect(result).toBeNull();
  });

  it("returns null on a 500 response", async () => {
    process.env.CRONTECH_API_KEY = "ct";
    globalThis.fetch = (async () =>
      new Response("", { status: 500 })) as unknown as typeof fetch;
    const result = await getDeploymentForCommit({
      repo: "o/r",
      commitSha: "deadbeef",
    });
    expect(result).toBeNull();
  });

  it("parses a valid deployment body on 200", async () => {
    process.env.CRONTECH_API_KEY = "ct";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          deployId: "dep_1",
          commitSha: "deadbeef",
          status: "live",
          environment: "production",
          startedAt: "2026-01-01T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;
    const result = await getDeploymentForCommit({
      repo: "o/r",
      commitSha: "deadbeef",
    });
    expect(result).not.toBeNull();
    expect(result?.deployId).toBe("dep_1");
    expect(result?.status).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// triggerRedeploy
// ---------------------------------------------------------------------------

describe("crontech-client — triggerRedeploy", () => {
  it("returns null in offline mode (no key)", async () => {
    const result = await triggerRedeploy({
      repo: "o/r",
      commitSha: "cafef00d",
    });
    expect(result).toBeNull();
  });

  it("returns null on a 500 response", async () => {
    process.env.CRONTECH_API_KEY = "ct";
    globalThis.fetch = (async () =>
      new Response("", { status: 500 })) as unknown as typeof fetch;
    const result = await triggerRedeploy({
      repo: "o/r",
      commitSha: "cafef00d",
      environment: "staging",
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rollbackDeployment
// ---------------------------------------------------------------------------

describe("crontech-client — rollbackDeployment", () => {
  it("returns false in offline mode (no key)", async () => {
    const ok = await rollbackDeployment({ repo: "o/r", deployId: "dep_1" });
    expect(ok).toBe(false);
  });

  it("returns false on a 500 response", async () => {
    process.env.CRONTECH_API_KEY = "ct";
    globalThis.fetch = (async () =>
      new Response("", { status: 500 })) as unknown as typeof fetch;
    const ok = await rollbackDeployment({ repo: "o/r", deployId: "dep_1" });
    expect(ok).toBe(false);
  });

  it("returns false when deployId is empty even with a key", async () => {
    process.env.CRONTECH_API_KEY = "ct";
    const ok = await rollbackDeployment({ repo: "o/r", deployId: "" });
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// watchDeployment
// ---------------------------------------------------------------------------

describe("crontech-client — watchDeployment", () => {
  it("returns offline:true immediately when no key is set", async () => {
    globalThis.fetch = (() => {
      throw new Error("fetch must not run offline");
    }) as unknown as typeof fetch;
    const start = Date.now();
    const result = await watchDeployment({
      repo: "o/r",
      deployId: "dep_1",
      maxWaitMs: 60_000,
    });
    const elapsed = Date.now() - start;
    expect(result.offline).toBe(true);
    expect(result.finalStatus).toBe("failed");
    expect(result.errors).toEqual([]);
    // Should short-circuit in well under a second.
    expect(elapsed).toBeLessThan(500);
  });

  it("resolves with finalStatus=live when the poll returns terminal status", async () => {
    process.env.CRONTECH_API_KEY = "ct";
    let call = 0;
    globalThis.fetch = (async (input: unknown) => {
      call++;
      const url = String(input);
      if (url.endsWith("/status")) {
        return new Response(
          JSON.stringify({ status: "live" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/errors")) {
        return new Response(
          JSON.stringify({ errors: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await watchDeployment({
      repo: "o/r",
      deployId: "dep_1",
      maxWaitMs: 5_000,
      pollIntervalMs: 50,
    });
    expect(result.offline).toBe(false);
    expect(result.finalStatus).toBe("live");
    expect(call).toBeGreaterThanOrEqual(2); // status + errors
  });

  it("bails to offline after repeated 500 status polls", async () => {
    process.env.CRONTECH_API_KEY = "ct";
    globalThis.fetch = (async () =>
      new Response("", { status: 500 })) as unknown as typeof fetch;
    const result = await watchDeployment({
      repo: "o/r",
      deployId: "dep_1",
      maxWaitMs: 5_000,
      pollIntervalMs: 10,
    });
    expect(result.offline).toBe(true);
    expect(result.finalStatus).toBe("failed");
  });
});

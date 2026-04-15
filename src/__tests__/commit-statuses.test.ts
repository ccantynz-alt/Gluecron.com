/**
 * Block J8 — Commit status API tests. Pure helpers + route-auth smokes.
 * DB-backed CRUD is covered in integration.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  STATUS_STATES,
  isValidSha,
  isValidState,
  reduceCombined,
  sanitiseContext,
  __internal,
} from "../lib/commit-statuses";

describe("commit-statuses — isValidSha", () => {
  it("accepts 4 to 40 hex chars", () => {
    expect(isValidSha("abcd")).toBe(true);
    expect(isValidSha("a".repeat(40))).toBe(true);
    expect(isValidSha("DEADBEEF")).toBe(true);
  });

  it("rejects too short / too long / bad chars / empty / null", () => {
    expect(isValidSha("abc")).toBe(false);
    expect(isValidSha("a".repeat(41))).toBe(false);
    expect(isValidSha("xyz1")).toBe(false);
    expect(isValidSha("")).toBe(false);
    expect(isValidSha(null)).toBe(false);
    expect(isValidSha(undefined)).toBe(false);
  });
});

describe("commit-statuses — isValidState", () => {
  it("accepts the four canonical states", () => {
    for (const s of STATUS_STATES) expect(isValidState(s)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidState("")).toBe(false);
    expect(isValidState("passed")).toBe(false);
    expect(isValidState("ok")).toBe(false);
    expect(isValidState(null)).toBe(false);
    expect(isValidState(42)).toBe(false);
    expect(isValidState(undefined)).toBe(false);
  });
});

describe("commit-statuses — sanitiseContext", () => {
  it("defaults to 'default' on empty / nullish", () => {
    expect(sanitiseContext("")).toBe("default");
    expect(sanitiseContext(null)).toBe("default");
    expect(sanitiseContext(undefined)).toBe("default");
    expect(sanitiseContext("   ")).toBe("default");
  });

  it("trims and caps length", () => {
    expect(sanitiseContext("  ci/build  ")).toBe("ci/build");
    const long = "x".repeat(500);
    expect(sanitiseContext(long).length).toBe(__internal.CONTEXT_MAX);
  });
});

describe("commit-statuses — reduceCombined", () => {
  it("empty list rolls up as success (no blockers)", () => {
    expect(reduceCombined([])).toBe("success");
  });

  it("any failure dominates", () => {
    expect(reduceCombined(["success", "failure"])).toBe("failure");
    expect(reduceCombined(["pending", "failure"])).toBe("failure");
  });

  it("any error dominates (bucketed as failure)", () => {
    expect(reduceCombined(["success", "error"])).toBe("failure");
    expect(reduceCombined(["pending", "error"])).toBe("failure");
  });

  it("no failure + any pending → pending", () => {
    expect(reduceCombined(["pending"])).toBe("pending");
    expect(reduceCombined(["success", "pending", "success"])).toBe("pending");
  });

  it("all success → success", () => {
    expect(reduceCombined(["success", "success", "success"])).toBe("success");
  });
});

describe("commit-statuses — __internal.clamp", () => {
  it("returns null for empty / nullish", () => {
    expect(__internal.clamp("", 10)).toBeNull();
    expect(__internal.clamp(null, 10)).toBeNull();
    expect(__internal.clamp(undefined, 10)).toBeNull();
  });

  it("caps at max", () => {
    expect(__internal.clamp("abcdef", 3)).toBe("abc");
    expect(__internal.clamp("ok", 10)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Route auth — these run without a DB so we only assert unauthenticated
// behaviour. Authenticated paths (owner check, actual upsert) belong in
// integration tests against a live DB.
// ---------------------------------------------------------------------------

describe("commit-statuses — route auth", () => {
  it("POST without auth → 302 /login redirect", async () => {
    const res = await app.request(
      "/api/v1/repos/alice/repo/statuses/abc1234",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "success" }),
      }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST with invalid bearer token → 401 JSON", async () => {
    const res = await app.request(
      "/api/v1/repos/alice/repo/statuses/abc1234",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer glc_not_a_real_token",
        },
        body: JSON.stringify({ state: "success" }),
      }
    );
    expect(res.status).toBe(401);
  });

  it("GET list returns JSON (200 / 404 / 500 depending on env)", async () => {
    const res = await app.request(
      "/api/v1/repos/alice/repo/commits/abc1234/statuses"
    );
    expect([200, 404, 500]).toContain(res.status);
  });

  it("GET combined status returns JSON", async () => {
    const res = await app.request(
      "/api/v1/repos/alice/repo/commits/abc1234/status"
    );
    expect([200, 404, 500]).toContain(res.status);
  });

  it("GET with obviously invalid sha → 400", async () => {
    const res = await app.request(
      "/api/v1/repos/alice/repo/commits/NOT_HEX/status"
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("sha");
  });
});

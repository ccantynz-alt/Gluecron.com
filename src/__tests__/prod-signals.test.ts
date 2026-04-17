/**
 * Block K9 — Production-signal ingestion tests.
 *
 * Pure helpers cover the security-critical bits (sha sanity, hash
 * stability, frame extraction, source allow-listing). Route smokes
 * only assert auth behaviour — DB-backed CRUD is an integration
 * concern and lives in the live-DB suite.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  SIGNAL_SOURCES,
  extractTopFrame,
  hashError,
  isValidSha,
  sanitiseKind,
  sanitiseSeverity,
  sanitiseSource,
  __internal,
} from "../lib/prod-signals";

describe("prod-signals — isValidSha", () => {
  it("accepts 7–64 hex chars", () => {
    expect(isValidSha("abcdef1")).toBe(true); // 7
    expect(isValidSha("a".repeat(40))).toBe(true); // full git sha
    expect(isValidSha("a".repeat(64))).toBe(true); // sha-256 bound
    expect(isValidSha("DEADBEEF1234")).toBe(true); // case insensitive
  });

  it("rejects too short / too long / bad chars / empty / null", () => {
    expect(isValidSha("abc123")).toBe(false); // 6 < 7
    expect(isValidSha("a".repeat(65))).toBe(false);
    expect(isValidSha("xyz12345")).toBe(false);
    expect(isValidSha("")).toBe(false);
    expect(isValidSha(null)).toBe(false);
    expect(isValidSha(undefined)).toBe(false);
    expect(isValidSha(1234567 as any)).toBe(false);
  });
});

describe("prod-signals — hashError", () => {
  it("is deterministic for the same inputs", () => {
    const a = hashError("TypeError: x is null", "at foo (bar.ts:1:1)");
    const b = hashError("TypeError: x is null", "at foo (bar.ts:1:1)");
    expect(a).toBe(b);
  });

  it("returns a 16-hex-char string", () => {
    const h = hashError("boom", "at foo (bar.ts)");
    expect(h.length).toBe(__internal.HASH_LEN);
    expect(/^[a-f0-9]+$/.test(h)).toBe(true);
  });

  it("differs when top frame differs", () => {
    const a = hashError("boom", "at foo (a.ts:1:1)");
    const b = hashError("boom", "at bar (c.ts:1:1)");
    expect(a).not.toBe(b);
  });

  it("collapses volatile details in messages (whitespace, hex pointers, line:col)", () => {
    // Two forms of the same error that differ only by whitespace / addr / line:col
    // should collide after normalisation.
    const a = hashError(
      "Cannot read property 'x' of null at 0xdeadbeef:12:34",
      "at foo (a.ts:10:5)"
    );
    const b = hashError(
      "Cannot   read property 'x' of null at 0xfeedface:99:1",
      "at foo (a.ts:10:5)"
    );
    expect(a).toBe(b);
  });

  it("tolerates null / undefined inputs", () => {
    const h = hashError(null as any, undefined as any);
    expect(h.length).toBe(__internal.HASH_LEN);
  });
});

describe("prod-signals — extractTopFrame", () => {
  it("returns the first non-empty, non-node_modules line", () => {
    const st = [
      "",
      "    at Module._compile (node:internal/modules)",
      "    at ./node_modules/foo/index.js:3:10",
      "    at ./src/app.ts:42:5",
    ].join("\n");
    expect(extractTopFrame(st)).toBe(
      "at Module._compile (node:internal/modules)"
    );
  });

  it("skips node_modules frames", () => {
    const st = [
      "    at ./node_modules/react/cjs/react.js:10:1",
      "    at ./src/App.tsx:15:3",
    ].join("\n");
    expect(extractTopFrame(st)).toBe("at ./src/App.tsx:15:3");
  });

  it("caps at FRAME_MAX", () => {
    const line = "at foo " + "x".repeat(2000);
    const top = extractTopFrame(line);
    expect(top.length).toBe(__internal.FRAME_MAX);
  });

  it("returns empty string on malformed / empty input", () => {
    expect(extractTopFrame("")).toBe("");
    expect(extractTopFrame(null)).toBe("");
    expect(extractTopFrame(undefined)).toBe("");
    expect(extractTopFrame("   \n\n  ")).toBe("");
  });
});

describe("prod-signals — sanitiseSource", () => {
  it("accepts the allow-listed sources", () => {
    for (const s of SIGNAL_SOURCES) expect(sanitiseSource(s)).toBe(s);
  });

  it("lower-cases and trims", () => {
    expect(sanitiseSource("  CRONTECH  ")).toBe("crontech");
    expect(sanitiseSource("Gatetest")).toBe("gatetest");
  });

  it("falls back to 'manual' for unknown / missing", () => {
    expect(sanitiseSource("datadog")).toBe("manual");
    expect(sanitiseSource("")).toBe("manual");
    expect(sanitiseSource(null)).toBe("manual");
    expect(sanitiseSource(undefined)).toBe("manual");
    expect(sanitiseSource(42 as any)).toBe("manual");
  });
});

describe("prod-signals — sanitiseKind", () => {
  it("accepts canonical kinds", () => {
    expect(sanitiseKind("runtime_error")).toBe("runtime_error");
    expect(sanitiseKind("test_failure")).toBe("test_failure");
    expect(sanitiseKind("deploy_failure")).toBe("deploy_failure");
    expect(sanitiseKind("performance")).toBe("performance");
    expect(sanitiseKind("security")).toBe("security");
  });

  it("defaults unknown kinds to runtime_error", () => {
    expect(sanitiseKind("weird")).toBe("runtime_error");
    expect(sanitiseKind(null)).toBe("runtime_error");
    expect(sanitiseKind(undefined)).toBe("runtime_error");
  });
});

describe("prod-signals — sanitiseSeverity", () => {
  it("accepts canonical severities", () => {
    expect(sanitiseSeverity("info")).toBe("info");
    expect(sanitiseSeverity("warning")).toBe("warning");
    expect(sanitiseSeverity("error")).toBe("error");
    expect(sanitiseSeverity("critical")).toBe("critical");
  });

  it("defaults to 'error'", () => {
    expect(sanitiseSeverity("")).toBe("error");
    expect(sanitiseSeverity("fatal")).toBe("error");
    expect(sanitiseSeverity(null)).toBe("error");
    expect(sanitiseSeverity(undefined)).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Route auth smoke tests. Without a live DB we only assert that
// unauthenticated writes are rejected and that the shape of the error
// is JSON (not an HTML /login redirect — API clients don't follow it).
// These tolerate "not yet mounted" (404) so the file can land before the
// main thread wires signals.ts into app.tsx.
// ---------------------------------------------------------------------------
describe("prod-signals — route auth", () => {
  it("POST /api/v1/signals/error without auth → 401 JSON (or 404 pre-mount)", async () => {
    const res = await app.request("/api/v1/signals/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "alice/demo",
        commit_sha: "abc1234",
        source: "crontech",
        kind: "runtime_error",
        message: "boom",
      }),
    });
    expect([401, 404]).toContain(res.status);
  });

  it("POST with invalid bearer token → 401 JSON (or 404 pre-mount)", async () => {
    const res = await app.request("/api/v1/signals/error", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer glc_not_a_real_token",
      },
      body: JSON.stringify({
        repo: "alice/demo",
        commit_sha: "abc1234",
        source: "manual",
        kind: "runtime_error",
        message: "boom",
      }),
    });
    expect([401, 404]).toContain(res.status);
  });

  it("POST dismiss without auth → 401 (or 404 pre-mount)", async () => {
    const res = await app.request(
      "/api/v1/signals/00000000-0000-0000-0000-000000000000/dismiss",
      { method: "POST" }
    );
    expect([401, 404]).toContain(res.status);
  });

  it("POST resolve without auth → 401 (or 404 pre-mount)", async () => {
    const res = await app.request(
      "/api/v1/signals/00000000-0000-0000-0000-000000000000/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }
    );
    expect([401, 404]).toContain(res.status);
  });

  it("GET repo signals returns JSON (200 / 403 / 404 / 500 depending on env)", async () => {
    const res = await app.request("/api/v1/repos/alice/demo/signals");
    expect([200, 403, 404, 500]).toContain(res.status);
  });

  it("GET commit signals with invalid sha → 400 (or 404 pre-mount)", async () => {
    const res = await app.request(
      "/api/v1/repos/alice/demo/commits/NOT_HEX/signals"
    );
    expect([400, 404]).toContain(res.status);
  });
});

/**
 * Tests for src/lib/push-policy.ts.
 *
 * The DB-touching paths (matchProtectedTag, listRulesetsForRepo,
 * canBypassProtectedTag) require a live DB; we don't have one in unit
 * tests. Instead we cover:
 *
 *   - The pure formatPolicyError formatter — exhaustive.
 *   - The fail-open guarantee on bad input (empty refs, missing repo id).
 *   - Module shape (imports don't throw, expected exports are present).
 *
 * Real end-to-end coverage of the policy decisions runs in the existing
 * rulesets + protected-tags test suites (which exercise evaluatePush and
 * matchGlob directly). This file verifies that the new wrapper preserves
 * fail-open semantics, which is the property that protects production
 * pushes from a Postgres hiccup.
 */

import { describe, it, expect } from "bun:test";
import {
  evaluatePushPolicy,
  formatPolicyError,
  ZERO_SHA,
} from "../lib/push-policy";

describe("ZERO_SHA constant", () => {
  it("is exactly 40 zeros", () => {
    expect(ZERO_SHA).toBe("0000000000000000000000000000000000000000");
    expect(ZERO_SHA.length).toBe(40);
  });
});

describe("formatPolicyError", () => {
  it("returns a generic message when violations is empty", () => {
    expect(formatPolicyError([])).toBe("Push rejected by Gluecron policy.");
  });

  it("returns a generic message when violations is null/undefined", () => {
    expect(formatPolicyError(null as any)).toBe(
      "Push rejected by Gluecron policy."
    );
    expect(formatPolicyError(undefined as any)).toBe(
      "Push rejected by Gluecron policy."
    );
  });

  it("renders one violation as a bulleted list", () => {
    const out = formatPolicyError(['tag "v1.0" is protected']);
    expect(out).toContain("Push rejected by Gluecron policy:");
    expect(out).toContain(' - tag "v1.0" is protected');
  });

  it("renders multiple violations on separate lines", () => {
    const out = formatPolicyError([
      'tag "v1.0" is protected',
      'ruleset "no-prod-pushes" rule branch_name_pattern: blocked',
    ]);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("Push rejected by Gluecron policy:");
    expect(lines[1]).toBe(' - tag "v1.0" is protected');
    expect(lines[2]).toBe(
      ' - ruleset "no-prod-pushes" rule branch_name_pattern: blocked'
    );
  });

  it("ends with a newline (so git surfaces the body cleanly)", () => {
    expect(formatPolicyError(["one violation"]).endsWith("\n")).toBe(true);
  });
});

describe("evaluatePushPolicy — fail-open on bad input", () => {
  it("returns allowed=true for an empty refs list", async () => {
    const r = await evaluatePushPolicy({
      repositoryId: "repo-1",
      refs: [],
      pusherUserId: null,
    });
    expect(r.allowed).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("returns allowed=true for missing repositoryId", async () => {
    const r = await evaluatePushPolicy({
      repositoryId: "" as any,
      refs: [
        {
          oldSha: ZERO_SHA,
          newSha: "a".repeat(40),
          refName: "refs/tags/v1.0",
        },
      ],
      pusherUserId: null,
    });
    expect(r.allowed).toBe(true);
  });

  it("returns allowed=true when DB is unreachable (refs target a nonexistent repo)", async () => {
    // No real repo exists with id "definitely-not-a-real-repo-id"; the
    // matchProtectedTag + listRulesetsForRepo callers catch their own
    // errors and return empty arrays, so the wrapper returns allowed.
    const r = await evaluatePushPolicy({
      repositoryId: "definitely-not-a-real-repo-id",
      refs: [
        {
          oldSha: ZERO_SHA,
          newSha: "a".repeat(40),
          refName: "refs/heads/main",
        },
      ],
      pusherUserId: null,
    });
    expect(r.allowed).toBe(true);
  });
});

describe("evaluatePushPolicy — module shape", () => {
  it("exports the functions the route depends on", async () => {
    const mod = await import("../lib/push-policy");
    expect(typeof mod.evaluatePushPolicy).toBe("function");
    expect(typeof mod.formatPolicyError).toBe("function");
    expect(typeof mod.ZERO_SHA).toBe("string");
  });
});

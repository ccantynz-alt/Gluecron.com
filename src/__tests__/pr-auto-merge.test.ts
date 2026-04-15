/**
 * Block J16 — PR auto-merge. Pure state-machine + route-auth smokes.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  MERGE_METHODS,
  isValidMergeMethod,
  computeAutoMergeAction,
  __internal,
} from "../lib/pr-auto-merge";

describe("pr-auto-merge — isValidMergeMethod", () => {
  it("accepts the three canonical methods", () => {
    for (const m of MERGE_METHODS) expect(isValidMergeMethod(m)).toBe(true);
  });

  it("rejects unknown methods + non-strings", () => {
    expect(isValidMergeMethod("fast-forward")).toBe(false);
    expect(isValidMergeMethod("")).toBe(false);
    expect(isValidMergeMethod(null)).toBe(false);
    expect(isValidMergeMethod(undefined)).toBe(false);
    expect(isValidMergeMethod(42)).toBe(false);
  });
});

describe("pr-auto-merge — computeAutoMergeAction", () => {
  const base = {
    autoMergeEnabled: true,
    prState: "open",
    isDraft: false,
    combinedState: "success" as const,
    totalChecks: 3,
  };

  it("skips when auto-merge is not enabled", () => {
    const r = computeAutoMergeAction({ ...base, autoMergeEnabled: false });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("not_enabled");
  });

  it("skips when the PR is not open", () => {
    expect(
      computeAutoMergeAction({ ...base, prState: "closed" }).reason
    ).toBe("pr_closed");
    expect(
      computeAutoMergeAction({ ...base, prState: "merged" }).reason
    ).toBe("pr_closed");
  });

  it("skips draft PRs", () => {
    const r = computeAutoMergeAction({ ...base, isDraft: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("pr_draft");
  });

  it("waits when no checks have reported yet", () => {
    const r = computeAutoMergeAction({
      ...base,
      combinedState: null,
      totalChecks: 0,
    });
    expect(r.action).toBe("wait");
    expect(r.reason).toBe("no_checks");
  });

  it("waits when combined state is pending", () => {
    const r = computeAutoMergeAction({
      ...base,
      combinedState: "pending",
      totalChecks: 2,
    });
    expect(r.action).toBe("wait");
    expect(r.reason).toBe("checks_pending");
  });

  it("skips on any failure/error", () => {
    expect(
      computeAutoMergeAction({ ...base, combinedState: "failure" }).reason
    ).toBe("checks_failed");
    expect(
      computeAutoMergeAction({ ...base, combinedState: "error" }).reason
    ).toBe("checks_failed");
  });

  it("merges when combined state is success and checks > 0", () => {
    const r = computeAutoMergeAction(base);
    expect(r.action).toBe("merge");
    expect(r.reason).toBe("checks_passed");
  });

  it("waits (not merges) when combined state is success but totalChecks is 0", () => {
    // Defensive — the "success with zero checks" combined output means
    // the reducer returned success for an empty list. We should not flip
    // to merge in that case.
    const r = computeAutoMergeAction({
      ...base,
      combinedState: "success",
      totalChecks: 0,
    });
    expect(r.action).toBe("wait");
    expect(r.reason).toBe("no_checks");
  });

  it("draft check beats checks failure — still skip as draft", () => {
    const r = computeAutoMergeAction({
      ...base,
      isDraft: true,
      combinedState: "failure",
    });
    expect(r.reason).toBe("pr_draft");
  });

  it("disabled beats draft — still not_enabled", () => {
    const r = computeAutoMergeAction({
      ...base,
      autoMergeEnabled: false,
      isDraft: true,
    });
    expect(r.reason).toBe("not_enabled");
  });
});

describe("pr-auto-merge — routes", () => {
  it("POST /:o/:r/pulls/:n/auto-merge requires auth", async () => {
    const res = await app.request(
      "/alice/nope/pulls/1/auto-merge",
      { method: "POST", body: "mergeMethod=merge" }
    );
    expect([302, 401, 404].includes(res.status)).toBe(true);
  });

  it("POST .../auto-merge/disable requires auth", async () => {
    const res = await app.request(
      "/alice/nope/pulls/1/auto-merge/disable",
      { method: "POST" }
    );
    expect([302, 401, 404].includes(res.status)).toBe(true);
  });

  it("POST with invalid bearer → 401 JSON", async () => {
    const res = await app.request(
      "/alice/nope/pulls/1/auto-merge",
      {
        method: "POST",
        headers: { authorization: "Bearer glc_garbage" },
        body: "mergeMethod=merge",
      }
    );
    expect(res.status).toBe(401);
  });
});

describe("pr-auto-merge — __internal", () => {
  it("exposes the pure helpers for parity", () => {
    expect(__internal.computeAutoMergeAction).toBe(computeAutoMergeAction);
    expect(__internal.isValidMergeMethod).toBe(isValidMergeMethod);
    expect(__internal.MERGE_METHODS).toBe(MERGE_METHODS);
  });
});

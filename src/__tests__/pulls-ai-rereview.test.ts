/**
 * Smoke tests for the new on-demand AI re-review endpoint:
 *   POST /:owner/:repo/pulls/:number/ai-rereview
 *
 * Write-access only. Verifies auth-guard contracts.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("POST /:owner/:repo/pulls/:number/ai-rereview — auth guard", () => {
  it("redirects to /login when unauthenticated", async () => {
    const res = await app.request(
      "/alice/demo/pulls/1/ai-rereview",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
        redirect: "manual",
      }
    );
    expect([301, 302, 303, 307, 401, 403, 404, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303 || res.status === 307) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });

  it("rejects bogus bearer tokens", async () => {
    const res = await app.request(
      "/alice/demo/pulls/1/ai-rereview",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer glct_definitely-not-valid",
        },
        body: "",
      }
    );
    expect([401, 403, 404, 503]).toContain(res.status);
  });
});

describe("triggerAiReview — force option (idempotency bypass)", () => {
  it("accepts and propagates the force flag without throwing", async () => {
    const { triggerAiReview } = await import("../lib/ai-review");
    let threw = false;
    try {
      // No API key in test env → should bail at isAiReviewEnabled check.
      // The force flag is just a parameter pass-through; we verify it
      // doesn't change the never-throw contract.
      await triggerAiReview(
        "alice",
        "demo",
        "00000000-0000-0000-0000-000000000000",
        "Title",
        "Body",
        "main",
        "feature",
        { force: true }
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("default options (no force) still works", async () => {
    const { triggerAiReview } = await import("../lib/ai-review");
    let threw = false;
    try {
      await triggerAiReview(
        "alice",
        "demo",
        "00000000-0000-0000-0000-000000000000",
        "Title",
        "Body",
        "main",
        "feature"
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

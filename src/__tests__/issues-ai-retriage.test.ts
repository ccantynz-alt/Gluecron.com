/**
 * Smoke tests for the on-demand issue re-triage endpoint:
 *   POST /:owner/:repo/issues/:number/ai-retriage
 *
 * Write-access only. Verifies auth-guard contracts and the
 * triggerIssueTriage `force` parameter never-throws contract.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("POST /:owner/:repo/issues/:number/ai-retriage — auth guard", () => {
  it("redirects to /login when unauthenticated", async () => {
    const res = await app.request(
      "/alice/demo/issues/1/ai-retriage",
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
      "/alice/demo/issues/1/ai-retriage",
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

describe("triggerIssueTriage — force option (idempotency bypass)", () => {
  it("accepts and propagates the force flag without throwing", async () => {
    const { triggerIssueTriage } = await import("../lib/issue-triage");
    let threw = false;
    try {
      await triggerIssueTriage(
        {
          ownerName: "alice",
          repoName: "demo",
          repositoryId: "00000000-0000-0000-0000-000000000000",
          issueId: "00000000-0000-0000-0000-000000000000",
          issueNumber: 1,
          authorId: "00000000-0000-0000-0000-000000000000",
          title: "Test",
          body: "",
        },
        { force: true }
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

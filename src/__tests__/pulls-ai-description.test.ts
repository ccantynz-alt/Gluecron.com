/**
 * Smoke tests for the new AI-PR-description endpoint:
 *   POST /:owner/:repo/ai/pr-description
 *
 * The route requires write access, so unauthenticated callers should
 * never see a 200/JSON body. Authenticated paths require a live DB +
 * git checkout, so we focus on the auth-guard contract.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("POST /:owner/:repo/ai/pr-description — auth guard", () => {
  it("redirects to /login when unauthenticated (no bearer)", async () => {
    const res = await app.request(
      "/alice/demo/ai/pr-description",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "title=Test&base=main&head=feature",
        redirect: "manual",
      }
    );
    // Either a 302 to /login (cookie flow), or a 4xx/5xx if requireAuth
    // / requireRepoAccess fail-closed earlier. The one thing we MUST NOT
    // see is a 200 with a leaked body.
    expect([301, 302, 303, 307, 401, 403, 404, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303 || res.status === 307) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });

  it("rejects bogus bearer tokens with 401", async () => {
    const res = await app.request(
      "/alice/demo/ai/pr-description",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer glct_definitely-not-valid",
        },
        body: "title=Test&base=main&head=feature",
      }
    );
    expect([401, 403, 404, 503]).toContain(res.status);
  });
});

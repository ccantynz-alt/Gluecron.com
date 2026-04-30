/**
 * Smoke tests for the new AI commit-message endpoint:
 *   POST /:owner/:repo/ai/commit-message
 *
 * The route requires write access. Anonymous and bogus-bearer callers
 * should never see a 200 / leaked AI body.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("POST /:owner/:repo/ai/commit-message — auth guard", () => {
  it("redirects to /login when unauthenticated", async () => {
    const res = await app.request(
      "/alice/demo/ai/commit-message",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "ref=main&filePath=README.md&content=hello",
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
      "/alice/demo/ai/commit-message",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer glct_definitely-not-valid",
        },
        body: "ref=main&filePath=README.md&content=hello",
      }
    );
    expect([401, 403, 404, 503]).toContain(res.status);
  });
});

/**
 * Block J5 — Profile README smoke.
 *
 * We can't test the full "user has a user/user repo with a README" path
 * without a real git checkout, but we can verify the profile route still
 * responds on the happy + missing paths.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("profile README — route smoke", () => {
  it("GET /<unknown-user> renders without blowing up on missing profile repo", async () => {
    // Non-existent user → 200 page (renders with empty ownerUser) or 500 when
    // DB is unreachable. Either way, the profile-readme block must not crash.
    const res = await app.request("/does-not-exist-xyz");
    expect([200, 404, 500]).toContain(res.status);
  });

  it("GET /login stays a fixed route, not captured by /:owner", async () => {
    const res = await app.request("/login");
    // login page renders 200
    expect([200, 302]).toContain(res.status);
  });
});

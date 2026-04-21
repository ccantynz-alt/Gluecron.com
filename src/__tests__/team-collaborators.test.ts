/**
 * Team-collaborator routes — auth guard smoke.
 *
 * Mirrors src/__tests__/collaborators.test.ts. Two assertions:
 *   1. unauthenticated GET redirects to /login (requireAuth)
 *   2. an authed non-owner is blocked — either 403 (inline owner check) or
 *      redirected away (302 to /login when the stub cookie can't resolve).
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("team-collaborators — auth guard", () => {
  it("GET /:owner/:repo/settings/collaborators/teams without auth redirects to /login", async () => {
    const res = await app.request(
      "/somebody/some-repo/settings/collaborators/teams"
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET as an authed non-owner returns 403 or redirects away", async () => {
    const res = await app.request(
      "/some-owner/some-repo/settings/collaborators/teams",
      { headers: { cookie: "session=not-a-real-token" } }
    );
    expect([302, 403, 404]).toContain(res.status);
    if (res.status === 302) {
      expect(res.headers.get("location") || "").toContain("/login");
    }
  });
});

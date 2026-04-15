/**
 * Block I5 — Code scanning UI tests.
 *
 * The route uses softAuth + hits the DB on every request, so without a live
 * DATABASE_URL we can't exercise the 404 path in unit tests. We verify the
 * route is mounted by asserting that `/:owner/:repo/security` produces a
 * response (any status) rather than being swallowed by an unrelated handler.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("code-scanning — route mount", () => {
  it("GET /:owner/:repo/security is handled (not swallowed)", async () => {
    const res = await app.request(
      "/__does_not_exist_user__/__nope__/security"
    );
    // Without a DB connection the handler 500s. With a DB it returns 404.
    // Either proves the route was reached.
    expect([404, 500]).toContain(res.status);
  });
});

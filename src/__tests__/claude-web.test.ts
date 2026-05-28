/**
 * Tests for src/routes/claude-web.tsx.
 *
 * We only verify the auth gate behaviour here — the Claude session logic
 * itself is covered by claude-web-session.test.ts.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("claude-web route registration", () => {
  it("GET /:owner/:repo/claude redirects unauthenticated users to /login", async () => {
    // The route exists and enforces authentication — without a session
    // cookie the response must be a redirect to /login.
    const res = await app.request("/testowner/testrepo/claude", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
  });

  it("GET /:owner/:repo/claude/:sessionId redirects unauthenticated users to /login", async () => {
    const res = await app.request(
      "/testowner/testrepo/claude/00000000-0000-0000-0000-000000000001",
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
  });

  it("GET /:owner/:repo/claude/:sessionId/stream redirects unauthenticated users to /login", async () => {
    const res = await app.request(
      "/testowner/testrepo/claude/00000000-0000-0000-0000-000000000001/stream",
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
  });
});

/**
 * CSRF middleware — same-origin (Origin/Referer) defence + double-submit
 * cookie token fallback.
 *
 * The platform was previously broken in production for logged-in users:
 * the global `csrfProtect` middleware required a token on every POST but
 * ~40+ web-UI forms didn't include one, so every authenticated form
 * submission returned 403. The middleware now accepts a request iff EITHER:
 *
 *   1) Origin/Referer header matches the request host (same-origin), OR
 *   2) The legacy double-submit cookie token check passes.
 *
 * These tests lock in that behaviour so a future refactor cannot silently
 * regress it.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { csrfToken, csrfProtect } from "../middleware/csrf";

function buildApp() {
  const app = new Hono();
  app.use("*", csrfToken);
  app.use("*", csrfProtect);
  app.get("/echo", (c) => c.text("ok"));
  app.post("/echo", (c) => c.text("ok"));
  return app;
}

describe("csrfProtect — request-method gating", () => {
  it("lets GET requests through unconditionally", async () => {
    const app = buildApp();
    const res = await app.request("/echo");
    expect(res.status).toBe(200);
  });

  it("lets HEAD/OPTIONS pass the csrf gate (does not 403)", async () => {
    const app = buildApp();
    const head = await app.request("/echo", { method: "HEAD" });
    const opts = await app.request("/echo", { method: "OPTIONS" });
    // The middleware does not return 403 — any non-200 status here means
    // the route handler didn't accept the method, not that CSRF rejected.
    expect(head.status).not.toBe(403);
    expect(opts.status).not.toBe(403);
  });
});

describe("csrfProtect — skip paths", () => {
  it("skips when no session cookie is present (anonymous user)", async () => {
    const app = buildApp();
    // No `session` cookie → anonymous → not a CSRF target
    const res = await app.request("/echo", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("skips API routes (/api/*) regardless of method", async () => {
    const app = new Hono();
    app.use("*", csrfToken);
    app.use("*", csrfProtect);
    app.post("/api/anything", (c) => c.text("ok"));

    const res = await app.request("/api/anything", {
      method: "POST",
      headers: { cookie: "session=fake-session-cookie" },
    });
    expect(res.status).toBe(200);
  });

  it("skips Bearer-authenticated requests", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake",
        authorization: "Bearer some-token-here",
      },
    });
    expect(res.status).toBe(200);
  });
});

describe("csrfProtect — same-origin defence (Origin/Referer)", () => {
  it("accepts POST when Origin matches request host", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake",
        host: "gluecron.example.com",
        origin: "https://gluecron.example.com",
      },
    });
    expect(res.status).toBe(200);
  });

  it("accepts POST when Origin matches host with a non-default port", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake",
        host: "localhost:3000",
        origin: "http://localhost:3000",
      },
    });
    expect(res.status).toBe(200);
  });

  it("accepts POST when Referer matches host (browser may strip Origin)", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake",
        host: "gluecron.example.com",
        referer: "https://gluecron.example.com/some/page",
      },
    });
    expect(res.status).toBe(200);
  });

  it("rejects POST when Origin is an attacker site", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake",
        host: "gluecron.example.com",
        origin: "https://evil.example.com",
      },
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST when Referer is an attacker site", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake",
        host: "gluecron.example.com",
        referer: "https://evil.example.com/page",
      },
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST when Origin and Referer are both absent and no token cookie", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: { cookie: "session=fake" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST when Origin is a malformed URL", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake",
        host: "gluecron.example.com",
        origin: "::::not a url::::",
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("csrfProtect — double-submit token fallback", () => {
  it("accepts POST with matching token in header even when Origin is missing", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake; csrf_token=abc123",
        "x-csrf-token": "abc123",
      },
    });
    expect(res.status).toBe(200);
  });

  it("rejects POST with mismatched token", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake; csrf_token=abc123",
        "x-csrf-token": "wrong-token",
      },
    });
    expect(res.status).toBe(403);
  });

  it("accepts POST with matching token in form body", async () => {
    const app = buildApp();
    const body = new URLSearchParams({ _csrf: "abc123", other: "field" });
    const res = await app.request("/echo", {
      method: "POST",
      headers: {
        cookie: "session=fake; csrf_token=abc123",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
  });
});

describe("csrfToken — cookie setter", () => {
  it("sets a csrf_token cookie on first request when none exists", async () => {
    const app = buildApp();
    const res = await app.request("/echo");
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("csrf_token=");
  });

  it("does not overwrite an existing csrf_token cookie", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      headers: { cookie: "csrf_token=existing-value" },
    });
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).not.toContain("csrf_token=");
  });
});

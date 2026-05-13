/**
 * Regression guard for the "29 routes render Layout without user= prop" bug.
 *
 * Before the fix, several Hono handlers built `<Layout title="..." />` without
 * forwarding the `user` prop pulled from `c.get("user")`. The Layout's nav
 * fell back to the logged-out shell ("Sign in" / "Register" links) even when
 * the request was authenticated — so every authed user saw themselves as
 * signed-out in the top-right nav. The owner caught this in a prod screenshot.
 *
 * This test hits a handful of authed routes with a fake session and asserts:
 *   1. The response HTML contains the authed user's username/display name in
 *      the `.nav-user` slot (proves Layout received user=).
 *   2. The response HTML does NOT contain the logged-out anchors
 *      (`href="/login" class="nav-link">Sign in`) — those only render when
 *      Layout's `user` prop is null/undefined.
 *
 * Plus two extras:
 *   3. /login and /register, when hit with an active session, redirect away
 *      (302 -> /dashboard or the `redirect=` target) instead of rendering the
 *      sign-in shell over an authed session.
 *
 * Mock isolation
 * --------------
 * Bun's `mock.module()` is process-global. Like `mcp-write.test.ts`, we:
 *   - Capture the real module before mocking so afterAll can restore.
 *   - Mock ONLY `../db` (the one external resource), spreading the real
 *     export so any non-mocked surface stays untouched.
 *   - Restore the mock and clear `sessionCache` in afterAll.
 *   - Reset per-test row hooks in beforeEach so nothing leaks between tests
 *     in this file or downstream files.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

const _real_db = await import("../db");
const _real_cache = await import("../lib/cache");

// --- per-test row hooks ----------------------------------------------------
let _nextSessionRow: any = null;
let _nextUserRow: any = null;
let _lastSelectFrom: any = null;

const tableName = (t: any): string => {
  if (!t || typeof t !== "object") return "?";
  if ("token" in t && "expiresAt" in t && "userId" in t) return "sessions";
  if ("passwordHash" in t && "username" in t) return "users";
  if ("fingerprint" in t || "publicKey" in t) return "ssh_keys";
  return "?";
};

const _selectChain: any = {
  from: (t: any) => {
    _lastSelectFrom = t;
    return _selectChain;
  },
  innerJoin: () => _selectChain,
  leftJoin: () => _selectChain,
  where: () => _selectChain,
  orderBy: () => _selectChain,
  limit: async () => {
    const name = tableName(_lastSelectFrom);
    if (name === "sessions") return _nextSessionRow ? [_nextSessionRow] : [];
    if (name === "users") return _nextUserRow ? [_nextUserRow] : [];
    return [];
  },
  then: (resolve: (v: any) => void) => {
    // Unbounded `await db.select()...` (no .limit()) — used by /settings/keys
    // listing SSH keys for the user. Empty array renders the "No SSH keys
    // yet." empty state, which is exactly what we want.
    resolve([]);
  },
};

const _fakeDb = {
  db: {
    select: () => _selectChain,
    insert: () => ({
      values: () => ({
        returning: async () => [],
        then: (r: (v: any) => void) => r(undefined),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve() }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
  getDb: () => _fakeDb.db,
};

mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));

// Import AFTER the mock is installed so the app graph picks up our fake db.
const { default: app } = await import("../app");
const { sessionCache } = await import("../lib/cache");

// --- fixtures --------------------------------------------------------------
const USER_ID = "44444444-4444-4444-4444-444444444444";
const SESSION_TOKEN = "test-session-token-layout-userprop";

const TEST_USER = {
  id: USER_ID,
  username: "regression_user",
  displayName: "Regression User",
  email: "reg@example.com",
  passwordHash: "x",
  bio: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const TEST_SESSION = {
  userId: USER_ID,
  token: SESSION_TOKEN,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  requires2fa: false,
};

function authedHeaders(): HeadersInit {
  return { cookie: `session=${SESSION_TOKEN}` };
}

beforeEach(() => {
  _nextSessionRow = TEST_SESSION;
  _nextUserRow = TEST_USER;
  // Pre-warm the soft-auth cache so handlers using `softAuth` skip the DB
  // path entirely and pick up our user from in-memory state.
  sessionCache.set(SESSION_TOKEN, TEST_USER as any);
});

afterAll(() => {
  // Drop the cache entry so downstream test files don't inherit a "logged
  // in" session token they didn't create.
  sessionCache.invalidate(SESSION_TOKEN);
  _nextSessionRow = null;
  _nextUserRow = null;
  mock.module("../db", () => _real_db);
});

// --- helpers ---------------------------------------------------------------
const LOGGED_OUT_NAV_MARKER = `href="/login" class="nav-link"`;

function assertAuthedNav(html: string) {
  // The Layout nav renders `<a href={`/${user.username}`} class="nav-user">`
  // with the user's display name when `user` is present. If the prop is
  // missing the literal "Sign in" link shows up instead.
  expect(html).toContain('class="nav-user"');
  expect(html).toContain(TEST_USER.displayName);
  expect(html).not.toContain(LOGGED_OUT_NAV_MARKER);
}

// --- tests -----------------------------------------------------------------
describe("Layout user= prop is forwarded on authed routes", () => {
  it("/settings renders the user nav (was missing user= before fix)", async () => {
    const res = await app.request("/settings", { headers: authedHeaders() });
    expect(res.status).toBe(200);
    const body = await res.text();
    assertAuthedNav(body);
  });

  it("/settings/keys renders the user nav", async () => {
    const res = await app.request("/settings/keys", {
      headers: authedHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    assertAuthedNav(body);
  });

  it("/new (new repo form) renders the user nav", async () => {
    const res = await app.request("/new", { headers: authedHeaders() });
    expect(res.status).toBe(200);
    const body = await res.text();
    assertAuthedNav(body);
  });

  it("global 404 page renders the user nav when authed", async () => {
    // Pick a path with enough segments that no route claims it, so we end
    // up in app.notFound. The `/:owner` and `/:owner/:repo` patterns greedy-
    // match shorter paths; deeper paths land in the 404 handler.
    const res = await app.request(
      "/__nope__/__nope__/__nope__/__nope__/__nope__",
      { headers: authedHeaders() }
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    assertAuthedNav(body);
  });
});

describe("auth landing pages bounce already-authed users", () => {
  // The owner's call: /login and /register should NOT render the logged-out
  // sign-in shell while a valid session cookie is present. They redirect.

  it("/login with a live session 302s to /dashboard", async () => {
    const res = await app.request("/login", { headers: authedHeaders() });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("/login?redirect=/foo honours the redirect target when authed", async () => {
    const res = await app.request("/login?redirect=%2Ffoo%2Fbar", {
      headers: authedHeaders(),
    });
    expect(res.status).toBe(302);
    // Hono decodes query params; location is the decoded path.
    expect(res.headers.get("location")).toBe("/foo/bar");
  });

  it("/register with a live session 302s to /dashboard", async () => {
    const res = await app.request("/register", { headers: authedHeaders() });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("/login WITHOUT a session still renders the sign-in shell", async () => {
    // Empty cache + no cookie → softAuth sets user=null → page renders.
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const body = await res.text();
    // Logged-out nav literal is present on the actual sign-in page.
    expect(body).toContain(LOGGED_OUT_NAV_MARKER);
  });
});

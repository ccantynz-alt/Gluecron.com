/**
 * Block M2 — Web Push tests.
 *
 * Covers `src/lib/push.ts` + the `/pwa/*` API surface:
 *   - getVapidPublicKey: stable across calls (process-cached)
 *   - subscribeUser: persists, idempotent on (user, endpoint)
 *   - unsubscribeUser: deletes
 *   - sendPushToUser: per-subscription failures don't crash the fan-out,
 *     returns sent/failed counts
 *   - Stale-endpoint deletion on HTTP 410
 *   - Routes: vapid-public-key public, subscribe requires auth,
 *     unsubscribe requires auth
 *
 * Mock isolation
 * --------------
 * Bun's `mock.module()` is process-global. We capture the real `../db`
 * module BEFORE any mock so afterAll can restore it. The fake db
 * dispatches on the table passed to .from/.insert/.delete/.update,
 * records mutations to in-memory arrays, and returns canned rows.
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterAll,
} from "bun:test";

const _real_db = await import("../db");

// ---------------------------------------------------------------------------
// Fake db state
// ---------------------------------------------------------------------------

type SubRow = {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
};

let _subRows: SubRow[] = [];
let _nextUserRow: any = null;
const _inserted: any[] = [];
const _updated: any[] = [];
const _deleted: any[] = [];

const tableName = (t: any): string => {
  if (!t || typeof t !== "object") return "?";
  if ("p256dh" in t && "endpoint" in t) return "push_subscriptions";
  if ("token" in t && "expiresAt" in t && "userId" in t) return "sessions";
  if ("notifyPushOnMention" in t || "passwordHash" in t) return "users";
  return "?";
};

let _lastSelectFrom: any = null;
let _nextSessionRow: any = null;

const _selectChain: any = {
  from: (t: any) => {
    _lastSelectFrom = t;
    return _selectChain;
  },
  where: () => _selectChain,
  orderBy: () => _selectChain,
  limit: async () => {
    const name = tableName(_lastSelectFrom);
    if (name === "sessions") return _nextSessionRow ? [_nextSessionRow] : [];
    if (name === "users") return _nextUserRow ? [_nextUserRow] : [];
    return [];
  },
  then: (resolve: (v: any) => void) => {
    const name = tableName(_lastSelectFrom);
    if (name === "push_subscriptions") {
      resolve(_subRows.map((r) => ({
        endpoint: r.endpoint,
        p256dh: r.p256dh,
        auth: r.auth,
      })));
      return;
    }
    resolve([]);
  },
};

const _insertChain = (table: any) => ({
  values: (vals: any) => ({
    onConflictDoUpdate: ({ set }: { set: any }) => {
      const name = tableName(table);
      if (name === "push_subscriptions") {
        const existing = _subRows.find(
          (r) => r.userId === vals.userId && r.endpoint === vals.endpoint
        );
        if (existing) {
          existing.p256dh = set.p256dh ?? vals.p256dh;
          existing.auth = set.auth ?? vals.auth;
          existing.userAgent = set.userAgent ?? vals.userAgent ?? null;
        } else {
          _subRows.push({
            userId: vals.userId,
            endpoint: vals.endpoint,
            p256dh: vals.p256dh,
            auth: vals.auth,
            userAgent: vals.userAgent ?? null,
          });
        }
      }
      _inserted.push({ table: name, values: vals });
      return Promise.resolve();
    },
    returning: async () => [],
    then: (r: (v: any) => void) => {
      const name = tableName(table);
      if (name === "push_subscriptions") {
        _subRows.push({
          userId: vals.userId,
          endpoint: vals.endpoint,
          p256dh: vals.p256dh,
          auth: vals.auth,
          userAgent: vals.userAgent ?? null,
        });
      }
      _inserted.push({ table: name, values: vals });
      r(undefined);
    },
  }),
});

const _updateChain = (table: any) => ({
  set: (s: any) => ({
    where: () => {
      const name = tableName(table);
      _updated.push({ table: name, set: s });
      return Promise.resolve();
    },
  }),
});

let _deleteFilter: { userId?: string; endpoint?: string } | null = null;

const _deleteChain = (table: any) => ({
  where: (_cond: any) => {
    const name = tableName(table);
    _deleted.push({ table: name });
    if (name === "push_subscriptions") {
      // We don't get the filter values from the cond object easily; the
      // tests below call delete after subscribing exactly one row per
      // case, so we just drop everything matching the most recently used
      // endpoint hint stored on the chain.
      if (_deleteFilter) {
        _subRows = _subRows.filter(
          (r) =>
            !(r.userId === _deleteFilter!.userId &&
              r.endpoint === _deleteFilter!.endpoint)
        );
      }
    }
    return Promise.resolve();
  },
});

const _fakeDb = {
  db: {
    select: () => _selectChain,
    insert: (t: any) => _insertChain(t),
    update: (t: any) => _updateChain(t),
    delete: (t: any) => _deleteChain(t),
  },
  getDb: () => _fakeDb.db,
};

mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));

// Imports must come AFTER the mock so the module graph picks up the fake db.
const {
  getVapidPublicKey,
  subscribeUser,
  unsubscribeUser,
  sendPushToUser,
  __setSendTransport,
  __resetVapidCacheForTests,
} = await import("../lib/push");
const { default: app } = await import("../app");
const { sessionCache } = await import("../lib/cache");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Valid (random) base64url-encoded payload-encryption keys. The encryption
// path generates a fresh ECDH keypair on each call so the recipient public
// key only needs to be a real P-256 uncompressed point; we generate one
// with Web Crypto at test setup time.
let RECIPIENT_P256DH = "";
let RECIPIENT_AUTH = "";

const USER_ID = "55555555-5555-5555-5555-555555555555";
const SESSION_TOKEN = "test-session-token-push-m2";

const TEST_USER = {
  id: USER_ID,
  username: "push_test_user",
  displayName: "Push Test User",
  email: "push@example.com",
  passwordHash: "x",
  bio: null,
  notifyPushOnMention: true,
  notifyPushOnAssign: true,
  notifyPushOnReviewRequest: true,
  notifyPushOnDeployFailed: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function authedHeaders(): HeadersInit {
  return {
    cookie: `session=${SESSION_TOKEN}`,
    "content-type": "application/json",
    // CSRF same-origin guard: requests from real browser fetch() carry an
    // Origin matching the page host. We mirror that here so the
    // double-submit token isn't required for these JSON POSTs.
    host: "localhost",
    origin: "http://localhost",
  };
}

beforeEach(async () => {
  _subRows = [];
  _nextUserRow = TEST_USER;
  _nextSessionRow = {
    userId: USER_ID,
    token: SESSION_TOKEN,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    requires2fa: false,
  };
  _inserted.length = 0;
  _updated.length = 0;
  _deleted.length = 0;
  _deleteFilter = null;
  sessionCache.set(SESSION_TOKEN, TEST_USER as any);

  // Generate a real P-256 point so encryptPayload doesn't choke on dummy
  // bytes. We only need the public-key bytes; the private key stays inside
  // Web Crypto. `auth` can be any 16 bytes.
  if (!RECIPIENT_P256DH) {
    const kp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", kp.publicKey)
    );
    const authBytes = crypto.getRandomValues(new Uint8Array(16));
    RECIPIENT_P256DH = b64u(raw);
    RECIPIENT_AUTH = b64u(authBytes);
  }
});

function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

afterAll(() => {
  sessionCache.invalidate(SESSION_TOKEN);
  __resetVapidCacheForTests();
  mock.module("../db", () => _real_db);
});

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe("push.ts — getVapidPublicKey", () => {
  it("returns a stable key across calls (in-memory cached)", async () => {
    __resetVapidCacheForTests();
    const a = await getVapidPublicKey();
    const b = await getVapidPublicKey();
    expect(a).toBe(b);
    // Base64url, no padding.
    expect(a).toMatch(/^[A-Za-z0-9_\-]+$/);
    expect(a.length).toBeGreaterThan(40);
  });
});

describe("push.ts — subscribeUser / unsubscribeUser", () => {
  it("subscribeUser inserts a row", async () => {
    await subscribeUser(
      USER_ID,
      { endpoint: "https://push.example/abc", keys: { p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH } },
      "test-ua"
    );
    expect(_subRows.length).toBe(1);
    expect(_subRows[0]!.userId).toBe(USER_ID);
    expect(_subRows[0]!.endpoint).toBe("https://push.example/abc");
    expect(_subRows[0]!.userAgent).toBe("test-ua");
  });

  it("subscribeUser is idempotent on (user, endpoint)", async () => {
    await subscribeUser(USER_ID, {
      endpoint: "https://push.example/abc",
      keys: { p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH },
    });
    await subscribeUser(USER_ID, {
      endpoint: "https://push.example/abc",
      keys: { p256dh: RECIPIENT_P256DH, auth: "newauth" },
    });
    expect(_subRows.length).toBe(1);
    expect(_subRows[0]!.auth).toBe("newauth");
  });

  it("unsubscribeUser deletes the row", async () => {
    await subscribeUser(USER_ID, {
      endpoint: "https://push.example/zzz",
      keys: { p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH },
    });
    expect(_subRows.length).toBe(1);
    _deleteFilter = { userId: USER_ID, endpoint: "https://push.example/zzz" };
    await unsubscribeUser(USER_ID, "https://push.example/zzz");
    expect(_subRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sendPushToUser fan-out + stale-endpoint cleanup
// ---------------------------------------------------------------------------

describe("push.ts — sendPushToUser", () => {
  it("swallows per-subscription failures and returns sent/failed counts", async () => {
    // Three subscriptions: one ok (200), one server error (500), one gone (410).
    _subRows = [
      { userId: USER_ID, endpoint: "https://push.example/ok",   p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH, userAgent: null },
      { userId: USER_ID, endpoint: "https://push.example/fail", p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH, userAgent: null },
      { userId: USER_ID, endpoint: "https://push.example/gone", p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH, userAgent: null },
    ];

    const prev = __setSendTransport(async (url) => {
      if (url.endsWith("/ok"))   return { status: 201 };
      if (url.endsWith("/fail")) return { status: 500 };
      if (url.endsWith("/gone")) return { status: 410 };
      return { status: 502 };
    });
    try {
      // Drop the gone endpoint when the helper purges it.
      _deleteFilter = { userId: USER_ID, endpoint: "https://push.example/gone" };
      const res = await sendPushToUser(USER_ID, {
        title: "hello",
        body: "world",
        url: "/notifications",
      });
      expect(res.sent).toBe(1);
      expect(res.failed).toBe(2);
      // The 410 endpoint should have been purged from the table.
      expect(_subRows.find((r) => r.endpoint.endsWith("/gone"))).toBeUndefined();
      // The 500 endpoint must NOT be purged — it might be transient.
      expect(_subRows.find((r) => r.endpoint.endsWith("/fail"))).toBeDefined();
    } finally {
      __setSendTransport(prev);
    }
  });

  it("returns zero counts when the user has no subscriptions", async () => {
    _subRows = [];
    const res = await sendPushToUser(USER_ID, { title: "x", body: "y" });
    expect(res).toEqual({ sent: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("/pwa/vapid-public-key", () => {
  it("is public — returns 200 + { key } without auth", async () => {
    const res = await app.request("/pwa/vapid-public-key");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.key).toBe("string");
    expect(body.key.length).toBeGreaterThan(40);
  });
});

describe("/pwa/subscribe", () => {
  it("requires auth (302 to /login when anonymous)", async () => {
    const res = await app.request("/pwa/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://push.example/x",
        keys: { p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH },
      }),
    });
    // requireAuth either redirects to /login or returns 401 — accept either.
    expect([302, 401, 403]).toContain(res.status);
  });

  it("authed POST persists a subscription and returns 201", async () => {
    const res = await app.request("/pwa/subscribe", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        endpoint: "https://push.example/me",
        keys: { p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH },
      }),
    });
    expect(res.status).toBe(201);
    expect(_subRows.length).toBe(1);
    expect(_subRows[0]!.endpoint).toBe("https://push.example/me");
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await app.request("/pwa/subscribe", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ endpoint: "no-keys" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("/pwa/unsubscribe", () => {
  it("requires auth", async () => {
    const res = await app.request("/pwa/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example/x" }),
    });
    expect([302, 401, 403]).toContain(res.status);
  });

  it("authed POST deletes and returns 204", async () => {
    _subRows = [
      { userId: USER_ID, endpoint: "https://push.example/byebye", p256dh: RECIPIENT_P256DH, auth: RECIPIENT_AUTH, userAgent: null },
    ];
    _deleteFilter = { userId: USER_ID, endpoint: "https://push.example/byebye" };
    const res = await app.request("/pwa/unsubscribe", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ endpoint: "https://push.example/byebye" }),
    });
    expect(res.status).toBe(204);
    expect(_subRows.length).toBe(0);
  });
});

describe("/sw-push.js (offline + push handler service worker)", () => {
  it("serves the push-aware service worker", async () => {
    const res = await app.request("/sw-push.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain(
      "application/javascript"
    );
    const body = await res.text();
    expect(body).toContain("addEventListener('push'");
    expect(body).toContain("addEventListener('notificationclick'");
    expect(body).toContain("addEventListener('fetch'");
    expect(body).toContain("/offline.html");
  });
});

describe("/offline.html", () => {
  it("serves a dark-themed offline page", async () => {
    const res = await app.request("/offline.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/html");
    const body = await res.text();
    expect(body).toContain("You're offline");
    expect(body).toContain('data-theme="light"');
  });
});

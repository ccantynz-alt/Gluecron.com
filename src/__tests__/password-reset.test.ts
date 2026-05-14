/**
 * Block P1 — Password reset flow.
 *
 * Covers `src/lib/password-reset.ts` (token primitives, request creation,
 * token consumption) and the `src/routes/password-reset.tsx` HTTP surface
 * (forgot-password GET/POST, reset-password GET/POST).
 *
 * Strategy:
 *   - The library tests stub the `db` module (K1 spread-from-real pattern)
 *     so they don't require Neon. The stub stores rows in in-memory arrays
 *     keyed by `tableName(t)` and re-uses the same fluent chain shape that
 *     mcp-write.test.ts established.
 *   - Email sending is replaced via `__setEmailForTests` so we can assert
 *     "an email was queued for this user" without hitting a real provider.
 *   - The HTTP-surface tests use `app.request(...)` so the real Hono router
 *     answers — including the `csrfProtect` middleware (which exempts
 *     unauth POSTs via the session-cookie shortcut).
 *
 * All `mock.module(...)` calls capture the REAL module first and restore
 * in `afterAll` so we don't poison every test file that runs after us.
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";

// Capture real modules BEFORE any mock.module() so afterAll can restore them.
const _real_db = await import("../db");

// ---------------------------------------------------------------------------
// In-memory DB stub
// ---------------------------------------------------------------------------

interface FakeRow { [k: string]: any; }
interface FakeStore {
  users: FakeRow[];
  password_reset_tokens: FakeRow[];
  sessions: FakeRow[];
}

const store: FakeStore = { users: [], password_reset_tokens: [], sessions: [] };

function resetStore() {
  store.users = [];
  store.password_reset_tokens = [];
  store.sessions = [];
}

function tableName(t: any): keyof FakeStore | "?" {
  if (!t || typeof t !== "object") return "?";
  if ("tokenHash" in t && "usedAt" in t) return "password_reset_tokens";
  if ("token" in t && "expiresAt" in t && !("tokenHash" in t)) return "sessions";
  if ("passwordHash" in t && "username" in t) return "users";
  return "?";
}

let _whereFilter: any = null;

function makeEq(lhs: any, rhs: any) {
  return { __op: "eq", lhs, rhs };
}

function colKey(lhs: any): string | null {
  if (!lhs || typeof lhs !== "object") return null;
  const name: string = lhs.name || "";
  const camel = name.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
  return camel || null;
}

function applyFilter(rows: FakeRow[], where: any): FakeRow[] {
  if (!where) return rows;
  const k = colKey(where.lhs);
  if (!k) return rows;
  return rows.filter((r) => r[k] === where.rhs);
}

const _inserted: { table: string; values: any }[] = [];

let _lastSelectTable: keyof FakeStore | "?" = "?";
let _lastUpdateTable: keyof FakeStore | "?" = "?";
let _lastDeleteTable: keyof FakeStore | "?" = "?";

const selectChain: any = {
  from(t: any) { _lastSelectTable = tableName(t); return selectChain; },
  where(w: any) { _whereFilter = w; return selectChain; },
  orderBy() { return selectChain; },
  async limit(_n: number) {
    const tbl = _lastSelectTable;
    const where = _whereFilter;
    _whereFilter = null;
    if (tbl === "?") return [];
    const rows = applyFilter(store[tbl] as FakeRow[], where);
    return rows.slice(0, _n);
  },
};

const fakeDb: any = {
  select(_s?: any) { return selectChain; },
  insert(t: any) {
    const tbl = tableName(t);
    return {
      async values(v: any) {
        const row = { ...v, id: v.id || crypto.randomUUID() };
        if (tbl !== "?") (store[tbl] as FakeRow[]).push(row);
        _inserted.push({ table: tbl, values: row });
        return { rows: [row] };
      },
      returning() {
        return {
          async values(v: any) {
            const row = { ...v, id: v.id || crypto.randomUUID() };
            if (tbl !== "?") (store[tbl] as FakeRow[]).push(row);
            _inserted.push({ table: tbl, values: row });
            return [row];
          },
        };
      },
    };
  },
  update(t: any) {
    _lastUpdateTable = tableName(t);
    return {
      set(s: any) {
        const tbl = _lastUpdateTable;
        return {
          async where(w: any) {
            if (tbl === "?") return;
            const rows = applyFilter(store[tbl] as FakeRow[], w);
            for (const r of rows) Object.assign(r, s);
          },
        };
      },
    };
  },
  delete(t: any) {
    _lastDeleteTable = tableName(t);
    return {
      async where(w: any) {
        const tbl = _lastDeleteTable;
        if (tbl === "?") return;
        const remaining = (store[tbl] as FakeRow[]).filter(
          (r) => !applyFilter([r], w).length
        );
        (store[tbl] as FakeRow[]).length = 0;
        (store[tbl] as FakeRow[]).push(...remaining);
      },
    };
  },
};

mock.module("../db", () => ({ ..._real_db, db: fakeDb }));

const _real_drizzle = await import("drizzle-orm");
mock.module("drizzle-orm", () => ({
  ..._real_drizzle,
  eq: (lhs: any, rhs: any) => makeEq(lhs, rhs),
}));

// ---------------------------------------------------------------------------
// Email seam
// ---------------------------------------------------------------------------

const _emails: { to: string; subject: string; text: string; html?: string }[] = [];

import {
  generateResetToken,
  createPasswordResetRequest,
  consumeResetToken,
  inspectResetToken,
  buildResetUrl,
  __setEmailForTests,
} from "../lib/password-reset";

__setEmailForTests((msg: any) => {
  _emails.push({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  return { ok: true, provider: "log" as const };
});

afterAll(() => {
  __setEmailForTests(null);
  mock.module("../db", () => _real_db);
  mock.module("drizzle-orm", () => _real_drizzle);
});

beforeEach(() => {
  resetStore();
  _inserted.length = 0;
  _emails.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function seedUser(overrides: Partial<FakeRow> = {}): FakeRow {
  const u: FakeRow = {
    id: crypto.randomUUID(),
    username: "ada",
    email: "ada@example.com",
    passwordHash: "$2b$10$oldhashplaceholder0123456789012345678901234567890123",
    updatedAt: new Date(),
    ...overrides,
  };
  store.users.push(u);
  return u;
}

// ---------------------------------------------------------------------------
// generateResetToken
// ---------------------------------------------------------------------------

describe("generateResetToken", () => {
  it("emits 64 hex chars of plaintext + a matching sha256 hash", async () => {
    const { plaintext, hash } = generateResetToken();
    expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex(plaintext));
  });

  it("emits unique plaintexts on repeated calls", () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

// ---------------------------------------------------------------------------
// createPasswordResetRequest
// ---------------------------------------------------------------------------

describe("createPasswordResetRequest", () => {
  it("creates a token row and queues an email for a known user", async () => {
    const u = seedUser({ email: "ada@example.com", username: "ada" });
    const res = await createPasswordResetRequest("ada@example.com", { requestIp: "127.0.0.1" });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 5));

    expect(store.password_reset_tokens.length).toBe(1);
    const row = store.password_reset_tokens[0]!;
    expect(row.userId).toBe(u.id);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt instanceof Date).toBe(true);
    expect(row.requestIp).toBe("127.0.0.1");

    expect(_emails.length).toBe(1);
    expect(_emails[0]!.to).toBe("ada@example.com");
    expect(_emails[0]!.subject).toBe("Reset your Gluecron password");
    expect(_emails[0]!.text).toContain("Hi ada,");
    expect(_emails[0]!.text).toContain("/reset-password?token=");
    expect(_emails[0]!.text).toContain("utm_source=password_reset");
    expect(_emails[0]!.html).toContain("Reset password");
  });

  it("returns ok for unknown emails (no enumeration) and does NOT create a token", async () => {
    const res = await createPasswordResetRequest("nobody@example.com");
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.password_reset_tokens.length).toBe(0);
    expect(_emails.length).toBe(0);
  });

  it("returns ok for garbage inputs without throwing", async () => {
    expect((await createPasswordResetRequest("")).ok).toBe(true);
    expect((await createPasswordResetRequest("not-an-email")).ok).toBe(true);
    expect(store.password_reset_tokens.length).toBe(0);
    expect(_emails.length).toBe(0);
  });

  it("normalizes email case before lookup", async () => {
    seedUser({ email: "ada@example.com", username: "ada" });
    const res = await createPasswordResetRequest("ADA@Example.COM");
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.password_reset_tokens.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// consumeResetToken
// ---------------------------------------------------------------------------

describe("consumeResetToken", () => {
  it("rejects garbage tokens with reason=invalid", async () => {
    const res = await consumeResetToken("not-a-real-token", "newpassword1");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid");
  });

  it("rejects an empty token", async () => {
    const res = await consumeResetToken("", "newpassword1");
    expect(res.ok).toBe(false);
  });

  it("rejects passwords shorter than 8 chars with reason=weak", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const res = await consumeResetToken(plaintext, "short");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("weak");
  });

  it("rejects expired tokens", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 60_000),
      usedAt: null,
    });
    const res = await consumeResetToken(plaintext, "longenoughpassword");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
  });

  it("rejects already-used tokens", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(Date.now() - 1000),
    });
    const res = await consumeResetToken(plaintext, "longenoughpassword");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("used");
  });

  it("happy path: rotates password hash, marks token used, drops sessions", async () => {
    const u = seedUser({ passwordHash: "OLD-HASH" });
    store.sessions.push({ id: crypto.randomUUID(), userId: u.id, token: "sess-1", expiresAt: new Date(Date.now() + 86_400_000) });
    store.sessions.push({ id: crypto.randomUUID(), userId: u.id, token: "sess-2", expiresAt: new Date(Date.now() + 86_400_000) });
    const other = seedUser({ username: "bob", email: "bob@example.com" });
    store.sessions.push({ id: crypto.randomUUID(), userId: other.id, token: "sess-other", expiresAt: new Date(Date.now() + 86_400_000) });

    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    const res = await consumeResetToken(plaintext, "brandnewpass");
    expect(res.ok).toBe(true);

    const updatedUser = store.users.find((r) => r.id === u.id)!;
    expect(updatedUser.passwordHash).not.toBe("OLD-HASH");
    expect(updatedUser.passwordHash).not.toBe("brandnewpass");
    expect(updatedUser.passwordHash.length).toBeGreaterThan(20);

    const tokenRow = store.password_reset_tokens[0]!;
    expect(tokenRow.usedAt instanceof Date).toBe(true);

    expect(store.sessions.filter((s) => s.userId === u.id).length).toBe(0);
    expect(store.sessions.filter((s) => s.userId === other.id).length).toBe(1);
  });

  it("a second consume of the same token is rejected as already used", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const first = await consumeResetToken(plaintext, "newpass-one");
    expect(first.ok).toBe(true);
    const second = await consumeResetToken(plaintext, "newpass-two");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("used");
  });
});

// ---------------------------------------------------------------------------
// inspectResetToken
// ---------------------------------------------------------------------------

describe("inspectResetToken", () => {
  it("reports valid for an unused, unexpired token", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const r = await inspectResetToken(plaintext);
    expect(r.valid).toBe(true);
  });

  it("reports invalid for an unknown token", async () => {
    const r = await inspectResetToken("not-a-real-token");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("invalid");
  });

  it("reports expired for an expired token", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
    });
    const r = await inspectResetToken(plaintext);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// buildResetUrl
// ---------------------------------------------------------------------------

describe("buildResetUrl", () => {
  it("includes the token and utm tag", () => {
    const u = buildResetUrl("abc123");
    expect(u).toContain("/reset-password?token=abc123");
    expect(u).toContain("utm_source=password_reset");
  });
});

// ---------------------------------------------------------------------------
// HTTP surface — pull in the app AFTER the module mocks are installed.
// ---------------------------------------------------------------------------

const app = (await import("../app")).default;

describe("GET /forgot-password", () => {
  it("renders the email-entry form with a CSRF input", async () => {
    const res = await app.request("/forgot-password");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Reset your password");
    expect(html).toContain('name="email"');
    expect(html).toContain('name="_csrf"');
    expect(html).toContain("Send reset link");
  });

  it("?sent=1 renders the generic success page", async () => {
    const res = await app.request("/forgot-password?sent=1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Check your inbox");
    expect(html).toContain("If we have an account");
  });
});

describe("POST /forgot-password", () => {
  it("always redirects to ?sent=1, regardless of whether the email exists", async () => {
    seedUser({ email: "ada@example.com" });
    const res1 = await app.request("/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ada@example.com" }),
    });
    expect(res1.status).toBe(302);
    expect(res1.headers.get("location")).toContain("/forgot-password?sent=1");

    const res2 = await app.request("/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ghost@example.com" }),
    });
    expect(res2.status).toBe(302);
    expect(res2.headers.get("location")).toContain("/forgot-password?sent=1");
  });
});

describe("GET /reset-password", () => {
  it("renders the form when the token is valid", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const res = await app.request(`/reset-password?token=${encodeURIComponent(plaintext)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Set a new password");
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirm"');
    expect(html).toContain('name="token"');
  });

  it("shows the dead-link page for unknown tokens", async () => {
    const res = await app.request("/reset-password?token=garbage");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This link is no longer valid");
    expect(html).toContain("/forgot-password");
  });

  it("shows the dead-link page for expired tokens", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 60_000),
      usedAt: null,
    });
    const res = await app.request(`/reset-password?token=${encodeURIComponent(plaintext)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This link is no longer valid");
  });

  it("shows the dead-link page when no token query is present", async () => {
    const res = await app.request("/reset-password");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This link is no longer valid");
  });
});

describe("POST /reset-password", () => {
  it("happy path: rotates password and redirects to /login?success=…", async () => {
    const u = seedUser({ passwordHash: "OLD" });
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    const res = await app.request("/reset-password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: plaintext,
        password: "newpassword12",
        confirm: "newpassword12",
      }),
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login");
    expect(loc).toContain("success=");

    const updated = store.users.find((r) => r.id === u.id)!;
    expect(updated.passwordHash).not.toBe("OLD");
  });

  it("password / confirm mismatch redirects back with an error", async () => {
    const u = seedUser();
    const { plaintext, hash } = generateResetToken();
    store.password_reset_tokens.push({
      id: crypto.randomUUID(),
      userId: u.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const res = await app.request("/reset-password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: plaintext,
        password: "newpassword12",
        confirm: "different12345",
      }),
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/reset-password");
    expect(loc).toContain("error=");
  });

  it("an invalid/used token renders the dead-link page", async () => {
    const res = await app.request("/reset-password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "not-a-real-token",
        password: "newpassword12",
        confirm: "newpassword12",
      }),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This link is no longer valid");
  });
});

// ---------------------------------------------------------------------------
// Rate limit — temporarily flip out of "test" env so the in-memory limiter
// is actually enforced.
// ---------------------------------------------------------------------------

describe("rate limit on /forgot-password", () => {
  const _origNodeEnv = process.env.NODE_ENV;
  const _origBunEnv = process.env.BUN_ENV;

  afterEach(() => {
    process.env.NODE_ENV = _origNodeEnv;
    process.env.BUN_ENV = _origBunEnv;
  });

  it("returns 429 after 5 requests inside the 60s window", async () => {
    process.env.NODE_ENV = "development";
    process.env.BUN_ENV = "development";

    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "203.0.113.55",
    } as Record<string, string>;
    const body = () => new URLSearchParams({ email: "ghost@example.com" });

    for (let i = 0; i < 5; i++) {
      const res = await app.request("/forgot-password", { method: "POST", headers, body: body() });
      expect(res.status).toBe(302);
    }
    const sixth = await app.request("/forgot-password", { method: "POST", headers, body: body() });
    expect(sixth.status).toBe(429);
  });
});

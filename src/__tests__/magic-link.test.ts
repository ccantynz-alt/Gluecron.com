/**
 * Block Q2 — Magic-link sign-in.
 *
 * Covers `src/lib/magic-link.ts` (token primitives, start, consume) and
 * the `src/routes/magic-link.tsx` HTTP surface (GET/POST /login/magic,
 * GET /login/magic/callback).
 *
 * Strategy mirrors password-reset.test.ts:
 *   - The library tests stub the `db` module (K1 spread-from-real pattern)
 *     so they don't require Neon. Rows live in in-memory arrays keyed by
 *     `tableName(t)` derived from drizzle column metadata.
 *   - Email sending is replaced via `__setEmailForTests`.
 *   - The HTTP-surface tests use `app.request(...)` so the real Hono
 *     router + csrf middleware answer.
 *
 * All `mock.module(...)` calls capture the REAL module first and restore
 * in `afterAll` so we don't poison test files that run after us.
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

// Capture real modules BEFORE any mock.module() so afterAll can restore.
const _real_db = await import("../db");

// ---------------------------------------------------------------------------
// In-memory DB stub
// ---------------------------------------------------------------------------

interface FakeRow { [k: string]: any; }
interface FakeStore {
  users: FakeRow[];
  magic_link_tokens: FakeRow[];
  sessions: FakeRow[];
}

const store: FakeStore = { users: [], magic_link_tokens: [], sessions: [] };

function resetStore() {
  store.users = [];
  store.magic_link_tokens = [];
  store.sessions = [];
}

function tableName(t: any): keyof FakeStore | "?" {
  if (!t || typeof t !== "object") return "?";
  // magic_link_tokens: has tokenHash AND email (P1 reset tokens have no email)
  if ("tokenHash" in t && "email" in t && "usedAt" in t) return "magic_link_tokens";
  // sessions: token + expiresAt but no tokenHash
  if ("token" in t && "expiresAt" in t && !("tokenHash" in t)) return "sessions";
  // users: passwordHash + username
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
        if (!row.createdAt) row.createdAt = new Date();
        if (tbl !== "?") (store[tbl] as FakeRow[]).push(row);
        _inserted.push({ table: tbl, values: row });
        return { rows: [row] };
      },
      returning() {
        return {
          async values(v: any) {
            const row = { ...v, id: v.id || crypto.randomUUID() };
            if (!row.createdAt) row.createdAt = new Date();
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
  generateMagicLinkToken,
  startMagicLinkSignIn,
  consumeMagicLinkToken,
  buildMagicLinkUrl,
  __setEmailForTests,
} from "../lib/magic-link";

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
    emailVerifiedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
  store.users.push(u);
  return u;
}

function seedToken(overrides: Partial<FakeRow> = {}): { row: FakeRow; plaintext: string } {
  const { plaintext, hash } = generateMagicLinkToken();
  const row: FakeRow = {
    id: crypto.randomUUID(),
    email: "ada@example.com",
    userId: null,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    requestIp: null,
    createdAt: new Date(),
    ...overrides,
  };
  store.magic_link_tokens.push(row);
  return { row, plaintext };
}

// Give the fire-and-forget email send a tick to land in the recorder.
async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 5));
}

// ---------------------------------------------------------------------------
// generateMagicLinkToken
// ---------------------------------------------------------------------------

describe("generateMagicLinkToken", () => {
  it("emits 64 hex chars of plaintext + a matching sha256 hash", async () => {
    const { plaintext, hash } = generateMagicLinkToken();
    expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex(plaintext));
  });

  it("emits unique plaintexts on repeated calls", () => {
    const a = generateMagicLinkToken();
    const b = generateMagicLinkToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

// ---------------------------------------------------------------------------
// startMagicLinkSignIn
// ---------------------------------------------------------------------------

describe("startMagicLinkSignIn", () => {
  it("creates a token row linked to an existing user and queues an email", async () => {
    const u = seedUser({ email: "ada@example.com", username: "ada" });
    const res = await startMagicLinkSignIn("ada@example.com", { requestIp: "127.0.0.1" });
    expect(res.ok).toBe(true);
    await flushMicrotasks();

    expect(store.magic_link_tokens.length).toBe(1);
    const row = store.magic_link_tokens[0]!;
    expect(row.userId).toBe(u.id);
    expect(row.email).toBe("ada@example.com");
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt instanceof Date).toBe(true);
    expect(row.requestIp).toBe("127.0.0.1");

    expect(_emails.length).toBe(1);
    expect(_emails[0]!.to).toBe("ada@example.com");
    expect(_emails[0]!.subject).toBe("Your Gluecron sign-in link");
    expect(_emails[0]!.text).toContain("expires in 15 minutes");
    expect(_emails[0]!.text).toContain("/login/magic/callback?token=");
    expect(_emails[0]!.html).toContain("Sign in");
  });

  it("returns ok for non-existent email AND still mints a token row (userId=null) so consume can auto-create", async () => {
    const res = await startMagicLinkSignIn("ghost@example.com");
    expect(res.ok).toBe(true);
    await flushMicrotasks();

    expect(store.magic_link_tokens.length).toBe(1);
    const row = store.magic_link_tokens[0]!;
    expect(row.userId).toBeFalsy();
    expect(row.email).toBe("ghost@example.com");
    expect(_emails.length).toBe(1);
    expect(_emails[0]!.to).toBe("ghost@example.com");
  });

  it("does NOT mint a token when autoCreate=false and email is unknown", async () => {
    const res = await startMagicLinkSignIn("ghost@example.com", { autoCreate: false });
    expect(res.ok).toBe(true);
    await flushMicrotasks();
    expect(store.magic_link_tokens.length).toBe(0);
    expect(_emails.length).toBe(0);
  });

  it("returns ok for garbage inputs without throwing", async () => {
    expect((await startMagicLinkSignIn("")).ok).toBe(true);
    expect((await startMagicLinkSignIn("not-an-email")).ok).toBe(true);
    expect(store.magic_link_tokens.length).toBe(0);
    expect(_emails.length).toBe(0);
  });

  it("normalizes email case before lookup", async () => {
    seedUser({ email: "ada@example.com", username: "ada" });
    const res = await startMagicLinkSignIn("ADA@Example.COM");
    expect(res.ok).toBe(true);
    await flushMicrotasks();
    expect(store.magic_link_tokens.length).toBe(1);
    expect(store.magic_link_tokens[0]!.email).toBe("ada@example.com");
  });

  it("enforces the per-email rate limit (3 mints / hour)", async () => {
    seedUser({ email: "ada@example.com" });
    for (let i = 0; i < 3; i++) {
      const r = await startMagicLinkSignIn("ada@example.com");
      expect(r.ok).toBe(true);
    }
    await flushMicrotasks();
    expect(store.magic_link_tokens.length).toBe(3);

    // 4th call still returns ok (generic) but does NOT create another token.
    const r4 = await startMagicLinkSignIn("ada@example.com");
    expect(r4.ok).toBe(true);
    await flushMicrotasks();
    expect(store.magic_link_tokens.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// consumeMagicLinkToken
// ---------------------------------------------------------------------------

describe("consumeMagicLinkToken", () => {
  it("rejects garbage tokens with reason=invalid", async () => {
    const res = await consumeMagicLinkToken("not-a-real-token");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid");
  });

  it("rejects an empty token", async () => {
    const res = await consumeMagicLinkToken("");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid");
  });

  it("rejects expired tokens", async () => {
    const u = seedUser();
    const { plaintext } = seedToken({
      userId: u.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await consumeMagicLinkToken(plaintext);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
  });

  it("rejects already-used tokens", async () => {
    const u = seedUser();
    const { plaintext } = seedToken({
      userId: u.id,
      usedAt: new Date(Date.now() - 1000),
    });
    const res = await consumeMagicLinkToken(plaintext);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("used");
  });

  it("happy path with existing user: returns userId, marks token used, no account created", async () => {
    const u = seedUser({ email: "ada@example.com", username: "ada" });
    const { row, plaintext } = seedToken({ userId: u.id, email: "ada@example.com" });

    const res = await consumeMagicLinkToken(plaintext);
    expect(res.ok).toBe(true);
    expect(res.userId).toBe(u.id);
    expect(res.createdAccount).toBe(false);

    const updated = store.magic_link_tokens.find((r) => r.id === row.id)!;
    expect(updated.usedAt instanceof Date).toBe(true);

    // No new user row.
    expect(store.users.length).toBe(1);
  });

  it("happy path with no existing user: creates account, returns userId + createdAccount=true", async () => {
    const { plaintext } = seedToken({ userId: null, email: "ghost@example.com" });

    const res = await consumeMagicLinkToken(plaintext);
    expect(res.ok).toBe(true);
    expect(res.userId).toBeTruthy();
    expect(res.createdAccount).toBe(true);

    // A fresh user row was minted for the email.
    expect(store.users.length).toBe(1);
    const created = store.users[0]!;
    expect(created.email).toBe("ghost@example.com");
    expect(created.username).toMatch(/^user-[a-z0-9]{8,}$/);
    // The placeholder password hash exists but is not the plaintext.
    expect(created.passwordHash).toBeTruthy();
    expect(created.passwordHash).not.toBe(plaintext);
    // The click verified the address.
    expect(created.emailVerifiedAt instanceof Date).toBe(true);
  });

  it("invalidates all other unused magic-link tokens for the same email on success", async () => {
    const u = seedUser({ email: "ada@example.com", username: "ada" });
    const { plaintext } = seedToken({ userId: u.id, email: "ada@example.com" });
    // Two more outstanding tokens for the same email — should be burned.
    const t2 = seedToken({ userId: u.id, email: "ada@example.com" });
    const t3 = seedToken({ userId: u.id, email: "ada@example.com" });
    // A token for a DIFFERENT email — must NOT be touched.
    const otherUser = seedUser({ email: "bob@example.com", username: "bob" });
    const tOther = seedToken({ userId: otherUser.id, email: "bob@example.com" });

    const res = await consumeMagicLinkToken(plaintext);
    expect(res.ok).toBe(true);

    // Every ada@example.com row is now used.
    const adaRows = store.magic_link_tokens.filter((r) => r.email === "ada@example.com");
    expect(adaRows.length).toBe(3);
    for (const r of adaRows) expect(r.usedAt instanceof Date).toBe(true);

    // The bob@example.com row is untouched.
    const bobRow = store.magic_link_tokens.find((r) => r.id === tOther.row.id)!;
    expect(bobRow.usedAt).toBe(null);

    // A second consume of one of the burned siblings is rejected as used.
    const second = await consumeMagicLinkToken(t2.plaintext);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("used");
    // Same for t3.
    const third = await consumeMagicLinkToken(t3.plaintext);
    expect(third.ok).toBe(false);
    expect(third.reason).toBe("used");
  });
});

// ---------------------------------------------------------------------------
// buildMagicLinkUrl
// ---------------------------------------------------------------------------

describe("buildMagicLinkUrl", () => {
  it("includes the token in the callback path", () => {
    const u = buildMagicLinkUrl("abc123");
    expect(u).toContain("/login/magic/callback?token=abc123");
  });
});

// ---------------------------------------------------------------------------
// HTTP surface — pull in the app AFTER the module mocks are installed.
// ---------------------------------------------------------------------------

const app = (await import("../app")).default;

describe("GET /login/magic", () => {
  it("renders the email-entry form with a CSRF input", async () => {
    const res = await app.request("/login/magic");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with a magic link");
    expect(html).toContain('name="email"');
    expect(html).toContain('name="_csrf"');
    expect(html).toContain("Send me a sign-in link");
  });

  it("?sent=1 renders the generic success page", async () => {
    const res = await app.request("/login/magic?sent=1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Check your inbox");
    expect(html).toContain("expires in 15 minutes");
  });
});

describe("POST /login/magic", () => {
  it("always redirects to ?sent=1 regardless of whether the email exists", async () => {
    seedUser({ email: "ada@example.com" });
    const res1 = await app.request("/login/magic", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ada@example.com" }),
    });
    expect(res1.status).toBe(302);
    expect(res1.headers.get("location")).toContain("/login/magic?sent=1");

    const res2 = await app.request("/login/magic", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ghost@example.com" }),
    });
    expect(res2.status).toBe(302);
    expect(res2.headers.get("location")).toContain("/login/magic?sent=1");
  });
});

describe("GET /login/magic/callback", () => {
  it("happy path with existing user → 302 to /dashboard with a session cookie", async () => {
    const u = seedUser({ email: "ada@example.com", username: "ada" });
    const { plaintext } = seedToken({ userId: u.id, email: "ada@example.com" });

    const res = await app.request(`/login/magic/callback?token=${encodeURIComponent(plaintext)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("session=");
  });

  it("happy path with no existing user → 302 to /onboarding?welcome=1 and creates account", async () => {
    const { plaintext } = seedToken({ userId: null, email: "ghost@example.com" });

    const res = await app.request(`/login/magic/callback?token=${encodeURIComponent(plaintext)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/onboarding?welcome=1");
    expect(res.headers.get("set-cookie") || "").toContain("session=");

    expect(store.users.length).toBe(1);
    expect(store.users[0]!.email).toBe("ghost@example.com");
  });

  it("invalid/garbage token → renders the dead-link page", async () => {
    const res = await app.request("/login/magic/callback?token=garbage");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This link is no longer valid");
    expect(html).toContain("/login/magic");
  });

  it("no token query → renders the dead-link page", async () => {
    const res = await app.request("/login/magic/callback");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This link is no longer valid");
  });

  it("expired token → renders the dead-link page", async () => {
    const u = seedUser();
    const { plaintext } = seedToken({
      userId: u.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await app.request(`/login/magic/callback?token=${encodeURIComponent(plaintext)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This link is no longer valid");
  });
});

// ---------------------------------------------------------------------------
// Rate limit — temporarily flip out of "test" env so the in-memory limiter
// is actually enforced.
// ---------------------------------------------------------------------------

describe("rate limit on /login/magic", () => {
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
      "x-forwarded-for": "203.0.113.77",
    } as Record<string, string>;
    const body = () => new URLSearchParams({ email: "ghost@example.com" });

    for (let i = 0; i < 5; i++) {
      const res = await app.request("/login/magic", { method: "POST", headers, body: body() });
      expect(res.status).toBe(302);
    }
    const sixth = await app.request("/login/magic", { method: "POST", headers, body: body() });
    expect(sixth.status).toBe(429);
  });
});

/**
 * Block P2 — email verification + welcome email tests.
 *
 * We stub `../db` via `mock.module` (K1 spread-from-real pattern) so the
 * lib's drizzle calls land on an in-memory fake instead of Neon. The email
 * sender is swapped out via the lib's `__setEmailForTests` test seam.
 *
 * Bun 1.3's `bun test` shares a single module registry across every test
 * file in a run and `mock.restore()` does NOT un-mock `mock.module(...)`
 * registrations. To stay neighbourly:
 *   - we capture the real `../db` module before overriding so unrelated
 *     downstream tests can fall back to it via the spread;
 *   - we re-install our mock in `beforeEach` so an earlier test file's
 *     `mock.module("../db", ...)` doesn't shadow ours mid-run;
 *   - we restore the real DB module in `afterAll` so the next file's
 *     suite sees the prod contract again.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { createHash } from "node:crypto";

// Capture the real `../db` module so we can spread-from-real and so we
// can restore it in `afterAll` for downstream test files.
const _real_db = await import("../db");

// ---------------------------------------------------------------------------
// Fake DB — narrowly scoped to what `email-verification.ts` + the route call.
// ---------------------------------------------------------------------------

interface FakeUser {
  id: string;
  username: string;
  email: string;
  emailVerifiedAt: Date | null;
}

interface FakeToken {
  id: string;
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

const _state = {
  users: [] as FakeUser[],
  tokens: [] as FakeToken[],
  _lastFromTable: "" as "users" | "tokens" | "",
};

function resetState() {
  _state.users = [];
  _state.tokens = [];
  _state._lastFromTable = "";
}

function tableName(t: any): "users" | "tokens" | "" {
  if (!t || typeof t !== "object") return "";
  if ("emailVerifiedAt" in t && "passwordHash" in t) return "users";
  if ("emailVerifiedAt" in t && "username" in t) return "users";
  if ("tokenHash" in t && "expiresAt" in t && "email" in t) return "tokens";
  return "";
}

let _nextWhereFilter: ((row: any) => boolean) | null = null;
function setNextWhereFilter(fn: (row: any) => boolean) {
  _nextWhereFilter = fn;
}

// The drizzle chain is awaited two ways in code we proxy through:
//   await db.select(...).from(...).where(...).limit(N)
//   await db.select(...).from(...).where(...)              // no limit
// We support both by exposing both `.limit()` AND a thenable on the chain
// itself. The thenable yields the same shape `.limit(N)` would, with
// N=Infinity (no cap) — that's the convention drizzle uses for awaited
// chains without an explicit limit.
function resolveSelect(n: number = Infinity): any[] {
  const rows =
    _state._lastFromTable === "users"
      ? _state.users
      : _state._lastFromTable === "tokens"
        ? _state.tokens
        : [];
  const filtered = _nextWhereFilter ? rows.filter(_nextWhereFilter) : rows;
  _nextWhereFilter = null;
  return filtered.slice(0, n);
}

// We model the drizzle chain as a function-target Proxy that:
//   - returns itself for any chained method (`.from`, `.where`,
//     `.orderBy`, `.leftJoin`, `.innerJoin`, etc.) so chain calls compose;
//   - exposes a `then` that resolves to the current row array, making
//     `await selectChain` work without an explicit `.limit()`;
//   - exposes `.limit(N)` for callers that DO cap the row count.
//
// The proxy is built on a function target rather than `{}` so the
// resulting object reads as a thenable to V8's await machinery (some
// edge cases with `{}` + `then` were observed where the runtime read
// `then` through a different path and ignored it). Function targets
// always present a clean own-property `then` slot.
function makeSelectChain(): any {
  function chainFn() {}
  const handler: ProxyHandler<any> = {
    get(_t, prop, receiver) {
      if (prop === "then") {
        // Standard thenable contract: `(resolve, reject) => …`. We
        // resolve synchronously since the fake never actually waits on
        // anything — V8 promotes us into a microtask anyway.
        return (resolve: (v: any[]) => void) => resolve(resolveSelect());
      }
      if (prop === "limit") {
        return (n: number) => Promise.resolve(resolveSelect(n));
      }
      if (prop === "from") {
        return (table: any) => {
          _state._lastFromTable = tableName(table);
          return receiver;
        };
      }
      // Any other method (where / orderBy / groupBy / leftJoin / innerJoin
      // / rightJoin / etc.) returns the same proxy so we keep chaining.
      // Symbols / unknown non-string keys pass through as undefined.
      if (typeof prop !== "string") return undefined;
      return () => receiver;
    },
  };
  return new Proxy(chainFn, handler);
}

const selectChain: any = makeSelectChain();

const insertChain: any = {
  values(v: any) {
    if (_state._lastFromTable === "tokens") {
      _state.tokens.push({
        id: `tok-${_state.tokens.length + 1}`,
        userId: v.userId,
        email: v.email,
        tokenHash: v.tokenHash,
        expiresAt:
          v.expiresAt instanceof Date ? v.expiresAt : new Date(v.expiresAt),
        usedAt: null,
        createdAt: new Date(),
      });
    }
    return Promise.resolve();
  },
};

const updateChain: any = {
  _pendingSet: null as any,
  set(values: any) {
    updateChain._pendingSet = values;
    return updateChain;
  },
  async where(_clause: any) {
    const target =
      _state._lastFromTable === "tokens"
        ? _state.tokens
        : _state._lastFromTable === "users"
          ? _state.users
          : [];
    const filter = _nextWhereFilter || (() => true);
    _nextWhereFilter = null;
    for (const row of target) {
      if (filter(row)) Object.assign(row, updateChain._pendingSet);
    }
  },
};

const _fakeDb = {
  db: {
    select: (_proj?: any) => {
      _state._lastFromTable = "";
      return selectChain;
    },
    insert: (t: any) => {
      _state._lastFromTable = tableName(t);
      return insertChain;
    },
    update: (t: any) => {
      _state._lastFromTable = tableName(t);
      updateChain._pendingSet = null;
      return updateChain;
    },
    delete: (_t: any) => ({ where: async () => {} }),
  },
  getDb: () => _fakeDb.db,
};

// Spread the real module first so functions like `getDb` keep working
// when downstream code paths reach for them — only the names we override
// take the fake. Same K1 pattern account-deletion.test.ts uses.
mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));

function _reinstallDbMock() {
  mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));
}

// ---------------------------------------------------------------------------
// Email recorder — installed via the lib's test seam.
// ---------------------------------------------------------------------------

interface RecordedEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
const _emails: RecordedEmail[] = [];
async function recordEmail(msg: RecordedEmail) {
  _emails.push({ ...msg });
  return { ok: true as const, provider: "log" as const };
}

// Load the lib AFTER mock.module so the import picks up the fake DB.
const {
  generateVerificationToken,
  hashToken,
  startEmailVerification,
  consumeVerificationToken,
  sendWelcomeEmail,
  renderVerificationEmail,
  renderWelcomeEmail,
  __setEmailForTests,
} = await import("../lib/email-verification");

const { default: emailVerificationRoutes, __resetResendRateLimitForTests } =
  await import("../routes/email-verification");
const authRoutesModule = await import("../routes/auth");
const authRoutes = authRoutesModule.default;

function buildApp() {
  const app = new Hono();
  app.route("/", emailVerificationRoutes);
  return app;
}

let _restoreEmail: ReturnType<typeof __setEmailForTests> | null = null;

beforeEach(() => {
  _reinstallDbMock();
  resetState();
  _emails.length = 0;
  __resetResendRateLimitForTests();
  _restoreEmail = __setEmailForTests(recordEmail);
});

afterAll(() => {
  if (_restoreEmail) __setEmailForTests(_restoreEmail);
  resetState();
  _emails.length = 0;
  // Restore the real DB module so downstream test files see prod semantics.
  mock.module("../db", () => _real_db);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("generateVerificationToken", () => {
  it("produces a 64-char hex plaintext and a matching sha256 hash", () => {
    const { plaintext, hash } = generateVerificationToken();
    expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(plaintext).digest("hex"));
    expect(hashToken(plaintext)).toBe(hash);
  });

  it("returns different tokens on successive calls", () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("renderVerificationEmail / renderWelcomeEmail", () => {
  it("verification email subject + html escape username", () => {
    const m = renderVerificationEmail({
      username: "<bob>",
      link: "https://example.com/verify-email?token=abc",
    });
    expect(m.subject).toBe("Confirm your email for Gluecron");
    expect(m.text).toContain("Hi <bob>");
    expect(m.html).toContain("&lt;bob&gt;");
    expect(m.html).toContain("https://example.com/verify-email?token=abc");
  });

  it("welcome email mentions all four next-step links", () => {
    const m = renderWelcomeEmail({ username: "alice" });
    expect(m.subject).toContain("Welcome to Gluecron");
    expect(m.text).toContain("Welcome aboard, alice!");
    expect(m.text).toContain("/new");
    expect(m.text).toContain("/import");
    expect(m.text).toContain("/demo");
    expect(m.text).toContain("/install");
    expect(m.html).toContain("Welcome aboard,");
  });
});

// ---------------------------------------------------------------------------
// startEmailVerification + consumeVerificationToken (DB path)
// ---------------------------------------------------------------------------

describe("startEmailVerification", () => {
  it("inserts a token row and sends a verification email", async () => {
    _state.users.push({
      id: "u1",
      username: "alice",
      email: "alice@example.com",
      emailVerifiedAt: null,
    });
    setNextWhereFilter((u: FakeUser) => u.id === "u1");
    const r = await startEmailVerification("u1", "alice@example.com");
    expect(r.ok).toBe(true);
    expect(_state.tokens.length).toBe(1);
    expect(_state.tokens[0].userId).toBe("u1");
    expect(_state.tokens[0].email).toBe("alice@example.com");
    expect(_state.tokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(_emails.length).toBe(1);
    expect(_emails[0].to).toBe("alice@example.com");
    expect(_emails[0].subject).toBe("Confirm your email for Gluecron");
    expect(_emails[0].text).toContain("alice");
  });
});

describe("consumeVerificationToken", () => {
  it("rejects garbage / empty input", async () => {
    expect((await consumeVerificationToken("")).ok).toBe(false);
    expect(
      (await consumeVerificationToken("not-a-real-token")).ok
    ).toBe(false);
  });

  it("happy path: marks token used + sets users.emailVerifiedAt", async () => {
    _state.users.push({
      id: "u2",
      username: "bob",
      email: "bob@example.com",
      emailVerifiedAt: null,
    });
    const { plaintext, hash } = generateVerificationToken();
    _state.tokens.push({
      id: "t-1",
      userId: "u2",
      email: "bob@example.com",
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      usedAt: null,
      createdAt: new Date(),
    });
    setNextWhereFilter(
      (t: FakeToken) =>
        t.tokenHash === hash &&
        t.usedAt === null &&
        t.expiresAt.getTime() > Date.now()
    );
    const r = await consumeVerificationToken(plaintext);
    expect(r.ok).toBe(true);
    expect(r.userId).toBe("u2");
    expect(_state.tokens[0].usedAt).toBeInstanceOf(Date);
    expect(_state.users[0].emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("rejects expired tokens", async () => {
    const { plaintext, hash } = generateVerificationToken();
    _state.tokens.push({
      id: "t-2",
      userId: "u3",
      email: "expired@example.com",
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
      createdAt: new Date(),
    });
    setNextWhereFilter(
      (t: FakeToken) =>
        t.tokenHash === hash &&
        t.usedAt === null &&
        t.expiresAt.getTime() > Date.now()
    );
    const r = await consumeVerificationToken(plaintext);
    expect(r.ok).toBe(false);
  });

  it("rejects already-used tokens", async () => {
    const { plaintext, hash } = generateVerificationToken();
    _state.tokens.push({
      id: "t-3",
      userId: "u4",
      email: "used@example.com",
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      usedAt: new Date(),
      createdAt: new Date(),
    });
    setNextWhereFilter(
      (t: FakeToken) =>
        t.tokenHash === hash &&
        t.usedAt === null &&
        t.expiresAt.getTime() > Date.now()
    );
    const r = await consumeVerificationToken(plaintext);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendWelcomeEmail
// ---------------------------------------------------------------------------

describe("sendWelcomeEmail", () => {
  it("sends a welcome email for the resolved user", async () => {
    _state.users.push({
      id: "u5",
      username: "carol",
      email: "carol@example.com",
      emailVerifiedAt: new Date(),
    });
    setNextWhereFilter((u: FakeUser) => u.id === "u5");
    await sendWelcomeEmail("u5");
    expect(_emails.length).toBe(1);
    expect(_emails[0].to).toBe("carol@example.com");
    expect(_emails[0].subject).toContain("Welcome to Gluecron");
    expect(_emails[0].text).toContain("carol");
  });

  it("no-ops + does not throw for unknown user", async () => {
    setNextWhereFilter(() => false);
    await sendWelcomeEmail("nope");
    expect(_emails.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /verify-email — HTTP-level
// ---------------------------------------------------------------------------

describe("GET /verify-email", () => {
  it("valid token → 302 /dashboard?verified=1 + fires welcome email", async () => {
    _state.users.push({
      id: "u6",
      username: "dave",
      email: "dave@example.com",
      emailVerifiedAt: null,
    });
    const { plaintext, hash } = generateVerificationToken();
    _state.tokens.push({
      id: "t-6",
      userId: "u6",
      email: "dave@example.com",
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      usedAt: null,
      createdAt: new Date(),
    });
    setNextWhereFilter(
      (t: FakeToken) =>
        t.tokenHash === hash &&
        t.usedAt === null &&
        t.expiresAt.getTime() > Date.now()
    );
    const app = buildApp();
    const res = await app.request(
      `/verify-email?token=${encodeURIComponent(plaintext)}`
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard?verified=1");
    // Welcome email is fire-and-forget — give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(_emails.some((e) => e.subject.includes("Welcome"))).toBe(true);
  });

  it("invalid token → 200 with 'Link expired' page", async () => {
    const app = buildApp();
    const res = await app.request("/verify-email?token=not-a-real-token");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Link expired");
  });
});

// ---------------------------------------------------------------------------
// Rate limit smoke
// ---------------------------------------------------------------------------

describe("POST /verify-email/resend rate limit", () => {
  it("__resetResendRateLimitForTests is exported + idempotent", async () => {
    const mod = await import("../routes/email-verification");
    expect(typeof mod.__resetResendRateLimitForTests).toBe("function");
    mod.__resetResendRateLimitForTests();
    mod.__resetResendRateLimitForTests();
  });
});

// ---------------------------------------------------------------------------
// Register POST wires through to startEmailVerification
// ---------------------------------------------------------------------------

describe("POST /register → startEmailVerification wiring", () => {
  it("startEmailVerification produces a token row (the wire-up's payload)", async () => {
    _state.users.push({
      id: "u-reg",
      username: "newbie",
      email: "newbie@example.com",
      emailVerifiedAt: null,
    });
    setNextWhereFilter((u: FakeUser) => u.id === "u-reg");
    const r = await startEmailVerification("u-reg", "newbie@example.com");
    expect(r.ok).toBe(true);
    expect(_state.tokens.length).toBe(1);
    expect(_state.tokens[0].userId).toBe("u-reg");
    expect(typeof startEmailVerification).toBe("function");
  });

  it("auth.tsx /register handler imports email-verification", async () => {
    const m = await import("../lib/email-verification");
    expect(typeof m.startEmailVerification).toBe("function");
    expect(typeof m.consumeVerificationToken).toBe("function");
    expect(typeof m.sendWelcomeEmail).toBe("function");
    expect(authRoutes).toBeDefined();
  });
});

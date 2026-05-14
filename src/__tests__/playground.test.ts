/**
 * Block Q3 — Anonymous playground tests.
 *
 * Strategy mirrors `account-deletion.test.ts`:
 *   - Spread-from-real `../db` mock so other test files keep working;
 *   - In-memory `users` / `sessions` / `repositories` / `issues` /
 *     `labels` / `audit_log` tables;
 *   - Real `audit()` + real `email-verification.startEmailVerification`
 *     run against our stub (both swallow DB errors);
 *   - `initBareRepo` + bare-git plumbing are stubbed at the
 *     `../git/repository` module boundary so a clean test directory
 *     doesn't need git installed (and so the suite is hermetic).
 *
 * Bun's `mock.module(...)` is process-global; we `mock.module("../db", _real_db)`
 * in `afterAll` so downstream files see the real binding again.
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterAll,
} from "bun:test";

// Point the real `initBareRepo` at a hermetic per-process tmp dir so
// the test doesn't litter `./repos/` with `guest-*` subdirs. Set
// BEFORE importing `../db` (and downstream `../lib/playground`).
process.env.GIT_REPOS_PATH = `/tmp/playground-test-${process.pid}-${Date.now()}`;

const _real_db = await import("../db");
const _real_notify = await import("../lib/notify");
const _real_email_verification = await import("../lib/email-verification");

// ---------------------------------------------------------------------------
// Fake DB state
// ---------------------------------------------------------------------------

interface FakeUser {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  isPlayground: boolean;
  playgroundExpiresAt: Date | null;
  emailVerifiedAt: Date | null;
  [k: string]: any;
}
interface FakeSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}
interface FakeRepo {
  id: string;
  name: string;
  ownerId: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  diskPath: string;
}
interface FakeIssue {
  id: string;
  repositoryId: string;
  authorId: string;
  title: string;
  body: string | null;
  state: string;
}
interface FakeLabel {
  id: string;
  repositoryId: string;
  name: string;
  color: string;
  description: string | null;
}
interface FakeIssueLabel {
  id: string;
  issueId: string;
  labelId: string;
}

const _state = {
  users: [] as FakeUser[],
  sessions: [] as FakeSession[],
  repositories: [] as FakeRepo[],
  issues: [] as FakeIssue[],
  labels: [] as FakeLabel[],
  issueLabels: [] as FakeIssueLabel[],
  auditInserts: [] as any[],
};

function resetState() {
  _state.users = [];
  _state.sessions = [];
  _state.repositories = [];
  _state.issues = [];
  _state.labels = [];
  _state.issueLabels = [];
  _state.auditInserts = [];
}

// The columns we discriminate on for table identity. Test-friendly only.
function tableName(t: any): string {
  if (!t || typeof t !== "object") return "?";
  if ("isPlayground" in t && "passwordHash" in t) return "users";
  if ("token" in t && "expiresAt" in t && "userId" in t) return "sessions";
  if ("ownerId" in t && "diskPath" in t) return "repositories";
  if ("state" in t && "repositoryId" in t && "title" in t) return "issues";
  if ("color" in t && "repositoryId" in t && "name" in t) return "labels";
  if ("issueId" in t && "labelId" in t) return "issue_labels";
  if ("action" in t && "targetType" in t) return "audit_log";
  return "?";
}

// Per-query where predicate. Each `select()` resets it; subsequent
// `where(...)` calls install it; subsequent `limit()` / await consumes
// it. The predicate is built by interpreting drizzle's `eq(col, val)`
// expression's exposed `queryChunks` (a public-ish field that holds
// SQL fragments + column refs + value literals in order). Good enough
// for the simple where clauses our code emits.
let _whereFn: ((row: any) => boolean) | null = null;
function clearWhereFn() { _whereFn = null; }

function predicateFromExpr(expr: any): ((row: any) => boolean) | null {
  if (!expr || typeof expr !== "object") return null;
  const chunks: any[] = expr.queryChunks;
  if (!Array.isArray(chunks)) return null;

  // Detect a "leaf" comparison: chunks = [SQL[""], Column, SQL[op], (value?), SQL[""]]
  let colChunk: any = null;
  let opStr = "";
  let valChunk: any = undefined;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c && typeof c === "object" && "name" in c && c.name && !c.queryChunks) {
      colChunk = c;
      // op is the next sql chunk
      const op = chunks[i + 1];
      if (op && Array.isArray((op as any).value)) {
        opStr = String((op as any).value[0] || "").trim().toLowerCase();
      }
      // value (for binary ops) is the chunk after the op
      if (opStr !== "is not null") {
        valChunk = chunks[i + 2];
      }
      break;
    }
  }

  if (colChunk) {
    const camel = String(colChunk.name).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (opStr === "is not null") {
      return (row: any) => row[camel] !== null && row[camel] !== undefined;
    }
    // Drizzle wraps parameter values in a Param object whose plain
    // .value field exposes the raw JS value. SQL-chunk objects ALSO
    // expose .value (an array of SQL fragments) — so unwrap only when
    // value is not an array.
    const rawVal =
      valChunk && typeof valChunk === "object" && "value" in valChunk && !Array.isArray((valChunk as any).value)
        ? (valChunk as any).value
        : valChunk;
    if (opStr === "<") {
      return (row: any) =>
        row[camel] !== null && row[camel] !== undefined && row[camel] < rawVal;
    }
    if (opStr === ">") {
      return (row: any) =>
        row[camel] !== null && row[camel] !== undefined && row[camel] > rawVal;
    }
    // Default: equality (handles "=").
    return (row: any) => {
      const v = row[camel];
      if (v instanceof Date && rawVal instanceof Date) {
        return v.getTime() === rawVal.getTime();
      }
      return v === rawVal;
    };
  }

  // Compound expression — recurse over nested EXPR chunks and AND them
  // together. Drizzle's `and()` wraps its operands as EXPR queryChunks
  // with `" and "` SQL separators; `or()` similarly.
  const sub: Array<(row: any) => boolean> = [];
  let connector: "and" | "or" = "and";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as any).value)) {
      const s = String((c as any).value[0] || "").trim().toLowerCase();
      if (s === "or") connector = "or";
    }
    if (c && typeof c === "object" && Array.isArray(c.queryChunks)) {
      const fn = predicateFromExpr(c);
      if (fn) sub.push(fn);
    }
  }
  if (sub.length === 0) return null;
  if (connector === "or") {
    return (row: any) => sub.some((p) => p(row));
  }
  return (row: any) => sub.every((p) => p(row));
}

function predicateFromChunks(chunks: any[]): ((row: any) => boolean) | null {
  return predicateFromExpr({ queryChunks: chunks });
}

function rowsForTable(table: string): any[] {
  switch (table) {
    case "users": return _state.users;
    case "sessions": return _state.sessions;
    case "repositories": return _state.repositories;
    case "issues": return _state.issues;
    case "labels": return _state.labels;
    case "issue_labels": return _state.issueLabels;
    default: return [];
  }
}

let _lastFromTable = "?";

function collectSelect(cap?: number): any[] {
  let rows = rowsForTable(_lastFromTable);
  if (_whereFn) rows = rows.filter(_whereFn);
  clearWhereFn();
  if (cap !== undefined) rows = rows.slice(0, cap);
  return rows;
}

function makeSelectChain(): any {
  const chain: any = {
    limit: (cap?: number) => Promise.resolve(collectSelect(cap)),
    offset: () => chain,
    orderBy: () => chain,
    then: (resolve: (v: any) => void) => resolve(collectSelect()),
  };
  return new Proxy(chain, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      return (...args: any[]) => {
        if (prop === "from" && args[0]) _lastFromTable = tableName(args[0]);
        if (prop === "where" && args[0]) {
          const expr = args[0];
          if (expr && expr.queryChunks) {
            const fn = predicateFromChunks(expr.queryChunks);
            if (fn) _whereFn = fn;
          }
        }
        return proxy;
      };
    },
  });
}
const proxy = makeSelectChain();

function makeUpdateChain(table: any) {
  const name = tableName(table);
  return {
    set: (vals: any) => ({
      where: (expr: any) => {
        let fn: ((row: any) => boolean) | null = null;
        if (expr && expr.queryChunks) {
          fn = predicateFromChunks(expr.queryChunks);
        }
        return {
          returning: () => {
            const rows = rowsForTable(name);
            const matched = fn ? rows.filter(fn) : rows;
            for (const r of matched) Object.assign(r, vals);
            return Promise.resolve(
              matched.map((r) => ({
                id: r.id,
                username: r.username,
                email: r.email,
              }))
            );
          },
          then: (resolve: (v: any) => void) => {
            const rows = rowsForTable(name);
            const matched = fn ? rows.filter(fn) : rows;
            for (const r of matched) Object.assign(r, vals);
            resolve(undefined);
          },
        };
      },
    }),
  };
}

function makeDeleteChain(table: any) {
  const name = tableName(table);
  return {
    where: (expr: any) => {
      let fn: ((row: any) => boolean) | null = null;
      if (expr && expr.queryChunks) {
        fn = predicateFromChunks(expr.queryChunks);
      }
      const apply = () => {
        const rows = rowsForTable(name);
        const matched = fn ? rows.filter(fn) : rows;
        const ids = matched.map((r) => r.id);
        if (name === "users") {
          _state.users = _state.users.filter((u) => !ids.includes(u.id));
          // CASCADE
          _state.sessions = _state.sessions.filter(
            (s) => !ids.includes(s.userId)
          );
          _state.repositories = _state.repositories.filter(
            (r) => !ids.includes(r.ownerId)
          );
        } else if (name === "sessions") {
          _state.sessions = _state.sessions.filter(
            (s) => !ids.includes(s.id)
          );
        }
        return ids;
      };
      return {
        returning: () => {
          const ids = apply();
          return Promise.resolve(ids.map((id) => ({ id })));
        },
        then: (resolve: (v: any) => void) => {
          apply();
          resolve(undefined);
        },
      };
    },
  };
}

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `id-${_idCounter.toString(16).padStart(12, "0")}-test`;
}

function makeInsertChain(table: any) {
  const name = tableName(table);
  return {
    values: (vals: any) => {
      let inserted: any = null;
      if (name === "audit_log") {
        _state.auditInserts.push(vals);
      } else if (name === "users") {
        const u: FakeUser = {
          id: vals.id || nextId(),
          username: vals.username,
          email: vals.email,
          passwordHash: vals.passwordHash,
          isPlayground: !!vals.isPlayground,
          playgroundExpiresAt: vals.playgroundExpiresAt ?? null,
          emailVerifiedAt: vals.emailVerifiedAt ?? null,
        };
        _state.users.push(u);
        inserted = { id: u.id, username: u.username, email: u.email };
      } else if (name === "sessions") {
        const s: FakeSession = {
          id: nextId(),
          userId: vals.userId,
          token: vals.token,
          expiresAt: vals.expiresAt,
        };
        _state.sessions.push(s);
        inserted = { id: s.id };
      } else if (name === "repositories") {
        const r: FakeRepo = {
          id: nextId(),
          name: vals.name,
          ownerId: vals.ownerId,
          description: vals.description ?? null,
          isPrivate: !!vals.isPrivate,
          defaultBranch: vals.defaultBranch || "main",
          diskPath: vals.diskPath || "",
        };
        _state.repositories.push(r);
        inserted = { id: r.id };
      } else if (name === "issues") {
        const i: FakeIssue = {
          id: nextId(),
          repositoryId: vals.repositoryId,
          authorId: vals.authorId,
          title: vals.title,
          body: vals.body ?? null,
          state: vals.state || "open",
        };
        _state.issues.push(i);
        inserted = { id: i.id };
      } else if (name === "labels") {
        const l: FakeLabel = {
          id: nextId(),
          repositoryId: vals.repositoryId,
          name: vals.name,
          color: vals.color || "#888",
          description: vals.description ?? null,
        };
        _state.labels.push(l);
        inserted = { id: l.id };
      } else if (name === "issue_labels") {
        const il: FakeIssueLabel = {
          id: nextId(),
          issueId: vals.issueId,
          labelId: vals.labelId,
        };
        _state.issueLabels.push(il);
        inserted = { id: il.id };
      }
      return {
        returning: () =>
          Promise.resolve(inserted ? [inserted] : []),
        onConflictDoNothing: () =>
          Promise.resolve(inserted ? [inserted] : []),
        then: (resolve: (v: any) => void) => resolve(undefined),
      };
    },
  };
}

const _fakeDb = {
  db: {
    select: (_cols?: any) => {
      _lastFromTable = "?";
      return makeSelectChain();
    },
    insert: (t: any) => makeInsertChain(t),
    update: (t: any) => makeUpdateChain(t),
    delete: (t: any) => makeDeleteChain(t),
  },
};

// ---------------------------------------------------------------------------
// Note: we deliberately do NOT mock `../git/repository` or
// `../lib/repo-bootstrap`. The lib wraps every disk + git subprocess
// in try/catch, so the real bindings degrade to a logged error when
// the fake repo dir doesn't exist — and we sidestep mock pollution
// against git-repository.test.ts. The DB mock still captures repo +
// label + issue inserts so assertions on `_state.repositories` still
// hold.

// Track verification-email "sends" via the lib's first-party
// `__setEmailForTests` seam. The real `startEmailVerification` still
// runs end-to-end (write token row → render email → call sender);
// we intercept only the outbound email so we can record the target
// address without coupling to the email module's internals. We
// restore the previous sender in `afterAll` so other test files'
// recorders aren't overwritten.
let _verificationCalls: Array<{ email: string }> = [];
const _origSender = _real_email_verification.__setEmailForTests(
  async (msg: any) => {
    _verificationCalls.push({ email: String(msg.to) });
    return { ok: true };
  }
);

// ---------------------------------------------------------------------------
// Mock module wiring
// ---------------------------------------------------------------------------

function _reinstallMocks() {
  mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));
  mock.module("../lib/notify", () => _real_notify);
}
_reinstallMocks();

afterAll(async () => {
  resetState();
  clearWhereFn();
  _lastFromTable = "?";
  mock.module("../db", () => _real_db);
  mock.module("../lib/notify", () => _real_notify);
  // Restore the prior email sender so other tests' recorders survive.
  _real_email_verification.__setEmailForTests(_origSender);
  // Best-effort cleanup of the tmp git-repos dir.
  try {
    const { rm } = await import("node:fs/promises");
    await rm(process.env.GIT_REPOS_PATH!, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Dynamic import AFTER mock.module so the lib's bindings resolve to
// our fakes.
const _pg = await import("../lib/playground");
const createPlaygroundAccount = _pg.createPlaygroundAccount;
const claimPlaygroundAccount = _pg.claimPlaygroundAccount;
const purgeExpiredPlaygroundAccounts = _pg.purgeExpiredPlaygroundAccounts;
const isPlaygroundAccount = _pg.isPlaygroundAccount;
const PLAYGROUND_TTL_MS = _pg.PLAYGROUND_TTL_MS;
const SANDBOX_REPO_NAME = _pg.SANDBOX_REPO_NAME;

beforeEach(() => {
  _reinstallMocks();
  resetState();
  clearWhereFn();
  _lastFromTable = "?";
  _verificationCalls = [];
});

// ---------------------------------------------------------------------------
// createPlaygroundAccount
// ---------------------------------------------------------------------------

describe("createPlaygroundAccount", () => {
  it("mints a playground user + 24h session + sandbox repo", async () => {
    const before = Date.now();
    const result = await createPlaygroundAccount();
    const after = Date.now();

    expect(result.user.username).toMatch(/^guest-[0-9a-f]{8}$/);
    expect(result.user.email).toBe(
      `${result.user.username}@playground.gluecron.local`
    );
    expect(result.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sampleRepoFullName).toBe(
      `${result.user.username}/${SANDBOX_REPO_NAME}`
    );

    // User row
    const u = _state.users.find((r) => r.id === result.user.id);
    expect(u).toBeDefined();
    expect(u!.isPlayground).toBe(true);
    expect(u!.playgroundExpiresAt).toBeInstanceOf(Date);
    const expMs = u!.playgroundExpiresAt!.getTime();
    expect(expMs).toBeGreaterThanOrEqual(before + PLAYGROUND_TTL_MS - 1000);
    expect(expMs).toBeLessThanOrEqual(after + PLAYGROUND_TTL_MS + 1000);
    expect(u!.emailVerifiedAt).toBeInstanceOf(Date);

    // Session row
    const s = _state.sessions.find((r) => r.token === result.sessionToken);
    expect(s).toBeDefined();
    expect(s!.userId).toBe(result.user.id);

    // Sandbox repo
    const r = _state.repositories.find((r) => r.ownerId === result.user.id);
    expect(r).toBeDefined();
    expect(r!.name).toBe(SANDBOX_REPO_NAME);
    expect(r!.isPrivate).toBe(false);

    // Sample issues
    const repoIssues = _state.issues.filter(
      (i) => i.repositoryId === r!.id
    );
    expect(repoIssues.length).toBeGreaterThanOrEqual(2);
  });

  it("marks email_verified_at so the verify-email banner is suppressed", async () => {
    const result = await createPlaygroundAccount();
    const u = _state.users.find((r) => r.id === result.user.id);
    expect(u!.emailVerifiedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// claimPlaygroundAccount
// ---------------------------------------------------------------------------

describe("claimPlaygroundAccount", () => {
  async function makePlayground(): Promise<string> {
    const r = await createPlaygroundAccount();
    return r.user.id;
  }

  it("clears playground flags, sets new email + password, fires verification", async () => {
    const uid = await makePlayground();

    const ok = await claimPlaygroundAccount(uid, {
      email: "real@example.com",
      password: "supersecret",
    });

    expect(ok.ok).toBe(true);
    const u = _state.users.find((r) => r.id === uid);
    expect(u!.isPlayground).toBe(false);
    expect(u!.playgroundExpiresAt).toBeNull();
    expect(u!.email).toBe("real@example.com");
    expect(u!.emailVerifiedAt).toBeNull();
    expect(u!.passwordHash).not.toBe("");

    // Allow the fire-and-forget Promise to schedule. We don't actually
    // need to await it because the fake just pushes synchronously
    // inside a Promise body — but flushing the microtask queue lets
    // the call settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(_verificationCalls.length).toBeGreaterThanOrEqual(1);
    expect(_verificationCalls[0].email).toBe("real@example.com");
  });

  it("rejects when email is already taken by another user", async () => {
    // Seed a real user with the email.
    _state.users.push({
      id: "preexisting",
      username: "alice",
      email: "taken@example.com",
      passwordHash: "x",
      isPlayground: false,
      playgroundExpiresAt: null,
      emailVerifiedAt: new Date(),
    });

    const uid = await makePlayground();

    const result = await claimPlaygroundAccount(uid, {
      email: "taken@example.com",
      password: "supersecret",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("email_taken");
  });

  it("rejects invalid email + short password", async () => {
    const uid = await makePlayground();

    const r1 = await claimPlaygroundAccount(uid, {
      email: "nope",
      password: "supersecret",
    });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe("invalid_email");

    const r2 = await claimPlaygroundAccount(uid, {
      email: "real@example.com",
      password: "short",
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("password_too_short");
  });

  it("rejects when invoked on a non-playground user", async () => {
    _state.users.push({
      id: "real-user",
      username: "bob",
      email: "bob@example.com",
      passwordHash: "x",
      isPlayground: false,
      playgroundExpiresAt: null,
      emailVerifiedAt: new Date(),
    });
    const r = await claimPlaygroundAccount("real-user", {
      email: "new@example.com",
      password: "supersecret",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_a_playground_account");
  });
});

// ---------------------------------------------------------------------------
// purgeExpiredPlaygroundAccounts
// ---------------------------------------------------------------------------

describe("purgeExpiredPlaygroundAccounts", () => {
  it("hard-deletes expired playground users, leaves unexpired alone", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    const expiredId = "ex-1";
    const liveId = "ex-2";
    _state.users.push(
      {
        id: expiredId,
        username: "guest-deadbeef",
        email: "guest-deadbeef@playground.gluecron.local",
        passwordHash: "x",
        isPlayground: true,
        playgroundExpiresAt: past,
        emailVerifiedAt: new Date(),
      },
      {
        id: liveId,
        username: "guest-cafebabe",
        email: "guest-cafebabe@playground.gluecron.local",
        passwordHash: "x",
        isPlayground: true,
        playgroundExpiresAt: future,
        emailVerifiedAt: new Date(),
      }
    );

    const result = await purgeExpiredPlaygroundAccounts({ now: new Date() });

    expect(result.errors).toBe(0);
    expect(_state.users.find((u) => u.id === expiredId)).toBeUndefined();
    expect(_state.users.find((u) => u.id === liveId)).toBeDefined();
    expect(result.purged).toBe(1);
  });

  it("caps deletions at the supplied cap and never throws", async () => {
    const past = new Date(Date.now() - 60_000);
    for (let i = 0; i < 5; i++) {
      _state.users.push({
        id: `g-${i}`,
        username: `guest-${i.toString(16).padStart(8, "0")}`,
        email: `g${i}@playground.gluecron.local`,
        passwordHash: "x",
        isPlayground: true,
        playgroundExpiresAt: past,
        emailVerifiedAt: new Date(),
      });
    }
    const result = await purgeExpiredPlaygroundAccounts({ cap: 2 });
    expect(result.purged).toBeLessThanOrEqual(2);
    expect(result.errors).toBe(0);
  });

  it("survives DB outage with errors > 0 and never throws", async () => {
    const orig = _fakeDb.db.select;
    _fakeDb.db.select = (() => {
      throw new Error("synthetic outage");
    }) as any;
    try {
      const result = await purgeExpiredPlaygroundAccounts({ now: new Date() });
      expect(result.purged).toBe(0);
      expect(result.errors).toBeGreaterThan(0);
    } finally {
      _fakeDb.db.select = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// isPlaygroundAccount (pure helper)
// ---------------------------------------------------------------------------

describe("isPlaygroundAccount", () => {
  it("returns true only when isPlayground is exactly true", () => {
    expect(isPlaygroundAccount({ isPlayground: true })).toBe(true);
    expect(isPlaygroundAccount({ isPlayground: false })).toBe(false);
    expect(isPlaygroundAccount({ isPlayground: null })).toBe(false);
    expect(isPlaygroundAccount({} as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Route + autopilot wiring assertions (source-string checks).
// ---------------------------------------------------------------------------

describe("route wiring (source-string assertions)", () => {
  let playgroundSrc = "";
  let autopilotSrc = "";
  let layoutSrc = "";
  let landingSrc = "";
  let appSrc = "";

  beforeEach(async () => {
    if (!playgroundSrc) {
      const fs = await import("node:fs/promises");
      playgroundSrc = await fs.readFile(
        new URL("../routes/playground.tsx", import.meta.url),
        "utf8"
      );
      autopilotSrc = await fs.readFile(
        new URL("../lib/autopilot.ts", import.meta.url),
        "utf8"
      );
      layoutSrc = await fs.readFile(
        new URL("../views/layout.tsx", import.meta.url),
        "utf8"
      );
      landingSrc = await fs.readFile(
        new URL("../views/landing.tsx", import.meta.url),
        "utf8"
      );
      appSrc = await fs.readFile(
        new URL("../app.tsx", import.meta.url),
        "utf8"
      );
    }
  });

  it("playground.tsx registers GET /play and POST /play", () => {
    expect(playgroundSrc).toMatch(/\.get\(\s*["']\/play["']/);
    expect(playgroundSrc).toMatch(/\.post\(\s*["']\/play["']/);
  });

  it("playground.tsx registers GET + POST /play/claim and requireAuth", () => {
    expect(playgroundSrc).toMatch(/\.get\(\s*["']\/play\/claim["']\s*,\s*requireAuth/);
    expect(playgroundSrc).toMatch(/\.post\(\s*["']\/play\/claim["']\s*,\s*requireAuth/);
  });

  it("POST /play is rate-limited at 3/min via the shared middleware", () => {
    expect(playgroundSrc).toContain('rateLimit(3, 60_000');
  });

  it("autopilot.ts wires the playground-purge task", () => {
    expect(autopilotSrc).toContain('name: "playground-purge"');
    expect(autopilotSrc).toContain("purgeExpiredPlaygroundAccounts");
  });

  it("layout.tsx renders the playground banner gated on user.isPlayground", () => {
    expect(layoutSrc).toContain("playground-banner");
    expect(layoutSrc).toContain("isPlayground");
    expect(layoutSrc).toContain("Save your work");
  });

  it("landing.tsx adds the tertiary /play CTA", () => {
    expect(landingSrc).toContain('href="/play"');
    expect(landingSrc).toContain("without signing up");
  });

  it("app.tsx mounts the playground routes", () => {
    expect(appSrc).toContain("playgroundRoutes");
    expect(appSrc).toContain('"./routes/playground"');
  });
});

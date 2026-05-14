/**
 * Block R1 — Tests for /admin/ops, the site-admin operations console.
 *
 * Coverage:
 *   - GET /admin/ops requires site-admin (302 for anon, 403 for non-admin,
 *     200 HTML for admin)
 *   - POST /admin/ops/auto-merge/enable calls runEnableAutoMerge with the
 *     right args and redirects with success
 *   - POST /admin/ops/auto-merge/disable passes `off:true`
 *   - POST /admin/ops/deploy/trigger forwards to the N4 handler
 *   - POST /admin/ops/rollback resolves the previous-successful SHA and
 *     dispatches a workflow_dispatch with that ref
 *   - findPreviousSuccessfulDeploy returns null when there's nothing prior
 *   - triggerRollback maps 401 / 422 into friendly errors
 *
 * Mock pattern: K1-style `mock.module("../db", ...)` with afterAll
 * restoration. The opsRoutes module exposes `__setOpsDepsForTests` so we
 * inject the runEnableAutoMerge / triggerRollback / findPreviousSuccessfulDeploy
 * spies as actual collaborators — no need to stub Drizzle for the script's
 * private queries.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers shared with cli-deploy.test.ts.
// ---------------------------------------------------------------------------

function jsonRes(status: number, body: any) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}
function noContent() {
  return { status: 204, ok: true, text: async () => "" };
}

// ---------------------------------------------------------------------------
// Spread-from-real `../db` mock. We capture select returns per-test via
// per-table "next row" hooks, identical to cli-deploy.test.ts.
// ---------------------------------------------------------------------------

const _real_db = await import("../db");
const _schema = await import("../db/schema");
const _schemaDeploys = await import("../db/schema-deploys");

let _nextSessionRow: any = null;
let _nextUserRow: any = null;
let _nextAdminRow: any = null;
let _nextBpOwnerRow: any = null; // for readAutoMergeState owner lookup
let _nextRepoRow: any = null;
let _nextBpRow: any = null;
let _nextLatestDeployRow: any = null;
let _lastSelectFrom: any = null;
let _userSelectCount = 0;

const tableName = (t: any): string => {
  if (t === _schema.sessions) return "sessions";
  if (t === _schema.users) return "users";
  if (t === _schema.siteAdmins) return "site_admins";
  if (t === _schema.repositories) return "repositories";
  if (t === _schema.branchProtection) return "branch_protection";
  if (t === _schemaDeploys.platformDeploys) return "platform_deploys";
  return "?";
};

const _selectChain: any = {
  from: (t: any) => {
    _lastSelectFrom = t;
    if (tableName(t) === "users") _userSelectCount++;
    return _selectChain;
  },
  innerJoin: () => _selectChain,
  leftJoin: () => _selectChain,
  where: () => _selectChain,
  orderBy: () => _selectChain,
  limit: async () => {
    const name = tableName(_lastSelectFrom);
    if (name === "sessions") return _nextSessionRow ? [_nextSessionRow] : [];
    if (name === "users") {
      // The softAuth path performs a users-select for the session lookup;
      // the page handler then does additional users-selects for the ops
      // repo owner. We let the first call be the session user and second+
      // calls be the bp owner — the test sets both via setters below.
      if (_userSelectCount === 1) return _nextUserRow ? [_nextUserRow] : [];
      return _nextBpOwnerRow ? [_nextBpOwnerRow] : [];
    }
    if (name === "site_admins") return _nextAdminRow ? [_nextAdminRow] : [];
    if (name === "repositories") return _nextRepoRow ? [_nextRepoRow] : [];
    if (name === "branch_protection")
      return _nextBpRow ? [_nextBpRow] : [];
    if (name === "platform_deploys")
      return _nextLatestDeployRow ? [_nextLatestDeployRow] : [];
    return [];
  },
  then: (resolve: (v: any) => void) => resolve([]),
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
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
    execute: async () => ({ rows: [{ column_name: "enable_auto_merge" }] }),
  },
  getDb: () => _fakeDb.db,
};

mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));

// Import the app + ops module AFTER mock.module has installed the fake.
const { default: app } = await import("../app");
const { sessionCache } = await import("../lib/cache");
const opsModule = await import("../routes/admin-ops");
const adminDeploys = await import("../routes/admin-deploys");
const rollbackLib = await import("../lib/rollback-deploy");

// ---------------------------------------------------------------------------
// Fake users + session tokens
// ---------------------------------------------------------------------------

const ADMIN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NON_ADMIN_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ADMIN_TOKEN = "r1-admin-token";
const NON_ADMIN_TOKEN = "r1-nonadmin-token";

const ADMIN_USER = {
  id: ADMIN_ID,
  username: "ops_admin",
  displayName: "Ops Admin",
  email: "ops@example.com",
  passwordHash: "x",
  createdAt: new Date(),
  updatedAt: new Date(),
};
const NON_ADMIN_USER = {
  id: NON_ADMIN_ID,
  username: "ops_nobody",
  displayName: "Nobody",
  email: "n@example.com",
  passwordHash: "x",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const SAME_ORIGIN_HEADERS = {
  host: "localhost",
  origin: "http://localhost",
};

function authedPost(token: string): RequestInit {
  return {
    method: "POST",
    headers: {
      ...SAME_ORIGIN_HEADERS,
      cookie: `session=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
    redirect: "manual",
  };
}

function authedGet(token: string | null): RequestInit {
  const headers: Record<string, string> = { ...SAME_ORIGIN_HEADERS };
  if (token) headers.cookie = `session=${token}`;
  return { method: "GET", headers, redirect: "manual" };
}

beforeEach(() => {
  sessionCache.set(ADMIN_TOKEN, ADMIN_USER as any);
  sessionCache.set(NON_ADMIN_TOKEN, NON_ADMIN_USER as any);
  _nextSessionRow = null;
  _nextUserRow = null;
  _nextAdminRow = null;
  _nextBpOwnerRow = null;
  _nextRepoRow = null;
  _nextBpRow = null;
  _nextLatestDeployRow = null;
  _userSelectCount = 0;
  opsModule.__setOpsDepsForTests(null);
});

afterAll(() => {
  sessionCache.invalidate(ADMIN_TOKEN);
  sessionCache.invalidate(NON_ADMIN_TOKEN);
  opsModule.__setOpsDepsForTests(null);
  adminDeploys.__setGithubFetchForTests(null);
  adminDeploys.__setEnvForTests(null);
  mock.module("../db", () => _real_db);
});

// ===========================================================================
// GET /admin/ops gating
// ===========================================================================

describe("GET /admin/ops gating", () => {
  it("redirects anonymous users to /login", async () => {
    const res = await app.request("/admin/ops", authedGet(null));
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login");
  });

  it("403s an authed non-admin", async () => {
    _nextAdminRow = null;
    const res = await app.request(
      "/admin/ops",
      authedGet(NON_ADMIN_TOKEN)
    );
    expect(res.status).toBe(403);
  });

  it("renders HTML 200 for a site admin (auto-merge card present)", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    // Stub the readiness-friendly helpers so the page renders without
    // exercising the autopilot module-load probe.
    opsModule.__setOpsDepsForTests({
      findPreviousSuccessfulDeploy: async () => null,
    });
    const res = await app.request("/admin/ops", authedGet(ADMIN_TOKEN));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("AI auto-merge on main");
    expect(html).toContain("Deploy");
    expect(html).toContain("Rollback");
  });
});

// ===========================================================================
// POST /admin/ops/auto-merge/{enable,disable}
// ===========================================================================

describe("POST /admin/ops/auto-merge/enable", () => {
  it("redirects 401-equivalent to login when anonymous", async () => {
    const res = await app.request("/admin/ops/auto-merge/enable", {
      method: "POST",
      headers: SAME_ORIGIN_HEADERS,
      redirect: "manual",
    });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("403s for a non-admin", async () => {
    _nextAdminRow = null;
    const res = await app.request(
      "/admin/ops/auto-merge/enable",
      authedPost(NON_ADMIN_TOKEN)
    );
    expect(res.status).toBe(403);
  });

  it("calls runEnableAutoMerge with off=false + redirects success", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    let captured: any = null;
    opsModule.__setOpsDepsForTests({
      runEnableAutoMerge: async (_db, args) => {
        captured = args;
        return {
          action: "updated",
          before: { enableAutoMerge: false } as any,
          after: {
            id: "bp-1",
            enableAutoMerge: true,
          } as any,
          auditWritten: true,
        };
      },
    });
    const res = await app.request(
      "/admin/ops/auto-merge/enable",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/admin/ops");
    expect(loc).toContain("success=");
    expect(loc.toLowerCase()).toContain("enabled");
    expect(captured).not.toBeNull();
    expect(captured.ownerSlash).toBe("ccantynz/Gluecron.com");
    expect(captured.pattern).toBe("main");
    expect(captured.off).toBe(false);
    expect(captured.actorUserId).toBe(ADMIN_ID);
  });

  it("reports a friendly error when the script throws", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    opsModule.__setOpsDepsForTests({
      runEnableAutoMerge: async () => {
        throw new Error("Repository not found: ccantynz/Gluecron.com.");
      },
    });
    const res = await app.request(
      "/admin/ops/auto-merge/enable",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("error=");
    expect(decodeURIComponent(loc)).toMatch(/Repository not found/);
  });
});

describe("POST /admin/ops/auto-merge/disable", () => {
  it("calls the script with off=true + redirects success", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    let captured: any = null;
    opsModule.__setOpsDepsForTests({
      runEnableAutoMerge: async (_db, args) => {
        captured = args;
        return {
          action: "updated",
          before: { enableAutoMerge: true } as any,
          after: { id: "bp-1", enableAutoMerge: false } as any,
          auditWritten: true,
        };
      },
    });
    const res = await app.request(
      "/admin/ops/auto-merge/disable",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    expect(captured.off).toBe(true);
    expect(captured.actorUserId).toBe(ADMIN_ID);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("success=");
    expect(decodeURIComponent(loc).toLowerCase()).toContain("disabled");
  });
});

// ===========================================================================
// POST /admin/ops/deploy/trigger — re-uses N4 internally
// ===========================================================================

describe("POST /admin/ops/deploy/trigger", () => {
  it("forwards to N4 and redirects success when GitHub returns 204", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    adminDeploys.__setEnvForTests({ GITHUB_TOKEN: "ghp_admin" });
    let captured: { url: string; method?: string; body?: string } | null = null;
    adminDeploys.__setGithubFetchForTests(async (url, init) => {
      captured = { url, method: init?.method, body: init?.body };
      return noContent();
    });
    const res = await app.request(
      "/admin/ops/deploy/trigger",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("success=");
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain(
      "/actions/workflows/hetzner-deploy.yml/dispatches"
    );
  });

  it("surfaces the N4 error when GitHub rejects the dispatch", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    adminDeploys.__setEnvForTests({ GITHUB_TOKEN: "ghp_admin" });
    adminDeploys.__setGithubFetchForTests(async () =>
      jsonRes(422, { message: "No ref found" })
    );
    const res = await app.request(
      "/admin/ops/deploy/trigger",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("error=");
    expect(decodeURIComponent(loc)).toMatch(/422.*No ref found/);
  });
});

// ===========================================================================
// POST /admin/ops/rollback
// ===========================================================================

describe("POST /admin/ops/rollback", () => {
  it("400-style redirect when there's no previous successful deploy", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    opsModule.__setOpsDepsForTests({
      findPreviousSuccessfulDeploy: async () => null,
    });
    const res = await app.request(
      "/admin/ops/rollback",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("error=");
    expect(decodeURIComponent(loc)).toMatch(/No previous successful deploy/);
  });

  it("calls triggerRollback with the previous-successful SHA on success", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    const PREV_SHA = "def56781234567890abcdef";
    let capturedArgs: any = null;
    opsModule.__setOpsDepsForTests({
      findPreviousSuccessfulDeploy: async () => ({
        sha: PREV_SHA,
        runId: "9999",
        finishedAt: new Date(),
      }),
      triggerRollback: async (args) => {
        capturedArgs = args;
        return { ok: true, htmlUrl: "https://github.com/x/y/actions" };
      },
    });
    const res = await app.request(
      "/admin/ops/rollback",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs.targetSha).toBe(PREV_SHA);
    expect(capturedArgs.triggeredByUserId).toBe(ADMIN_ID);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("success=");
    expect(decodeURIComponent(loc)).toContain(PREV_SHA.slice(0, 7));
  });

  it("redirects with error when triggerRollback returns ok:false", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    opsModule.__setOpsDepsForTests({
      findPreviousSuccessfulDeploy: async () => ({
        sha: "abc1234",
        runId: "1",
        finishedAt: new Date(),
      }),
      triggerRollback: async () => ({ ok: false, error: "GitHub auth failed (401)" }),
    });
    const res = await app.request(
      "/admin/ops/rollback",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("error=");
    expect(decodeURIComponent(loc)).toMatch(/GitHub auth failed/);
  });

  it("403s non-admins", async () => {
    _nextAdminRow = null;
    const res = await app.request(
      "/admin/ops/rollback",
      authedPost(NON_ADMIN_TOKEN)
    );
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// rollback-deploy.ts library helpers
// ===========================================================================

describe("findPreviousSuccessfulDeploy", () => {
  it("returns null when the table is empty", async () => {
    _nextLatestDeployRow = null;
    const r = await rollbackLib.findPreviousSuccessfulDeploy();
    expect(r).toBeNull();
  });
});

describe("triggerRollback — friendly error mapping", () => {
  it("rejects missing targetSha", async () => {
    const r = await rollbackLib.triggerRollback({
      targetSha: "",
      triggeredByUserId: ADMIN_ID,
      githubToken: "ghp_x",
      fetchImpl: (async () => noContent()) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/targetSha is required/);
  });

  it("rejects missing GITHUB_TOKEN", async () => {
    const r = await rollbackLib.triggerRollback({
      targetSha: "abc1234",
      triggeredByUserId: ADMIN_ID,
      githubToken: "",
      fetchImpl: (async () => noContent()) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GITHUB_TOKEN/);
  });

  it("maps 401 → friendly auth error", async () => {
    const r = await rollbackLib.triggerRollback({
      targetSha: "abc1234",
      triggeredByUserId: ADMIN_ID,
      githubToken: "ghp_bad",
      fetchImpl: (async () =>
        jsonRes(401, { message: "Bad credentials" })) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GitHub auth failed \(401\)/);
  });

  it("maps 422 → friendly ref error", async () => {
    const r = await rollbackLib.triggerRollback({
      targetSha: "nope",
      triggeredByUserId: ADMIN_ID,
      githubToken: "ghp_x",
      fetchImpl: (async () =>
        jsonRes(422, { message: "No ref found for: nope" })) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/422.*No ref found/);
  });

  it("ok:true on a 204 dispatch + POSTs ref=targetSha", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const r = await rollbackLib.triggerRollback({
      targetSha: "abc1234def",
      triggeredByUserId: ADMIN_ID,
      githubToken: "ghp_x",
      fetchImpl: (async (url: string, init?: any) => {
        calls.push({ url, body: init?.body });
        return noContent();
      }) as any,
    });
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toContain("/dispatches");
    expect(JSON.parse(calls[0]!.body!).ref).toBe("abc1234def");
  });
});

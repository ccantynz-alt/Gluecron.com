/**
 * BLOCK W — Tests for the self-host migration.
 *
 * Coverage:
 *   1. The post-receive hook fires self-deploy only when SELF_HOST_REPO
 *      matches owner/repo AND ref is refs/heads/main.
 *   2. It does NOT fire when SELF_HOST_REPO is unset.
 *   3. It does NOT fire on customer repos with the same name.
 *   4. The spawn is non-blocking — the stub returns synchronously and
 *      onPostReceive resolves without awaiting any deploy work.
 *   5. The bootstrap script's idempotency — re-running with the same
 *      args INSERTs the row once and finds it on the second pass.
 *   6. `/admin/self-host` renders for site-admin, 403s for non-admin,
 *      redirects anon.
 *
 * K1-style spread-from-real mock pattern + afterAll cleanup so we don't
 * pollute the cross-test module cache.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// ---------------------------------------------------------------------------
// Spread-from-real `../db` mock — captures per-table next rows for tests
// that need to drive admin-self-host + the bootstrap orchestrator.
// ---------------------------------------------------------------------------

const _real_db = await import("../db");
const _schema = await import("../db/schema");
const _schemaDeploys = await import("../db/schema-deploys");

let _nextSessionRow: any = null;
let _nextUserRow: any = null;
let _nextAdminRow: any = null;
let _nextOwnerRow: any = null;
let _nextRepoRow: any = null;
let _recentDeploys: any[] = [];
let _lastSelectFrom: any = null;
let _userSelectCount = 0;
const _inserted: { table: string; values: any }[] = [];

const tableName = (t: any): string => {
  if (t === _schema.sessions) return "sessions";
  if (t === _schema.users) return "users";
  if (t === _schema.siteAdmins) return "site_admins";
  if (t === _schema.repositories) return "repositories";
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
      // First users-select = the softAuth session lookup; subsequent =
      // admin-self-host's repo-owner lookup.
      if (_userSelectCount === 1) return _nextUserRow ? [_nextUserRow] : [];
      return _nextOwnerRow ? [_nextOwnerRow] : [];
    }
    if (name === "site_admins") return _nextAdminRow ? [_nextAdminRow] : [];
    if (name === "repositories") return _nextRepoRow ? [_nextRepoRow] : [];
    if (name === "platform_deploys") return _recentDeploys;
    return [];
  },
  then: (resolve: (v: any) => void) => resolve([]),
};

const _fakeDb = {
  db: {
    select: () => _selectChain,
    insert: (t: any) => ({
      values: (v: any) => {
        _inserted.push({ table: tableName(t), values: v });
        return {
          returning: async () => [{ id: "new-repo-id" }],
          then: (r: (v: any) => void) => r(undefined),
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
    execute: async () => ({ rows: [] }),
  },
  getDb: () => _fakeDb.db,
};

mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));

// Import the app AFTER mock.module has installed the fake.
const { default: app } = await import("../app");
const { sessionCache } = await import("../lib/cache");
const postReceive = await import("../hooks/post-receive");
const selfHostMod = await import("../routes/admin-self-host");
const bootstrapMod = await import("../../scripts/self-host-bootstrap");

// ---------------------------------------------------------------------------
// Fake users + tokens
// ---------------------------------------------------------------------------

const ADMIN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NON_ADMIN_ID = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
const ADMIN_TOKEN = "w1-admin-token";
const NON_ADMIN_TOKEN = "w1-nonadmin-token";

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

function authedGet(token: string | null): RequestInit {
  const headers: Record<string, string> = { ...SAME_ORIGIN_HEADERS };
  if (token) headers.cookie = `session=${token}`;
  return { method: "GET", headers, redirect: "manual" };
}
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

// Preserve original env so we restore it cleanly between tests.
const origSelfHostRepo = process.env.SELF_HOST_REPO;
const origSelfDeployScript = process.env.GLUECRON_SELF_DEPLOY_SCRIPT;

beforeEach(() => {
  sessionCache.set(ADMIN_TOKEN, ADMIN_USER as any);
  sessionCache.set(NON_ADMIN_TOKEN, NON_ADMIN_USER as any);
  _nextSessionRow = null;
  _nextUserRow = null;
  _nextAdminRow = null;
  _nextOwnerRow = null;
  _nextRepoRow = null;
  _recentDeploys = [];
  _userSelectCount = 0;
  _inserted.length = 0;
  delete process.env.SELF_HOST_REPO;
  delete process.env.GLUECRON_SELF_DEPLOY_SCRIPT;
  postReceive.__setSelfHostSpawnForTests(null);
  selfHostMod.__setSelfHostDepsForTests(null);
});

afterAll(() => {
  sessionCache.invalidate(ADMIN_TOKEN);
  sessionCache.invalidate(NON_ADMIN_TOKEN);
  postReceive.__setSelfHostSpawnForTests(null);
  selfHostMod.__setSelfHostDepsForTests(null);
  if (origSelfHostRepo === undefined) delete process.env.SELF_HOST_REPO;
  else process.env.SELF_HOST_REPO = origSelfHostRepo;
  if (origSelfDeployScript === undefined)
    delete process.env.GLUECRON_SELF_DEPLOY_SCRIPT;
  else process.env.GLUECRON_SELF_DEPLOY_SCRIPT = origSelfDeployScript;
  mock.module("../db", () => _real_db);
});

// ===========================================================================
// 1–4. Post-receive self-host gating
// ===========================================================================
//
// onPostReceive calls into autoRepair / analyzePush / computeHealthScore
// which each touch the DB. The mocked DB is intentionally empty, so each
// helper logs an error and continues. We assert *only* on the self-host
// spawn — the existing crontech/intelligence behaviour is covered by
// other test files and untouched here.
// ---------------------------------------------------------------------------

function makeRefs(opts: {
  refName?: string;
  newSha?: string;
  oldSha?: string;
} = {}) {
  return [
    {
      oldSha: opts.oldSha ?? "0".repeat(40),
      newSha: opts.newSha ?? "a".repeat(40),
      refName: opts.refName ?? "refs/heads/main",
    },
  ];
}

describe("post-receive — BLOCK W self-host dispatch", () => {
  it("fires self-deploy when SELF_HOST_REPO matches owner/repo on push to main", async () => {
    process.env.SELF_HOST_REPO = "ccantynz/Gluecron.com";
    process.env.GLUECRON_SELF_DEPLOY_SCRIPT = "/fake/self-deploy.sh";
    const calls: { cmd: string[]; opts: any }[] = [];
    postReceive.__setSelfHostSpawnForTests((cmd, opts) => {
      calls.push({ cmd, opts });
      return { unref: () => {} } as any;
    });

    await postReceive.onPostReceive(
      "ccantynz",
      "Gluecron.com",
      makeRefs({ newSha: "b".repeat(40) })
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd[0]).toBe("/fake/self-deploy.sh");
    expect(calls[0]!.cmd[1]).toBe("0".repeat(40)); // oldSha
    expect(calls[0]!.cmd[2]).toBe("b".repeat(40)); // newSha
  });

  it("does NOT fire when SELF_HOST_REPO is unset", async () => {
    delete process.env.SELF_HOST_REPO;
    const calls: { cmd: string[] }[] = [];
    postReceive.__setSelfHostSpawnForTests((cmd) => {
      calls.push({ cmd });
      return { unref: () => {} } as any;
    });

    await postReceive.onPostReceive(
      "ccantynz",
      "Gluecron.com",
      makeRefs()
    );
    expect(calls.length).toBe(0);
  });

  it("does NOT fire on a customer repo with the same name", async () => {
    process.env.SELF_HOST_REPO = "ccantynz/Gluecron.com";
    const calls: { cmd: string[] }[] = [];
    postReceive.__setSelfHostSpawnForTests((cmd) => {
      calls.push({ cmd });
      return { unref: () => {} } as any;
    });

    // Different owner — same repo name.
    await postReceive.onPostReceive(
      "someone-else",
      "Gluecron.com",
      makeRefs()
    );
    expect(calls.length).toBe(0);
  });

  it("does NOT fire on a non-main branch", async () => {
    process.env.SELF_HOST_REPO = "ccantynz/Gluecron.com";
    const calls: { cmd: string[] }[] = [];
    postReceive.__setSelfHostSpawnForTests((cmd) => {
      calls.push({ cmd });
      return { unref: () => {} } as any;
    });

    await postReceive.onPostReceive(
      "ccantynz",
      "Gluecron.com",
      makeRefs({ refName: "refs/heads/feature" })
    );
    expect(calls.length).toBe(0);
  });

  it("does NOT fire on a branch deletion (newSha all zeros)", async () => {
    process.env.SELF_HOST_REPO = "ccantynz/Gluecron.com";
    const calls: { cmd: string[] }[] = [];
    postReceive.__setSelfHostSpawnForTests((cmd) => {
      calls.push({ cmd });
      return { unref: () => {} } as any;
    });

    await postReceive.onPostReceive(
      "ccantynz",
      "Gluecron.com",
      makeRefs({ newSha: "0".repeat(40) })
    );
    expect(calls.length).toBe(0);
  });

  it("spawn is non-blocking — the stub is called synchronously and onPostReceive resolves without awaiting the deploy", async () => {
    process.env.SELF_HOST_REPO = "ccantynz/Gluecron.com";
    let spawnReturned = false;
    let onPostReceiveResolved = false;
    postReceive.__setSelfHostSpawnForTests(() => {
      spawnReturned = true;
      // Return an object that would never resolve if the hook awaited it.
      return {
        unref: () => {},
        // Intentional: no `exited` promise, no callbacks.
      } as any;
    });

    const p = postReceive
      .onPostReceive("ccantynz", "Gluecron.com", makeRefs())
      .then(() => {
        onPostReceiveResolved = true;
      });
    await p;
    expect(spawnReturned).toBe(true);
    expect(onPostReceiveResolved).toBe(true);
  });
});

// ===========================================================================
// 5. Bootstrap idempotency + cutover printing
// ===========================================================================

function makeFakeDepsForBootstrap(opts: {
  hasUser?: boolean;
  hasAdmin?: boolean;
  hasRepoRow?: boolean;
  bareExists?: boolean;
} = {}): any {
  const fakeUsers: any[] = opts.hasUser ?? true ? [{ id: "u-1", username: "ccantynz" }] : [];
  const fakeAdmins: any[] = opts.hasAdmin
    ? [{ id: "u-1", username: "ccantynz" }]
    : [];
  const fakeRepoRows: any[] = opts.hasRepoRow ? [{ id: "r-1" }] : [];

  let currentFrom = "";
  const selectChain: any = {
    from: (t: any) => {
      if (t === _schema.siteAdmins || t === _schema.users) {
        currentFrom = t === _schema.siteAdmins ? "site_admins" : "users";
      } else if (t === _schema.repositories) {
        currentFrom = "repositories";
      }
      return selectChain;
    },
    innerJoin: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: async () => {
      if (currentFrom === "site_admins") return fakeAdmins;
      if (currentFrom === "users") return fakeUsers;
      if (currentFrom === "repositories") return fakeRepoRows;
      return [];
    },
  };

  const inserts: any[] = [];
  const fakeDb: any = {
    select: () => selectChain,
    insert: (_t: any) => ({
      values: (v: any) => {
        inserts.push(v);
        return {
          returning: async () => [{ id: "r-new" }],
        };
      },
    }),
  };

  const calls: { cmd: string[] }[] = [];
  const fsExistsMap: Record<string, boolean> = {};
  if (opts.bareExists) {
    fsExistsMap[
      "/repos/ccantynz/Gluecron.com.git/HEAD"
    ] = true;
  }

  const writes: { path: string; body: string }[] = [];
  const chmods: { path: string; mode: number }[] = [];

  const deps = {
    db: fakeDb,
    schema: {
      users: _schema.users,
      repositories: _schema.repositories,
      siteAdmins: _schema.siteAdmins,
    },
    reposPath: "/repos",
    sh: async (cmd: string[]) => {
      calls.push({ cmd });
      // Pretend every shell command succeeds. The clone+push --mirror
      // pair is treated as a no-op; tests assert on `calls` instead.
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    fsExists: (p: string) => fsExistsMap[p] === true,
    fsMkdir: async (_p: string, _opts?: any) => undefined,
    fsWrite: async (p: string, body: string) => {
      writes.push({ path: p, body });
    },
    fsChmod: async (p: string, mode: number) => {
      chmods.push({ path: p, mode });
    },
    fsRm: async (_p: string, _opts?: any) => undefined,
    log: {
      say: () => {},
      ok: () => {},
      warn: () => {},
      bad: () => {},
      info: () => {},
    },
    tmpRoot: "/tmp",
  };

  return { deps, calls, inserts, writes, chmods };
}

describe("self-host bootstrap orchestrator", () => {
  it("INSERTs the repositories row on a fresh run", async () => {
    const { deps, inserts } = makeFakeDepsForBootstrap({
      hasUser: true,
      hasAdmin: true,
      hasRepoRow: false,
    });
    const result = await bootstrapMod.runBootstrap(
      {
        owner: "ccantynz",
        name: "Gluecron.com",
        source: "https://github.com/x/y.git",
        dryRun: false,
      },
      deps as any
    );
    expect(result.steps.operator).not.toBeNull();
    expect(result.steps.operator?.username).toBe("ccantynz");
    expect(result.steps.repoRow?.created).toBe(true);
    expect(inserts.length).toBe(1);
    expect(inserts[0].name).toBe("Gluecron.com");
    expect(inserts[0].ownerId).toBe("u-1");
    expect(inserts[0].defaultBranch).toBe("main");
    expect(inserts[0].isPrivate).toBe(false);
  });

  it("is idempotent — re-running with the same args is a no-op for repo + bare repo", async () => {
    const { deps, inserts, calls } = makeFakeDepsForBootstrap({
      hasUser: true,
      hasAdmin: true,
      hasRepoRow: true,
      bareExists: true,
    });
    const result = await bootstrapMod.runBootstrap(
      {
        owner: "ccantynz",
        name: "Gluecron.com",
        source: "https://github.com/x/y.git",
        dryRun: false,
      },
      deps as any
    );
    expect(result.steps.repoRow?.created).toBe(false);
    expect(inserts.length).toBe(0);
    // `git init --bare` should NOT have been called when HEAD already exists.
    expect(calls.find((c) => c.cmd.includes("init"))).toBeUndefined();
    expect(result.steps.bareRepoCreated).toBe(false);
  });

  it("falls back to oldest user when site_admins is empty", async () => {
    const { deps } = makeFakeDepsForBootstrap({
      hasUser: true,
      hasAdmin: false,
      hasRepoRow: false,
    });
    const result = await bootstrapMod.runBootstrap(
      {
        owner: "ccantynz",
        name: "Gluecron.com",
        source: "https://github.com/x/y.git",
        dryRun: false,
      },
      deps as any
    );
    expect(result.steps.operator).not.toBeNull();
    expect(result.steps.operator?.id).toBe("u-1");
  });

  it("bails when there are no users at all", async () => {
    const { deps } = makeFakeDepsForBootstrap({
      hasUser: false,
      hasAdmin: false,
      hasRepoRow: false,
    });
    const result = await bootstrapMod.runBootstrap(
      {
        owner: "ccantynz",
        name: "Gluecron.com",
        source: "https://github.com/x/y.git",
        dryRun: false,
      },
      deps as any
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no users/i);
  });

  it("dry-run never INSERTs and never spawns git", async () => {
    const { deps, inserts, calls } = makeFakeDepsForBootstrap({
      hasUser: true,
      hasAdmin: true,
      hasRepoRow: false,
    });
    await bootstrapMod.runBootstrap(
      {
        owner: "ccantynz",
        name: "Gluecron.com",
        source: "https://github.com/x/y.git",
        dryRun: true,
      },
      deps as any
    );
    expect(inserts.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("parses --owner / --name / --source / --dry-run flags", () => {
    const args = bootstrapMod.parseArgs([
      "--owner=alice",
      "--name=Demo",
      "--source=https://example.com/foo.git",
      "--dry-run",
    ]);
    expect(args.owner).toBe("alice");
    expect(args.name).toBe("Demo");
    expect(args.source).toBe("https://example.com/foo.git");
    expect(args.dryRun).toBe(true);
  });
});

// ===========================================================================
// 6. /admin/self-host gating
// ===========================================================================

describe("GET /admin/self-host gating", () => {
  it("redirects anonymous users to /login", async () => {
    const res = await app.request("/admin/self-host", authedGet(null));
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login");
  });

  it("403s an authed non-admin", async () => {
    _nextAdminRow = null;
    const res = await app.request(
      "/admin/self-host",
      authedGet(NON_ADMIN_TOKEN)
    );
    expect(res.status).toBe(403);
  });

  it("renders HTML 200 for a site admin (status + bootstrap + recent cards)", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    selfHostMod.__setSelfHostDepsForTests({
      fsExists: () => false,
      getEnv: () => ({ SELF_HOST_REPO: "ccantynz/Gluecron.com" }),
    });
    const res = await app.request(
      "/admin/self-host",
      authedGet(ADMIN_TOKEN)
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Self-host");
    expect(html).toContain("ccantynz/Gluecron.com");
    expect(html).toContain("SELF_HOST_REPO");
    expect(html).toContain("Bootstrap");
    expect(html).toContain("Last 10 self-deploys");
  });

  it("shows 'Mismatch' when SELF_HOST_REPO is set to a different value", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    selfHostMod.__setSelfHostDepsForTests({
      fsExists: () => false,
      getEnv: () => ({ SELF_HOST_REPO: "someone-else/Other.com" }),
    });
    const res = await app.request(
      "/admin/self-host",
      authedGet(ADMIN_TOKEN)
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Mismatch");
  });
});

describe("POST /admin/self-host/bootstrap", () => {
  it("redirects anon to /login", async () => {
    const res = await app.request("/admin/self-host/bootstrap", {
      method: "POST",
      headers: SAME_ORIGIN_HEADERS,
      redirect: "manual",
    });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("403s for non-admin", async () => {
    _nextAdminRow = null;
    const res = await app.request(
      "/admin/self-host/bootstrap",
      authedPost(NON_ADMIN_TOKEN)
    );
    expect(res.status).toBe(403);
  });

  it("spawns the bootstrap script and redirects success for admin", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    const captured: { cmd: string[] }[] = [];
    selfHostMod.__setSelfHostDepsForTests({
      spawn: (cmd) => {
        captured.push({ cmd });
        return { unref: () => {} } as any;
      },
      getEnv: () => ({}),
    });
    const res = await app.request(
      "/admin/self-host/bootstrap",
      authedPost(ADMIN_TOKEN)
    );
    expect([302, 303]).toContain(res.status);
    expect(captured.length).toBe(1);
    // The third arg is the script path; first is bun, second is "run".
    expect(captured[0]!.cmd[1]).toBe("run");
    expect(captured[0]!.cmd[2]).toMatch(/self-host-bootstrap\.ts$/);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/admin/self-host");
    expect(loc).toContain("success=");
  });
});

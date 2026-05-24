/**
 * Block N4 — `gluecron deploy` CLI + /admin/deploys/trigger route tests.
 *
 * The CLI tests drive `triggerWorkflowDispatch`, `watchDeploy`, and the
 * `handleDeployCmd` glue with an injected `fetchImpl` — no network, no real
 * GitHub. They cover:
 *   - happy path: 204 dispatch → list-runs picks up the new run → exit 0
 *   - 401 / 422 friendly errors
 *   - --no-watch skips the polling loop entirely
 *
 * The /admin/deploys/trigger route test uses Bun's `mock.module` to stub
 * `../db` so the `softAuth → sessionCache` path can mint a fake admin user
 * without a real Neon connection. The K1-style spread-from-real pattern is
 * followed and the mock is restored in afterAll so this file never pollutes
 * the rest of the suite.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

import {
  triggerWorkflowDispatch,
  watchDeploy,
  handleDeployCmd,
  type FetchLike,
} from "../../cli/gluecron";

// ---------- helpers ---------------------------------------------------------

function jsonRes(status: number, body: any) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function noContent() {
  return {
    status: 204,
    ok: true,
    text: async () => "",
  };
}

function capture() {
  const lines: string[] = [];
  return {
    out: (s: string) => lines.push(s),
    text: () => lines.join("\n"),
    lines,
  };
}

// =============================================================================
// CLI — triggerWorkflowDispatch
// =============================================================================

describe("cli/deploy — triggerWorkflowDispatch", () => {
  it("POSTs to the right dispatch URL and resolves the latest run", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fakeRun = {
      id: 99887766,
      url: "https://api.github.com/repos/foo/bar/actions/runs/99887766",
      html_url: "https://github.com/foo/bar/actions/runs/99887766",
      created_at: new Date(Date.now()).toISOString(),
    };
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method || "GET", body: init?.body });
      if (init?.method === "POST" && url.includes("/dispatches")) {
        return noContent();
      }
      if (url.includes("/runs?")) {
        return jsonRes(200, { workflow_runs: [fakeRun] });
      }
      throw new Error("unexpected fetch: " + url);
    };

    const result = await triggerWorkflowDispatch(
      {
        repo: "foo/bar",
        workflow: "hetzner-deploy.yml",
        ref: "main",
        githubToken: "ghp_test",
      },
      { fetchImpl, now: () => Date.now() }
    );

    expect(result.runId).toBe(99887766);
    expect(result.htmlUrl).toContain("/actions/runs/99887766");

    // First call is POST .../workflows/hetzner-deploy.yml/dispatches
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/foo/bar/actions/workflows/hetzner-deploy.yml/dispatches"
    );
    expect(calls[0].body).toBe(JSON.stringify({ ref: "main" }));
    // Second call is the runs query
    expect(calls[1].url).toContain(
      "/repos/foo/bar/actions/workflows/hetzner-deploy.yml/runs"
    );
    expect(calls[1].url).toContain("event=workflow_dispatch");
    expect(calls[1].url).toContain("branch=main");
  });

  it("maps 401 to a friendly error", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonRes(401, { message: "Bad credentials" });
    await expect(
      triggerWorkflowDispatch(
        {
          repo: "foo/bar",
          workflow: "hetzner-deploy.yml",
          ref: "main",
          githubToken: "ghp_bad",
        },
        { fetchImpl }
      )
    ).rejects.toThrow(/GitHub auth failed \(401\)/);
  });

  it("maps 422 (bad ref) to a friendly error", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonRes(422, { message: "No ref found for: nope" });
    await expect(
      triggerWorkflowDispatch(
        {
          repo: "foo/bar",
          workflow: "hetzner-deploy.yml",
          ref: "nope",
          githubToken: "ghp_test",
        },
        { fetchImpl }
      )
    ).rejects.toThrow(/422.*No ref found/);
  });

  it("rejects when no GitHub token is provided", async () => {
    await expect(
      triggerWorkflowDispatch(
        { repo: "foo/bar", workflow: "x.yml", ref: "main", githubToken: "" },
        { fetchImpl: async () => noContent() }
      )
    ).rejects.toThrow(/GLUECRON_GITHUB_TOKEN/);
  });

  it("rejects when --repo is not owner/name", async () => {
    await expect(
      triggerWorkflowDispatch(
        { repo: "no-slash", workflow: "x.yml", ref: "main", githubToken: "x" },
        { fetchImpl: async () => noContent() }
      )
    ).rejects.toThrow(/owner\/name/);
  });
});

// =============================================================================
// CLI — handleDeployCmd glue
// =============================================================================

describe("cli/deploy — handleDeployCmd", () => {
  it("--no-watch exits 0 immediately after dispatch (no polling)", async () => {
    let pollCalls = 0;
    const fakeRun = {
      id: 1,
      url: "u",
      html_url: "https://github.com/foo/bar/actions/runs/1",
      created_at: new Date().toISOString(),
    };
    const fetchImpl: FetchLike = async (url, init) => {
      if (init?.method === "POST" && url.includes("/dispatches")) return noContent();
      if (url.includes("/runs?")) return jsonRes(200, { workflow_runs: [fakeRun] });
      if (url.includes("/jobs")) {
        pollCalls++;
        return jsonRes(200, { jobs: [] });
      }
      throw new Error("unexpected: " + url);
    };
    const { out, text } = capture();
    const code = await handleDeployCmd(
      { host: "x" } as any,
      [
        "--repo",
        "foo/bar",
        "--gh-token",
        "ghp_x",
        "--no-watch",
      ],
      out,
      { fetchImpl }
    );
    expect(code).toBe(0);
    expect(pollCalls).toBe(0);
    expect(text()).toContain("Triggering hetzner-deploy.yml on foo/bar@main");
    expect(text()).toContain("Workflow run dispatched");
    expect(text()).not.toContain("Watching deploy status");
  });

  it("missing token prints a clear instructional error", async () => {
    const prevEnv = process.env.GLUECRON_GITHUB_TOKEN;
    delete process.env.GLUECRON_GITHUB_TOKEN;
    try {
      const { out, text } = capture();
      const code = await handleDeployCmd(
        { host: "x" } as any,
        ["--repo", "foo/bar"],
        out,
        { fetchImpl: async () => noContent() }
      );
      expect(code).toBe(1);
      expect(text()).toMatch(/GLUECRON_GITHUB_TOKEN/);
      expect(text()).toMatch(/config set github-token/);
    } finally {
      if (prevEnv !== undefined) process.env.GLUECRON_GITHUB_TOKEN = prevEnv;
    }
  });
});

// =============================================================================
// CLI — watchDeploy poll loop
// =============================================================================

describe("cli/deploy — watchDeploy", () => {
  it("logs step transitions and returns ok on success", async () => {
    const t0 = 1_700_000_000_000;
    const transcripts = [
      // poll 1: setup in progress
      {
        jobs: [
          {
            status: "in_progress",
            conclusion: null,
            steps: [
              {
                name: "Setup",
                status: "in_progress",
                conclusion: null,
                started_at: new Date(t0 + 5000).toISOString(),
                completed_at: null,
              },
            ],
          },
        ],
      },
      // poll 2: setup done, deploy in progress
      {
        jobs: [
          {
            status: "in_progress",
            conclusion: null,
            steps: [
              {
                name: "Setup",
                status: "completed",
                conclusion: "success",
                started_at: new Date(t0 + 5000).toISOString(),
                completed_at: new Date(t0 + 18000).toISOString(),
              },
              {
                name: "Deploy",
                status: "in_progress",
                conclusion: null,
                started_at: new Date(t0 + 18000).toISOString(),
                completed_at: null,
              },
            ],
          },
        ],
      },
      // poll 3: everything done, success
      {
        jobs: [
          {
            status: "completed",
            conclusion: "success",
            steps: [
              {
                name: "Setup",
                status: "completed",
                conclusion: "success",
                started_at: new Date(t0 + 5000).toISOString(),
                completed_at: new Date(t0 + 18000).toISOString(),
              },
              {
                name: "Deploy",
                status: "completed",
                conclusion: "success",
                started_at: new Date(t0 + 18000).toISOString(),
                completed_at: new Date(t0 + 42000).toISOString(),
              },
            ],
          },
        ],
      },
    ];
    let pollIdx = 0;
    const fetchImpl: FetchLike = async () =>
      jsonRes(200, transcripts[Math.min(pollIdx++, transcripts.length - 1)]);

    let nowMs = t0;
    const { out, lines } = capture();
    const res = await watchDeploy(
      { repo: "foo/bar", runId: 1, githubToken: "x", startedAt: t0 },
      out,
      {
        fetchImpl,
        pollMs: 0,
        maxPolls: 10,
        sleep: async () => {
          nowMs += 13_000;
        },
        now: () => nowMs,
      }
    );
    expect(res.ok).toBe(true);
    expect(res.conclusion).toBe("success");
    expect(lines.some((l) => l.includes("Setup (in progress)"))).toBe(true);
    expect(lines.some((l) => l.includes("Setup (completed in 13s)"))).toBe(true);
    expect(lines.some((l) => l.includes("Deploy (in progress)"))).toBe(true);
    expect(lines.some((l) => l.includes("Deploy (completed in 24s)"))).toBe(true);
  });

  it("returns ok:false when the run concludes with failure", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonRes(200, {
        jobs: [
          {
            status: "completed",
            conclusion: "failure",
            steps: [
              {
                name: "Smoke test",
                status: "completed",
                conclusion: "failure",
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
              },
            ],
          },
        ],
      });
    const { out } = capture();
    const res = await watchDeploy(
      { repo: "foo/bar", runId: 1, githubToken: "x", startedAt: Date.now() },
      out,
      { fetchImpl, pollMs: 0, maxPolls: 1, sleep: async () => {} }
    );
    expect(res.ok).toBe(false);
    expect(res.conclusion).toBe("failure");
  });
});

// =============================================================================
// /admin/deploys/trigger route
// =============================================================================
//
// We DI the github fetcher + GITHUB_TOKEN env via the test-only hooks on the
// route module so we never hit api.github.com. The session/auth path goes
// through softAuth + sessionCache, which we pre-warm with a fake user.

const _real_db = await import("../db");
const _schema = await import("../db/schema");

// Per-test row hooks (matching the layout-user-prop.test.ts pattern).
let _nextSessionRow: any = null;
let _nextUserRow: any = null;
let _nextAdminRow: any = null;
let _lastSelectFrom: any = null;

const tableName = (t: any): string => {
  // Identify by object identity against the real drizzle table objects.
  // Using `"propName" in table` (the previous approach) is unreliable
  // because drizzle's pgTable proxy doesn't always expose column names
  // via `has`. Identity comparison is rock-solid.
  if (t === _schema.sessions) return "sessions";
  if (t === _schema.users) return "users";
  if (t === _schema.siteAdmins) return "site_admins";
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
    if (name === "site_admins") return _nextAdminRow ? [_nextAdminRow] : [];
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
  },
  getDb: () => _fakeDb.db,
};

mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));

const { default: app } = await import("../app");
const { sessionCache } = await import("../lib/cache");
const adminDeploys = await import("../routes/admin-deploys");

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const NON_ADMIN_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN_TOKEN = "n4-admin-token";
const NON_ADMIN_TOKEN = "n4-nonadmin-token";

const ADMIN_USER = {
  id: ADMIN_ID,
  username: "admin_user",
  displayName: "Admin",
  email: "a@example.com",
  passwordHash: "x",
  createdAt: new Date(),
  updatedAt: new Date(),
};
const NON_ADMIN_USER = {
  id: NON_ADMIN_ID,
  username: "nobody",
  displayName: "Nobody",
  email: "n@example.com",
  passwordHash: "x",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  // softAuth reads sessions+users from DB OR sessionCache. Pre-warming the
  // cache is enough; `isSiteAdmin` reads from `site_admins` table via _nextAdminRow.
  sessionCache.set(ADMIN_TOKEN, ADMIN_USER as any);
  sessionCache.set(NON_ADMIN_TOKEN, NON_ADMIN_USER as any);
  _nextSessionRow = null;
  _nextUserRow = null;
  _nextAdminRow = null;
});

afterAll(() => {
  sessionCache.invalidate(ADMIN_TOKEN);
  sessionCache.invalidate(NON_ADMIN_TOKEN);
  adminDeploys.__setGithubFetchForTests(null);
  adminDeploys.__setEnvForTests(null);
  mock.module("../db", () => _real_db);
});

// CSRF protection accepts a POST when either the Origin matches the host OR
// a CSRF token cookie+header is supplied. We use the Origin-match path — set
// `host: localhost` and `origin: http://localhost` and the middleware
// recognises it as a same-origin request.
const SAME_ORIGIN_HEADERS = {
  host: "localhost",
  origin: "http://localhost",
};

function authedPost(token: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      ...SAME_ORIGIN_HEADERS,
      cookie: `session=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

describe("/admin/deploys/trigger", () => {
  it("403s for an authed non-admin user", async () => {
    _nextAdminRow = null;
    adminDeploys.__setEnvForTests({ GITHUB_TOKEN: "ghp_admin" });
    adminDeploys.__setGithubFetchForTests(async () => noContent());

    const res = await app.request(
      "/admin/deploys/trigger",
      authedPost(NON_ADMIN_TOKEN, {})
    );
    expect(res.status).toBe(403);
  });

  it("401s when not authenticated", async () => {
    adminDeploys.__setEnvForTests({ GITHUB_TOKEN: "ghp_admin" });
    adminDeploys.__setGithubFetchForTests(async () => noContent());
    const res = await app.request("/admin/deploys/trigger", {
      method: "POST",
      headers: { ...SAME_ORIGIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns a helpful 400 when GITHUB_TOKEN is unset", async () => {
    _nextAdminRow = { userId: ADMIN_ID }; // site admin
    adminDeploys.__setEnvForTests({});       // no token
    let called = false;
    adminDeploys.__setGithubFetchForTests(async () => {
      called = true;
      return noContent();
    });
    const res = await app.request(
      "/admin/deploys/trigger",
      authedPost(ADMIN_TOKEN, {})
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/GITHUB_TOKEN/);
    expect(called).toBe(false);
  });

  it("200s for admin and POSTs the dispatch to GitHub", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    adminDeploys.__setEnvForTests({ GITHUB_TOKEN: "ghp_admin" });
    let captured: { url: string; body?: string; method?: string } | null = null;
    adminDeploys.__setGithubFetchForTests(async (url, init) => {
      captured = { url, body: init?.body, method: init?.method };
      return noContent();
    });
    const res = await app.request(
      "/admin/deploys/trigger",
      authedPost(ADMIN_TOKEN, {})
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Default repo is the GitHub-side mirror (`ccantynz-alt`), NOT the
    // Gluecron-side name (`ccantynz`). GitHub doesn't know `ccantynz`,
    // so dispatching to that returned 404 in production until we fixed
    // the default. See src/routes/admin-deploys.tsx for the comment.
    expect(body.repo).toBe("ccantynz-alt/Gluecron.com");
    expect(body.workflow).toBe("hetzner-deploy.yml");
    expect(body.ref).toBe("main");
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain("/actions/workflows/hetzner-deploy.yml/dispatches");
    expect(JSON.parse(captured!.body!).ref).toBe("main");
  });

  it("502s when GitHub rejects the dispatch", async () => {
    _nextAdminRow = { userId: ADMIN_ID };
    adminDeploys.__setEnvForTests({ GITHUB_TOKEN: "ghp_admin" });
    adminDeploys.__setGithubFetchForTests(async () =>
      jsonRes(422, { message: "No ref found" })
    );
    const res = await app.request(
      "/admin/deploys/trigger",
      authedPost(ADMIN_TOKEN, { ref: "no-such-branch" })
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/422.*No ref found/);
  });
});

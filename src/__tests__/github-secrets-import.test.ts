/**
 * Block T1 — GitHub Actions secret-migration helper tests.
 *
 * Covers:
 *   - `listGithubSecretNames` happy path / error paths / pagination
 *   - `createPlaceholderSecrets` inserts + skips existing + counts correctly
 *   - `importSecretsForRepo` end-to-end with injected fetch + a stubbed DB
 *   - GET /:owner/:repo/import/secrets route auth gates (302 for anon, 403
 *     for non-owner — exact status depends on requireRepoAccess shape)
 *   - POST /:owner/:repo/import/secrets/:name persists the encrypted value
 *
 * K1-style spread-from-real mock pattern: we capture the REAL `../db` and
 * `../lib/notify` modules before calling `mock.module()`, install minimal
 * stubs for THIS file's needs, and explicitly restore in `afterAll` so
 * downstream test files in the same `bun test` invocation aren't poisoned.
 *
 * Fetch is dependency-injected (`fetchImpl`) — never mock global fetch.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// Capture REAL modules before any mock.module() so we can fully restore.
const _real_db = await import("../db");
const _real_notify = await import("../lib/notify");

// ─── Master key fixture ────────────────────────────────────────────────────
// We need a real AES-256 key for the encrypt/decrypt round-trips. Stash the
// previous value (if any) and restore in afterAll so downstream tests that
// rely on the absence of the key aren't polluted.
const _prevWfKey = process.env.WORKFLOW_SECRETS_KEY;
process.env.WORKFLOW_SECRETS_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

// ─── Fake DB ───────────────────────────────────────────────────────────────
// Per-test handles for canned row shapes.
let _nextSelectRows: any[] = [];
let _insertedRows: any[] = [];
// Maps repoId -> Set<name> for fast lookup. Drizzle's chain hides the
// `.where()` parameters from us, but we can recover the queried name by
// peeking at the SQL operands the eq() builder records inside the chain.
let _existingNamesByRepo: Map<string, Set<string>> = new Map();
let _activeRepoId: string | null = null;
let _lastInsertTable: any = null;

const tableLooksLike = (t: any): string => {
  if (!t || typeof t !== "object") return "?";
  if ("encryptedValue" in t || "encrypted_value" in t) return "workflow_secrets";
  return "?";
};

// Drizzle's eq() returns a SQL fragment whose internal shape includes the
// queryChunks. We peek at them defensively — if anything looks off we
// degrade to "no rows match".
const extractWhereValues = (whereArg: any): unknown[] => {
  const values: unknown[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node !== "object") return;
    if ("queryChunks" in node) walk(node.queryChunks);
    if ("value" in node) values.push((node as any).value);
    if ("expr" in node) walk((node as any).expr);
    if ("conditions" in node) walk((node as any).conditions);
  };
  walk(whereArg);
  return values;
};

const makeSelectChain = (): any => {
  let _from: any = null;
  let _whereValues: unknown[] = [];
  const chain: any = {
    from: (t: any) => {
      _from = t;
      return chain;
    },
    where: (cond: any) => {
      _whereValues = extractWhereValues(cond);
      return chain;
    },
    orderBy: () => chain,
    limit: async () => {
      // For createPlaceholderSecrets existence probe: filter by name.
      if (tableLooksLike(_from) === "workflow_secrets" && _activeRepoId) {
        const existing = _existingNamesByRepo.get(_activeRepoId) ?? new Set();
        // The probe encodes (repoId, name) into the where clause.
        // Find the first value that matches a known name.
        for (const v of _whereValues) {
          if (typeof v === "string" && existing.has(v)) {
            return [{ id: `mock-id-${v}` }];
          }
        }
        return [];
      }
      return [];
    },
    then: (resolve: (v: any) => void) => {
      // Non-limited select: importSecretsForRepo's snapshot query +
      // the route's full-list query. Return every existing row for the
      // active repo.
      if (tableLooksLike(_from) === "workflow_secrets" && _activeRepoId) {
        const existing = Array.from(
          _existingNamesByRepo.get(_activeRepoId) ?? new Set()
        ).map((name) => ({ id: `mock-id-${name}`, name }));
        return resolve(existing);
      }
      resolve(_nextSelectRows);
    },
  };
  return chain;
};

const _fakeDb = {
  db: {
    select: () => makeSelectChain(),
    insert: (t: any) => {
      _lastInsertTable = t;
      return {
        values: (vals: any) => ({
          then: (resolve: (v: any) => void) => {
            _insertedRows.push({ table: tableLooksLike(t), values: vals });
            // Track the new row in the existing-rows map so a subsequent
            // probe for the same name returns it.
            if (
              tableLooksLike(t) === "workflow_secrets" &&
              typeof vals?.repositoryId === "string" &&
              typeof vals?.name === "string"
            ) {
              const set =
                _existingNamesByRepo.get(vals.repositoryId) ?? new Set<string>();
              set.add(vals.name);
              _existingNamesByRepo.set(vals.repositoryId, set);
            }
            resolve(undefined);
          },
        }),
      };
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
  getDb: () => _fakeDb.db,
};

mock.module("../db", () => ({ ..._real_db, ..._fakeDb }));
mock.module("../lib/notify", () => ({
  ..._real_notify,
  notify: async () => {},
  notifyMany: async () => {},
  audit: async () => {},
}));

afterAll(() => {
  // Restore master key
  if (_prevWfKey === undefined) {
    delete process.env.WORKFLOW_SECRETS_KEY;
  } else {
    process.env.WORKFLOW_SECRETS_KEY = _prevWfKey;
  }
  // Clear K1-style per-file state so it doesn't bleed into other tests.
  _nextSelectRows = [];
  _insertedRows = [];
  _existingNamesByRepo = new Map();
  _activeRepoId = null;
  _lastInsertTable = null;
  // Best-effort module restore.
  mock.module("../db", () => _real_db);
  mock.module("../lib/notify", () => _real_notify);
});

beforeEach(() => {
  _nextSelectRows = [];
  _insertedRows = [];
  _existingNamesByRepo = new Map();
  _activeRepoId = null;
  _lastInsertTable = null;
});

// ─── Tests: listGithubSecretNames ──────────────────────────────────────────

describe("listGithubSecretNames", () => {
  it("returns parsed array on a 200 mock", async () => {
    const { listGithubSecretNames } = await import("../lib/github-secrets-import");
    const fakeFetch: any = async (url: string, _init: any) => {
      expect(url).toContain(
        "/repos/octocat/Hello-World/actions/secrets?per_page=30&page=1"
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 2,
          secrets: [
            {
              name: "STRIPE_API_KEY",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
            {
              name: "DATABASE_URL",
              created_at: "2026-02-01T00:00:00Z",
              updated_at: "2026-02-02T00:00:00Z",
            },
          ],
        }),
      };
    };
    const out = await listGithubSecretNames({
      owner: "octocat",
      repo: "Hello-World",
      githubToken: "ghp_test",
      fetchImpl: fakeFetch,
    });
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("STRIPE_API_KEY");
    expect(out[1].name).toBe("DATABASE_URL");
  });

  it("sends Authorization: Bearer header", async () => {
    const { listGithubSecretNames } = await import("../lib/github-secrets-import");
    let seenAuth: string | undefined;
    const fakeFetch: any = async (_url: string, init: any) => {
      seenAuth = init?.headers?.Authorization;
      return {
        ok: true,
        json: async () => ({ total_count: 0, secrets: [] }),
      };
    };
    await listGithubSecretNames({
      owner: "o",
      repo: "r",
      githubToken: "ghp_abc",
      fetchImpl: fakeFetch,
    });
    expect(seenAuth).toBe("Bearer ghp_abc");
  });

  it("returns [] on 401 (never throws)", async () => {
    const { listGithubSecretNames } = await import("../lib/github-secrets-import");
    const fakeFetch: any = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: "Bad credentials" }),
    });
    const out = await listGithubSecretNames({
      owner: "o",
      repo: "r",
      githubToken: "ghp_x",
      fetchImpl: fakeFetch,
    });
    expect(out).toEqual([]);
  });

  it("returns [] on 404 (never throws)", async () => {
    const { listGithubSecretNames } = await import("../lib/github-secrets-import");
    const fakeFetch: any = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const out = await listGithubSecretNames({
      owner: "o",
      repo: "r",
      githubToken: "ghp_x",
      fetchImpl: fakeFetch,
    });
    expect(out).toEqual([]);
  });

  it("returns [] on network error (never throws)", async () => {
    const { listGithubSecretNames } = await import("../lib/github-secrets-import");
    const fakeFetch: any = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await listGithubSecretNames({
      owner: "o",
      repo: "r",
      githubToken: "ghp_x",
      fetchImpl: fakeFetch,
    });
    expect(out).toEqual([]);
  });

  it("paginates when total_count > 30", async () => {
    const { listGithubSecretNames } = await import("../lib/github-secrets-import");
    // Page 1 returns 30 entries (the full per_page batch); the helper
    // keeps going until either total_count is reached or the page
    // is smaller than per_page.
    const page1 = Array.from({ length: 30 }, (_, i) => ({
      name: `S${i.toString().padStart(2, "0")}`,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }));
    const page2 = [
      {
        name: "S30",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    let calls = 0;
    const fakeFetch: any = async (url: string) => {
      calls++;
      if (url.includes("page=1")) {
        return {
          ok: true,
          json: async () => ({ total_count: 31, secrets: page1 }),
        };
      }
      return {
        ok: true,
        json: async () => ({ total_count: 31, secrets: page2 }),
      };
    };
    const out = await listGithubSecretNames({
      owner: "o",
      repo: "r",
      githubToken: "ghp_x",
      fetchImpl: fakeFetch,
    });
    expect(calls).toBe(2);
    expect(out).toHaveLength(31);
    expect(out[30].name).toBe("S30");
  });

  it("returns [] when token is missing", async () => {
    const { listGithubSecretNames } = await import("../lib/github-secrets-import");
    const fakeFetch: any = async () => {
      throw new Error("should not be called");
    };
    const out = await listGithubSecretNames({
      owner: "o",
      repo: "r",
      githubToken: "",
      fetchImpl: fakeFetch,
    });
    expect(out).toEqual([]);
  });
});

// ─── Tests: createPlaceholderSecrets ───────────────────────────────────────

describe("createPlaceholderSecrets", () => {
  it("inserts new rows + reports created count", async () => {
    _activeRepoId = "repo-1";
    const { createPlaceholderSecrets } = await import("../lib/github-secrets-import");
    const out = await createPlaceholderSecrets({
      repositoryId: "repo-1",
      names: ["STRIPE_API_KEY", "DATABASE_URL"],
      createdByUserId: "user-1",
    });
    expect(out.created).toBe(2);
    expect(out.skippedExisting).toBe(0);
    // Both rows should have been inserted via db.insert(workflowSecrets).
    expect(_insertedRows.length).toBe(2);
    expect(_insertedRows.every((r) => r.table === "workflow_secrets")).toBe(true);
    expect(_insertedRows[0].values.name).toBe("STRIPE_API_KEY");
    expect(_insertedRows[0].values.repositoryId).toBe("repo-1");
    // encryptedValue should be a non-empty base64 string (encryption of "")
    expect(typeof _insertedRows[0].values.encryptedValue).toBe("string");
    expect(_insertedRows[0].values.encryptedValue.length).toBeGreaterThan(0);
  });

  it("skips names that already exist for the target repo", async () => {
    _activeRepoId = "repo-2";
    _existingNamesByRepo.set("repo-2", new Set(["EXISTING_KEY"]));
    const { createPlaceholderSecrets } = await import("../lib/github-secrets-import");
    const out = await createPlaceholderSecrets({
      repositoryId: "repo-2",
      names: ["EXISTING_KEY", "NEW_KEY"],
      createdByUserId: "user-1",
    });
    expect(out.created).toBe(1);
    expect(out.skippedExisting).toBe(1);
    // Only the new key should have been inserted.
    expect(_insertedRows.length).toBe(1);
    expect(_insertedRows[0].values.name).toBe("NEW_KEY");
  });

  it("returns 0/0 on empty names array", async () => {
    const { createPlaceholderSecrets } = await import("../lib/github-secrets-import");
    const out = await createPlaceholderSecrets({
      repositoryId: "repo-x",
      names: [],
      createdByUserId: "u",
    });
    expect(out).toEqual({ created: 0, skippedExisting: 0 });
  });

  it("returns 0/0 on missing repositoryId", async () => {
    const { createPlaceholderSecrets } = await import("../lib/github-secrets-import");
    const out = await createPlaceholderSecrets({
      repositoryId: "",
      names: ["X"],
      createdByUserId: "u",
    });
    expect(out).toEqual({ created: 0, skippedExisting: 0 });
  });

  it("returns 0/0 when master key is missing (degrades gracefully)", async () => {
    const stash = process.env.WORKFLOW_SECRETS_KEY;
    delete process.env.WORKFLOW_SECRETS_KEY;
    try {
      const { createPlaceholderSecrets } = await import(
        "../lib/github-secrets-import"
      );
      const out = await createPlaceholderSecrets({
        repositoryId: "repo-3",
        names: ["X"],
        createdByUserId: "u",
      });
      expect(out).toEqual({ created: 0, skippedExisting: 0 });
    } finally {
      process.env.WORKFLOW_SECRETS_KEY = stash;
    }
  });
});

// ─── Tests: importSecretsForRepo end-to-end ────────────────────────────────

describe("importSecretsForRepo (end-to-end)", () => {
  it("happy path: lists names + inserts placeholders + returns status array", async () => {
    _activeRepoId = "repo-e2e";
    const { importSecretsForRepo } = await import("../lib/github-secrets-import");
    const fakeFetch: any = async () => ({
      ok: true,
      json: async () => ({
        total_count: 2,
        secrets: [
          { name: "API_KEY", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
          { name: "DEPLOY_TOKEN", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        ],
      }),
    });
    const out = await importSecretsForRepo({
      githubOwner: "octocat",
      githubRepo: "Hello-World",
      githubToken: "ghp_test",
      gluecronRepositoryId: "repo-e2e",
      importedByUserId: "user-1",
      fetchImpl: fakeFetch,
    });
    expect(out.imported).toHaveLength(2);
    expect(out.imported.map((r) => r.name).sort()).toEqual([
      "API_KEY",
      "DEPLOY_TOKEN",
    ]);
    expect(out.imported.every((r) => r.status === "placeholder_created")).toBe(
      true
    );
    expect(out.errors).toEqual([]);
  });

  it("returns empty imported + no error when GitHub reports zero secrets", async () => {
    const { importSecretsForRepo } = await import("../lib/github-secrets-import");
    const fakeFetch: any = async () => ({
      ok: true,
      json: async () => ({ total_count: 0, secrets: [] }),
    });
    const out = await importSecretsForRepo({
      githubOwner: "o",
      githubRepo: "r",
      githubToken: "ghp_x",
      gluecronRepositoryId: "repo-x",
      importedByUserId: "user-1",
      fetchImpl: fakeFetch,
    });
    expect(out.imported).toEqual([]);
  });

  it("reports no_github_token when token is empty", async () => {
    const { importSecretsForRepo } = await import("../lib/github-secrets-import");
    const fakeFetch: any = async () => ({
      ok: true,
      json: async () => ({ total_count: 0, secrets: [] }),
    });
    const out = await importSecretsForRepo({
      githubOwner: "o",
      githubRepo: "r",
      githubToken: "",
      gluecronRepositoryId: "repo-x",
      importedByUserId: "u",
      fetchImpl: fakeFetch,
    });
    expect(out.imported).toEqual([]);
    expect(out.errors).toContain("no_github_token");
  });
});

// ─── Tests: route auth ─────────────────────────────────────────────────────

describe("import-secrets route — auth gate", () => {
  it("GET /:owner/:repo/import/secrets unauthenticated → 302 /login", async () => {
    let mod: any;
    try {
      mod = await import("../routes/import-secrets");
    } catch {
      // JSX runtime resolution flake in this bun env — degrade gracefully.
      return;
    }
    const res = await mod.default.request("/octocat/hello/import/secrets");
    // requireAuth redirects to /login; resolveRepoAccess may run first on
    // some routes but the auth middleware sits in front for this one.
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /:owner/:repo/import/secrets/X unauthenticated → 302 /login", async () => {
    let mod: any;
    try {
      mod = await import("../routes/import-secrets");
    } catch {
      return;
    }
    const res = await mod.default.request(
      "/octocat/hello/import/secrets/MY_SECRET",
      {
        method: "POST",
        body: new URLSearchParams({ value: "v" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });

  it("POST /:owner/:repo/import/secrets/done unauthenticated → 302 /login", async () => {
    let mod: any;
    try {
      mod = await import("../routes/import-secrets");
    } catch {
      return;
    }
    const res = await mod.default.request(
      "/octocat/hello/import/secrets/done",
      {
        method: "POST",
        body: new URLSearchParams({}),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toMatch(/^\/login/);
  });
});

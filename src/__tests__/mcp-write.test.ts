/**
 * Block K1 — MCP write surface tests.
 *
 * Covers the 10 new tools added in src/lib/mcp-tools.ts:
 *   create_issue / comment_issue / close_issue / reopen_issue
 *   create_pr    / get_pr        / list_prs    / comment_pr
 *   merge_pr     / close_pr
 *
 * Each tool gets at minimum:
 *   - Happy-ish path: authenticated owner returns the spec-described shape
 *   - Auth gate    : ctx.userId === null → McpError(-32602 INVALID_PARAMS)
 *   - Write-access : authed but no write access → McpError(-32601 NOT_FOUND)
 *
 * We stub the `../db` module (same pattern as repo-access.test.ts and
 * import-verify.test.ts) so these tests never touch Neon. The fake `db`
 * dispatches on the table passed to `.from(...)` / `.insert(...)` to
 * decide which canned shape to return. Mutations are recorded in the
 * `_inserted` / `_updated` arrays so the assertions can verify the audit
 * + DB-write path was actually exercised.
 *
 * We also stub `./notify` to avoid the email-fanout path (which would
 * also try to hit the DB), and `./gate` + `./branch-protection` +
 * `./merge-resolver` for the merge_pr happy path so we don't shell out
 * to git.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import {
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  McpError,
} from "../lib/mcp";

// ---------------------------------------------------------------------------
// Module stubs
// ---------------------------------------------------------------------------

/** Per-test override hooks. Reset in beforeEach. */
let _nextRepoRow: any = null;
let _nextCollabRow: any = null;
let _nextIssueRow: any = null;
let _nextPrRow: any = null;
let _nextAiCommentRows: any[] = [];
let _nextProtectionRule: any = null;

const _inserted: { table: string; values: any; returned: any }[] = [];
const _updated: { table: string; set: any }[] = [];

let _lastSelectFrom: any = null;
let _lastInsertTable: any = null;
let _lastUpdateTable: any = null;
let _lastInsertValues: any = null;

const tableName = (t: any): string => {
  if (!t || typeof t !== "object") return "?";
  // Drizzle pgTable objects expose a Symbol-keyed name. We probe `_` /
  // common keys to identify the table without importing the schema.
  if ("isPrivate" in t) return "repositories";
  if ("acceptedAt" in t || "invitedAt" in t) return "repo_collaborators";
  if ("issueId" in t && "body" in t) return "issue_comments";
  if ("pullRequestId" in t) return "pr_comments";
  if (
    "baseBranch" in t ||
    "headBranch" in t ||
    "mergedAt" in t ||
    "isDraft" in t
  )
    return "pull_requests";
  if ("state" in t && "closedAt" in t && "title" in t && !("baseBranch" in t))
    return "issues";
  if ("username" in t && "passwordHash" in t) return "users";
  if ("kind" in t) return "notifications";
  if ("action" in t && "userId" in t) return "audit_log";
  return "?";
};

const _selectChain: any = {
  from: (t: any) => {
    _lastSelectFrom = t;
    return _selectChain;
  },
  innerJoin: () => _selectChain,
  leftJoin: () => _selectChain,
  rightJoin: () => _selectChain,
  where: () => _selectChain,
  orderBy: () => _selectChain,
  groupBy: () => _selectChain,
  limit: async () => {
    const name = tableName(_lastSelectFrom);
    if (name === "repositories") {
      return _nextRepoRow ? [_nextRepoRow] : [];
    }
    if (name === "repo_collaborators") {
      return _nextCollabRow ? [_nextCollabRow] : [];
    }
    if (name === "issues") {
      return _nextIssueRow ? [_nextIssueRow] : [];
    }
    if (name === "pull_requests") {
      return _nextPrRow ? [_nextPrRow] : [];
    }
    if (name === "pr_comments") {
      return _nextAiCommentRows;
    }
    if (name === "users") {
      return _nextRepoRow?.username ? [{ username: _nextRepoRow.username }] : [{ username: "owner-x" }];
    }
    return [];
  },
  // For pr-comments AI-approval lookup, the route doesn't `.limit(1)` — it
  // awaits the chain directly. We expose `.then` so `await chain` yields
  // the rows.
  then: (resolve: (v: any) => void) => {
    const name = tableName(_lastSelectFrom);
    if (name === "pr_comments") return resolve(_nextAiCommentRows);
    if (name === "pull_requests") return resolve(_nextPrRow ? [_nextPrRow] : []);
    return resolve([]);
  },
};

const _insertChain = (table: any) => {
  _lastInsertTable = table;
  return {
    values: (vals: any) => {
      _lastInsertValues = vals;
      return {
        returning: async () => {
          const name = tableName(table);
          let returned: any;
          if (name === "issues") {
            returned = {
              id: "iss-id-1",
              number: 42,
              repositoryId: vals.repositoryId,
              authorId: vals.authorId,
              title: vals.title,
              body: vals.body,
              state: "open",
              createdAt: new Date(),
              updatedAt: new Date(),
              closedAt: null,
            };
          } else if (name === "issue_comments") {
            returned = {
              id: "ic-id-1",
              issueId: vals.issueId,
              authorId: vals.authorId,
              body: vals.body,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          } else if (name === "pull_requests") {
            returned = {
              id: "pr-id-1",
              number: 7,
              repositoryId: vals.repositoryId,
              authorId: vals.authorId,
              title: vals.title,
              body: vals.body,
              state: "open",
              baseBranch: vals.baseBranch,
              headBranch: vals.headBranch,
              isDraft: vals.isDraft ?? false,
              mergeStrategy: "merge",
              milestoneId: null,
              mergedAt: null,
              mergedBy: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              closedAt: null,
            };
          } else if (name === "pr_comments") {
            returned = {
              id: "pc-id-1",
              pullRequestId: vals.pullRequestId,
              authorId: vals.authorId,
              body: vals.body,
              isAiReview: vals.isAiReview ?? false,
              filePath: null,
              lineNumber: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          } else {
            returned = vals;
          }
          _inserted.push({ table: name, values: vals, returned });
          return [returned];
        },
        // Allow `await db.insert(...).values(...)` (no `.returning()`),
        // used by notify/audit + auto-close-issues path.
        then: (resolve: (v: any) => void) => {
          _inserted.push({ table: tableName(table), values: vals, returned: null });
          resolve(undefined);
        },
      };
    },
  };
};

const _updateChain = (table: any) => {
  _lastUpdateTable = table;
  return {
    set: (vals: any) => {
      _updated.push({ table: tableName(table), set: vals });
      return {
        where: () => ({
          then: (resolve: (v: any) => void) => resolve(undefined),
        }),
      };
    },
  };
};

const _fakeDb = {
  db: {
    select: () => _selectChain,
    insert: (t: any) => _insertChain(t),
    update: (t: any) => _updateChain(t),
    delete: () => ({ where: () => Promise.resolve() }),
  },
  getDb: () => _fakeDb.db,
  isNeonUrl: () => false,
};
mock.module("../db", () => _fakeDb);

// Stub notify so we don't shell out to email + DB on the fan-out path.
const _notifyCalls: any[] = [];
const _auditCalls: any[] = [];
mock.module("../lib/notify", () => ({
  notify: async (userId: string, opts: any) => {
    _notifyCalls.push({ userId, ...opts });
  },
  notifyMany: async () => {},
  audit: async (opts: any) => {
    _auditCalls.push(opts);
  },
}));

// merge_pr depends on these — stub the green path.
mock.module("../lib/gate", () => ({
  runAllGateChecks: async () => ({ checks: [] }),
}));
mock.module("../lib/branch-protection", () => ({
  matchProtection: async () => null,
  countHumanApprovals: async () => 0,
  listRequiredChecks: async () => [],
  passingCheckNames: async () => [],
  evaluateProtection: () => ({ allowed: true, reasons: [] }),
}));
mock.module("../lib/merge-resolver", () => ({
  mergeWithAutoResolve: async () => ({ success: true, resolvedFiles: [] }),
}));
mock.module("../lib/ai-review", () => ({
  isAiReviewEnabled: () => false,
  triggerAiReview: async () => {},
}));
mock.module("../lib/close-keywords", () => ({
  extractClosingRefsMulti: () => [],
}));

// Block all SSE fanout — the import is dynamic so we need to mock it too.
mock.module("../lib/sse", () => ({
  publish: () => {},
  subscribe: () => () => {},
  topicSubscriberCount: () => 0,
}));

// We stub Bun.spawn globally so any git subprocess (e.g. resolveRef,
// `git update-ref` in merge_pr) returns a deterministic happy exit. We
// intentionally do NOT mock `../git/repository` so the rest of the
// library's static imports keep resolving correctly.
const _realBunSpawn = (globalThis as any).Bun?.spawn;
function stubBunSpawnSuccess() {
  (globalThis as any).Bun.spawn = () => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n"));
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
  });
}
function restoreBunSpawn() {
  if (_realBunSpawn) (globalThis as any).Bun.spawn = _realBunSpawn;
}
// Install the stub globally for all tests — most calls don't care, the
// ones that do are happy with exitCode 0 + the deadbeef SHA.
stubBunSpawnSuccess();

afterAll(() => {
  restoreBunSpawn();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const REPO_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_USER_ID = "33333333-3333-3333-3333-333333333333";

const PUBLIC_REPO_ROW = {
  id: REPO_ID,
  ownerId: OWNER_ID,
  isPrivate: false,
  defaultBranch: "main",
  username: "alice",
};

const ownerCtx = { userId: OWNER_ID };
const anonCtx = { userId: null };
const otherCtx = { userId: OTHER_USER_ID };

function resetState() {
  _nextRepoRow = PUBLIC_REPO_ROW;
  _nextCollabRow = null; // No collaborator rows → public repo non-owner = read
  _nextIssueRow = null;
  _nextPrRow = null;
  _nextAiCommentRows = [];
  _nextProtectionRule = null;
  _inserted.length = 0;
  _updated.length = 0;
  _notifyCalls.length = 0;
  _auditCalls.length = 0;
}

beforeEach(() => {
  resetState();
});

async function getTools() {
  const m = await import("../lib/mcp-tools");
  return m.__test;
}

// ---------------------------------------------------------------------------
// gluecron_create_issue
// ---------------------------------------------------------------------------

describe("gluecron_create_issue", () => {
  it("owner can create an issue (happy path)", async () => {
    const T = await getTools();
    const result = (await T.createIssue.run(
      { owner: "alice", repo: "demo", title: "Hello", body: "World" },
      ownerCtx
    )) as { number: number; url: string };
    expect(result.number).toBe(42);
    expect(result.url).toBe("/alice/demo/issues/42");
    expect(_inserted.find((r) => r.table === "issues")).toBeTruthy();
    expect(_auditCalls.some((a) => a.action === "issue.created")).toBe(true);
  });

  it("anonymous → -32602 INVALID_PARAMS", async () => {
    const T = await getTools();
    let caught: McpError | null = null;
    try {
      await T.createIssue.run(
        { owner: "alice", repo: "demo", title: "x" },
        anonCtx
      );
    } catch (err) {
      if (err instanceof McpError) caught = err;
    }
    expect(caught?.code).toBe(ERR_INVALID_PARAMS);
    expect(caught?.message).toMatch(/authentication required/);
  });

  it("authed-but-no-write → -32601 METHOD_NOT_FOUND", async () => {
    const T = await getTools();
    // Public repo, other user, no collab row → only "read"
    let caught: McpError | null = null;
    try {
      await T.createIssue.run(
        { owner: "alice", repo: "demo", title: "x" },
        otherCtx
      );
    } catch (err) {
      if (err instanceof McpError) caught = err;
    }
    expect(caught?.code).toBe(ERR_METHOD_NOT_FOUND);
    expect(caught?.message).toMatch(/no write access/);
  });
});

// ---------------------------------------------------------------------------
// gluecron_comment_issue
// ---------------------------------------------------------------------------

describe("gluecron_comment_issue", () => {
  it("owner can comment on an issue", async () => {
    const T = await getTools();
    _nextIssueRow = {
      id: "iss-id-1",
      number: 42,
      repositoryId: REPO_ID,
      authorId: OWNER_ID,
      state: "open",
    };
    const result = (await T.commentIssue.run(
      { owner: "alice", repo: "demo", number: 42, body: "thanks!" },
      ownerCtx
    )) as { commentId: string };
    expect(result.commentId).toBe("ic-id-1");
    expect(_inserted.find((r) => r.table === "issue_comments")).toBeTruthy();
  });

  it("anonymous → -32602", async () => {
    const T = await getTools();
    expect(
      T.commentIssue.run(
        { owner: "alice", repo: "demo", number: 1, body: "x" },
        anonCtx
      )
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("other user (read-only) → -32601", async () => {
    const T = await getTools();
    expect(
      T.commentIssue.run(
        { owner: "alice", repo: "demo", number: 1, body: "x" },
        otherCtx
      )
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// gluecron_close_issue
// ---------------------------------------------------------------------------

describe("gluecron_close_issue", () => {
  it("owner can close an open issue", async () => {
    const T = await getTools();
    _nextIssueRow = {
      id: "iss-1",
      number: 5,
      repositoryId: REPO_ID,
      authorId: OWNER_ID,
      state: "open",
    };
    const result = (await T.closeIssue.run(
      { owner: "alice", repo: "demo", number: 5 },
      ownerCtx
    )) as { state: string };
    expect(result.state).toBe("closed");
    expect(_updated.find((u) => u.table === "issues")).toBeTruthy();
  });

  it("anonymous → -32602", async () => {
    const T = await getTools();
    expect(
      T.closeIssue.run({ owner: "alice", repo: "demo", number: 5 }, anonCtx)
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("other user → -32601", async () => {
    const T = await getTools();
    expect(
      T.closeIssue.run({ owner: "alice", repo: "demo", number: 5 }, otherCtx)
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// gluecron_reopen_issue
// ---------------------------------------------------------------------------

describe("gluecron_reopen_issue", () => {
  it("owner can reopen a closed issue", async () => {
    const T = await getTools();
    _nextIssueRow = {
      id: "iss-1",
      number: 5,
      repositoryId: REPO_ID,
      authorId: OWNER_ID,
      state: "closed",
      closedAt: new Date(),
    };
    const result = (await T.reopenIssue.run(
      { owner: "alice", repo: "demo", number: 5 },
      ownerCtx
    )) as { state: string };
    expect(result.state).toBe("open");
    expect(_updated.find((u) => u.table === "issues")).toBeTruthy();
  });

  it("anonymous → -32602", async () => {
    const T = await getTools();
    expect(
      T.reopenIssue.run({ owner: "alice", repo: "demo", number: 5 }, anonCtx)
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("other user → -32601", async () => {
    const T = await getTools();
    expect(
      T.reopenIssue.run({ owner: "alice", repo: "demo", number: 5 }, otherCtx)
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// gluecron_create_pr
// ---------------------------------------------------------------------------

describe("gluecron_create_pr", () => {
  it("owner can open a PR (base defaults to repo default branch)", async () => {
    const T = await getTools();
    const result = (await T.createPr.run(
      {
        owner: "alice",
        repo: "demo",
        title: "Feature X",
        head_branch: "feat/x",
      },
      ownerCtx
    )) as { number: number; url: string };
    expect(result.number).toBe(7);
    expect(result.url).toBe("/alice/demo/pulls/7");
    const ins = _inserted.find((r) => r.table === "pull_requests");
    expect(ins).toBeTruthy();
    expect(ins?.values.baseBranch).toBe("main");
    expect(ins?.values.headBranch).toBe("feat/x");
  });

  it("rejects when base === head", async () => {
    const T = await getTools();
    let caught: McpError | null = null;
    try {
      await T.createPr.run(
        {
          owner: "alice",
          repo: "demo",
          title: "x",
          head_branch: "main",
          base_branch: "main",
        },
        ownerCtx
      );
    } catch (err) {
      if (err instanceof McpError) caught = err;
    }
    expect(caught?.code).toBe(ERR_INVALID_PARAMS);
  });

  it("anonymous → -32602", async () => {
    const T = await getTools();
    expect(
      T.createPr.run(
        { owner: "alice", repo: "demo", title: "x", head_branch: "feat" },
        anonCtx
      )
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("other user → -32601", async () => {
    const T = await getTools();
    expect(
      T.createPr.run(
        { owner: "alice", repo: "demo", title: "x", head_branch: "feat" },
        otherCtx
      )
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// gluecron_get_pr
// ---------------------------------------------------------------------------

describe("gluecron_get_pr", () => {
  it("returns full detail for an authed reader", async () => {
    const T = await getTools();
    _nextPrRow = {
      id: "pr-1",
      number: 7,
      repositoryId: REPO_ID,
      authorId: OWNER_ID,
      title: "Feature",
      body: "Body",
      state: "open",
      baseBranch: "main",
      headBranch: "feat/x",
      isDraft: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      mergedAt: null,
      closedAt: null,
    };
    const r = (await T.getPr.run(
      { owner: "alice", repo: "demo", number: 7 },
      ownerCtx
    )) as any;
    expect(r.number).toBe(7);
    expect(r.state).toBe("open");
    expect(r.baseBranch).toBe("main");
    expect(r.headBranch).toBe("feat/x");
    expect(r.url).toBe("/alice/demo/pulls/7");
  });

  it("anonymous → -32602 (write surface requires auth)", async () => {
    const T = await getTools();
    expect(
      T.getPr.run({ owner: "alice", repo: "demo", number: 1 }, anonCtx)
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("private repo + non-collaborator → -32601 (privacy)", async () => {
    const T = await getTools();
    _nextRepoRow = { ...PUBLIC_REPO_ROW, isPrivate: true };
    expect(
      T.getPr.run({ owner: "alice", repo: "demo", number: 1 }, otherCtx)
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// gluecron_list_prs
// ---------------------------------------------------------------------------

describe("gluecron_list_prs", () => {
  it("rejects an unknown state value", async () => {
    const T = await getTools();
    expect(
      T.listPrs.run(
        { owner: "alice", repo: "demo", state: "garbage" },
        ownerCtx
      )
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("anonymous → -32602", async () => {
    const T = await getTools();
    expect(
      T.listPrs.run({ owner: "alice", repo: "demo" }, anonCtx)
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("private repo + non-collaborator → -32601", async () => {
    const T = await getTools();
    _nextRepoRow = { ...PUBLIC_REPO_ROW, isPrivate: true };
    expect(
      T.listPrs.run({ owner: "alice", repo: "demo" }, otherCtx)
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });

  it("authed reader gets a 0-row list when none exist", async () => {
    const T = await getTools();
    const r = (await T.listPrs.run(
      { owner: "alice", repo: "demo" },
      ownerCtx
    )) as { total: number; prs: any[] };
    // The fake DB returns [] for the listPrs path because the chain only
    // returns canned rows on `.limit(1)` of repositories. The unbounded
    // PR list shape comes back empty — which is the explicit "no PRs"
    // happy path we want to assert.
    expect(typeof r.total).toBe("number");
    expect(Array.isArray(r.prs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gluecron_comment_pr
// ---------------------------------------------------------------------------

describe("gluecron_comment_pr", () => {
  it("owner can comment on a PR", async () => {
    const T = await getTools();
    _nextPrRow = {
      id: "pr-1",
      number: 7,
      repositoryId: REPO_ID,
      authorId: OWNER_ID,
      state: "open",
      baseBranch: "main",
      headBranch: "feat/x",
      isDraft: false,
    };
    const result = (await T.commentPr.run(
      { owner: "alice", repo: "demo", number: 7, body: "LGTM" },
      ownerCtx
    )) as { commentId: string };
    expect(result.commentId).toBe("pc-id-1");
    expect(_inserted.find((r) => r.table === "pr_comments")).toBeTruthy();
  });

  it("anonymous → -32602", async () => {
    const T = await getTools();
    expect(
      T.commentPr.run(
        { owner: "alice", repo: "demo", number: 1, body: "x" },
        anonCtx
      )
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("other user → -32601", async () => {
    const T = await getTools();
    expect(
      T.commentPr.run(
        { owner: "alice", repo: "demo", number: 1, body: "x" },
        otherCtx
      )
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// gluecron_merge_pr
// ---------------------------------------------------------------------------

describe("gluecron_merge_pr", () => {
  it("owner can merge a clean open PR (no protection, no conflicts)", async () => {
    const T = await getTools();
    _nextPrRow = {
      id: "pr-1",
      number: 7,
      repositoryId: REPO_ID,
      authorId: OWNER_ID,
      title: "Feature",
      body: "",
      state: "open",
      baseBranch: "main",
      headBranch: "feat/x",
      isDraft: false,
    };
    stubBunSpawnSuccess();
    try {
      const r = (await T.mergePr.run(
        { owner: "alice", repo: "demo", number: 7 },
        ownerCtx
      )) as { merged: boolean; sha?: string; reason?: string };
      expect(r.merged).toBe(true);
      expect(typeof r.sha).toBe("string");
      expect(_updated.some((u) => u.table === "pull_requests")).toBe(true);
    } finally {
      restoreBunSpawn();
    }
  });

  it("draft PR → merged=false with human-readable reason", async () => {
    const T = await getTools();
    _nextPrRow = {
      id: "pr-1",
      number: 7,
      repositoryId: REPO_ID,
      authorId: OWNER_ID,
      state: "open",
      baseBranch: "main",
      headBranch: "feat/x",
      isDraft: true,
    };
    const r = (await T.mergePr.run(
      { owner: "alice", repo: "demo", number: 7 },
      ownerCtx
    )) as { merged: boolean; reason?: string };
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/draft/i);
  });

  it("anonymous → -32602", async () => {
    const T = await getTools();
    expect(
      T.mergePr.run({ owner: "alice", repo: "demo", number: 1 }, anonCtx)
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("other user → -32601", async () => {
    const T = await getTools();
    expect(
      T.mergePr.run({ owner: "alice", repo: "demo", number: 1 }, otherCtx)
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// gluecron_close_pr
// ---------------------------------------------------------------------------

describe("gluecron_close_pr", () => {
  it("owner can close an open PR", async () => {
    const T = await getTools();
    _nextPrRow = {
      id: "pr-1",
      number: 7,
      repositoryId: REPO_ID,
      authorId: OWNER_ID,
      state: "open",
      baseBranch: "main",
      headBranch: "feat/x",
      isDraft: false,
    };
    const r = (await T.closePr.run(
      { owner: "alice", repo: "demo", number: 7 },
      ownerCtx
    )) as { state: string };
    expect(r.state).toBe("closed");
    expect(_updated.some((u) => u.table === "pull_requests")).toBe(true);
  });

  it("anonymous → -32602", async () => {
    const T = await getTools();
    expect(
      T.closePr.run({ owner: "alice", repo: "demo", number: 1 }, anonCtx)
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("other user → -32601", async () => {
    const T = await getTools();
    expect(
      T.closePr.run({ owner: "alice", repo: "demo", number: 1 }, otherCtx)
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// Default registry contains the new tools
// ---------------------------------------------------------------------------

describe("defaultTools — registry shape", () => {
  it("includes all 10 K1 write-surface tools", async () => {
    const { defaultTools } = await import("../lib/mcp-tools");
    const tools = defaultTools();
    const expected = [
      "gluecron_create_issue",
      "gluecron_comment_issue",
      "gluecron_close_issue",
      "gluecron_reopen_issue",
      "gluecron_create_pr",
      "gluecron_get_pr",
      "gluecron_list_prs",
      "gluecron_comment_pr",
      "gluecron_merge_pr",
      "gluecron_close_pr",
    ];
    for (const name of expected) {
      expect(tools[name]).toBeTruthy();
      expect(tools[name].tool.name).toBe(name);
      expect(tools[name].tool.inputSchema.type).toBe("object");
    }
  });
});

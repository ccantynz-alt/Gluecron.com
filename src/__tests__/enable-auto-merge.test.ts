/**
 * Block N1 — Tests for the auto-merge bootstrap + readiness scripts.
 *
 * The script exports a pure orchestrator (`runEnableAutoMerge`) that
 * takes a DB-shaped dependency and an `audit` callback. We feed it a
 * hand-rolled fake DB that records inserts / updates / selects so every
 * branch (insert vs update vs no-op) is observable without going near
 * Neon.
 *
 * No `mock.module()` here on purpose — the orchestrator was designed
 * with explicit DI so we don't have to poison the module graph for
 * downstream test files.
 */

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  runEnableAutoMerge,
  renderDiff,
  resolveRepo,
  type DbLike,
  type EnableAutoMergeArgs,
} from "../../scripts/enable-auto-merge";
import {
  checkAnthropicKey,
  checkAutopilotEnabled,
  checkAutoMergeSweepRegistered,
  checkMigration0040,
} from "../../scripts/check-auto-merge-readiness";
import type { BranchProtection } from "../db/schema";

// ---------------------------------------------------------------------------
// Fake DB — narrowly scoped to the script's actual queries.
// ---------------------------------------------------------------------------

interface FakeState {
  users: Array<{ id: string; username: string }>;
  repositories: Array<{
    id: string;
    ownerId: string;
    name: string;
    defaultBranch: string;
  }>;
  branchProtection: BranchProtection[];
  inserts: Array<{ table: string; values: any }>;
  updates: Array<{ table: string; set: any }>;
}

function freshState(): FakeState {
  return {
    users: [],
    repositories: [],
    branchProtection: [],
    inserts: [],
    updates: [],
  };
}

/**
 * Inspect a Drizzle pgTable proxy to identify it by a unique-shape
 * column. We mirror the K1 approach: peek at well-known columns rather
 * than importing the schema-internal Symbol.
 */
function tableName(t: any): string {
  if (!t || typeof t !== "object") return "?";
  if ("isPrivate" in t && "defaultBranch" in t) return "repositories";
  if ("username" in t && "passwordHash" in t) return "users";
  if ("pattern" in t && "enableAutoMerge" in t) return "branch_protection";
  if ("action" in t && "userId" in t && "targetType" in t) return "audit_log";
  return "?";
}

/**
 * Build a where-predicate from a Drizzle SQL expression. We can't
 * introspect Drizzle's AST cheaply, so the fake instead records the
 * "select context" (which table is being queried) and the test sets
 * `_filter` when needed. For this script's queries we only need one
 * filter per call so we infer it from the most recent select.
 */
function makeDb(state: FakeState): DbLike {
  let _selectTable: string = "?";
  let _selectCols: any = null;
  let _selectFilter: any = null;

  // Drizzle's `eq(col, val)` returns a plain object — we don't need to
  // unwrap it. Instead we capture the *operand* values via wrapped
  // helpers that the script itself uses through drizzle-orm.
  // For our purposes the filter just needs to be applied in `.limit()`
  // or `.where().limit()`, so we approximate: each table only has one
  // representative row that the test wants matched. We match by the
  // first call argument shape.

  const selectChain: any = {
    from: (t: any) => {
      _selectTable = tableName(t);
      return selectChain;
    },
    where: (cond: any) => {
      _selectFilter = cond;
      return selectChain;
    },
    limit: async () => {
      return resolveSelect(_selectTable, _selectFilter, _selectCols, state);
    },
  };

  return {
    select: (cols?: any) => {
      _selectCols = cols;
      _selectTable = "?";
      _selectFilter = null;
      return selectChain;
    },
    insert: (t: any) => {
      const name = tableName(t);
      return {
        values: (vals: any) => {
          state.inserts.push({ table: name, values: vals });
          if (name === "branch_protection") {
            // Synthesize a BranchProtection row.
            const row: BranchProtection = {
              id: `bp-${state.branchProtection.length + 1}`,
              repositoryId: vals.repositoryId,
              pattern: vals.pattern,
              requirePullRequest: vals.requirePullRequest ?? true,
              requireGreenGates: vals.requireGreenGates ?? true,
              requireAiApproval: vals.requireAiApproval ?? true,
              requireHumanReview: vals.requireHumanReview ?? false,
              requiredApprovals: vals.requiredApprovals ?? 0,
              allowForcePush: vals.allowForcePush ?? false,
              allowDeletion: vals.allowDeletion ?? false,
              dismissStaleReviews: vals.dismissStaleReviews ?? false,
              enableAutoMerge: vals.enableAutoMerge ?? false,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            state.branchProtection.push(row);
            return {
              returning: async () => [row],
            };
          }
          return {
            returning: async () => [vals],
          };
        },
      };
    },
    update: (t: any) => {
      const name = tableName(t);
      return {
        set: (vals: any) => {
          state.updates.push({ table: name, set: vals });
          return {
            where: async () => {
              if (name === "branch_protection") {
                // Apply set values to the single bp row (script only
                // updates by id, and tests only have one bp row at a time).
                for (const r of state.branchProtection) {
                  Object.assign(r, vals);
                }
              }
              return undefined;
            },
          };
        },
      };
    },
  };
}

function resolveSelect(
  table: string,
  _filter: any,
  _cols: any,
  state: FakeState
): any[] {
  // Approximation: return the (single) configured row for the table.
  // resolveRepo issues two selects in sequence — first against `users`,
  // then `repositories` — and the script only seeds one of each in
  // these tests, so returning the first row is sufficient.
  if (table === "users") {
    return state.users.length > 0 ? [state.users[0]] : [];
  }
  if (table === "repositories") {
    return state.repositories.length > 0
      ? [{
          id: state.repositories[0]!.id,
          ownerId: state.repositories[0]!.ownerId,
          name: state.repositories[0]!.name,
          defaultBranch: state.repositories[0]!.defaultBranch,
        }]
      : [];
  }
  if (table === "branch_protection") {
    return state.branchProtection.length > 0
      ? [state.branchProtection[0]]
      : [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Audit fake
// ---------------------------------------------------------------------------

type AuditCall = {
  userId?: string | null;
  repositoryId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
};

function makeAudit(sink: AuditCall[]) {
  return async (opts: AuditCall) => {
    sink.push(opts);
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let state: FakeState;
let audits: AuditCall[];
let db: DbLike;

function seedRepo(opts?: { withProtection?: Partial<BranchProtection> }) {
  state.users.push({ id: "user-1", username: "ccantynz" });
  state.repositories.push({
    id: "repo-1",
    ownerId: "user-1",
    name: "Gluecron.com",
    defaultBranch: "main",
  });
  if (opts?.withProtection) {
    state.branchProtection.push({
      id: "bp-existing",
      repositoryId: "repo-1",
      pattern: "main",
      requirePullRequest: true,
      requireGreenGates: true,
      requireAiApproval: true,
      requireHumanReview: false,
      requiredApprovals: 0,
      allowForcePush: false,
      allowDeletion: false,
      dismissStaleReviews: false,
      enableAutoMerge: false,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ...opts.withProtection,
    } as BranchProtection);
  }
}

beforeEach(() => {
  state = freshState();
  audits = [];
  db = makeDb(state);
});

afterAll(() => {
  // No module-level mocks installed — nothing to undo. Reset state for
  // hygiene anyway.
  state = freshState();
  audits = [];
});

// ---------------------------------------------------------------------------
// resolveRepo
// ---------------------------------------------------------------------------

describe("resolveRepo", () => {
  test("returns the repo when owner + name match", async () => {
    seedRepo();
    const r = await resolveRepo(db, "ccantynz/Gluecron.com");
    expect(r).not.toBeNull();
    expect(r?.id).toBe("repo-1");
  });

  test("returns null when the owner doesn't exist", async () => {
    // No seeded users
    const r = await resolveRepo(db, "ghost/repo");
    expect(r).toBeNull();
  });

  test("rejects malformed owner/name", async () => {
    seedRepo();
    expect(await resolveRepo(db, "no-slash")).toBeNull();
    expect(await resolveRepo(db, "/")).toBeNull();
    expect(await resolveRepo(db, "owner/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runEnableAutoMerge — INSERT path
// ---------------------------------------------------------------------------

describe("runEnableAutoMerge — fresh insert", () => {
  test("inserts a new branch_protection row with the safety defaults", async () => {
    seedRepo(); // no existing protection
    const args: EnableAutoMergeArgs = {
      ownerSlash: "ccantynz/Gluecron.com",
      pattern: "main",
    };
    const result = await runEnableAutoMerge(db, args, makeAudit(audits));

    expect(result.action).toBe("inserted");
    expect(result.before).toBeNull();
    expect(result.after.enableAutoMerge).toBe(true);

    // Safety defaults present on insert.
    const ins = state.inserts.find((i) => i.table === "branch_protection");
    expect(ins).toBeTruthy();
    expect(ins!.values.requireGreenGates).toBe(true);
    expect(ins!.values.requireAiApproval).toBe(true);
    expect(ins!.values.requireHumanReview).toBe(false);
    expect(ins!.values.requiredApprovals).toBe(0);
    expect(ins!.values.enableAutoMerge).toBe(true);
    expect(ins!.values.dismissStaleReviews).toBe(false);
    expect(ins!.values.allowForcePush).toBe(false);
    expect(ins!.values.allowDeletion).toBe(false);

    // Audit row written.
    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe("auto_merge.enabled_on_main");
    expect(audits[0]!.repositoryId).toBe("repo-1");
    expect(audits[0]!.targetType).toBe("branch_protection");
  });

  test("throws a clear error when the repo isn't found", async () => {
    // No seed — empty DB.
    let caught: Error | null = null;
    try {
      await runEnableAutoMerge(
        db,
        { ownerSlash: "ghost/nope", pattern: "main" },
        makeAudit(audits)
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/Repository not found/);
    // No audit entry written for a failed resolve.
    expect(audits.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runEnableAutoMerge — UPDATE path
// ---------------------------------------------------------------------------

describe("runEnableAutoMerge — existing row", () => {
  test("flips enableAutoMerge=true on an existing row, preserves other fields", async () => {
    seedRepo({
      withProtection: {
        enableAutoMerge: false,
        requireGreenGates: true,
        requireAiApproval: true,
        requireHumanReview: true, // not what the defaults would set
        requiredApprovals: 2,
      },
    });
    const result = await runEnableAutoMerge(
      db,
      { ownerSlash: "ccantynz/Gluecron.com", pattern: "main" },
      makeAudit(audits)
    );

    expect(result.action).toBe("updated");
    expect(result.before).not.toBeNull();
    expect(result.before!.enableAutoMerge).toBe(false);
    expect(result.after.enableAutoMerge).toBe(true);

    // Other fields preserved on the after row.
    expect(result.after.requireHumanReview).toBe(true);
    expect(result.after.requiredApprovals).toBe(2);

    // Only enableAutoMerge + updatedAt should land in the SET payload.
    const upd = state.updates.find((u) => u.table === "branch_protection");
    expect(upd).toBeTruthy();
    expect(upd!.set.enableAutoMerge).toBe(true);
    expect("requireHumanReview" in upd!.set).toBe(false);
    expect("requiredApprovals" in upd!.set).toBe(false);

    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe("auto_merge.enabled_on_main");
  });

  test("--off flips the bit to false and writes the disable audit action", async () => {
    seedRepo({ withProtection: { enableAutoMerge: true } });
    const result = await runEnableAutoMerge(
      db,
      { ownerSlash: "ccantynz/Gluecron.com", pattern: "main", off: true },
      makeAudit(audits)
    );

    expect(result.action).toBe("updated");
    expect(result.after.enableAutoMerge).toBe(false);
    expect(audits[0]!.action).toBe("auto_merge.disabled_on_main");
  });

  test("idempotent: second run is a no-op with no second audit entry", async () => {
    seedRepo({ withProtection: { enableAutoMerge: true } });
    const result = await runEnableAutoMerge(
      db,
      { ownerSlash: "ccantynz/Gluecron.com", pattern: "main" },
      makeAudit(audits)
    );
    expect(result.action).toBe("noop");
    expect(result.auditWritten).toBe(false);
    expect(audits.length).toBe(0);
    // And no UPDATE was issued.
    expect(state.updates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderDiff
// ---------------------------------------------------------------------------

describe("renderDiff", () => {
  test("INSERT case renders every tracked field as additions", () => {
    const after: BranchProtection = {
      id: "bp-1",
      repositoryId: "repo-1",
      pattern: "main",
      requirePullRequest: true,
      requireGreenGates: true,
      requireAiApproval: true,
      requireHumanReview: false,
      requiredApprovals: 0,
      allowForcePush: false,
      allowDeletion: false,
      dismissStaleReviews: false,
      enableAutoMerge: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as BranchProtection;
    const out = renderDiff(null, after);
    expect(out).toContain("no previous");
    expect(out).toContain("enableAutoMerge = true");
    expect(out).toContain("requireAiApproval = true");
  });

  test("UPDATE case renders only the changed fields", () => {
    const before: BranchProtection = {
      id: "bp-1",
      repositoryId: "repo-1",
      pattern: "main",
      requirePullRequest: true,
      requireGreenGates: true,
      requireAiApproval: true,
      requireHumanReview: false,
      requiredApprovals: 0,
      allowForcePush: false,
      allowDeletion: false,
      dismissStaleReviews: false,
      enableAutoMerge: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as BranchProtection;
    const after = { ...before, enableAutoMerge: true } as BranchProtection;
    const out = renderDiff(before, after);
    expect(out).toContain("enableAutoMerge");
    expect(out).toContain("false");
    expect(out).toContain("true");
    // No other field should appear.
    expect(out).not.toContain("requireAiApproval:");
    expect(out).not.toContain("requireGreenGates:");
  });
});

// ---------------------------------------------------------------------------
// Readiness checks
// ---------------------------------------------------------------------------

describe("readiness check helpers", () => {
  test("checkAnthropicKey fails when env var is missing", () => {
    const r = checkAnthropicKey({} as NodeJS.ProcessEnv);
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  test("checkAnthropicKey passes when env var is present", () => {
    const r = checkAnthropicKey({
      ANTHROPIC_API_KEY: "sk-ant-1234567890",
    } as unknown as NodeJS.ProcessEnv);
    expect(r.status).toBe("pass");
  });

  test("checkAutopilotEnabled fails when AUTOPILOT_DISABLED=1", () => {
    const r = checkAutopilotEnabled({
      AUTOPILOT_DISABLED: "1",
    } as unknown as NodeJS.ProcessEnv);
    expect(r.status).toBe("fail");
  });

  test("checkAutopilotEnabled passes when AUTOPILOT_DISABLED is unset", () => {
    const r = checkAutopilotEnabled({} as NodeJS.ProcessEnv);
    expect(r.status).toBe("pass");
  });

  test("checkAutoMergeSweepRegistered passes when the task is present", () => {
    const r = checkAutoMergeSweepRegistered([
      { name: "mirror-sync" },
      { name: "auto-merge-sweep" },
      { name: "weekly-digest" },
    ]);
    expect(r.status).toBe("pass");
  });

  test("checkAutoMergeSweepRegistered fails when missing", () => {
    const r = checkAutoMergeSweepRegistered([{ name: "mirror-sync" }]);
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/auto-merge-sweep/);
  });

  test("checkMigration0040 fails when column is missing", async () => {
    const r = await checkMigration0040(async () => ({ exists: false }));
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/enable_auto_merge/);
  });

  test("checkMigration0040 fails on runner error", async () => {
    const r = await checkMigration0040(async () => ({
      exists: false,
      error: "connection refused",
    }));
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/connection refused/);
  });

  test("checkMigration0040 passes when column exists", async () => {
    const r = await checkMigration0040(async () => ({ exists: true }));
    expect(r.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Confirm the real defaultTasks() registers auto-merge-sweep.
// ---------------------------------------------------------------------------

describe("real defaultTasks() registration", () => {
  test("registers an 'auto-merge-sweep' task (guards against accidental removal)", async () => {
    const { defaultTasks } = await import("../lib/autopilot");
    const tasks = defaultTasks();
    expect(tasks.some((t) => t.name === "auto-merge-sweep")).toBe(true);
  });
});

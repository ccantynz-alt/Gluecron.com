/**
 * Tests for `src/lib/pr-slash-commands.ts`.
 *
 * Two layers (matching the project convention):
 *   1. Pure helpers — `parseSlashCommand`, marker detection,
 *     `parseMergeStrategy`, `/help` rendering. Run unconditionally.
 *   2. End-to-end with a real DB row + bare repo. Gated on
 *     `DATABASE_URL` via `HAS_DB` skipIf, matching ai-ci-healer.test.ts.
 *
 * All AI calls are stubbed via the `deps.anthropic` injection point.
 * The merge call is stubbed via `deps.merge` to avoid touching real
 * git refs (the executor's job is to format the result, not to re-test
 * pr-merge.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import { eq } from "drizzle-orm";

import {
  parseSlashCommand,
  executeSlashCommand,
  detectSlashCmdComment,
  stripSlashCmdMarker,
  slashCmdMarker,
  SLASH_COMMANDS,
  __test,
} from "../lib/pr-slash-commands";
import { db } from "../db";
import {
  pullRequests,
  prComments,
  repositories,
  users,
  workflows,
} from "../db/schema";
import { initBareRepo, createOrUpdateFileOnBranch } from "../git/repository";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-pr-slash-" + Date.now()
);

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Pure parser surface — runs without a DB
// ---------------------------------------------------------------------------

describe("parseSlashCommand", () => {
  it("returns null for empty input", () => {
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("   ")).toBeNull();
  });

  it("returns null for free-form text", () => {
    expect(parseSlashCommand("hey team, take a look")).toBeNull();
    expect(parseSlashCommand("hey /merge")).toBeNull(); // must start at col 0
  });

  it("returns null for Unix-path-like comments that start with /", () => {
    expect(parseSlashCommand("/usr/local/bin/foo")).toBeNull();
    expect(parseSlashCommand("/etc/passwd is interesting")).toBeNull();
  });

  it("recognises every command without args", () => {
    for (const cmd of SLASH_COMMANDS) {
      const parsed = parseSlashCommand(`/${cmd}`);
      expect(parsed).not.toBeNull();
      expect(parsed!.command).toBe(cmd);
      expect(parsed!.args).toEqual([]);
    }
  });

  it("parses /merge with a strategy arg", () => {
    expect(parseSlashCommand("/merge squash")).toEqual({
      command: "merge",
      args: ["squash"],
      raw: "merge squash",
    });
    expect(parseSlashCommand("/merge rebase")).toEqual({
      command: "merge",
      args: ["rebase"],
      raw: "merge rebase",
    });
    expect(parseSlashCommand("/merge merge")).toEqual({
      command: "merge",
      args: ["merge"],
      raw: "merge merge",
    });
  });

  it("parses /cc with multiple @users", () => {
    const p = parseSlashCommand("/cc @alice @bob @carol");
    expect(p).not.toBeNull();
    expect(p!.command).toBe("cc");
    expect(p!.args).toEqual(["@alice", "@bob", "@carol"]);
  });

  it("only inspects the first non-blank line", () => {
    const p = parseSlashCommand("/needs-work\nplease tighten the loop body");
    expect(p).not.toBeNull();
    expect(p!.command).toBe("needs-work");
    expect(p!.args).toEqual([]);
  });

  it("normalises trailing punctuation", () => {
    expect(parseSlashCommand("/help.")!.command).toBe("help");
    expect(parseSlashCommand("/HELP")!.command).toBe("help");
  });

  it("ignores a leading space after the slash", () => {
    expect(parseSlashCommand("/ merge")).toBeNull();
  });
});

describe("detectSlashCmdComment / stripSlashCmdMarker", () => {
  it("detects each command marker", () => {
    for (const cmd of SLASH_COMMANDS) {
      const body = `${slashCmdMarker(cmd)}\n\nbody text`;
      expect(detectSlashCmdComment(body)).toBe(cmd);
      expect(stripSlashCmdMarker(body)).toBe("body text");
    }
  });

  it("returns null for normal comments", () => {
    expect(detectSlashCmdComment("just a plain comment")).toBeNull();
    expect(detectSlashCmdComment("<!-- something else -->")).toBeNull();
  });
});

describe("__test.parseMergeStrategy", () => {
  it("defaults to merge when the arg is missing or junk", () => {
    expect(__test.parseMergeStrategy(undefined)).toBe("merge");
    expect(__test.parseMergeStrategy("")).toBe("merge");
    expect(__test.parseMergeStrategy("rocket")).toBe("merge");
  });
  it("accepts the three documented strategies", () => {
    expect(__test.parseMergeStrategy("squash")).toBe("squash");
    expect(__test.parseMergeStrategy("rebase")).toBe("rebase");
    expect(__test.parseMergeStrategy("merge")).toBe("merge");
    expect(__test.parseMergeStrategy("SQUASH")).toBe("squash");
  });
});

// ---------------------------------------------------------------------------
// 2. Executor — /help runs without any deps
// ---------------------------------------------------------------------------

describe("executeSlashCommand — /help", () => {
  it("renders the full command list with the marker", async () => {
    const result = await executeSlashCommand({
      command: "help",
      args: [],
      prId: "00000000-0000-0000-0000-000000000000",
      userId: "00000000-0000-0000-0000-000000000000",
      repositoryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(true);
    expect(result.marker).toBe(slashCmdMarker("help"));
    expect(result.body).toContain(slashCmdMarker("help"));
    // Every recognised command is documented in the help output.
    for (const cmd of SLASH_COMMANDS) {
      expect(result.body).toContain(`/${cmd}`);
    }
  });
});

describe("executeSlashCommand — unrecognised input never throws", () => {
  it("does not throw when no DB is available", async () => {
    // parseSlashCommand would normally reject this; we call execute
    // directly to make sure the route-side defence-in-depth is fine.
    const result = await executeSlashCommand({
      // @ts-expect-error — exercising the default-case branch
      command: "does-not-exist",
      args: [],
      prId: "00000000-0000-0000-0000-000000000000",
      userId: "00000000-0000-0000-0000-000000000000",
      repositoryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.body).toContain("Unrecognised slash command");
  });
});

// ---------------------------------------------------------------------------
// 3. DB-backed flows — /explain (mock Claude), /merge (mock performMerge)
// ---------------------------------------------------------------------------

function fakeAnthropic(responseText: string) {
  return {
    messages: {
      create: async () => ({
        id: "msg_test",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-sonnet-4-test",
        stop_reason: "end_turn" as const,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: "text" as const, text: responseText }],
      }),
    },
  } as any;
}

interface SlashFixture {
  userId: string;
  repoId: string;
  prId: string;
  ownerUsername: string;
  repoName: string;
}

async function seedFixture(label: string): Promise<SlashFixture> {
  const username = `slash_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const [u] = await db
    .insert(users)
    .values({
      username,
      email: `${username}@example.com`,
      passwordHash: "x",
    })
    .returning({ id: users.id });

  const repoName = `subject_${label}_${Date.now()}`;
  const [r] = await db
    .insert(repositories)
    .values({
      ownerId: u.id,
      name: repoName,
      diskPath: `/tmp/${username}/${repoName}`,
      defaultBranch: "main",
    })
    .returning({ id: repositories.id });

  await initBareRepo(username, repoName);
  // Seed a base commit on main + a head commit on feat-x so the diff
  // /explain consumes is non-empty.
  await createOrUpdateFileOnBranch({
    owner: username,
    name: repoName,
    branch: "main",
    filePath: "src/index.ts",
    bytes: new TextEncoder().encode("export const v = 1;\n"),
    message: "base",
    authorName: "Seeder",
    authorEmail: "s@e.com",
  });
  await createOrUpdateFileOnBranch({
    owner: username,
    name: repoName,
    branch: "feat-x",
    filePath: "src/index.ts",
    bytes: new TextEncoder().encode("export const v = 2;\n"),
    message: "feat: bump v",
    authorName: "Seeder",
    authorEmail: "s@e.com",
  });

  const [pr] = await db
    .insert(pullRequests)
    .values({
      repositoryId: r.id,
      number: 1,
      title: "Bump v",
      body: "Bumps the version constant.",
      authorId: u.id,
      baseBranch: "main",
      headBranch: "feat-x",
      state: "open",
    })
    .returning({ id: pullRequests.id });

  return {
    userId: u.id,
    repoId: r.id,
    prId: pr.id,
    ownerUsername: username,
    repoName,
  };
}

describe.skipIf(!HAS_DB)("executeSlashCommand — /explain (DB-backed)", () => {
  it("calls Claude and returns its explanation in the result body", async () => {
    const fx = await seedFixture("explain");
    const result = await executeSlashCommand({
      command: "explain",
      args: [],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
      deps: { anthropic: fakeAnthropic("This PR bumps `v` from 1 to 2.") },
    });
    expect(result.ok).toBe(true);
    expect(result.body).toContain(slashCmdMarker("explain"));
    expect(result.body).toContain("This PR bumps `v` from 1 to 2.");
  }, 15_000);
});

describe.skipIf(!HAS_DB)("executeSlashCommand — /merge (DB-backed)", () => {
  it("forwards the requested strategy and reports the merge result", async () => {
    const fx = await seedFixture("merge");

    let observedActor: string | null = null;
    const fakeMerge = async (mergeArgs: any) => {
      observedActor = mergeArgs.actorUserId;
      expect(mergeArgs.pr.id).toBe(fx.prId);
      expect(mergeArgs.pr.headBranch).toBe("feat-x");
      expect(mergeArgs.pr.baseBranch).toBe("main");
      return {
        ok: true as const,
        closedIssueNumbers: [42],
        resolvedFiles: [],
      };
    };

    const result = await executeSlashCommand({
      command: "merge",
      args: ["squash"],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
      deps: {
        merge: fakeMerge as any,
        // Repo owner = userId, so resolveAccess would return "owner"
        // anyway; pin it for determinism + DB isolation.
        resolveAccess: async () => "owner",
      },
    });
    expect(result.ok).toBe(true);
    expect(observedActor).toBe(fx.userId);
    expect(result.body).toContain(slashCmdMarker("merge"));
    expect(result.body).toContain("Merged");
    expect(result.body).toContain("/merge squash");
    expect(result.body).toContain("#42");
  });

  it("refuses to merge when the actor lacks write access", async () => {
    const fx = await seedFixture("merge-noauth");
    const result = await executeSlashCommand({
      command: "merge",
      args: [],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
      deps: {
        merge: async () => {
          throw new Error("should not be called");
        },
        resolveAccess: async () => "read",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.body).toContain("denied");
  });

  it("surfaces the underlying performMerge error verbatim", async () => {
    const fx = await seedFixture("merge-fail");
    const result = await executeSlashCommand({
      command: "merge",
      args: [],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
      deps: {
        merge: async () => ({
          ok: false as const,
          error: "git update-ref failed: not-fast-forward",
          closedIssueNumbers: [],
          resolvedFiles: [],
        }),
        resolveAccess: async () => "owner",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.body).toContain("not-fast-forward");
  });
});

describe.skipIf(!HAS_DB)("executeSlashCommand — /lgtm + /needs-work (DB-backed)", () => {
  it("posts an approval-style body for /lgtm", async () => {
    const fx = await seedFixture("lgtm");
    const result = await executeSlashCommand({
      command: "lgtm",
      args: [],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
    });
    expect(result.ok).toBe(true);
    expect(result.body.toLowerCase()).toContain("approved");
  });

  it("captures the reason given to /needs-work", async () => {
    const fx = await seedFixture("nw");
    const result = await executeSlashCommand({
      command: "needs-work",
      args: ["please", "tighten", "the", "loop"],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
    });
    expect(result.ok).toBe(true);
    expect(result.body).toContain("please tighten the loop");
  });
});

describe.skipIf(!HAS_DB)("executeSlashCommand — /cc (DB-backed)", () => {
  it("resolves known users and flags unknowns", async () => {
    const fx = await seedFixture("cc");
    const knownName = `slash_cc_known_${Date.now()}`;
    await db
      .insert(users)
      .values({
        username: knownName,
        email: `${knownName}@example.com`,
        passwordHash: "x",
      });

    const result = await executeSlashCommand({
      command: "cc",
      args: [`@${knownName}`, "@nobody-knows-this"],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
    });
    expect(result.ok).toBe(true);
    expect(result.body).toContain(knownName);
    expect(result.body).toContain("Skipped");
  });

  it("rejects when no @users are supplied", async () => {
    const fx = await seedFixture("cc-empty");
    const result = await executeSlashCommand({
      command: "cc",
      args: [],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
    });
    expect(result.ok).toBe(false);
    expect(result.body).toContain("requires one or more");
  });
});

describe.skipIf(!HAS_DB)("executeSlashCommand — /test (DB-backed)", () => {
  it("enqueues a workflow_dispatch when a test.yml workflow exists", async () => {
    const fx = await seedFixture("test");
    const [w] = await db
      .insert(workflows)
      .values({
        repositoryId: fx.repoId,
        name: "Tests",
        path: ".gluecron/workflows/test.yml",
        yaml: "name: Tests\non: [push, workflow_dispatch]\njobs:\n  t:\n    steps:\n      - run: bun test\n",
        parsed: JSON.stringify({
          name: "Tests",
          on: ["push", "workflow_dispatch"],
          jobs: { t: { steps: [{ run: "bun test" }] } },
        }),
        onEvents: JSON.stringify(["push", "workflow_dispatch"]),
      })
      .returning({ id: workflows.id });

    const result = await executeSlashCommand({
      command: "test",
      args: [],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
    });
    expect(result.ok).toBe(true);
    expect(result.body).toContain("dispatched");

    // Sanity: the lookup helper actually finds the row we just inserted.
    const found = await __test.findTestWorkflow(fx.repoId);
    expect(found?.id).toBe(w.id);
  }, 15_000);

  it("falls back gracefully when no test workflow is configured", async () => {
    const fx = await seedFixture("test-missing");
    const result = await executeSlashCommand({
      command: "test",
      args: [],
      prId: fx.prId,
      userId: fx.userId,
      repositoryId: fx.repoId,
    });
    expect(result.ok).toBe(false);
    expect(result.body).toContain("could not find a test workflow");
  });
});

// ---------------------------------------------------------------------------
// 4. Integration smoke — parse → execute round-trip preserves identity
// ---------------------------------------------------------------------------

describe("parse → execute round-trip (no DB needed)", () => {
  it("a slash that doesn't pass parseSlashCommand stays a normal comment", () => {
    // The route handler stores the comment verbatim and only THEN consults
    // parseSlashCommand. This test asserts the contract:
    //   - "/usr/bin/x" returns null → route does NOT execute anything
    //   - "/help" returns a parse → route executes
    expect(parseSlashCommand("/usr/bin/x")).toBeNull();
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("/help")).not.toBeNull();
  });
});

/**
 * Tests for src/lib/ai-test-generator.ts.
 *
 * Two layers:
 *
 *   1. Pure helpers — no DB, no Claude. Always run.
 *      - isCandidateSourceFile filters test files / docs / configs.
 *      - buildTestsForPrPrompt embeds the source file + framework hint.
 *      - testsBranchName respects an override and otherwise embeds the
 *        PR number + timestamp.
 *      - looksLikeSpecPr detects spec-implementation PR bodies.
 *      - renderFollowUpPrBody includes the marker, label, and file list.
 *      - autopilot dispatch counts on injected stubs.
 *
 *   2. End-to-end generateTestsForPr — injected fake Claude client + a
 *      real bare repo on disk. DB-backed steps (PR insert, label upsert,
 *      audit) are gated on HAS_DB so the DB-less sandbox still exercises
 *      the git-side write path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import { eq } from "drizzle-orm";
import {
  AI_TESTS_LABEL,
  AI_TESTS_MARKER,
  buildTestsForPrPrompt,
  generateTestsForPr,
  isCandidateSourceFile,
  looksLikeSpecPr,
  renderFollowUpPrBody,
  testsBranchName,
} from "../lib/ai-test-generator";
import {
  runPrTestGeneratorTaskOnce,
  type PrTestGenCandidate,
} from "../lib/autopilot-pr-test-generator";
import {
  initBareRepo,
  createOrUpdateFileOnBranch,
  getBlob,
  refExists,
  resolveRef,
} from "../git/repository";
import { db } from "../db";
import {
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-ai-test-gen-" + Date.now()
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
// Pure helpers
// ---------------------------------------------------------------------------

describe("isCandidateSourceFile", () => {
  it("accepts ordinary TypeScript / JS / Python / Go sources", () => {
    expect(isCandidateSourceFile("src/lib/math.ts")).toBe(true);
    expect(isCandidateSourceFile("pkg/widget.py")).toBe(true);
    expect(isCandidateSourceFile("cmd/main.go")).toBe(true);
    expect(isCandidateSourceFile("lib/util.js")).toBe(true);
  });

  it("rejects test files", () => {
    expect(isCandidateSourceFile("src/__tests__/math.test.ts")).toBe(false);
    expect(isCandidateSourceFile("tests/test_widget.py")).toBe(false);
    expect(isCandidateSourceFile("foo_test.go")).toBe(false);
    expect(isCandidateSourceFile("src/lib/math.spec.ts")).toBe(false);
  });

  it("rejects docs and configs", () => {
    expect(isCandidateSourceFile("README.md")).toBe(false);
    expect(isCandidateSourceFile("package.json")).toBe(false);
    expect(isCandidateSourceFile("vitest.config.ts")).toBe(true); // .ts is code-shaped
    expect(isCandidateSourceFile("public/logo.png")).toBe(false);
    expect(isCandidateSourceFile("docs/intro.md")).toBe(false);
  });

  it("rejects build / dependency directories", () => {
    expect(isCandidateSourceFile("node_modules/foo/index.js")).toBe(false);
    expect(isCandidateSourceFile("dist/bundle.js")).toBe(false);
    expect(isCandidateSourceFile(".github/workflows/ci.yml")).toBe(false);
  });

  it("rejects path-traversal attempts", () => {
    expect(isCandidateSourceFile("../etc/passwd")).toBe(false);
    expect(isCandidateSourceFile("src/../../oops.ts")).toBe(false);
  });
});

describe("buildTestsForPrPrompt", () => {
  it("embeds path, framework, language, and source code", () => {
    const out = buildTestsForPrPrompt({
      filePath: "src/lib/math.ts",
      language: "typescript",
      framework: "bun:test",
      sourceCode: "export function add(a: number, b: number) { return a + b; }",
      prTitle: "Add math helpers",
    });
    expect(out).toContain("src/lib/math.ts");
    expect(out).toContain("bun:test");
    expect(out).toContain("typescript");
    expect(out).toContain("export function add");
    expect(out).toContain("Add math helpers");
    // JSON schema cue MUST be present so the model returns parseable output.
    expect(out).toContain('"patches"');
    expect(out).toContain('"new_content"');
  });

  it("truncates very large source files", () => {
    const huge = "a".repeat(50_000);
    const out = buildTestsForPrPrompt({
      filePath: "big.ts",
      language: "typescript",
      framework: "bun:test",
      sourceCode: huge,
      prTitle: "huge file",
    });
    expect(out.length).toBeLessThan(huge.length + 4_000);
    expect(out).toContain("truncated");
  });
});

describe("testsBranchName", () => {
  it("honours an override", () => {
    expect(testsBranchName(42, "custom/branch")).toBe("custom/branch");
  });

  it("uses ai-tests/pr-<n>-<timestamp> by default", () => {
    const name = testsBranchName(42);
    expect(name.startsWith("ai-tests/pr-42-")).toBe(true);
    const ts = name.slice("ai-tests/pr-42-".length);
    expect(/^\d+$/.test(ts)).toBe(true);
  });
});

describe("looksLikeSpecPr", () => {
  it("detects the spec-implementation marker", () => {
    expect(
      looksLikeSpecPr("<!-- gluecron:ai-spec-implementation:v1 -->\nblah")
    ).toBe(true);
  });

  it("detects the spec label citation", () => {
    expect(looksLikeSpecPr("Label: `ai:spec-implementation`")).toBe(true);
  });

  it("returns false for empty / null / unrelated bodies", () => {
    expect(looksLikeSpecPr(null)).toBe(false);
    expect(looksLikeSpecPr("")).toBe(false);
    expect(looksLikeSpecPr("Normal PR body")).toBe(false);
  });
});

describe("renderFollowUpPrBody", () => {
  it("includes the marker, label, branch, and file list", () => {
    const body = renderFollowUpPrBody({
      originalPrNumber: 7,
      branch: "ai-tests/pr-7-1234",
      written: ["src/__tests__/math.test.ts"],
    });
    expect(body).toContain(AI_TESTS_MARKER);
    expect(body).toContain("for PR #7");
    expect(body).toContain(AI_TESTS_LABEL);
    expect(body).toContain("ai-tests/pr-7-1234");
    expect(body).toContain("src/__tests__/math.test.ts");
  });

  it("renders cleanly with no files", () => {
    const body = renderFollowUpPrBody({
      originalPrNumber: 1,
      branch: "ai-tests/pr-1-0",
      written: [],
    });
    expect(body).toContain(AI_TESTS_MARKER);
    expect(body).toContain("_(none)_");
  });
});

// ---------------------------------------------------------------------------
// Autopilot task — DI seam, no DB / no Claude
// ---------------------------------------------------------------------------

describe("runPrTestGeneratorTaskOnce", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalDisabled = process.env.AUTOPILOT_DISABLED;

  function restoreEnv() {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalDisabled === undefined) delete process.env.AUTOPILOT_DISABLED;
    else process.env.AUTOPILOT_DISABLED = originalDisabled;
  }

  it("no-ops cleanly when AUTOPILOT_DISABLED=1", async () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.AUTOPILOT_DISABLED = "1";
    let calls = 0;
    const out = await runPrTestGeneratorTaskOnce({
      findCandidates: async () => {
        calls += 1;
        return [];
      },
      dispatcher: async () => ({ ok: true }),
    });
    expect(calls).toBe(0);
    expect(out).toEqual({ considered: 0, dispatched: 0, skipped: 0, failed: 0 });
    restoreEnv();
  });

  it("no-ops cleanly when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    let calls = 0;
    const out = await runPrTestGeneratorTaskOnce({
      findCandidates: async () => {
        calls += 1;
        return [];
      },
      dispatcher: async () => ({ ok: true }),
    });
    expect(calls).toBe(0);
    expect(out.dispatched).toBe(0);
    restoreEnv();
  });

  it("counts dispatched / skipped / failed correctly", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    process.env.ANTHROPIC_API_KEY = "x";

    const candidates: PrTestGenCandidate[] = [
      { prId: "pr-ok", prNumber: 1, repositoryId: "r", body: "ok" },
      { prId: "pr-already", prNumber: 2, repositoryId: "r", body: "ok" },
      { prId: "pr-no-files", prNumber: 3, repositoryId: "r", body: "ok" },
      { prId: "pr-fail", prNumber: 4, repositoryId: "r", body: "ok" },
    ];

    const out = await runPrTestGeneratorTaskOnce({
      findCandidates: async () => candidates,
      dispatcher: async ({ prId }) => {
        if (prId === "pr-ok") return { ok: true, written: 1, branch: "x" };
        if (prId === "pr-already") return { ok: true, alreadyDone: true };
        if (prId === "pr-no-files")
          return { ok: false, error: "No candidate source files in diff" };
        return { ok: false, error: "real failure" };
      },
    });

    expect(out.considered).toBe(4);
    expect(out.dispatched).toBe(1);
    expect(out.skipped).toBe(2); // alreadyDone + no-candidate
    expect(out.failed).toBe(1);
    restoreEnv();
  });

  it("classifies AI-generated-PR refusals as skipped, not failed", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    process.env.ANTHROPIC_API_KEY = "x";

    const out = await runPrTestGeneratorTaskOnce({
      findCandidates: async () => [
        { prId: "pr-spec", prNumber: 9, repositoryId: "r", body: null },
      ],
      dispatcher: async () => ({
        ok: false,
        error: "PR is AI-generated (ai:spec-implementation); skipping",
      }),
    });
    expect(out.skipped).toBe(1);
    expect(out.failed).toBe(0);
    restoreEnv();
  });
});

// ---------------------------------------------------------------------------
// Injected-Claude end-to-end
// ---------------------------------------------------------------------------

function fakeClient(responseText: string) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text" as const, text: responseText }],
      }),
    },
  } as any;
}

describe("generateTestsForPr — guards (no DB needed)", () => {
  it("returns ok:false when ANTHROPIC_API_KEY is missing and no client injected", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const out = await generateTestsForPr({
      prId: "00000000-0000-0000-0000-000000000000",
      mode: "append-commit",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("ANTHROPIC_API_KEY");
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns ok:false when the PR id does not resolve", async () => {
    const out = await generateTestsForPr({
      prId: "00000000-0000-0000-0000-000000000000",
      mode: "append-commit",
      client: fakeClient('{"patches":[]}'),
    });
    expect(out.ok).toBe(false);
    // "PR not found" when DB is reachable; "PR not found" still surfaces
    // because loadPrFacts swallows DB errors and returns null.
    expect((out.error || "").toLowerCase()).toContain("not found");
  });
});

describe.skipIf(!HAS_DB)(
  "generateTestsForPr — end-to-end with fake Claude",
  () => {
    /**
     * Seed a fresh user + repo + bare git repo with a base commit and a
     * head branch that adds a single source file. Returns identifiers
     * the per-test cases can plug into a PR row.
     */
    async function seed(): Promise<{
      userId: string;
      repoId: string;
      ownerName: string;
      repoName: string;
      headBranch: string;
    }> {
      const username = `aitests_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          passwordHash: "x",
        })
        .returning({ id: users.id });

      const repoName = `subject_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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

      // Base commit on main.
      const baseSeed = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: "main",
        filePath: "README.md",
        bytes: new TextEncoder().encode("# subject\n"),
        message: "seed",
        authorName: "Seeder",
        authorEmail: "s@e.com",
      });
      if ("error" in baseSeed) throw new Error("base seed failed");

      // Head branch adds a source file.
      const headBranch = "feature/add-math";
      const headSeed = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: headBranch,
        filePath: "src/lib/math.ts",
        bytes: new TextEncoder().encode(
          "export function add(a: number, b: number): number { return a + b; }\n"
        ),
        message: "add math",
        authorName: "Dev",
        authorEmail: "d@e.com",
      });
      if ("error" in headSeed) throw new Error("head seed failed");

      return {
        userId: u.id,
        repoId: r.id,
        ownerName: username,
        repoName,
        headBranch,
      };
    }

    async function insertPr(args: {
      repoId: string;
      authorId: string;
      headBranch: string;
      title?: string;
      body?: string | null;
    }): Promise<{ id: string; number: number }> {
      const [pr] = await db
        .insert(pullRequests)
        .values({
          repositoryId: args.repoId,
          authorId: args.authorId,
          title: args.title || "Add math helpers",
          body: args.body ?? "Adds math helpers.",
          baseBranch: "main",
          headBranch: args.headBranch,
          isDraft: false,
        })
        .returning({ id: pullRequests.id, number: pullRequests.number });
      return { id: pr.id, number: pr.number };
    }

    const cannedPatch = JSON.stringify({
      patches: [
        {
          path: "src/__tests__/math.test.ts",
          new_content:
            "import { add } from '../lib/math';\nimport { describe, it, expect } from 'bun:test';\ndescribe('add', () => {\n  it('adds two numbers', () => {\n    expect(add(2, 3)).toBe(5);\n  });\n});\n",
        },
      ],
    });

    it(
      "append-commit mode pushes a test commit onto the PR's head branch",
      async () => {
        const fixt = await seed();
        const pr = await insertPr({
          repoId: fixt.repoId,
          authorId: fixt.userId,
          headBranch: fixt.headBranch,
        });

        const beforeHead = await resolveRef(
          fixt.ownerName,
          fixt.repoName,
          fixt.headBranch
        );

        const result = await generateTestsForPr({
          prId: pr.id,
          mode: "append-commit",
          client: fakeClient(cannedPatch),
        });

        expect(result.ok).toBe(true);
        expect(result.written).toBe(1);
        expect(result.branch).toBe(fixt.headBranch);
        expect(result.prNumber).toBeUndefined(); // append-commit doesn't open a PR

        // The head branch should have advanced.
        const afterHead = await resolveRef(
          fixt.ownerName,
          fixt.repoName,
          fixt.headBranch
        );
        expect(afterHead).not.toBe(beforeHead);

        // The new test file is on the head branch.
        const blob = await getBlob(
          fixt.ownerName,
          fixt.repoName,
          fixt.headBranch,
          "src/__tests__/math.test.ts"
        );
        expect(blob).not.toBeNull();
        expect(blob!.content).toContain("expect(add(2, 3)).toBe(5)");

        // The original source file should be untouched.
        const sourceBlob = await getBlob(
          fixt.ownerName,
          fixt.repoName,
          fixt.headBranch,
          "src/lib/math.ts"
        );
        expect(sourceBlob!.content).toContain("export function add");

        // Marker comment landed on the PR.
        const markerComments = await db
          .select({ body: prComments.body })
          .from(prComments)
          .where(eq(prComments.pullRequestId, pr.id));
        const hasMarker = markerComments.some((row) =>
          (row.body || "").includes(AI_TESTS_MARKER)
        );
        expect(hasMarker).toBe(true);

        // Dedupe: a second run must NOT re-write anything.
        const second = await generateTestsForPr({
          prId: pr.id,
          mode: "append-commit",
          client: fakeClient(cannedPatch),
        });
        expect(second.ok).toBe(true);
        expect(second.alreadyDone).toBe(true);
      },
      30_000
    );

    it(
      "follow-up-pr mode opens a new PR against the head branch",
      async () => {
        const fixt = await seed();
        const pr = await insertPr({
          repoId: fixt.repoId,
          authorId: fixt.userId,
          headBranch: fixt.headBranch,
        });

        const result = await generateTestsForPr({
          prId: pr.id,
          mode: "follow-up-pr",
          client: fakeClient(cannedPatch),
        });

        expect(result.ok).toBe(true);
        expect(result.branch).toBeDefined();
        expect(result.branch!.startsWith("ai-tests/pr-")).toBe(true);
        expect(typeof result.prNumber).toBe("number");

        // New branch exists and carries the test file.
        expect(
          await refExists(fixt.ownerName, fixt.repoName, `refs/heads/${result.branch}`)
        ).toBe(true);
        const blob = await getBlob(
          fixt.ownerName,
          fixt.repoName,
          result.branch!,
          "src/__tests__/math.test.ts"
        );
        expect(blob).not.toBeNull();

        // Follow-up PR row exists with the right base/head.
        const followUps = await db
          .select({
            number: pullRequests.number,
            title: pullRequests.title,
            baseBranch: pullRequests.baseBranch,
            headBranch: pullRequests.headBranch,
            body: pullRequests.body,
          })
          .from(pullRequests)
          .where(eq(pullRequests.repositoryId, fixt.repoId));

        const followUp = followUps.find((p) => p.number === result.prNumber);
        expect(followUp).toBeDefined();
        expect(followUp!.headBranch).toBe(result.branch!);
        expect(followUp!.baseBranch).toBe(fixt.headBranch);
        expect(followUp!.title).toContain(`+tests for #${pr.number}`);
        expect(followUp!.body).toContain(AI_TESTS_MARKER);
        expect(followUp!.body).toContain(AI_TESTS_LABEL);

        // Dedupe: a second run must NOT open another follow-up.
        const second = await generateTestsForPr({
          prId: pr.id,
          mode: "follow-up-pr",
          client: fakeClient(cannedPatch),
        });
        expect(second.ok).toBe(true);
        expect(second.alreadyDone).toBe(true);

        // Still only one follow-up PR exists.
        const followUpsAfter = await db
          .select({ number: pullRequests.number, title: pullRequests.title })
          .from(pullRequests)
          .where(eq(pullRequests.repositoryId, fixt.repoId));
        const aiOnes = followUpsAfter.filter((p) =>
          (p.title || "").startsWith("[tests] +tests for")
        );
        expect(aiOnes.length).toBe(1);
      },
      30_000
    );

    it("refuses a spec-implementation PR (recursion guard)", async () => {
      const fixt = await seed();
      const pr = await insertPr({
        repoId: fixt.repoId,
        authorId: fixt.userId,
        headBranch: fixt.headBranch,
        body: "<!-- gluecron:ai-spec-implementation:v1 -->\nSpec body.",
      });

      const result = await generateTestsForPr({
        prId: pr.id,
        mode: "append-commit",
        client: fakeClient(cannedPatch),
      });
      expect(result.ok).toBe(false);
      expect((result.error || "").toLowerCase()).toContain("ai-generated");
    });
  }
);

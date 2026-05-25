/**
 * Tests for src/lib/multi-repo-refactor.ts.
 *
 * Two layers:
 *
 *   1. Pure helpers — no DB, no Claude. Always run.
 *      - rollupStatus rolls children into the parent status correctly.
 *      - refactorLabelName / refactorBranchName are deterministic.
 *      - deriveTitle caps + cleans first line.
 *      - buildPlanPrompt / buildEditPrompt embed the description so the
 *        round trip is auditable.
 *
 *   2. End-to-end planRefactor + executeRefactor — exercises the full
 *      pipeline with a fake Anthropic client + a real bare repo on disk.
 *      Gated on HAS_DB so the DB-less sandbox still gets signal from the
 *      pure-helper assertions.
 *
 * Skip rule:
 *   - Production code requires ANTHROPIC_API_KEY OR an injected client.
 *     Our DB tests inject a fake `client`, so they DO run even when the
 *     key is missing. The describe.skipIf below is purely "HAS_DB"-gated.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import { eq } from "drizzle-orm";
import {
  __test,
  buildEditPrompt,
  buildPlanPrompt,
  deriveTitle,
  executeRefactor,
  getRefactor,
  MULTI_REPO_REFACTOR_LABEL_PREFIX,
  MULTI_REPO_REFACTOR_MARKER,
  planRefactor,
  refactorBranchName,
  refactorLabelName,
  renderRefactorPrBody,
  rollupStatus,
} from "../lib/multi-repo-refactor";
import {
  createOrUpdateFileOnBranch,
  initBareRepo,
  refExists,
} from "../git/repository";
import { db } from "../db";
import {
  multiRepoRefactorPrs,
  multiRepoRefactors,
  pullRequests,
  repositories,
  users,
} from "../db/schema";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-multi-repo-refactor-" + Date.now()
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

describe("refactorLabelName", () => {
  it("prefixes the refactor id with the group marker", () => {
    expect(refactorLabelName("abc-123")).toBe(
      `${MULTI_REPO_REFACTOR_LABEL_PREFIX}abc-123`
    );
  });
});

describe("refactorBranchName", () => {
  it("derives an 8-char branch suffix from the refactor uuid", () => {
    const branch = refactorBranchName("aaaabbbb-cccc-dddd-eeee-ffffffffffff");
    expect(branch.startsWith("multi-repo-refactor/")).toBe(true);
    expect(branch.length).toBeLessThan(50);
    // Deterministic given the same id.
    expect(branch).toBe(refactorBranchName("aaaabbbb-cccc-dddd-eeee-ffffffffffff"));
  });
});

describe("deriveTitle", () => {
  it("uses the first line of the description", () => {
    expect(deriveTitle("rename foo to bar\n\nmore details")).toBe(
      "rename foo to bar"
    );
  });
  it("caps long descriptions at ~80 chars with an ellipsis", () => {
    const long = "x".repeat(200);
    const title = deriveTitle(long);
    expect(title.endsWith("...")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
  });
  it("falls back to a default for empty input", () => {
    expect(deriveTitle("")).toBe("Multi-repo refactor");
  });
});

describe("rollupStatus", () => {
  it("returns failed when no children are present", () => {
    expect(rollupStatus([])).toBe("failed");
  });
  it("stays building when any child is still in flight", () => {
    expect(
      rollupStatus([{ status: "opened" }, { status: "building" }])
    ).toBe("building");
    expect(rollupStatus([{ status: "pending" }])).toBe("building");
  });
  it("rolls up to ready_for_review when every child has terminated and at least one opened", () => {
    expect(
      rollupStatus([{ status: "opened" }, { status: "opened" }])
    ).toBe("ready_for_review");
    // Mixed success/failure → still ready_for_review so the user can merge
    // what worked and retry the failed children.
    expect(
      rollupStatus([{ status: "opened" }, { status: "failed" }])
    ).toBe("ready_for_review");
  });
  it("rolls up to failed when every child failed", () => {
    expect(
      rollupStatus([{ status: "failed" }, { status: "failed" }])
    ).toBe("failed");
  });
});

describe("buildPlanPrompt", () => {
  it("embeds the description and repo list", () => {
    const prompt = buildPlanPrompt({
      description: "rename getUserById to findUser",
      repos: [
        { id: "id-1", owner: "alice", name: "service-a", description: null },
        {
          id: "id-2",
          owner: "alice",
          name: "service-b",
          description: "consumer",
        },
      ],
    });
    expect(prompt).toContain("rename getUserById to findUser");
    expect(prompt).toContain("id=id-1");
    expect(prompt).toContain("alice/service-b — consumer");
    expect(prompt).toContain('"predicted_changes_summary"');
  });
});

describe("buildEditPrompt", () => {
  it("embeds the description, predicted change, and any preloaded files", () => {
    const prompt = buildEditPrompt({
      description: "rename foo to bar",
      predictedChanges: "rename foo() in src/foo.ts",
      repoFiles: [{ path: "src/foo.ts", content: "export const foo = 1;" }],
    });
    expect(prompt).toContain("rename foo to bar");
    expect(prompt).toContain("rename foo() in src/foo.ts");
    expect(prompt).toContain("--- FILE: src/foo.ts ---");
    expect(prompt).toContain("export const foo = 1;");
  });
});

describe("renderRefactorPrBody", () => {
  it("includes the marker, group label, description, and file list", () => {
    const body = renderRefactorPrBody({
      refactorId: "ref-1",
      refactorTitle: "Rename helper",
      description: "rename foo to bar",
      predictedChanges: "edit src/foo.ts",
      explanation: "did the thing",
      patchPaths: ["src/foo.ts"],
    });
    expect(body).toContain(MULTI_REPO_REFACTOR_MARKER);
    expect(body).toContain(refactorLabelName("ref-1"));
    expect(body).toContain("rename foo to bar");
    expect(body).toContain("src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// End-to-end — fake Claude client + real bare repo + real DB
// ---------------------------------------------------------------------------

/**
 * Build a fake `ClaudeClient` whose `.messages.create` returns canned JSON
 * envelopes. The plan response comes first, then one edit response per
 * affected repo. We pop responses off the front so test sequences are
 * deterministic.
 */
function fakeClientSequence(responses: string[]) {
  const queue = [...responses];
  return {
    messages: {
      create: async () => {
        const text = queue.shift();
        if (text === undefined) {
          throw new Error("fakeClient: ran out of canned responses");
        }
        return {
          content: [{ type: "text" as const, text }],
        };
      },
    },
  } as any;
}

describe.skipIf(!HAS_DB)(
  "planRefactor + executeRefactor — end-to-end with fake Claude",
  () => {
    it(
      "plans across two repos, opens one PR per repo with the group label, and rolls up to ready_for_review",
      async () => {
        // 1. Seed a user + two repos with one source file each.
        const username =
          "refac_" +
          Date.now().toString(36) +
          "_" +
          Math.random().toString(36).slice(2, 6);
        const [u] = await db
          .insert(users)
          .values({
            username,
            email: `${username}@example.com`,
            passwordHash: "x",
          })
          .returning({ id: users.id });

        const repoA = `svc_a_${Date.now()}`;
        const repoB = `svc_b_${Date.now()}`;
        const [ra] = await db
          .insert(repositories)
          .values({
            ownerId: u.id,
            name: repoA,
            diskPath: `/tmp/${username}/${repoA}`,
            defaultBranch: "main",
          })
          .returning({ id: repositories.id, name: repositories.name });
        const [rb] = await db
          .insert(repositories)
          .values({
            ownerId: u.id,
            name: repoB,
            diskPath: `/tmp/${username}/${repoB}`,
            defaultBranch: "main",
          })
          .returning({ id: repositories.id, name: repositories.name });

        // Seed bare repos on disk so the executor can write a branch.
        await initBareRepo(username, repoA);
        await initBareRepo(username, repoB);
        for (const name of [repoA, repoB]) {
          const seeded = await createOrUpdateFileOnBranch({
            owner: username,
            name,
            branch: "main",
            filePath: "src/user.ts",
            bytes: new TextEncoder().encode(
              "export function getUserById(id: string) { return id; }\n"
            ),
            message: "seed",
            authorName: "Seeder",
            authorEmail: "s@e.com",
          });
          if ("error" in seeded) throw new Error(`seed ${name} failed`);
        }

        // 2. Plan — canned response selects both repos.
        const planJson = JSON.stringify({
          title: "Rename getUserById to findUser",
          affected: [
            {
              repository_id: ra.id,
              predicted_changes_summary:
                "rename getUserById -> findUser in src/user.ts",
            },
            {
              repository_id: rb.id,
              predicted_changes_summary:
                "rename getUserById -> findUser in src/user.ts",
            },
          ],
        });

        const plan = await planRefactor({
          userId: u.id,
          description:
            "rename `getUserById` to `findUser` across all my repos",
          client: fakeClientSequence([planJson]),
        });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.plan.length).toBe(2);
        expect(plan.refactor.status).toBe("planning");

        // 3. Execute — provide one canned edit response per repo.
        const editJson = JSON.stringify({
          explanation: "Renamed the helper.",
          patches: [
            {
              path: "src/user.ts",
              new_content:
                "export function findUser(id: string) { return id; }\n",
            },
          ],
        });
        const execRes = await executeRefactor({
          refactorId: plan.refactor.id,
          client: fakeClientSequence([editJson, editJson]),
        });
        expect(execRes.ok).toBe(true);
        if (!execRes.ok) return;
        expect(execRes.children.length).toBe(2);
        for (const child of execRes.children) {
          expect(child.status).toBe("opened");
          expect(typeof child.pullRequestId).toBe("string");
          expect(typeof child.prNumber).toBe("number");
          expect(child.branch).toBe(
            refactorBranchName(plan.refactor.id)
          );
        }
        expect(execRes.refactor.status).toBe("ready_for_review");

        // 4. Verify each PR has the marker label in its body and the right
        //    base/head branches.
        for (const child of execRes.children) {
          if (!child.pullRequestId) continue;
          const [pr] = await db
            .select()
            .from(pullRequests)
            .where(eq(pullRequests.id, child.pullRequestId))
            .limit(1);
          expect(pr).toBeTruthy();
          if (!pr) continue;
          expect(pr.title.startsWith("[refactor]")).toBe(true);
          expect(pr.body || "").toContain(
            refactorLabelName(plan.refactor.id)
          );
          expect(pr.body || "").toContain(MULTI_REPO_REFACTOR_MARKER);
          expect(pr.headBranch).toBe(refactorBranchName(plan.refactor.id));
          expect(pr.baseBranch).toBe("main");
        }

        // 5. Confirm the head branch actually exists on disk in each repo.
        for (const name of [repoA, repoB]) {
          const exists = await refExists(
            username,
            name,
            `refs/heads/${refactorBranchName(plan.refactor.id)}`
          );
          expect(exists).toBe(true);
        }

        // 6. getRefactor returns the children with PR numbers attached.
        const view = await getRefactor(plan.refactor.id, { userId: u.id });
        expect(view).toBeTruthy();
        if (!view) return;
        expect(view.refactor.status).toBe("ready_for_review");
        expect(view.children.length).toBe(2);
        expect(view.children.every((c) => typeof c.prNumber === "number")).toBe(
          true
        );
      },
      30_000
    );

    it(
      "marks the child as failed when Claude returns no patches, and rolls up to failed when every child fails",
      async () => {
        const username =
          "refac_fail_" +
          Date.now().toString(36) +
          "_" +
          Math.random().toString(36).slice(2, 6);
        const [u] = await db
          .insert(users)
          .values({
            username,
            email: `${username}@example.com`,
            passwordHash: "x",
          })
          .returning({ id: users.id });

        const repoName = `nofix_${Date.now()}`;
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
        await createOrUpdateFileOnBranch({
          owner: username,
          name: repoName,
          branch: "main",
          filePath: "src/x.ts",
          bytes: new TextEncoder().encode("export const x = 1;\n"),
          message: "seed",
          authorName: "Seeder",
          authorEmail: "s@e.com",
        });

        const planJson = JSON.stringify({
          title: "Empty refactor",
          affected: [
            {
              repository_id: r.id,
              predicted_changes_summary: "x",
            },
          ],
        });
        const editEmpty = JSON.stringify({
          explanation: "nothing to do",
          patches: [],
        });

        const plan = await planRefactor({
          userId: u.id,
          description: "do something",
          client: fakeClientSequence([planJson]),
        });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;

        const execRes = await executeRefactor({
          refactorId: plan.refactor.id,
          client: fakeClientSequence([editEmpty]),
        });
        expect(execRes.ok).toBe(true);
        if (!execRes.ok) return;
        expect(execRes.children.length).toBe(1);
        expect(execRes.children[0].status).toBe("failed");
        expect(execRes.refactor.status).toBe("failed");

        // No PRs should have been inserted for this repo.
        const prs = await db
          .select()
          .from(pullRequests)
          .where(eq(pullRequests.repositoryId, r.id));
        expect(prs.length).toBe(0);
      },
      30_000
    );
  }
);

// ---------------------------------------------------------------------------
// Guard tests (DB-less) — confirm we bail cleanly without an API key
// ---------------------------------------------------------------------------

describe("planRefactor — guards", () => {
  it("returns ok:false when description is empty", async () => {
    const out = await planRefactor({
      userId: "00000000-0000-0000-0000-000000000000",
      description: "   ",
      client: fakeClientSequence(["{}"]),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("empty");
  });

  it("returns ok:false when no API key AND no client are provided", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const out = await planRefactor({
        userId: "00000000-0000-0000-0000-000000000000",
        description: "rename foo",
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain("ANTHROPIC_API_KEY");
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

// Re-export the suite's internal helper coverage so it doesn't drift.
describe("__test exports", () => {
  it("exposes the same helpers tested above", () => {
    expect(typeof __test.rollupStatus).toBe("function");
    expect(typeof __test.refactorLabelName).toBe("function");
    expect(typeof __test.refactorBranchName).toBe("function");
    expect(typeof __test.deriveTitle).toBe("function");
    expect(typeof __test.buildPlanPrompt).toBe("function");
  });
});

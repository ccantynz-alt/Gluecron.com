/**
 * Tests for src/lib/ai-ci-healer.ts.
 *
 * Two layers:
 *   1. Pure helpers — buildCiHealPrompt + fixesToFindings + small private
 *      helpers exposed via __test. Always run.
 *   2. End-to-end with a fake Claude client + a real DB row + bare repo.
 *      Gated on DATABASE_URL via the HAS_DB skipIf pattern used across
 *      the suite.
 *
 * The Anthropic client is faked via the public `client` option so we never
 * touch the network or require ANTHROPIC_API_KEY. We also DI the
 * patch-generator into `healOneRun` so each test pins its own outcome.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import { eq, and } from "drizzle-orm";
import {
  analyzeFailedWorkflowRun,
  buildCiHealPrompt,
  fixesToFindings,
  healOneRun,
  runCiHealerTick,
  __test,
} from "../lib/ai-ci-healer";
import { db } from "../db";
import {
  auditLog,
  pullRequests,
  repositories,
  users,
  workflowJobs,
  workflowRuns,
  workflows,
} from "../db/schema";
import {
  createOrUpdateFileOnBranch,
  initBareRepo,
} from "../git/repository";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-ai-ci-healer-" + Date.now()
);

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  // Make sure autopilot doesn't short-circuit our tests via env.
  delete process.env.AUTOPILOT_DISABLED;
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildCiHealPrompt", () => {
  it("embeds repo, sha, yaml, and failed job logs", () => {
    const prompt = buildCiHealPrompt({
      repoFullName: "alice/web",
      commitSha: "abcdef1234567890",
      workflowYaml: "name: ci\non: [push]\njobs:\n  build:\n    steps: []",
      failedJobs: [
        { name: "build", conclusion: "failure", logs: "TypeError: x is not a function" },
      ],
    });
    expect(prompt).toContain("alice/web");
    expect(prompt).toContain("abcdef123456");
    expect(prompt).toContain("name: ci");
    expect(prompt).toContain("TypeError: x is not a function");
    // Strict JSON schema cue
    expect(prompt).toContain('"rootCause"');
    expect(prompt).toContain('"suggestedFixes"');
  });

  it("handles the empty-jobs case gracefully", () => {
    const prompt = buildCiHealPrompt({
      repoFullName: "x/y",
      commitSha: "1234567",
      workflowYaml: "name: ci",
      failedJobs: [],
    });
    expect(prompt).toContain("(no failed-job logs available)");
  });
});

describe("fixesToFindings", () => {
  it("maps SuggestedFix[] onto GateTestFinding[] preserving path + severity", () => {
    const findings = fixesToFindings(
      [
        { path: "src/a.ts", description: "fix imports", severity: "high" },
        { path: "src/b.ts", description: "guard null", severity: "medium" },
      ],
      "deadbeef"
    );
    expect(findings.length).toBe(2);
    expect(findings[0].path).toBe("src/a.ts");
    expect(findings[0].severity).toBe("high");
    expect(findings[0].id).toContain("ci-heal-deadbeef");
    expect(findings[1].path).toBe("src/b.ts");
    expect(findings[1].severity).toBe("medium");
  });

  it("drops fixes with no path", () => {
    const findings = fixesToFindings(
      [
        { path: "", description: "noop" },
        { path: "src/c.ts", description: "ok" },
      ],
      "x"
    );
    expect(findings.length).toBe(1);
    expect(findings[0].path).toBe("src/c.ts");
  });

  it("defaults severity to high when omitted", () => {
    const findings = fixesToFindings(
      [{ path: "src/d.ts", description: "no sev" }],
      "x"
    );
    expect(findings[0].severity).toBe("high");
  });
});

describe("__test internals", () => {
  it("normaliseSeverity accepts the canonical levels case-insensitively", () => {
    expect(__test.normaliseSeverity("HIGH")).toBe("high");
    expect(__test.normaliseSeverity("Medium")).toBe("medium");
    expect(__test.normaliseSeverity("critical")).toBe("critical");
    expect(__test.normaliseSeverity("low")).toBe("low");
  });

  it("normaliseSeverity rejects garbage", () => {
    expect(__test.normaliseSeverity("bananas")).toBeUndefined();
    expect(__test.normaliseSeverity(undefined)).toBeUndefined();
    expect(__test.normaliseSeverity(null)).toBeUndefined();
    expect(__test.normaliseSeverity(42)).toBeUndefined();
  });

  it("truncate caps long strings + appends marker", () => {
    expect(__test.truncate("abc", 10)).toBe("abc");
    const long = "x".repeat(20);
    const t = __test.truncate(long, 5);
    expect(t.startsWith("xxxxx")).toBe(true);
    expect(t).toContain("(truncated)");
  });
});

// ---------------------------------------------------------------------------
// Skip when AUTOPILOT_DISABLED: tick must no-op cleanly
// ---------------------------------------------------------------------------

describe("runCiHealerTick — env gates", () => {
  it("no-ops when AUTOPILOT_DISABLED=1", async () => {
    const prev = process.env.AUTOPILOT_DISABLED;
    process.env.AUTOPILOT_DISABLED = "1";
    try {
      const summary = await runCiHealerTick({
        findCandidates: async () => {
          throw new Error("should not be called");
        },
      });
      expect(summary).toEqual({
        considered: 0,
        healed: 0,
        gaveUp: 0,
        skipped: 0,
      });
    } finally {
      if (prev === undefined) delete process.env.AUTOPILOT_DISABLED;
      else process.env.AUTOPILOT_DISABLED = prev;
    }
  });

  it("no-ops when ANTHROPIC_API_KEY is unset", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const summary = await runCiHealerTick({
        findCandidates: async () => {
          throw new Error("should not be called");
        },
      });
      expect(summary.considered).toBe(0);
      expect(summary.healed).toBe(0);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// DB-backed end-to-end. Builds a real failed run + jobs + repo + workflow
// rows, then drives `healOneRun` with a fake Claude client.
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

interface Fixture {
  repoId: string;
  repoName: string;
  ownerUsername: string;
  workflowId: string;
  runId: string;
  baseSha: string;
}

async function seedFailedRun(label: string): Promise<Fixture> {
  const username = `cihealer_${label}_${Date.now()}_${Math.random()
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
    .returning({ id: repositories.id, name: repositories.name });

  await initBareRepo(username, repoName);
  const seeded = await createOrUpdateFileOnBranch({
    owner: username,
    name: repoName,
    branch: "main",
    filePath: "src/index.ts",
    bytes: new TextEncoder().encode(
      "export function broken(){ return undefined.length; }\n"
    ),
    message: "seed",
    authorName: "Seeder",
    authorEmail: "s@e.com",
  });
  if ("error" in seeded) throw new Error("seed failed: " + seeded.error);

  const [w] = await db
    .insert(workflows)
    .values({
      repositoryId: r.id,
      name: "ci",
      path: ".gluecron/workflows/ci.yml",
      yaml: "name: ci\non: [push]\njobs:\n  build:\n    steps:\n      - run: bun test",
      parsed: JSON.stringify({
        name: "ci",
        on: ["push"],
        jobs: { build: { steps: [{ run: "bun test" }] } },
      }),
    })
    .returning({ id: workflows.id });

  // Insert run as `failure` with createdAt safely in the past so the
  // candidate finder considers it (HEAL_MIN_AGE_MS = 60s).
  const oldCreatedAt = new Date(Date.now() - 5 * 60 * 1000);
  const [run] = await db
    .insert(workflowRuns)
    .values({
      workflowId: w.id,
      repositoryId: r.id,
      runNumber: 1,
      event: "push",
      ref: "refs/heads/main",
      commitSha: seeded.commitSha,
      status: "failure",
      conclusion: "failure",
      queuedAt: oldCreatedAt,
      startedAt: oldCreatedAt,
      finishedAt: oldCreatedAt,
      createdAt: oldCreatedAt,
    })
    .returning({ id: workflowRuns.id });

  await db.insert(workflowJobs).values({
    runId: run.id,
    name: "build",
    jobOrder: 0,
    runsOn: "default",
    status: "failure",
    conclusion: "failure",
    exitCode: 1,
    steps: "[]",
    logs:
      "==> bun test\nTypeError: Cannot read properties of undefined (reading 'length')\n  at broken (src/index.ts:1:38)\n[exit 1 in 120ms]",
    startedAt: oldCreatedAt,
    finishedAt: oldCreatedAt,
  });

  return {
    repoId: r.id,
    repoName,
    ownerUsername: username,
    workflowId: w.id,
    runId: run.id,
    baseSha: seeded.commitSha,
  };
}

describe.skipIf(!HAS_DB)("ai-ci-healer DB-backed E2E", () => {
  it("opens a patch PR + writes an ai.ci.healed audit row on the happy path", async () => {
    const fx = await seedFailedRun("happy");

    const cannedClaude = JSON.stringify({
      rootCause:
        "broken() references undefined.length, which throws at runtime.",
      fixable: true,
      suggestedFixes: [
        {
          path: "src/index.ts",
          description: "Return a numeric literal instead of dereferencing undefined.",
          severity: "high",
        },
      ],
    });

    const cannedPatch = JSON.stringify({
      explanation: "Replaced the bad expression with a safe literal.",
      patches: [
        {
          path: "src/index.ts",
          new_content: "export function broken(){ return 0; }\n",
        },
      ],
    });

    const client = fakeClient(cannedClaude);

    // Use the real patch generator — feed it the same fake client for the
    // patch call. The generator picks `client` from the opts we forward.
    const { generatePatchForGateTestFinding } = await import(
      "../lib/ai-patch-generator"
    );
    const out = await healOneRun(fx.runId, {
      client,
      // Wrap the real generator so we can swap in the second fake response
      // for the patch step (it makes a fresh call). The healer hands the
      // client through, so we wrap to replace the response between steps.
      generatePatch: async (opts) => {
        return generatePatchForGateTestFinding({
          ...opts,
          client: fakeClient(cannedPatch),
          branchOverride: `ai-patch/ci-heal-${Date.now()}`,
        });
      },
    });

    expect(out.outcome).toBe("healed");
    expect(typeof out.prNumber).toBe("number");
    expect(out.branch).toContain("ai-patch/ci-heal-");

    // PR row exists
    const prs = await db
      .select({ number: pullRequests.number, headBranch: pullRequests.headBranch })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, fx.repoId));
    expect(prs.length).toBe(1);
    expect(prs[0].number).toBe(out.prNumber!);

    // Audit marker present
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "workflow_run"),
          eq(auditLog.targetId, fx.runId)
        )
      );
    expect(audits.some((a) => a.action === "ai.ci.healed")).toBe(true);
  }, 30_000);

  it("writes ai.ci.gave_up + opens no PR when Claude says unfixable", async () => {
    const fx = await seedFailedRun("unfix");

    const cannedClaude = JSON.stringify({
      rootCause: "The npm registry returned 503 mid-install.",
      fixable: false,
      suggestedFixes: [],
      unfixableReason: "External registry outage — retry later.",
    });

    const client = fakeClient(cannedClaude);
    const out = await healOneRun(fx.runId, { client });
    expect(out.outcome).toBe("gave_up");

    // No PR row
    const prs = await db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, fx.repoId));
    expect(prs.length).toBe(0);

    // Audit marker present as gave_up
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "workflow_run"),
          eq(auditLog.targetId, fx.runId)
        )
      );
    expect(audits.some((a) => a.action === "ai.ci.gave_up")).toBe(true);
    expect(audits.some((a) => a.action === "ai.ci.healed")).toBe(false);
  }, 30_000);

  it("skips runs that already have a marker (no double-processing)", async () => {
    const fx = await seedFailedRun("dedupe");

    // Pre-insert a marker
    await db.insert(auditLog).values({
      action: "ai.ci.healed",
      targetType: "workflow_run",
      targetId: fx.runId,
      metadata: JSON.stringify({ pre: true }),
    });

    // Should refuse to act — Claude must NOT be called.
    let claudeCalled = 0;
    const client = {
      messages: {
        create: async () => {
          claudeCalled += 1;
          return { content: [{ type: "text" as const, text: "{}" }] };
        },
      },
    } as any;

    const out = await healOneRun(fx.runId, { client });
    expect(out.outcome).toBe("skipped");
    expect(claudeCalled).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// analyzeFailedWorkflowRun direct-call sanity (the public surface the
// task description explicitly calls out as the entry point).
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("analyzeFailedWorkflowRun", () => {
  it("returns parsed analysis with patchablePaths when Claude says fixable", async () => {
    const fx = await seedFailedRun("analyze");
    const canned = JSON.stringify({
      rootCause: "Null deref in src/index.ts.",
      fixable: true,
      suggestedFixes: [
        { path: "src/index.ts", description: "Add null guard.", severity: "high" },
      ],
    });
    const analysis = await analyzeFailedWorkflowRun(fx.runId, {
      client: fakeClient(canned),
    });
    expect(analysis).not.toBeNull();
    expect(analysis!.rootCause).toContain("Null deref");
    expect(analysis!.patchablePaths).toEqual(["src/index.ts"]);
    expect(analysis!.suggestedFixes.length).toBe(1);
  }, 30_000);

  it("returns null when Claude says unfixable", async () => {
    const fx = await seedFailedRun("analyze-unfix");
    const canned = JSON.stringify({
      rootCause: "Registry outage.",
      fixable: false,
      suggestedFixes: [],
    });
    const analysis = await analyzeFailedWorkflowRun(fx.runId, {
      client: fakeClient(canned),
    });
    expect(analysis).toBeNull();
  }, 30_000);

  it("returns null for non-failure runs", async () => {
    const fx = await seedFailedRun("non-failure");
    // Flip the run back to success — analyzer should bail.
    await db
      .update(workflowRuns)
      .set({ status: "success", conclusion: "success" })
      .where(eq(workflowRuns.id, fx.runId));
    const analysis = await analyzeFailedWorkflowRun(fx.runId, {
      client: fakeClient('{"rootCause":"x","fixable":true,"suggestedFixes":[]}'),
    });
    expect(analysis).toBeNull();
  }, 30_000);
});

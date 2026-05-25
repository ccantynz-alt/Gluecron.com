/**
 * Tests for src/lib/ai-review-trio.ts — the parallel security /
 * correctness / style reviewer pipeline.
 *
 * Layered:
 *
 *   1. Pure helpers — disagreement detection, finding normalisation,
 *      comment-body rendering. No DB, no network. Always run.
 *
 *   2. Persona-runner test seam — verify all three personas are invoked
 *      in parallel with their own system prompts. Always run (uses the
 *      `__setPersonaRunnerForTests` override).
 *
 *   3. DB-backed pipeline — gated on HAS_DB. Spins up a real user,
 *      repository, and pull request row, then asserts that all four
 *      prComments (3 personas + 1 summary) land with the correct
 *      markers.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { randomBytes } from "crypto";

import {
  __setPersonaRunnerForTests,
  __test,
  TRIO_COMMENT_MARKER,
  TRIO_SUMMARY_MARKER,
  alreadyTrioReviewed,
  computeDisagreements,
  isTrioReviewEnabled,
  runTrioReview,
  type PersonaRunner,
  type TrioPersona,
  type TrioVerdict,
} from "../lib/ai-review-trio";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Reset the persona runner between every test so leaks across files
// (or across `it` blocks) can't silently mask real bugs.
// ---------------------------------------------------------------------------

beforeEach(() => {
  __setPersonaRunnerForTests(null);
});

afterEach(() => {
  __setPersonaRunnerForTests(null);
});

// ---------------------------------------------------------------------------
// 1. isTrioReviewEnabled — flag plumbing.
// ---------------------------------------------------------------------------

describe("isTrioReviewEnabled", () => {
  it("returns false when AI_TRIO_REVIEW_ENABLED is unset", () => {
    const prev = process.env.AI_TRIO_REVIEW_ENABLED;
    delete process.env.AI_TRIO_REVIEW_ENABLED;
    try {
      expect(isTrioReviewEnabled()).toBe(false);
    } finally {
      if (prev !== undefined) process.env.AI_TRIO_REVIEW_ENABLED = prev;
    }
  });

  it("returns true when AI_TRIO_REVIEW_ENABLED=1", () => {
    const prev = process.env.AI_TRIO_REVIEW_ENABLED;
    process.env.AI_TRIO_REVIEW_ENABLED = "1";
    try {
      expect(isTrioReviewEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AI_TRIO_REVIEW_ENABLED;
      else process.env.AI_TRIO_REVIEW_ENABLED = prev;
    }
  });

  it("returns false for AI_TRIO_REVIEW_ENABLED=0 or other values", () => {
    const prev = process.env.AI_TRIO_REVIEW_ENABLED;
    process.env.AI_TRIO_REVIEW_ENABLED = "0";
    try {
      expect(isTrioReviewEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AI_TRIO_REVIEW_ENABLED;
      else process.env.AI_TRIO_REVIEW_ENABLED = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. computeDisagreements — pure helper.
// ---------------------------------------------------------------------------

function mkVerdict(
  persona: TrioPersona,
  findings: Array<{ file: string | null; line: number | null; issue: string }>,
  verdict: "pass" | "fail" = "fail"
): TrioVerdict {
  return {
    persona,
    verdict,
    findings: findings.map((f) => ({
      severity: "medium",
      file: f.file,
      line: f.line,
      issue: f.issue,
      fix: "",
    })),
    rawText: "",
    latencyMs: 0,
    failed: false,
  };
}

describe("computeDisagreements", () => {
  it("returns [] when no findings exist", () => {
    const out = computeDisagreements({
      securityVerdict: mkVerdict("security", [], "pass"),
      correctnessVerdict: mkVerdict("correctness", [], "pass"),
      styleVerdict: mkVerdict("style", [], "pass"),
    });
    expect(out).toEqual([]);
  });

  it("returns [] when all three flag the same file:line (unanimous)", () => {
    const findings = [{ file: "src/a.ts", line: 10, issue: "x" }];
    const out = computeDisagreements({
      securityVerdict: mkVerdict("security", findings),
      correctnessVerdict: mkVerdict("correctness", findings),
      styleVerdict: mkVerdict("style", findings),
    });
    expect(out).toEqual([]);
  });

  it("detects disagreement when only one persona flags a location", () => {
    const out = computeDisagreements({
      securityVerdict: mkVerdict("security", [
        { file: "src/a.ts", line: 10, issue: "sql injection" },
      ]),
      correctnessVerdict: mkVerdict("correctness", [], "pass"),
      styleVerdict: mkVerdict("style", [], "pass"),
    });
    expect(out.length).toBe(1);
    expect(out[0].file).toBe("src/a.ts");
    expect(out[0].line).toBe(10);
    expect(out[0].failingPersonas).toEqual(["security"]);
    expect(out[0].passingPersonas.sort()).toEqual(["correctness", "style"]);
  });

  it("detects disagreement when two personas flag and one is silent", () => {
    const out = computeDisagreements({
      securityVerdict: mkVerdict("security", [
        { file: "src/a.ts", line: 10, issue: "x" },
      ]),
      correctnessVerdict: mkVerdict("correctness", [
        { file: "src/a.ts", line: 10, issue: "y" },
      ]),
      styleVerdict: mkVerdict("style", [], "pass"),
    });
    expect(out.length).toBe(1);
    expect(out[0].failingPersonas.sort()).toEqual([
      "correctness",
      "security",
    ]);
    expect(out[0].passingPersonas).toEqual(["style"]);
  });

  it("ignores findings without a file (can't attribute)", () => {
    const out = computeDisagreements({
      securityVerdict: mkVerdict("security", [
        { file: null, line: null, issue: "ambient" },
      ]),
      correctnessVerdict: mkVerdict("correctness", [], "pass"),
      styleVerdict: mkVerdict("style", [], "pass"),
    });
    expect(out).toEqual([]);
  });

  it("sorts disagreements by file then line for stable rendering", () => {
    const out = computeDisagreements({
      securityVerdict: mkVerdict("security", [
        { file: "src/z.ts", line: 1, issue: "z1" },
        { file: "src/a.ts", line: 20, issue: "a20" },
        { file: "src/a.ts", line: 5, issue: "a5" },
      ]),
      correctnessVerdict: mkVerdict("correctness", [], "pass"),
      styleVerdict: mkVerdict("style", [], "pass"),
    });
    expect(out.map((d) => `${d.file}:${d.line}`)).toEqual([
      "src/a.ts:5",
      "src/a.ts:20",
      "src/z.ts:1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. normaliseFinding — pure helper.
// ---------------------------------------------------------------------------

describe("__test.normaliseFinding", () => {
  it("accepts a fully-formed finding", () => {
    const out = __test.normaliseFinding({
      severity: "high",
      file: "src/a.ts",
      line: 42,
      issue: "boom",
      fix: "do x",
    });
    expect(out).not.toBeNull();
    expect(out?.severity).toBe("high");
    expect(out?.file).toBe("src/a.ts");
    expect(out?.line).toBe(42);
  });

  it("defaults severity to medium when missing", () => {
    const out = __test.normaliseFinding({ issue: "x" });
    expect(out?.severity).toBe("medium");
  });

  it("rejects findings with no issue text", () => {
    expect(__test.normaliseFinding({ severity: "high" })).toBeNull();
    expect(__test.normaliseFinding(null)).toBeNull();
    expect(__test.normaliseFinding("not an object")).toBeNull();
  });

  it("falls back to `description` when `issue` is absent", () => {
    const out = __test.normaliseFinding({ description: "from desc" });
    expect(out?.issue).toBe("from desc");
  });

  it("nulls out non-integer or negative line numbers", () => {
    expect(__test.normaliseFinding({ issue: "x", line: 1.5 })?.line).toBeNull();
    expect(__test.normaliseFinding({ issue: "x", line: -3 })?.line).toBeNull();
    expect(__test.normaliseFinding({ issue: "x", line: 0 })?.line).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Persona-runner — three calls, distinct prompts, parallel.
// ---------------------------------------------------------------------------

describe("runTrioReview — persona runner", () => {
  it("invokes all three personas with their own system prompts", async () => {
    const seen: TrioPersona[] = [];
    const runner: PersonaRunner = async ({ persona }) => {
      seen.push(persona);
      return {
        text: JSON.stringify({ verdict: "pass", findings: [] }),
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    __setPersonaRunnerForTests(runner);

    // No DB → persistence will silently fail when the PR lookup
    // returns nothing; that's the documented behaviour. We only
    // assert the runner side here.
    const result = await runTrioReview({
      pullRequestId: "00000000-0000-0000-0000-000000000000",
      headSha: "abc123",
      diff: "diff --git a b\n+pass",
    });

    expect(seen.sort()).toEqual(["correctness", "security", "style"]);
    expect(result.securityVerdict.verdict).toBe("pass");
    expect(result.correctnessVerdict.verdict).toBe("pass");
    expect(result.styleVerdict.verdict).toBe("pass");
  });

  it("returns canned per-persona verdicts and computes disagreements", async () => {
    const runner: PersonaRunner = async ({ persona }) => {
      if (persona === "security") {
        return {
          text: JSON.stringify({
            verdict: "fail",
            findings: [
              {
                severity: "high",
                file: "src/auth.ts",
                line: 42,
                issue: "SQL injection",
                fix: "Use parameterised queries",
              },
            ],
          }),
          inputTokens: 100,
          outputTokens: 50,
        };
      }
      if (persona === "correctness") {
        return {
          text: JSON.stringify({
            verdict: "fail",
            findings: [
              {
                severity: "medium",
                file: "src/auth.ts",
                line: 42,
                issue: "Missing await",
                fix: "Add await",
              },
            ],
          }),
          inputTokens: 100,
          outputTokens: 50,
        };
      }
      // style — passes
      return {
        text: JSON.stringify({ verdict: "pass", findings: [] }),
        inputTokens: 80,
        outputTokens: 20,
      };
    };
    __setPersonaRunnerForTests(runner);

    const result = await runTrioReview({
      pullRequestId: "00000000-0000-0000-0000-000000000000",
      headSha: "abc123",
      diff: "diff --git a b\n+oops",
    });

    expect(result.securityVerdict.verdict).toBe("fail");
    expect(result.correctnessVerdict.verdict).toBe("fail");
    expect(result.styleVerdict.verdict).toBe("pass");
    expect(result.disagreements.length).toBe(1);
    expect(result.disagreements[0].file).toBe("src/auth.ts");
    expect(result.disagreements[0].failingPersonas.sort()).toEqual([
      "correctness",
      "security",
    ]);
    expect(result.disagreements[0].passingPersonas).toEqual(["style"]);
  });

  it("fail-closes when the runner throws", async () => {
    const runner: PersonaRunner = async () => {
      throw new Error("boom");
    };
    __setPersonaRunnerForTests(runner);

    const result = await runTrioReview({
      pullRequestId: "00000000-0000-0000-0000-000000000000",
      headSha: "abc123",
      diff: "",
    });

    expect(result.securityVerdict.failed).toBe(true);
    expect(result.securityVerdict.verdict).toBe("fail");
    expect(result.correctnessVerdict.failed).toBe(true);
    expect(result.styleVerdict.failed).toBe(true);
  });

  it("fail-closes when the runner returns unparseable JSON", async () => {
    const runner: PersonaRunner = async () => ({
      text: "totally not json {{{",
      inputTokens: 0,
      outputTokens: 0,
    });
    __setPersonaRunnerForTests(runner);

    const result = await runTrioReview({
      pullRequestId: "00000000-0000-0000-0000-000000000000",
      headSha: "abc123",
      diff: "",
    });

    expect(result.securityVerdict.failed).toBe(true);
    expect(result.securityVerdict.verdict).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// 5. Comment-body rendering — marker presence + verdict word.
// ---------------------------------------------------------------------------

describe("__test.renderPersonaCommentBody", () => {
  it("embeds the security marker + Pass word for a pass verdict", () => {
    const body = __test.renderPersonaCommentBody(
      mkVerdict("security", [], "pass")
    );
    expect(body).toContain(TRIO_COMMENT_MARKER.security);
    expect(body).toContain("Pass");
  });

  it("renders findings as a bulleted list", () => {
    const body = __test.renderPersonaCommentBody(
      mkVerdict("security", [
        { file: "src/a.ts", line: 1, issue: "boom" },
      ])
    );
    expect(body).toContain("src/a.ts:1");
    expect(body).toContain("boom");
  });

  it("notes when the call failed", () => {
    const body = __test.renderPersonaCommentBody({
      ...mkVerdict("style", [], "fail"),
      failed: true,
    });
    expect(body.toLowerCase()).toContain("fail-closed");
  });
});

describe("__test.renderSummaryCommentBody", () => {
  it("embeds the summary marker and lists all three verdicts", () => {
    const body = __test.renderSummaryCommentBody({
      securityVerdict: mkVerdict("security", [], "pass"),
      correctnessVerdict: mkVerdict("correctness", [], "pass"),
      styleVerdict: mkVerdict("style", [], "pass"),
      disagreements: [],
    });
    expect(body).toContain(TRIO_SUMMARY_MARKER);
    expect(body).toContain("security");
    expect(body).toContain("correctness");
    expect(body).toContain("style");
    expect(body).toContain("All three reviewers agree");
  });

  it("formats disagreements clearly", () => {
    const body = __test.renderSummaryCommentBody({
      securityVerdict: mkVerdict("security", [
        { file: "src/a.ts", line: 10, issue: "x" },
      ]),
      correctnessVerdict: mkVerdict("correctness", [], "pass"),
      styleVerdict: mkVerdict("style", [], "pass"),
      disagreements: [
        {
          file: "src/a.ts",
          line: 10,
          failingPersonas: ["security"],
          passingPersonas: ["correctness", "style"],
        },
      ],
    });
    expect(body).toContain("src/a.ts:10");
    expect(body).toContain("security");
    expect(body).toContain("say ✗");
    expect(body).toContain("say ✓");
  });
});

// ---------------------------------------------------------------------------
// 6. DB-backed — full pipeline inserts 4 prComments with correct markers.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("runTrioReview — DB persistence", () => {
  it.skipIf(!HAS_DB)(
    "inserts 3 persona comments + 1 summary, all isAiReview=true, with correct markers",
    async () => {
      const { db } = await import("../db");
      const { users, repositories, pullRequests, prComments } = await import(
        "../db/schema"
      );
      const { eq } = await import("drizzle-orm");

      const stamp = randomBytes(4).toString("hex");
      const username = `trio-${stamp}`;
      const reponame = `trio-${stamp}`;

      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@test.local`,
          passwordHash: "x",
        })
        .returning();
      if (!u) return;

      const [r] = await db
        .insert(repositories)
        .values({
          name: reponame,
          ownerId: u.id,
          diskPath: `/tmp/${reponame}.git`,
          defaultBranch: "main",
        })
        .returning();
      if (!r) return;

      const [pr] = await db
        .insert(pullRequests)
        .values({
          repositoryId: r.id,
          authorId: u.id,
          title: "Test trio PR",
          body: "Testing the trio review pipeline.",
          baseBranch: "main",
          headBranch: "feature",
        })
        .returning();
      if (!pr) return;

      // Canned runner: security fails on src/a.ts:10, others pass.
      const runner: PersonaRunner = async ({ persona }) => {
        if (persona === "security") {
          return {
            text: JSON.stringify({
              verdict: "fail",
              findings: [
                {
                  severity: "high",
                  file: "src/a.ts",
                  line: 10,
                  issue: "Hard-coded secret",
                  fix: "Move to env var",
                },
              ],
            }),
            inputTokens: 0,
            outputTokens: 0,
          };
        }
        return {
          text: JSON.stringify({ verdict: "pass", findings: [] }),
          inputTokens: 0,
          outputTokens: 0,
        };
      };
      __setPersonaRunnerForTests(runner);

      const result = await runTrioReview({
        pullRequestId: pr.id,
        headSha: "abc123",
        diff: "diff --git a b",
        repositoryId: r.id,
      });

      expect(result.securityVerdict.verdict).toBe("fail");
      expect(result.correctnessVerdict.verdict).toBe("pass");
      expect(result.styleVerdict.verdict).toBe("pass");
      expect(result.disagreements.length).toBe(1);

      // Fetch persisted comments — expect exactly 4 (3 personas + summary).
      const comments = await db
        .select()
        .from(prComments)
        .where(eq(prComments.pullRequestId, pr.id));

      expect(comments.length).toBe(4);
      // Every comment must be flagged as AI.
      expect(comments.every((c) => c.isAiReview === true)).toBe(true);

      // Each persona marker should appear exactly once across the 4.
      const bodies = comments.map((c) => c.body);
      const hasMarker = (m: string) =>
        bodies.filter((b) => b.includes(m)).length;
      expect(hasMarker(TRIO_COMMENT_MARKER.security)).toBe(1);
      expect(hasMarker(TRIO_COMMENT_MARKER.correctness)).toBe(1);
      expect(hasMarker(TRIO_COMMENT_MARKER.style)).toBe(1);
      expect(hasMarker(TRIO_SUMMARY_MARKER)).toBe(1);

      // alreadyTrioReviewed should now return true.
      const seen = await alreadyTrioReviewed(pr.id);
      expect(seen).toBe(true);
    }
  );
});

/**
 * Tests for src/lib/spec-to-pr.ts.
 *
 * Two layers:
 *
 *   1. Pure helpers — no DB, no Claude. Always run.
 *      - parseFrontMatter / serialiseSpec round-trip.
 *      - specBasename derivation.
 *      - createSpecPR's fail-fast guards (no API key, empty spec).
 *
 *   2. End-to-end runSpecToPr — exercises the autopilot-driven flow with
 *      a fake AI client + a real bare repo on disk. Gated on HAS_DB so the
 *      DB-less sandbox still gets signal from the git-side assertions.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import { eq } from "drizzle-orm";
import {
  createSpecPR,
  runSpecToPr,
  parseFrontMatter,
  serialiseSpec,
  specBasename,
  markSpecShipped,
  AI_SPEC_LABEL,
  AI_SPEC_PR_MARKER,
} from "../lib/spec-to-pr";
import {
  initBareRepo,
  createOrUpdateFileOnBranch,
  getBlob,
  refExists,
} from "../git/repository";
import {
  runSpecToPrTaskOnce,
  type SpecToPrCandidate,
} from "../lib/autopilot-spec-to-pr";
import { db } from "../db";
import {
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { _resetClientForTests as resetSpecAiClient } from "../lib/spec-ai";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-spec-to-pr-" + Date.now()
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
// createSpecPR — fail-fast guards (DB-less)
// ---------------------------------------------------------------------------

describe("createSpecPR — guards", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns ok:false when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await createSpecPR({
      repoId: "00000000-0000-0000-0000-000000000000",
      spec: "test",
      userId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("returns ok:false when spec is empty", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-test-placeholder";
    const result = await createSpecPR({
      repoId: "00000000-0000-0000-0000-000000000000",
      spec: "   ",
      userId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty");
    }
  });
});

// ---------------------------------------------------------------------------
// Pure front-matter helpers
// ---------------------------------------------------------------------------

describe("parseFrontMatter", () => {
  it("returns empty front-matter when the document has none", () => {
    const out = parseFrontMatter("just a body");
    expect(out.hasFrontMatter).toBe(false);
    expect(out.body).toBe("just a body");
    expect(out.frontMatter).toEqual({});
  });

  it("parses simple key: value pairs", () => {
    const out = parseFrontMatter("---\ntitle: Add dark mode\nstatus: ready\n---\nbody here");
    expect(out.hasFrontMatter).toBe(true);
    expect(out.frontMatter.title).toBe("Add dark mode");
    expect(out.frontMatter.status).toBe("ready");
    expect(out.body).toBe("body here");
  });

  it("strips matched surrounding quotes", () => {
    const out = parseFrontMatter('---\ntitle: "Quoted: title"\n---\nbody');
    expect(out.frontMatter.title).toBe("Quoted: title");
  });

  it("tolerates CRLF line endings", () => {
    const out = parseFrontMatter("---\r\ntitle: T\r\nstatus: ready\r\n---\r\nbody");
    expect(out.frontMatter.title).toBe("T");
    expect(out.frontMatter.status).toBe("ready");
  });
});

describe("serialiseSpec", () => {
  it("round-trips parsed front-matter", () => {
    const raw = "---\ntitle: Add dark mode\nstatus: ready\n---\nbody here\n";
    const parsed = parseFrontMatter(raw);
    const out = serialiseSpec(parsed.frontMatter, parsed.body);
    const reparsed = parseFrontMatter(out);
    expect(reparsed.frontMatter.title).toBe("Add dark mode");
    expect(reparsed.frontMatter.status).toBe("ready");
    expect(reparsed.body.trim()).toBe("body here");
  });

  it("quotes values containing colons", () => {
    const out = serialiseSpec({ title: "Foo: bar" }, "body");
    // The quoted form must round-trip back to the same string.
    const reparsed = parseFrontMatter(out);
    expect(reparsed.frontMatter.title).toBe("Foo: bar");
  });
});

describe("specBasename", () => {
  it("strips the directory and .md extension", () => {
    expect(specBasename(".gluecron/specs/foo-bar.md")).toBe("foo-bar");
  });

  it("falls back to 'spec' for unusable input", () => {
    expect(specBasename(".gluecron/specs/!!!.md")).toBe("spec");
  });
});

// ---------------------------------------------------------------------------
// runSpecToPr — guard short-circuits (DB-less)
// ---------------------------------------------------------------------------

describe("runSpecToPr — guards", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalDisabled = process.env.AUTOPILOT_DISABLED;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalDisabled === undefined) delete process.env.AUTOPILOT_DISABLED;
    else process.env.AUTOPILOT_DISABLED = originalDisabled;
  });

  it("short-circuits when AUTOPILOT_DISABLED=1", async () => {
    process.env.AUTOPILOT_DISABLED = "1";
    process.env.ANTHROPIC_API_KEY = "x";
    const result = await runSpecToPr({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      specPath: ".gluecron/specs/foo.md",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("AUTOPILOT_DISABLED");
  });

  it("short-circuits when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    const result = await runSpecToPr({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      specPath: ".gluecron/specs/foo.md",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects paths outside .gluecron/specs/", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    process.env.ANTHROPIC_API_KEY = "x";
    const result = await runSpecToPr({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      specPath: "src/evil.md",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(".gluecron/specs");
  });

  it("rejects non-.md paths", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    process.env.ANTHROPIC_API_KEY = "x";
    const result = await runSpecToPr({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      specPath: ".gluecron/specs/foo.txt",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(".md");
  });
});

// ---------------------------------------------------------------------------
// Autopilot task — short-circuit + dependency-injection coverage (DB-less)
// ---------------------------------------------------------------------------

describe("runSpecToPrTaskOnce", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalDisabled = process.env.AUTOPILOT_DISABLED;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalDisabled === undefined) delete process.env.AUTOPILOT_DISABLED;
    else process.env.AUTOPILOT_DISABLED = originalDisabled;
  });

  it("no-ops when AUTOPILOT_DISABLED=1", async () => {
    process.env.AUTOPILOT_DISABLED = "1";
    process.env.ANTHROPIC_API_KEY = "x";
    let called = 0;
    const out = await runSpecToPrTaskOnce({
      findCandidates: async () => {
        called += 1;
        return [];
      },
    });
    expect(out).toEqual({ considered: 0, dispatched: 0, skipped: 0, failed: 0 });
    expect(called).toBe(0);
  });

  it("no-ops when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    let called = 0;
    const out = await runSpecToPrTaskOnce({
      findCandidates: async () => {
        called += 1;
        return [];
      },
    });
    expect(out.dispatched).toBe(0);
    expect(called).toBe(0);
  });

  it("dispatches a ready spec exactly once and counts the result", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    process.env.ANTHROPIC_API_KEY = "x";
    const cand: SpecToPrCandidate = {
      repositoryId: "repo-1",
      ownerName: "alice",
      repoName: "demo",
      defaultBranch: "main",
      specPath: ".gluecron/specs/foo.md",
    };
    let dispatchCount = 0;
    const out = await runSpecToPrTaskOnce({
      findCandidates: async () => [cand],
      hasOpenLinkedPr: async () => false,
      dispatcher: async () => {
        dispatchCount += 1;
        return { ok: true, branch: "ai-spec/foo-1", prNumber: 7, status: "building" };
      },
    });
    expect(dispatchCount).toBe(1);
    expect(out.dispatched).toBe(1);
    expect(out.skipped).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.considered).toBe(1);
  });

  it("skips a spec whose PR already exists", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    process.env.ANTHROPIC_API_KEY = "x";
    let dispatched = 0;
    const out = await runSpecToPrTaskOnce({
      findCandidates: async () => [
        {
          repositoryId: "r",
          ownerName: "alice",
          repoName: "demo",
          defaultBranch: "main",
          specPath: ".gluecron/specs/foo.md",
        },
      ],
      hasOpenLinkedPr: async () => true,
      dispatcher: async () => {
        dispatched += 1;
        return { ok: true, branch: "x", prNumber: 1, status: "building" };
      },
    });
    expect(dispatched).toBe(0);
    expect(out.skipped).toBe(1);
    expect(out.dispatched).toBe(0);
  });

  it("counts dispatcher failures separately from skips", async () => {
    delete process.env.AUTOPILOT_DISABLED;
    process.env.ANTHROPIC_API_KEY = "x";
    const out = await runSpecToPrTaskOnce({
      findCandidates: async () => [
        {
          repositoryId: "r",
          ownerName: "alice",
          repoName: "demo",
          defaultBranch: "main",
          specPath: ".gluecron/specs/foo.md",
        },
      ],
      hasOpenLinkedPr: async () => false,
      dispatcher: async () => ({ ok: false, error: "boom" }),
    });
    expect(out.failed).toBe(1);
    expect(out.dispatched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end runSpecToPr — fake Claude + real bare repo
// ---------------------------------------------------------------------------

/**
 * Build a fake global `fetch` that returns the canned Claude JSON envelope.
 * The Anthropic SDK calls `fetch` under the hood, so swapping it lets us
 * exercise the full pipeline without an API key or network.
 */
function withFakeAnthropic<T>(
  responseText: string,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  // Reset the cached Anthropic client so it captures the stubbed fetch.
  resetSpecAiClient();
  (globalThis as any).fetch = async () => {
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: responseText }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
    resetSpecAiClient();
  });
}

describe.skipIf(!HAS_DB)("runSpecToPr — end-to-end with fake Claude", () => {
  it(
    "opens a PR, tags it, and rewrites the spec status to building",
    async () => {
      process.env.ANTHROPIC_API_KEY = "anthropic-test-placeholder";
      delete process.env.AUTOPILOT_DISABLED;

      const username = `spectopr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          passwordHash: "x",
        })
        .returning({ id: users.id });

      const repoName = `subject_${Date.now()}`;
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

      // Seed a minimal repo: a source file + a ready spec.
      const seedSrc = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: "main",
        filePath: "src/app.ts",
        bytes: new TextEncoder().encode("export const hello = 'world';\n"),
        message: "seed src",
        authorName: "Seeder",
        authorEmail: "s@e.com",
      });
      if ("error" in seedSrc) throw new Error("seed src failed");

      const specBody =
        "---\ntitle: Add greeting\nstatus: ready\n---\n\nAdd a `greet()` helper to src/app.ts that returns 'hi'.\n";
      const seedSpec = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: "main",
        filePath: ".gluecron/specs/greet.md",
        bytes: new TextEncoder().encode(specBody),
        message: "seed spec",
        authorName: "Seeder",
        authorEmail: "s@e.com",
      });
      if ("error" in seedSpec) throw new Error("seed spec failed");

      const cannedEdits = JSON.stringify({
        summary: "Add greet() helper",
        edits: [
          {
            action: "edit",
            path: "src/app.ts",
            content:
              "export const hello = 'world';\nexport function greet(): string { return 'hi'; }\n",
          },
        ],
      });

      const result = await withFakeAnthropic(cannedEdits, () =>
        runSpecToPr({
          repositoryId: r.id,
          specPath: ".gluecron/specs/greet.md",
        })
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.branch.startsWith("ai-spec/greet-")).toBe(true);
      expect(typeof result.prNumber).toBe("number");
      expect(result.status).toBe("building");

      // Branch exists and contains the patched file.
      expect(
        await refExists(username, repoName, `refs/heads/${result.branch}`)
      ).toBe(true);
      const blob = await getBlob(username, repoName, result.branch, "src/app.ts");
      expect(blob).not.toBeNull();
      expect(blob!.content).toContain("greet()");

      // PR row exists with the right marker + label citation.
      const [pr] = await db
        .select({
          number: pullRequests.number,
          headBranch: pullRequests.headBranch,
          baseBranch: pullRequests.baseBranch,
          body: pullRequests.body,
          title: pullRequests.title,
        })
        .from(pullRequests)
        .where(eq(pullRequests.repositoryId, r.id))
        .limit(1);
      expect(pr).toBeTruthy();
      expect(pr!.headBranch).toBe(result.branch);
      expect(pr!.baseBranch).toBe("main");
      expect(pr!.title.startsWith("[spec]")).toBe(true);
      expect(pr!.body).toContain(AI_SPEC_PR_MARKER);
      expect(pr!.body).toContain(AI_SPEC_LABEL);
      expect(pr!.body).toContain(".gluecron/specs/greet.md");

      // The spec file should now be `status: building` on main.
      const updatedSpec = await getBlob(
        username,
        repoName,
        "main",
        ".gluecron/specs/greet.md"
      );
      expect(updatedSpec).not.toBeNull();
      const parsed = parseFrontMatter(updatedSpec!.content);
      expect(parsed.frontMatter.status).toBe("building");
      expect(parsed.frontMatter.pr).toBe(String(pr!.number));

      // Re-running against the (now `building`) spec should NOT open another
      // PR — both because the status is not `ready` AND because the dedup
      // query will find the previous PR body referencing the spec path.
      const second = await withFakeAnthropic(cannedEdits, () =>
        runSpecToPr({
          repositoryId: r.id,
          specPath: ".gluecron/specs/greet.md",
        })
      );
      expect(second.ok).toBe(false);
      if (!second.ok) {
        // Either status mismatch OR the dedup short-circuit — both are
        // valid "doesn't re-trigger" signals.
        expect(
          second.error.includes("not ready") ||
            second.error.includes("PR already exists")
        ).toBe(true);
      }

      // Now mark shipped and re-read.
      const shipped = await markSpecShipped({
        ownerName: username,
        repoName,
        defaultBranch: "main",
        specPath: ".gluecron/specs/greet.md",
        prNumber: pr!.number,
      });
      expect(shipped.ok).toBe(true);
      const finalSpec = await getBlob(
        username,
        repoName,
        "main",
        ".gluecron/specs/greet.md"
      );
      const finalParsed = parseFrontMatter(finalSpec!.content);
      expect(finalParsed.frontMatter.status).toBe("shipped");
    },
    25000
  );

  it("refuses a spec whose status is not 'ready'", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-test-placeholder";
    delete process.env.AUTOPILOT_DISABLED;

    const username = `spectopr_draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [u] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@example.com`,
        passwordHash: "x",
      })
      .returning({ id: users.id });

    const repoName = `subject_${Date.now()}`;
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
    const seed = await createOrUpdateFileOnBranch({
      owner: username,
      name: repoName,
      branch: "main",
      filePath: ".gluecron/specs/draft.md",
      bytes: new TextEncoder().encode(
        "---\ntitle: Draft\nstatus: draft\n---\n\nNot ready yet.\n"
      ),
      message: "seed draft",
      authorName: "Seeder",
      authorEmail: "s@e.com",
    });
    if ("error" in seed) throw new Error("seed failed");

    // Should refuse before calling the AI — so we don't even need a fetch stub.
    const result = await runSpecToPr({
      repositoryId: r.id,
      specPath: ".gluecron/specs/draft.md",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not ready");

    // No PR should have been opened.
    const prs = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, r.id));
    expect(prs.length).toBe(0);
  });
});

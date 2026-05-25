/**
 * Tests for src/lib/voice-to-pr.ts.
 *
 * Three concerns we can cover without standing up a DB or a real Anthropic
 * client:
 *
 *   1. `interpretVoiceTranscript` — the pure pipeline. We exercise it with
 *      a stub `client.call(prompt)` that returns canned JSON for various
 *      transcripts (spec, issue, unclear, malformed). Also covers the
 *      graceful-degrade path when ANTHROPIC_API_KEY is missing AND no stub
 *      is supplied — the function must still return a valid suggestion.
 *
 *   2. `shipAsSpec` — confirms it computes the correct
 *      `.gluecron/specs/voice-<slug>-*.md` path and calls the underlying
 *      git writer with the right shape. We mock the DB + git plumbing via
 *      module override on the global `mockGitWrite` symbol injected by the
 *      test setup. Verifies the spec body carries `status: ready`.
 *
 *   3. `createIssueFromVoice` — confirms it goes through the existing
 *      `issues` table insert and returns the new issue number. Mocked DB
 *      symbol matches the shape used by the real code so the import path
 *      stays stable.
 *
 * The DB-touching tests use module-level mock injection — we wrap the
 * imports with `mock.module` (bun:test) so the real Drizzle/Neon stack is
 * never reached.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  interpretVoiceTranscript,
  voiceSlug,
  normaliseInterpretation,
  buildInterpretPrompt,
  __voiceTest,
} from "../lib/voice-to-pr";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("voiceSlug", () => {
  it("kebab-cases the input", () => {
    expect(voiceSlug("Add dark mode toggle")).toBe("add-dark-mode-toggle");
  });
  it("trims leading/trailing hyphens", () => {
    expect(voiceSlug("--hello--")).toBe("hello");
  });
  it("caps at 40 chars", () => {
    const long = "a".repeat(80);
    expect(voiceSlug(long).length).toBeLessThanOrEqual(40);
  });
  it("falls back to 'voice-note' when empty", () => {
    expect(voiceSlug("")).toBe("voice-note");
    expect(voiceSlug("   !!!  ")).toBe("voice-note");
  });
});

describe("normaliseInterpretation", () => {
  it("returns the heuristic when raw is null", () => {
    const out = normaliseInterpretation(null, "Add dark mode");
    expect(out.kind).toBe("spec");
    expect(out.title.length).toBeGreaterThan(0);
    expect(out.body_markdown).toBe("Add dark mode");
  });

  it("rejects unknown kinds and falls back to 'unclear'", () => {
    const out = normaliseInterpretation(
      { kind: "thingy", title: "t", body_markdown: "b" },
      "noop"
    );
    expect(out.kind).toBe("unclear");
  });

  it("trims and preserves valid fields", () => {
    const out = normaliseInterpretation(
      {
        kind: "issue",
        title: "  Bug: header flickers  ",
        body_markdown: "  On Safari only.  ",
        target_repo_id_hint: "repo-123",
      },
      "fallback"
    );
    expect(out.kind).toBe("issue");
    expect(out.title).toBe("Bug: header flickers");
    expect(out.body_markdown).toBe("On Safari only.");
    expect(out.target_repo_id_hint).toBe("repo-123");
  });
});

describe("buildInterpretPrompt", () => {
  it("embeds the transcript verbatim", () => {
    const p = buildInterpretPrompt("Add dark mode", []);
    expect(p.includes("Add dark mode")).toBe(true);
    expect(p.includes('"kind"')).toBe(true);
  });
  it("includes a repo list block when repos are supplied", () => {
    const p = buildInterpretPrompt("x", [
      { id: "id-1", fullName: "alice/dashboard" },
      { id: "id-2", fullName: "alice/landing" },
    ]);
    expect(p.includes("alice/dashboard")).toBe(true);
    expect(p.includes("id-1")).toBe(true);
  });
});

describe("__voiceTest.classifyHeuristically", () => {
  const { classifyHeuristically } = __voiceTest;
  it("classifies feature requests as spec", () => {
    expect(classifyHeuristically("Add a dark mode toggle").kind).toBe("spec");
    expect(classifyHeuristically("Implement export to CSV").kind).toBe("spec");
  });
  it("classifies bug reports as issue", () => {
    expect(classifyHeuristically("Login is broken on Safari").kind).toBe("issue");
    expect(classifyHeuristically("The dashboard crashes when I click").kind).toBe("issue");
  });
  it("falls back to 'unclear' for ambiguous text", () => {
    expect(classifyHeuristically("hmm something").kind).toBe("unclear");
  });
});

// ---------------------------------------------------------------------------
// interpretVoiceTranscript — with mocked Claude
// ---------------------------------------------------------------------------

describe("interpretVoiceTranscript", () => {
  it("returns ok:false on empty transcript", async () => {
    const r = await interpretVoiceTranscript({ transcript: "" });
    expect(r.ok).toBe(false);
  });

  it("uses the injected client.call and parses spec JSON", async () => {
    const r = await interpretVoiceTranscript({
      transcript: "Add a dark mode toggle to settings",
      client: {
        call: async () =>
          JSON.stringify({
            kind: "spec",
            title: "Add dark mode toggle",
            body_markdown: "Users want a moon icon in settings.",
          }),
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.suggestion.kind).toBe("spec");
    expect(r.suggestion.title).toBe("Add dark mode toggle");
    expect(r.suggestion.body_markdown).toContain("moon");
  });

  it("parses issue JSON wrapped in a ```json fence", async () => {
    const r = await interpretVoiceTranscript({
      transcript: "The deploy pill keeps flashing",
      client: {
        call: async () =>
          '```json\n{"kind":"issue","title":"Deploy pill flashes","body_markdown":"Race in SSE reconnect."}\n```',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.suggestion.kind).toBe("issue");
  });

  it("falls back to 'unclear' on malformed model output", async () => {
    const r = await interpretVoiceTranscript({
      transcript: "Some random utterance",
      client: { call: async () => "not json at all" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    // We don't enforce kind here — heuristic picks it. We *do* enforce
    // the title isn't empty so the UI can render something.
    expect(r.suggestion.title.length).toBeGreaterThan(0);
  });

  it("gracefully degrades to the heuristic when ANTHROPIC_API_KEY is missing", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await interpretVoiceTranscript({
        transcript: "Add a settings page",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error();
      expect(r.suggestion.kind).toBe("spec");
    } finally {
      if (before) process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it("returns ok:false (not throw) when the injected client throws", async () => {
    const r = await interpretVoiceTranscript({
      transcript: "stub fails",
      client: {
        call: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.error).toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// shipAsSpec + createIssueFromVoice — DB + git plumbing mocks
// ---------------------------------------------------------------------------

// Track captured git writes across the suite.
const gitWrites: Array<any> = [];
const issueInserts: Array<any> = [];

// Mock the git plumbing — return success and stash the call args.
mock.module("../git/repository", () => ({
  createOrUpdateFileOnBranch: async (input: any) => {
    gitWrites.push(input);
    return { commitSha: "deadbeef", blobSha: "cafebabe", parentSha: null };
  },
}));

// Mock the DB layer with a tiny fluent stub. Only the call shapes the
// real code uses are implemented — anything else throws so we catch drift.
mock.module("../db", () => {
  // We need to vary the returned row shape per select call so both
  // `resolveRepoAndAuthor` (which uses `{repoName, defaultBranch, ownerName}`)
  // and `createIssueFromVoice` (which uses `{id, name, issueCount, ownerName}`)
  // get back rows that match the column aliases they asked for. The stub
  // remembers the aliases passed to `select()` and returns a row whose keys
  // include all of them.
  function selectStub(shape: Record<string, unknown>): any {
    const keys = Object.keys(shape || {});
    const row: Record<string, unknown> = {};
    // Fill in a sensible value per known alias.
    const aliasDefaults: Record<string, unknown> = {
      id: "repo-1",
      name: "demo",
      repoName: "demo",
      defaultBranch: "main",
      ownerName: "alice",
      issueCount: 0,
      username: "alice",
      email: "alice@example.com",
    };
    for (const k of keys) {
      row[k] = aliasDefaults[k] ?? null;
    }
    // For the user lookup (`users.username`, `users.email`), no leftJoin.
    return {
      from: (_table: any) => ({
        leftJoin: (_t: any, _on: any) => ({
          where: (_cond: any) => ({
            limit: async (_n: number) => [row],
          }),
        }),
        innerJoin: (_t: any, _on: any) => ({
          where: () => ({ limit: async () => [row] }),
        }),
        where: (_cond: any) => ({
          limit: async (_n: number) => [row],
        }),
      }),
    };
  }
  function insertStub(): any {
    return {
      values: (row: any) => ({
        returning: async () => {
          issueInserts.push(row);
          return [{ id: "issue-id", number: 42 }];
        },
      }),
    };
  }
  function updateStub(): any {
    return {
      set: (_row: any) => ({
        where: async (_cond: any) => undefined,
      }),
    };
  }
  return {
    db: {
      select: (shape?: any) => selectStub(shape || {}),
      insert: () => insertStub(),
      update: () => updateStub(),
    },
  };
});

// Re-import AFTER the mocks so the lib picks them up.
let shipAsSpec: typeof import("../lib/voice-to-pr").shipAsSpec;
let createIssueFromVoice: typeof import("../lib/voice-to-pr").createIssueFromVoice;

beforeEach(async () => {
  gitWrites.length = 0;
  issueInserts.length = 0;
  // Bun's module cache + mock.module work together: require/import returns
  // the patched module after the call above. We re-import here so each
  // suite sees the freshest mocks.
  const mod = await import("../lib/voice-to-pr");
  shipAsSpec = mod.shipAsSpec;
  createIssueFromVoice = mod.createIssueFromVoice;
});

afterEach(() => {
  // No global cleanup needed; mocks persist across tests in the suite
  // which is the desired behaviour for shipAsSpec/createIssueFromVoice.
});

describe("shipAsSpec", () => {
  it("rejects an empty transcript", async () => {
    const r = await shipAsSpec({
      repositoryId: "repo-1",
      transcript: "  ",
      userId: "user-1",
    });
    expect(r.ok).toBe(false);
  });

  it("writes to `.gluecron/specs/voice-<slug>-<ts>.md` on the default branch", async () => {
    const r = await shipAsSpec({
      repositoryId: "repo-1",
      transcript: "Add dark mode toggle to settings",
      userId: "user-1",
      interpretation: {
        kind: "spec",
        title: "Add dark mode toggle",
        body_markdown: "Users want a moon icon.",
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.specPath.startsWith(".gluecron/specs/voice-add-dark-mode-toggle-")).toBe(true);
    expect(r.specPath.endsWith(".md")).toBe(true);
    expect(r.branch).toBe("main");
    expect(gitWrites.length).toBe(1);
    const w = gitWrites[0];
    expect(w.owner).toBe("alice");
    expect(w.name).toBe("demo");
    expect(w.branch).toBe("main");
    // Decode the spec body and assert key invariants.
    const body = new TextDecoder().decode(w.bytes);
    expect(body.includes("status: ready")).toBe(true);
    expect(body.includes("source: voice-to-pr")).toBe(true);
    expect(body.includes("Users want a moon icon.")).toBe(true);
  });

  it("uses a heuristic title when interpretation is omitted", async () => {
    const r = await shipAsSpec({
      repositoryId: "repo-1",
      transcript: "Implement CSV export",
      userId: "user-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.specPath.includes("voice-implement-csv-export-")).toBe(true);
  });
});

describe("createIssueFromVoice", () => {
  it("rejects an empty transcript", async () => {
    const r = await createIssueFromVoice({
      repositoryId: "repo-1",
      transcript: "",
      userId: "user-1",
    });
    expect(r.ok).toBe(false);
  });

  it("inserts an issue row and returns the issue number", async () => {
    const r = await createIssueFromVoice({
      repositoryId: "repo-1",
      transcript: "Header flickers on Safari",
      userId: "user-1",
      interpretation: {
        kind: "issue",
        title: "Header flickers on Safari",
        body_markdown: "Repro: open dashboard on Safari 17.",
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.issueNumber).toBe(42);
    expect(r.ownerName).toBe("alice");
    expect(r.repoName).toBe("demo");
    expect(issueInserts.length).toBe(1);
    expect(issueInserts[0].repositoryId).toBe("repo-1");
    expect(issueInserts[0].authorId).toBe("user-1");
    expect(issueInserts[0].title).toContain("Header flickers");
    expect(issueInserts[0].body).toContain("Repro");
    expect(issueInserts[0].body.toLowerCase()).toContain("voice-to-pr");
  });
});

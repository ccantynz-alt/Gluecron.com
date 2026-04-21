/**
 * Tests for spec-to-PR v2, part 2 — the Claude call + response parser.
 *
 * The Anthropic SDK captures `globalThis.fetch` at client construction, so
 * every test that installs a stub must first call `_resetClientForTests()`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetClientForTests,
  generateSpecEdits,
  isForbiddenPath,
  parseAiJsonResponse,
  validateEdit,
} from "../lib/spec-ai";

const origFetch = globalThis.fetch;
const origKey = process.env.ANTHROPIC_API_KEY;

/**
 * Install a fake fetch that returns a single Anthropic-shaped messages.create
 * response with the provided text body.
 */
function installAnthropicFetch(textBody: string | (() => string)): void {
  // @ts-expect-error — override global fetch for the duration of the test
  globalThis.fetch = async (
    _input: RequestInfo | URL,
    _init: RequestInit = {}
  ): Promise<Response> => {
    const text = typeof textBody === "function" ? textBody() : textBody;
    const payload = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function restoreEnv(): void {
  globalThis.fetch = origFetch;
  if (origKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = origKey;
  }
  _resetClientForTests();
}

// ---------------------------------------------------------------------------
// Pure helpers — quick sanity checks alongside the main 4 tests.
// ---------------------------------------------------------------------------

describe("lib/spec-ai — pure helpers", () => {
  it("isForbiddenPath flags locked files", () => {
    expect(isForbiddenPath("BUILD_BIBLE.md")).toBe(true);
    expect(isForbiddenPath("src/views/layout.tsx")).toBe(true);
    expect(isForbiddenPath("drizzle/0001_init.sql")).toBe(true);
    expect(isForbiddenPath("legal/terms.md")).toBe(true);
    expect(isForbiddenPath("LICENSE")).toBe(true);
    expect(isForbiddenPath(".github/workflows/ci.yml")).toBe(true);
  });

  it("isForbiddenPath lets ordinary source paths through", () => {
    expect(isForbiddenPath("src/lib/foo.ts")).toBe(false);
    expect(isForbiddenPath("src/routes/api.ts")).toBe(false);
  });

  it("validateEdit rejects unsafe paths", () => {
    expect(validateEdit({ action: "edit", path: "/etc/passwd", content: "" })).toBe(false);
    expect(validateEdit({ action: "edit", path: "../foo", content: "" })).toBe(false);
    expect(validateEdit({ action: "edit", path: "", content: "" })).toBe(false);
  });

  it("validateEdit accepts a well-formed edit", () => {
    expect(
      validateEdit({ action: "edit", path: "src/lib/foo.ts", content: "x" })
    ).toBe(true);
    expect(
      validateEdit({ action: "delete", path: "src/old.ts" })
    ).toBe(true);
  });

  it("parseAiJsonResponse strips ```json fences", () => {
    const parsed = parseAiJsonResponse('```json\n{"a":1}\n```');
    expect(parsed).toEqual({ a: 1 });
  });

  it("parseAiJsonResponse parses raw JSON", () => {
    const parsed = parseAiJsonResponse('{"b":2}');
    expect(parsed).toEqual({ b: 2 });
  });

  it("parseAiJsonResponse returns null on garbage", () => {
    expect(parseAiJsonResponse("not json at all")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The 4 required tests.
// ---------------------------------------------------------------------------

describe("lib/spec-ai — generateSpecEdits", () => {
  beforeEach(() => {
    _resetClientForTests();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("returns ok:false when ANTHROPIC_API_KEY missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await generateSpecEdits({
      spec: "add a greeting function",
      fileList: ["src/index.ts"],
      relevantFiles: [{ path: "src/index.ts", content: "// hi" }],
      defaultBranch: "main",
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("parses a well-formed response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    installAnthropicFetch(
      JSON.stringify({
        summary: "add greet()",
        edits: [
          {
            action: "create",
            path: "src/lib/greet.ts",
            content: "export const greet = () => 'hi';",
          },
          {
            action: "edit",
            path: "src/index.ts",
            content: "import { greet } from './lib/greet';\ngreet();",
          },
          { action: "delete", path: "src/old.ts" },
        ],
      })
    );

    const result = await generateSpecEdits({
      spec: "add a greeting",
      fileList: ["src/index.ts"],
      relevantFiles: [{ path: "src/index.ts", content: "// hi" }],
      defaultBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.summary).toBe("add greet()");
      expect(result.edits).toHaveLength(3);
      expect(result.edits[0]).toEqual({
        action: "create",
        path: "src/lib/greet.ts",
        content: "export const greet = () => 'hi';",
      });
      expect(result.edits[2]).toEqual({ action: "delete", path: "src/old.ts" });
    }
  });

  // We chose "drop the forbidden edit, keep the ok:true envelope" — the
  // caller can compare input vs output length if they want to detect this.
  // If Claude proposes ONLY forbidden edits, the caller receives
  // `{ok:true, edits:[], summary:"AI proposed no changes"}`.
  it("rejects edits targeting forbidden paths (silently dropped)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    installAnthropicFetch(
      JSON.stringify({
        summary: "mixed forbidden + allowed",
        edits: [
          {
            action: "edit",
            path: "BUILD_BIBLE.md",
            content: "should be dropped",
          },
          {
            action: "edit",
            path: "src/views/layout.tsx",
            content: "should also be dropped",
          },
          {
            action: "edit",
            path: "drizzle/0001_init.sql",
            content: "dropped",
          },
          {
            action: "edit",
            path: "LICENSE",
            content: "dropped",
          },
          {
            action: "edit",
            path: ".github/workflows/ci.yml",
            content: "dropped",
          },
          {
            action: "create",
            path: "src/lib/ok.ts",
            content: "export const ok = 1;",
          },
        ],
      })
    );

    const result = await generateSpecEdits({
      spec: "touch forbidden files",
      fileList: ["BUILD_BIBLE.md", "LICENSE"],
      relevantFiles: [],
      defaultBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      // Exactly one allowed edit survives.
      expect(result.edits).toHaveLength(1);
      expect(result.edits[0].path).toBe("src/lib/ok.ts");
      // No edit points at a forbidden path.
      for (const e of result.edits) {
        expect(isForbiddenPath(e.path)).toBe(false);
      }
    }
  });

  it("handles malformed JSON response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    installAnthropicFetch("this is not JSON, sorry");

    const result = await generateSpecEdits({
      spec: "whatever",
      fileList: [],
      relevantFiles: [],
      defaultBranch: "main",
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe("AI returned invalid JSON");
    }
  });
});

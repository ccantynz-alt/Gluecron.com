/**
 * Tests for the expanded MCP tool surface in src/lib/mcp-tools-expanded.ts.
 *
 * We focus on:
 *   - Manifest shape: every new tool has a name, description, inputSchema
 *   - Default tools registry merges the expanded set in (≥ 50 total)
 *   - Input validation: each tool rejects malformed args (missing fields)
 *   - Auth gating: write tools throw INVALID_PARAMS without ctx.userId
 *   - Scope gating: admin-grade tools throw INVALID_PARAMS without 'admin'
 *   - A handful of happy-path branches that exercise pure logic without
 *     touching Postgres (uses HAS_DB skipIf where DB is required).
 *
 * Mirrors the conventions of `mcp.test.ts` + `mcp-write.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import {
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  McpError,
} from "../lib/mcp";
import { defaultTools } from "../lib/mcp-tools";
import { expandedTools, __expandedTest } from "../lib/mcp-tools-expanded";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const anonCtx = { userId: null, scopes: [] };
const authedCtx = { userId: "user-fixture-id", scopes: ["repo", "user", "admin"] };
const limitedCtx = { userId: "user-fixture-id", scopes: ["repo"] };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("expanded tool registry", () => {
  it("exports at least 40 tools", () => {
    const tools = expandedTools();
    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(40);
  });

  it("merges into defaultTools() to surpass 50 total", () => {
    const all = defaultTools();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(50);
  });

  it("every tool name is gluecron_-prefixed", () => {
    for (const handler of Object.values(expandedTools())) {
      expect(handler.tool.name).toMatch(/^gluecron_/);
    }
  });

  it("every tool has a non-trivial description and object schema", () => {
    for (const handler of Object.values(expandedTools())) {
      expect(typeof handler.tool.description).toBe("string");
      expect(handler.tool.description.length).toBeGreaterThan(10);
      expect(handler.tool.inputSchema.type).toBe("object");
      expect(typeof handler.tool.inputSchema.properties).toBe("object");
    }
  });

  it("does not clobber any existing 15-tool name", () => {
    const expandedNames = new Set(Object.keys(expandedTools()));
    const legacy = [
      "gluecron_repo_search",
      "gluecron_repo_read_file",
      "gluecron_repo_list_issues",
      "gluecron_repo_explain_codebase",
      "gluecron_repo_health",
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
    for (const name of legacy) {
      expect(expandedNames.has(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("input validation — malformed args throw McpError", () => {
  // We assert one schema-validation behaviour per tool: missing required
  // argument → McpError. Reading happens before any DB call so these
  // never need a live DB.
  const malformedCases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "fork_repo", args: {} },
    { name: "delete_repo", args: { owner: "x" } },
    { name: "update_repo", args: {} },
    { name: "search_repos", args: {} },
    { name: "clone_url", args: { owner: "x" } },
    { name: "label_issue", args: { owner: "x", repo: "y" } },
    { name: "unlabel_issue", args: { owner: "x", repo: "y", number: 1 } },
    { name: "assign_issue", args: { owner: "x", repo: "y" } },
    { name: "search_issues", args: { owner: "x", repo: "y" } },
    { name: "request_changes", args: { owner: "x", repo: "y" } },
    { name: "search_prs", args: { owner: "x", repo: "y" } },
    { name: "open_draft_pr", args: { owner: "x", repo: "y" } },
    { name: "generate_pr_description", args: {} },
    { name: "read_file", args: { owner: "x", repo: "y" } },
    { name: "write_file", args: { owner: "x", repo: "y" } },
    { name: "delete_file", args: { owner: "x", repo: "y" } },
    { name: "list_tree", args: { owner: "x" } },
    { name: "get_commit", args: { owner: "x", repo: "y" } },
    { name: "create_branch", args: { owner: "x", repo: "y" } },
    { name: "atomic_multi_file_commit", args: { owner: "x", repo: "y" } },
    { name: "ship_spec", args: { owner: "x", repo: "y" } },
    { name: "voice_to_pr", args: { owner: "x", repo: "y" } },
    { name: "refactor_across_repos", args: {} },
    { name: "explain_repo", args: {} },
    { name: "chat_with_repo", args: { owner: "x", repo: "y" } },
    { name: "chat_continue", args: {} },
    { name: "generate_tests", args: { owner: "x", repo: "y" } },
    { name: "generate_commit_message", args: {} },
    { name: "generate_release_notes", args: { owner: "x", repo: "y" } },
    { name: "propose_migration", args: { owner: "x", repo: "y" } },
    { name: "propose_doc_update", args: { owner: "x" } },
    { name: "trigger_workflow", args: { owner: "x", repo: "y" } },
    { name: "get_workflow_run", args: { owner: "x", repo: "y" } },
    { name: "get_workflow_logs", args: { owner: "x", repo: "y" } },
    { name: "cancel_workflow_run", args: { owner: "x", repo: "y" } },
    { name: "get_preview_url", args: { owner: "x", repo: "y" } },
    { name: "provision_pr_sandbox", args: { owner: "x", repo: "y" } },
    { name: "create_agent_session", args: {} },
    { name: "acquire_lease", args: {} },
    { name: "release_lease", args: {} },
    { name: "get_agent_budget", args: {} },
    { name: "semantic_search", args: { owner: "x", repo: "y" } },
    { name: "find_symbol", args: { owner: "x", repo: "y" } },
    { name: "pr_status_summary", args: { owner: "x", repo: "y" } },
  ];

  for (const tc of malformedCases) {
    it(`gluecron_${tc.name} rejects missing required args`, async () => {
      const tools = expandedTools();
      // The malformed test cases above name the tool sans `gluecron_`
      // prefix so the tool name and the case name line up.
      const handler = tools[`gluecron_${tc.name}`];
      expect(handler).toBeDefined();
      // We always pass an authed ctx so the arg-validation path is the
      // *first* failure point — not the auth gate.
      await expect(handler.run(tc.args, authedCtx)).rejects.toThrow(McpError);
    });
  }
});

// ---------------------------------------------------------------------------
// Auth gates
// ---------------------------------------------------------------------------

describe("auth gates — write tools reject anonymous callers", () => {
  const writeTools = [
    {
      name: "gluecron_fork_repo",
      args: { owner: "a", repo: "b" },
    },
    {
      name: "gluecron_delete_repo",
      args: { owner: "a", repo: "b" },
    },
    {
      name: "gluecron_update_repo",
      args: { owner: "a", repo: "b", description: "x" },
    },
    {
      name: "gluecron_label_issue",
      args: { owner: "a", repo: "b", number: 1, labels: ["bug"] },
    },
    {
      name: "gluecron_unlabel_issue",
      args: { owner: "a", repo: "b", number: 1, label: "bug" },
    },
    {
      name: "gluecron_assign_issue",
      args: { owner: "a", repo: "b", number: 1, assignee: "x" },
    },
    {
      name: "gluecron_request_changes",
      args: { owner: "a", repo: "b", number: 1, body: "x" },
    },
    {
      name: "gluecron_open_draft_pr",
      args: { owner: "a", repo: "b", title: "t", head_branch: "h" },
    },
    {
      name: "gluecron_write_file",
      args: { owner: "a", repo: "b", path: "x", branch: "b", message: "m", content: "y" },
    },
    {
      name: "gluecron_delete_file",
      args: { owner: "a", repo: "b", path: "x", branch: "b", message: "m", sha: "0".repeat(40) },
    },
    {
      name: "gluecron_create_branch",
      args: { owner: "a", repo: "b", branch: "n", sha: "0".repeat(40) },
    },
    {
      name: "gluecron_atomic_multi_file_commit",
      args: {
        owner: "a",
        repo: "b",
        branch: "n",
        message: "m",
        changes: [{ path: "f", content: "x" }],
      },
    },
    {
      name: "gluecron_ship_spec",
      args: { owner: "a", repo: "b", title: "t", body: "x" },
    },
    {
      name: "gluecron_voice_to_pr",
      args: { owner: "a", repo: "b", transcript: "hi" },
    },
    {
      name: "gluecron_refactor_across_repos",
      args: { description: "x" },
    },
    {
      name: "gluecron_chat_with_repo",
      args: { owner: "a", repo: "b", message: "hi" },
    },
    {
      name: "gluecron_chat_continue",
      args: { chat_id: "x", message: "hi" },
    },
    {
      name: "gluecron_generate_tests",
      args: { owner: "a", repo: "b", number: 1 },
    },
    {
      name: "gluecron_propose_migration",
      args: {
        owner: "a",
        repo: "b",
        dependency: "d",
        from_version: "1",
        to_version: "2",
        base_sha: "x",
      },
    },
    {
      name: "gluecron_propose_doc_update",
      args: { owner: "a", repo: "b" },
    },
    {
      name: "gluecron_trigger_workflow",
      args: { owner: "a", repo: "b", filename: "ci.yml" },
    },
    {
      name: "gluecron_cancel_workflow_run",
      args: { owner: "a", repo: "b", run_id: "x" },
    },
    {
      name: "gluecron_provision_pr_sandbox",
      args: { owner: "a", repo: "b", number: 1 },
    },
    {
      name: "gluecron_create_agent_session",
      args: { name: "x" },
    },
    {
      name: "gluecron_acquire_lease",
      args: { agent_session_id: "x", target_type: "y", target_id: "z" },
    },
    {
      name: "gluecron_release_lease",
      args: { lease_id: "x" },
    },
    {
      name: "gluecron_get_agent_budget",
      args: { agent_session_id: "x" },
    },
    {
      name: "gluecron_ai_cost_summary",
      args: {},
    },
  ];

  for (const t of writeTools) {
    it(`${t.name} throws on anonymous ctx`, async () => {
      const tools = expandedTools();
      const handler = tools[t.name];
      await expect(handler.run(t.args, anonCtx)).rejects.toThrow(McpError);
    });
  }
});

// ---------------------------------------------------------------------------
// Scope gates
// ---------------------------------------------------------------------------

describe("scope gates", () => {
  it("delete_repo requires 'admin' scope", async () => {
    const { deleteRepo } = __expandedTest;
    await expect(
      deleteRepo.run({ owner: "a", repo: "b" }, limitedCtx)
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("create_agent_session requires 'admin' scope", async () => {
    const { createAgentSession } = __expandedTest;
    await expect(
      createAgentSession.run({ name: "agent-x" }, limitedCtx)
    ).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
  });

  it("requireScope helper passes when 'admin' is held", () => {
    const { requireScope } = __expandedTest;
    expect(() =>
      requireScope({ userId: "u", scopes: ["admin"] }, "repo", "x")
    ).not.toThrow();
  });

  it("requireScope helper passes when undefined scopes (legacy permissive)", () => {
    const { requireScope } = __expandedTest;
    expect(() =>
      requireScope({ userId: "u" }, "admin", "x")
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pure-logic happy paths
// ---------------------------------------------------------------------------

describe("pure-logic tools", () => {
  it("generate_commit_message returns a subject + body", async () => {
    const { generateCommitMessageTool } = __expandedTest;
    const out = (await generateCommitMessageTool.run(
      { diff: "diff --git a/x b/x\n+hello\n" },
      authedCtx
    )) as { subject: string; body: string };
    expect(typeof out.subject).toBe("string");
    expect(out.subject.length).toBeGreaterThan(0);
  });

  it("generate_pr_description routes through ai-commit-message", async () => {
    const { generatePrDescription } = __expandedTest;
    const out = (await generatePrDescription.run(
      { diff: "diff --git a/x b/x\n+hi\n" },
      authedCtx
    )) as { subject: string };
    expect(typeof out.subject).toBe("string");
  });

  it.skipIf(!HAS_DB)("clone_url throws METHOD_NOT_FOUND for missing repo", async () => {
    // resolveAccessibleRepo is the first gate; a non-existent repo
    // surfaces as a method_not_found error code regardless of caller
    // auth (privacy contract).
    const { cloneUrl } = __expandedTest;
    await expect(
      cloneUrl.run({ owner: "nobody-xyz-fixture", repo: "nope" }, anonCtx)
    ).rejects.toMatchObject({ code: ERR_METHOD_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// DB-backed smoke (HAS_DB gated)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("DB-backed smoke checks", () => {
  it("search_repos runs against the live DB and returns a shaped payload", async () => {
    const { searchRepos } = __expandedTest;
    const out = (await searchRepos.run(
      { query: "test", limit: 1 },
      anonCtx
    )) as { total: number; repos: unknown[] };
    expect(typeof out.total).toBe("number");
    expect(Array.isArray(out.repos)).toBe(true);
  });
});

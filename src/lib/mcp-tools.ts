/**
 * MCP tool handlers — read-only v1 set.
 *
 * Each handler returns either a string (auto-wrapped to text content)
 * or the full MCP `{content: [...]}` shape. Errors throw `McpError` from
 * `mcp.ts` so the router can surface them as JSON-RPC -32xxx codes.
 *
 * Tool surface (v1, all read-only):
 *   - gluecron_repo_search        — search public repos by keyword
 *   - gluecron_repo_read_file     — read a file from a repo at a ref
 *   - gluecron_repo_list_issues   — list open issues for a repo
 *   - gluecron_repo_explain_codebase — return cached AI explanation
 *
 * v2 will add write tools (create_issue, post_comment, run_workflow)
 * gated on `userId` + write-access on the target repo.
 */

import { and, asc, desc, eq, like, or } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  repositories,
  users,
  codebaseExplanations,
} from "../db/schema";
import { getBlob } from "../git/repository";
import { McpError, ERR_INVALID_PARAMS, ERR_METHOD_NOT_FOUND } from "./mcp";
import type { McpContext } from "./mcp";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

export type McpToolHandler = {
  tool: McpTool;
  run: (
    args: Record<string, unknown>,
    ctx: McpContext
  ) => Promise<unknown>;
};

const argString = (
  args: Record<string, unknown>,
  key: string,
  fallback?: string
): string => {
  const v = args[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (fallback !== undefined) return fallback;
  throw new McpError(ERR_INVALID_PARAMS, `argument '${key}' is required`);
};

const argNumber = (
  args: Record<string, unknown>,
  key: string,
  fallback?: number
): number => {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  if (fallback !== undefined) return fallback;
  throw new McpError(ERR_INVALID_PARAMS, `argument '${key}' must be a number`);
};

// ---------------------------------------------------------------------------
// gluecron_repo_search
// ---------------------------------------------------------------------------

const repoSearch: McpToolHandler = {
  tool: {
    name: "gluecron_repo_search",
    description:
      "Search public Gluecron repositories by keyword. Matches against name + description. Returns up to 20 results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword (1-100 chars)" },
        limit: { type: "number", description: "Max results, default 20" },
      },
      required: ["query"],
    },
  },
  async run(args) {
    const q = argString(args, "query");
    if (q.length > 100) {
      throw new McpError(ERR_INVALID_PARAMS, "query too long (max 100 chars)");
    }
    const limit = Math.max(1, Math.min(50, argNumber(args, "limit", 20)));
    const pattern = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        description: repositories.description,
        ownerName: users.username,
        stars: repositories.starCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(
          eq(repositories.isPrivate, false),
          or(
            like(repositories.name, pattern),
            like(repositories.description, pattern)
          )
        )
      )
      .orderBy(desc(repositories.starCount))
      .limit(limit);
    return {
      total: rows.length,
      repos: rows.map((r) => ({
        fullName: `${r.ownerName}/${r.name}`,
        description: r.description || "",
        stars: r.stars,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// gluecron_repo_read_file
// ---------------------------------------------------------------------------

const repoReadFile: McpToolHandler = {
  tool: {
    name: "gluecron_repo_read_file",
    description:
      "Read a single file from a public repository at a given ref (branch / tag / commit). Returns the text content (binary files rejected).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        ref: { type: "string", description: "Branch / tag / commit (default: main)" },
        path: { type: "string", description: "File path within the repo" },
      },
      required: ["owner", "repo", "path"],
    },
  },
  async run(args) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const ref = argString(args, "ref", "main");
    const path = argString(args, "path");

    // Visibility check — public-only for v1. (Authed users see private
    // repos in v2 once we extend the args.)
    const [r] = await db
      .select({ isPrivate: repositories.isPrivate })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    if (!r) throw new McpError(ERR_METHOD_NOT_FOUND, `repo not found: ${owner}/${repo}`);
    if (r.isPrivate) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `${owner}/${repo} is private; v1 MCP read tool is public-only`
      );
    }

    const blob = await getBlob(owner, repo, ref, path);
    if (!blob) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `path not found: ${owner}/${repo}@${ref}:${path}`
      );
    }
    return {
      content: [
        {
          type: "text",
          text: blob.content,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// gluecron_repo_list_issues
// ---------------------------------------------------------------------------

const repoListIssues: McpToolHandler = {
  tool: {
    name: "gluecron_repo_list_issues",
    description:
      "List open issues for a public repository. Returns up to 50 ordered by most-recent.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        limit: { type: "number", description: "Max results, default 25" },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const limit = Math.max(1, Math.min(50, argNumber(args, "limit", 25)));

    const [r] = await db
      .select({ id: repositories.id, isPrivate: repositories.isPrivate })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    if (!r) throw new McpError(ERR_METHOD_NOT_FOUND, `repo not found: ${owner}/${repo}`);
    if (r.isPrivate) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `${owner}/${repo} is private; v1 MCP read tool is public-only`
      );
    }

    const rows = await db
      .select({
        number: issues.number,
        title: issues.title,
        body: issues.body,
        state: issues.state,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(and(eq(issues.repositoryId, r.id), eq(issues.state, "open")))
      .orderBy(desc(issues.createdAt))
      .limit(limit);
    return {
      total: rows.length,
      issues: rows.map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body || "",
        state: i.state,
        createdAt: i.createdAt,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// gluecron_repo_explain_codebase
// ---------------------------------------------------------------------------

const repoExplain: McpToolHandler = {
  tool: {
    name: "gluecron_repo_explain_codebase",
    description:
      "Return the cached AI 'explain this codebase' Markdown for a public repo (most recent commit). Returns null when no cached explanation exists yet.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const [r] = await db
      .select({ id: repositories.id, isPrivate: repositories.isPrivate })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    if (!r) throw new McpError(ERR_METHOD_NOT_FOUND, `repo not found: ${owner}/${repo}`);
    if (r.isPrivate) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `${owner}/${repo} is private; v1 MCP read tool is public-only`
      );
    }
    const [row] = await db
      .select({
        commitSha: codebaseExplanations.commitSha,
        markdown: codebaseExplanations.markdown,
        createdAt: codebaseExplanations.createdAt,
      })
      .from(codebaseExplanations)
      .where(eq(codebaseExplanations.repositoryId, r.id))
      .orderBy(desc(codebaseExplanations.createdAt))
      .limit(1);
    if (!row) {
      return { explanation: null };
    }
    return {
      commitSha: row.commitSha,
      generatedAt: row.createdAt,
      markdown: row.markdown,
    };
  },
};

// ---------------------------------------------------------------------------
// Default tool registry
// ---------------------------------------------------------------------------

export function defaultTools(): Record<string, McpToolHandler> {
  return {
    [repoSearch.tool.name]: repoSearch,
    [repoReadFile.tool.name]: repoReadFile,
    [repoListIssues.tool.name]: repoListIssues,
    [repoExplain.tool.name]: repoExplain,
  };
}

/** Test-only export of internal helpers + per-tool handlers. */
export const __test = {
  argString,
  argNumber,
  repoSearch,
  repoReadFile,
  repoListIssues,
  repoExplain,
};

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

import { and, asc, desc, eq, like, or, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  issueComments,
  pullRequests,
  prComments,
  repositories,
  users,
  codebaseExplanations,
} from "../db/schema";
import { getBlob, repoExists, resolveRef, getRepoPath } from "../git/repository";
import { computeHealthScore } from "./intelligence";
import { McpError, ERR_INVALID_PARAMS, ERR_METHOD_NOT_FOUND } from "./mcp";
import type { McpContext } from "./mcp";
import { resolveRepoAccess, satisfiesAccess } from "../middleware/repo-access";
import type { RepoAccessLevel } from "../middleware/repo-access";
import { notify, audit } from "./notify";
import { runAllGateChecks } from "./gate";
import {
  matchProtection,
  countHumanApprovals,
  listRequiredChecks,
  passingCheckNames,
  evaluateProtection,
} from "./branch-protection";
import { mergeWithAutoResolve } from "./merge-resolver";
import { isAiReviewEnabled } from "./ai-review";
import {
  computePrRiskForPullRequest,
  getCachedPrRisk,
  getLatestCachedPrRisk,
  type PrRiskScore,
} from "./pr-risk";

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
        generatedAt: codebaseExplanations.generatedAt,
      })
      .from(codebaseExplanations)
      .where(eq(codebaseExplanations.repositoryId, r.id))
      .orderBy(desc(codebaseExplanations.generatedAt))
      .limit(1);
    if (!row) {
      return { explanation: null };
    }
    return {
      commitSha: row.commitSha,
      generatedAt: row.generatedAt,
      markdown: row.markdown,
    };
  },
};

// ---------------------------------------------------------------------------
// gluecron_repo_health
// ---------------------------------------------------------------------------

const repoHealth: McpToolHandler = {
  tool: {
    name: "gluecron_repo_health",
    description:
      "Compute the current health report for a public repo: overall score (0-100), letter grade, per-category breakdown (security/testing/complexity/dependencies/documentation/activity), and a list of insights to fix next. Backed by computeHealthScore in src/lib/intelligence.ts.",
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
        `${owner}/${repo} is private; v1 MCP tools are public-only`
      );
    }
    if (!(await repoExists(owner, repo))) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `${owner}/${repo} has no on-disk git data yet`
      );
    }
    const report = await computeHealthScore(owner, repo);
    return {
      score: report.score,
      grade: report.grade,
      breakdown: report.breakdown,
      insights: report.insights,
      generatedAt: report.generatedAt,
    };
  },
};

// ---------------------------------------------------------------------------
// Write-surface shared helpers (Block K1)
// ---------------------------------------------------------------------------

/**
 * Require an authenticated context — every write tool gates on this first.
 * Throws -32602 invalid_params with a tool-specific message so the client
 * surface knows exactly which call needs auth.
 */
function requireAuthedCtx(ctx: McpContext, toolName: string): string {
  if (!ctx.userId) {
    throw new McpError(
      ERR_INVALID_PARAMS,
      `authentication required for ${toolName}`
    );
  }
  return ctx.userId;
}

/**
 * Resolve an `owner/repo` pair to its full row, and confirm the caller has
 * at least `read` access. Privacy: when the repo is missing OR the caller
 * cannot see it, throw -32601 method_not_found with the same message —
 * matches the read-tool privacy contract so private-repo existence does
 * not leak.
 */
async function resolveAccessibleRepo(
  owner: string,
  repo: string,
  userId: string | null
): Promise<{
  repoId: string;
  ownerId: string;
  isPrivate: boolean;
  defaultBranch: string;
  access: RepoAccessLevel;
}> {
  const [row] = await db
    .select({
      id: repositories.id,
      ownerId: repositories.ownerId,
      isPrivate: repositories.isPrivate,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  if (!row) {
    throw new McpError(ERR_METHOD_NOT_FOUND, `repo not found: ${owner}/${repo}`);
  }
  const access = await resolveRepoAccess({
    repoId: row.id,
    userId,
    isPublic: !row.isPrivate,
  });
  if (!satisfiesAccess(access, "read")) {
    // Hide existence of private repos from non-collaborators.
    throw new McpError(ERR_METHOD_NOT_FOUND, `repo not found: ${owner}/${repo}`);
  }
  return {
    repoId: row.id,
    ownerId: row.ownerId,
    isPrivate: row.isPrivate,
    defaultBranch: row.defaultBranch,
    access,
  };
}

/**
 * Combine `requireAuthedCtx` + `resolveAccessibleRepo` + write-access gate.
 * Used by every write tool. Returns the repo metadata for downstream use.
 *
 * Per spec: reject with -32601 method_not_found (not -32603) so the
 * existence of private repos the caller cannot see is not leaked through
 * the error code shape.
 */
async function gateWriteAccess(
  args: { owner: string; repo: string },
  ctx: McpContext,
  toolName: string
): Promise<{
  userId: string;
  owner: string;
  repo: string;
  repoId: string;
  ownerId: string;
  isPrivate: boolean;
  defaultBranch: string;
}> {
  const userId = requireAuthedCtx(ctx, toolName);
  const info = await resolveAccessibleRepo(args.owner, args.repo, userId);
  if (!satisfiesAccess(info.access, "write")) {
    throw new McpError(
      ERR_METHOD_NOT_FOUND,
      `no write access to ${args.owner}/${args.repo}`
    );
  }
  return {
    userId,
    owner: args.owner,
    repo: args.repo,
    repoId: info.repoId,
    ownerId: info.ownerId,
    isPrivate: info.isPrivate,
    defaultBranch: info.defaultBranch,
  };
}

function prUrl(owner: string, repo: string, number: number): string {
  return `/${owner}/${repo}/pulls/${number}`;
}
function issueUrl(owner: string, repo: string, number: number): string {
  return `/${owner}/${repo}/issues/${number}`;
}

async function loadPrByNumber(repoId: string, prNumber: number) {
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repoId),
        eq(pullRequests.number, prNumber)
      )
    )
    .limit(1);
  return pr ?? null;
}

async function loadIssueByNumber(repoId: string, issueNumber: number) {
  const [row] = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.repositoryId, repoId),
        eq(issues.number, issueNumber)
      )
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// gluecron_create_issue
// ---------------------------------------------------------------------------

const createIssue: McpToolHandler = {
  tool: {
    name: "gluecron_create_issue",
    description:
      "Create a new issue on a Gluecron repository. Requires authenticated caller with write access on the target repo. Returns {number, url}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body (Markdown). Optional." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const title = argString(args, "title");
    const body = argString(args, "body", "");

    const gate = await gateWriteAccess({ owner, repo }, ctx, "gluecron_create_issue");

    const [inserted] = await db
      .insert(issues)
      .values({
        repositoryId: gate.repoId,
        authorId: gate.userId,
        title,
        body: body || null,
      })
      .returning();

    // Bump issue count (best-effort, mirrors the HTTP route)
    try {
      await db
        .update(repositories)
        .set({ issueCount: sqlExpr("issue_count + 1") })
        .where(eq(repositories.id, gate.repoId));
    } catch {
      /* non-fatal */
    }

    await audit({
      userId: gate.userId,
      repositoryId: gate.repoId,
      action: "issue.created",
      targetType: "issue",
      targetId: inserted.id,
      metadata: { source: "mcp", number: inserted.number, title },
    });

    // Notify repo owner if it's not the same user (mirrors typical web flow).
    if (gate.ownerId !== gate.userId) {
      notify(gate.ownerId, {
        kind: "issue_opened",
        title: `New issue: ${title}`,
        url: issueUrl(owner, repo, inserted.number),
        repositoryId: gate.repoId,
      }).catch(() => {});
    }

    return {
      number: inserted.number,
      url: issueUrl(owner, repo, inserted.number),
    };
  },
};

// ---------------------------------------------------------------------------
// gluecron_comment_issue
// ---------------------------------------------------------------------------

const commentIssue: McpToolHandler = {
  tool: {
    name: "gluecron_comment_issue",
    description:
      "Add a comment to an existing issue. Requires authenticated caller with write access. Returns {commentId}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "Issue number" },
        body: { type: "string", description: "Comment body (Markdown)" },
      },
      required: ["owner", "repo", "number", "body"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const number = argNumber(args, "number");
    const body = argString(args, "body");

    const gate = await gateWriteAccess({ owner, repo }, ctx, "gluecron_comment_issue");
    const issue = await loadIssueByNumber(gate.repoId, number);
    if (!issue) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `issue not found: ${owner}/${repo}#${number}`
      );
    }

    const [inserted] = await db
      .insert(issueComments)
      .values({
        issueId: issue.id,
        authorId: gate.userId,
        body,
      })
      .returning();

    // SSE fanout — best-effort.
    try {
      const { publish } = await import("./sse");
      publish(`repo:${gate.repoId}:issue:${number}`, {
        event: "issue-comment",
        data: {
          issueId: issue.id,
          commentId: inserted.id,
          authorId: gate.userId,
          authorUsername: null,
        },
      });
    } catch {
      /* SSE best-effort */
    }

    await audit({
      userId: gate.userId,
      repositoryId: gate.repoId,
      action: "issue.commented",
      targetType: "issue",
      targetId: issue.id,
      metadata: { source: "mcp", number },
    });

    return { commentId: inserted.id };
  },
};

// ---------------------------------------------------------------------------
// gluecron_close_issue
// ---------------------------------------------------------------------------

const closeIssue: McpToolHandler = {
  tool: {
    name: "gluecron_close_issue",
    description:
      "Close an open issue. Requires authenticated caller with write access. Idempotent — closing an already-closed issue is a no-op. Returns {state}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "Issue number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const number = argNumber(args, "number");

    const gate = await gateWriteAccess({ owner, repo }, ctx, "gluecron_close_issue");
    const issue = await loadIssueByNumber(gate.repoId, number);
    if (!issue) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `issue not found: ${owner}/${repo}#${number}`
      );
    }

    if (issue.state !== "closed") {
      await db
        .update(issues)
        .set({ state: "closed", closedAt: new Date(), updatedAt: new Date() })
        .where(eq(issues.id, issue.id));

      await audit({
        userId: gate.userId,
        repositoryId: gate.repoId,
        action: "issue.closed",
        targetType: "issue",
        targetId: issue.id,
        metadata: { source: "mcp", number },
      });
    }

    return { state: "closed" };
  },
};

// ---------------------------------------------------------------------------
// gluecron_reopen_issue
// ---------------------------------------------------------------------------

const reopenIssue: McpToolHandler = {
  tool: {
    name: "gluecron_reopen_issue",
    description:
      "Reopen a previously closed issue. Requires authenticated caller with write access. Idempotent. Returns {state}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "Issue number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const number = argNumber(args, "number");

    const gate = await gateWriteAccess({ owner, repo }, ctx, "gluecron_reopen_issue");
    const issue = await loadIssueByNumber(gate.repoId, number);
    if (!issue) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `issue not found: ${owner}/${repo}#${number}`
      );
    }

    if (issue.state !== "open") {
      await db
        .update(issues)
        .set({ state: "open", closedAt: null, updatedAt: new Date() })
        .where(eq(issues.id, issue.id));

      await audit({
        userId: gate.userId,
        repositoryId: gate.repoId,
        action: "issue.reopened",
        targetType: "issue",
        targetId: issue.id,
        metadata: { source: "mcp", number },
      });
    }

    return { state: "open" };
  },
};

// ---------------------------------------------------------------------------
// gluecron_create_pr
// ---------------------------------------------------------------------------

const createPr: McpToolHandler = {
  tool: {
    name: "gluecron_create_pr",
    description:
      "Open a new pull request. `head_branch` is required; `base_branch` defaults to the repo default branch. Requires authenticated caller with write access. Returns {number, url}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR body (Markdown). Optional." },
        head_branch: { type: "string", description: "Branch with the changes" },
        base_branch: {
          type: "string",
          description: "Target branch (default: repo default branch)",
        },
      },
      required: ["owner", "repo", "title", "head_branch"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const title = argString(args, "title");
    const body = argString(args, "body", "");
    const headBranch = argString(args, "head_branch");

    const gate = await gateWriteAccess({ owner, repo }, ctx, "gluecron_create_pr");
    const baseBranch = argString(args, "base_branch", gate.defaultBranch);

    if (baseBranch === headBranch) {
      throw new McpError(
        ERR_INVALID_PARAMS,
        "base and head branches must be different"
      );
    }

    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: gate.repoId,
        authorId: gate.userId,
        title,
        body: body || null,
        baseBranch,
        headBranch,
      })
      .returning();

    await audit({
      userId: gate.userId,
      repositoryId: gate.repoId,
      action: "pr.opened",
      targetType: "pull_request",
      targetId: pr.id,
      metadata: { source: "mcp", number: pr.number, baseBranch, headBranch },
    });

    if (gate.ownerId !== gate.userId) {
      notify(gate.ownerId, {
        kind: "pr_opened",
        title: `New PR: ${title}`,
        url: prUrl(owner, repo, pr.number),
        repositoryId: gate.repoId,
      }).catch(() => {});
    }

    return { number: pr.number, url: prUrl(owner, repo, pr.number) };
  },
};

// ---------------------------------------------------------------------------
// gluecron_get_pr
// ---------------------------------------------------------------------------

const getPr: McpToolHandler = {
  tool: {
    name: "gluecron_get_pr",
    description:
      "Fetch the full detail record of a pull request (title, body, state, branches, draft, author, timestamps). Authenticated callers only (the read tool surface still works anonymously).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "PR number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const number = argNumber(args, "number");

    requireAuthedCtx(ctx, "gluecron_get_pr");
    const info = await resolveAccessibleRepo(owner, repo, ctx.userId);

    const pr = await loadPrByNumber(info.repoId, number);
    if (!pr) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `pr not found: ${owner}/${repo}#${number}`
      );
    }

    const [author] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, pr.authorId))
      .limit(1);

    // Best-effort mergeability hint via a quick head-ref resolve.
    let mergeable: boolean | null = null;
    try {
      const headSha = await resolveRef(owner, repo, pr.headBranch);
      mergeable = headSha ? true : null;
    } catch {
      mergeable = null;
    }

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || "",
      state: pr.state,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      isDraft: pr.isDraft,
      mergeable,
      author: author?.username ?? null,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      url: prUrl(owner, repo, pr.number),
    };
  },
};

// ---------------------------------------------------------------------------
// gluecron_list_prs
// ---------------------------------------------------------------------------

const listPrs: McpToolHandler = {
  tool: {
    name: "gluecron_list_prs",
    description:
      "List pull requests on a repo, filtered by state (open|closed|merged|all). Authenticated callers only. Returns up to 50 summary rows.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        state: {
          type: "string",
          description: "open | closed | merged | all (default: open)",
        },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const state = argString(args, "state", "open");
    if (!["open", "closed", "merged", "all"].includes(state)) {
      throw new McpError(
        ERR_INVALID_PARAMS,
        `state must be one of open|closed|merged|all (got "${state}")`
      );
    }

    requireAuthedCtx(ctx, "gluecron_list_prs");
    const info = await resolveAccessibleRepo(owner, repo, ctx.userId);

    const whereClause =
      state === "all"
        ? eq(pullRequests.repositoryId, info.repoId)
        : and(
            eq(pullRequests.repositoryId, info.repoId),
            eq(pullRequests.state, state)
          );

    const rows = await db
      .select({
        number: pullRequests.number,
        title: pullRequests.title,
        state: pullRequests.state,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
        isDraft: pullRequests.isDraft,
        authorUsername: users.username,
        createdAt: pullRequests.createdAt,
        updatedAt: pullRequests.updatedAt,
      })
      .from(pullRequests)
      .innerJoin(users, eq(pullRequests.authorId, users.id))
      .where(whereClause)
      .orderBy(desc(pullRequests.createdAt))
      .limit(50);

    return {
      total: rows.length,
      prs: rows.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        baseBranch: p.baseBranch,
        headBranch: p.headBranch,
        isDraft: p.isDraft,
        author: p.authorUsername,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        url: prUrl(owner, repo, p.number),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// gluecron_comment_pr
// ---------------------------------------------------------------------------

const commentPr: McpToolHandler = {
  tool: {
    name: "gluecron_comment_pr",
    description:
      "Add a comment to a pull request. Requires authenticated caller with write access. Returns {commentId}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "PR number" },
        body: { type: "string", description: "Comment body (Markdown)" },
      },
      required: ["owner", "repo", "number", "body"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const number = argNumber(args, "number");
    const body = argString(args, "body");

    const gate = await gateWriteAccess({ owner, repo }, ctx, "gluecron_comment_pr");
    const pr = await loadPrByNumber(gate.repoId, number);
    if (!pr) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `pr not found: ${owner}/${repo}#${number}`
      );
    }

    const [inserted] = await db
      .insert(prComments)
      .values({
        pullRequestId: pr.id,
        authorId: gate.userId,
        body,
      })
      .returning();

    try {
      const { publish } = await import("./sse");
      publish(`repo:${gate.repoId}:pr:${number}`, {
        event: "pr-comment",
        data: {
          pullRequestId: pr.id,
          commentId: inserted.id,
          authorId: gate.userId,
          authorUsername: null,
        },
      });
    } catch {
      /* SSE best-effort */
    }

    await audit({
      userId: gate.userId,
      repositoryId: gate.repoId,
      action: "pr.commented",
      targetType: "pull_request",
      targetId: pr.id,
      metadata: { source: "mcp", number },
    });

    return { commentId: inserted.id };
  },
};

// ---------------------------------------------------------------------------
// gluecron_merge_pr
// ---------------------------------------------------------------------------

const mergePr: McpToolHandler = {
  tool: {
    name: "gluecron_merge_pr",
    description:
      "Merge an open PR. Enforces the same checks as the HTTP merge flow: not a draft, head SHA resolves, GateTest+AI-review hard gates pass, branch-protection rules satisfied. M3: soft-blocks when the pre-merge risk score is `critical` unless `confirm_high_risk: true` is passed. Returns {merged, sha?, reason?, riskScore?}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "PR number" },
        confirm_high_risk: {
          type: "boolean",
          description:
            "When true, bypass the M3 risk-score soft-block on critical-band PRs.",
        },
      },
      required: ["owner", "repo", "number"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const number = argNumber(args, "number");
    const confirmHighRisk = args.confirm_high_risk === true;

    const gate = await gateWriteAccess({ owner, repo }, ctx, "gluecron_merge_pr");
    const pr = await loadPrByNumber(gate.repoId, number);
    if (!pr) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `pr not found: ${owner}/${repo}#${number}`
      );
    }
    if (pr.state !== "open") {
      return { merged: false, reason: `pr is ${pr.state}, not open` };
    }
    if (pr.isDraft) {
      return {
        merged: false,
        reason: "This PR is a draft. Mark it as ready for review before merging.",
      };
    }

    // Block M3 — pre-merge risk score. Prefer the SHA-pinned cache entry;
    // fall back to most-recent cached row; finally compute on demand so the
    // MCP caller always gets a score (HTTP path is async + tolerant of a
    // missing score, but MCP callers want an answer in one round trip).
    let risk: PrRiskScore | null = null;
    try {
      risk =
        (await getCachedPrRisk(pr.id)) ||
        (await getLatestCachedPrRisk(pr.id)) ||
        (await computePrRiskForPullRequest(pr.id));
    } catch {
      risk = null;
    }

    if (risk && risk.band === "critical" && !confirmHighRisk) {
      return {
        merged: false,
        reason: `risk score is critical (${risk.score}/10) — confirm with confirm_high_risk: true`,
        riskScore: serialisePrRiskForResponse(risk),
      };
    }

    const headSha = await resolveRef(owner, repo, pr.headBranch);
    if (!headSha) {
      return { merged: false, reason: "Head branch not found" };
    }

    // AI review approval signal — same heuristic as routes/pulls.tsx.
    const aiComments = await db
      .select()
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, pr.id),
          eq(prComments.isAiReview, true)
        )
      );
    const aiApproved =
      aiComments.length === 0 ||
      aiComments.some(
        (c) =>
          c.body.includes("**Approved**") ||
          c.body.includes("approved: true") ||
          c.body.toLowerCase().includes("lgtm")
      );

    const gateResult = await runAllGateChecks(
      owner,
      repo,
      pr.baseBranch,
      pr.headBranch,
      headSha,
      aiApproved
    );

    const hardFailures = gateResult.checks.filter(
      (check) => !check.passed && check.name !== "Merge check"
    );
    if (hardFailures.length > 0) {
      return {
        merged: false,
        reason: hardFailures.map((f) => `${f.name}: ${f.details}`).join("; "),
      };
    }

    // D5 — branch-protection enforcement
    const protectionRule = await matchProtection(gate.repoId, pr.baseBranch);
    if (protectionRule) {
      const humanApprovals = await countHumanApprovals(pr.id);
      const required = await listRequiredChecks(protectionRule.id);
      const passingNames =
        required.length > 0
          ? await passingCheckNames(gate.repoId, headSha)
          : [];
      const decision = evaluateProtection(
        protectionRule,
        {
          aiApproved,
          humanApprovalCount: humanApprovals,
          gateResultGreen: hardFailures.length === 0,
          hasFailedGates: hardFailures.length > 0,
          passingCheckNames: passingNames,
        },
        required.map((r) => r.checkName)
      );
      if (!decision.allowed) {
        return { merged: false, reason: decision.reasons.join(" ") };
      }
    }

    const repoDir = getRepoPath(owner, repo);
    const mergeCheck = gateResult.checks.find((c) => c.name === "Merge check");
    const hasConflicts = mergeCheck && !mergeCheck.passed;

    if (hasConflicts && isAiReviewEnabled()) {
      const mergeResult = await mergeWithAutoResolve(
        owner,
        repo,
        pr.baseBranch,
        pr.headBranch,
        `Merge pull request #${pr.number}: ${pr.title}`
      );
      if (!mergeResult.success) {
        return {
          merged: false,
          reason: mergeResult.error || "Auto-merge failed",
        };
      }
      if (mergeResult.resolvedFiles.length > 0) {
        await db.insert(prComments).values({
          pullRequestId: pr.id,
          authorId: gate.userId,
          body: `**Auto-resolved merge conflicts** in:\n${mergeResult.resolvedFiles
            .map((f) => `- \`${f}\``)
            .join("\n")}\n\nConflicts were automatically resolved by GlueCron AI.`,
          isAiReview: true,
        });
      }
    } else {
      const ffProc = Bun.spawn(
        [
          "git",
          "update-ref",
          `refs/heads/${pr.baseBranch}`,
          `refs/heads/${pr.headBranch}`,
        ],
        { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
      );
      const ffExit = await ffProc.exited;
      if (ffExit !== 0) {
        return {
          merged: false,
          reason: "Merge failed — unable to update branch ref",
        };
      }
    }

    await db
      .update(pullRequests)
      .set({
        state: "merged",
        mergedAt: new Date(),
        mergedBy: gate.userId,
        updatedAt: new Date(),
      })
      .where(eq(pullRequests.id, pr.id));

    // J7 — closing keywords. Best-effort; mirrors routes/pulls.tsx.
    try {
      const { extractClosingRefsMulti } = await import("./close-keywords");
      const refs = extractClosingRefsMulti([pr.title, pr.body]);
      for (const n of refs) {
        const target = await loadIssueByNumber(gate.repoId, n);
        if (!target || target.state !== "open") continue;
        await db
          .update(issues)
          .set({ state: "closed", closedAt: new Date(), updatedAt: new Date() })
          .where(eq(issues.id, target.id));
        await db.insert(issueComments).values({
          issueId: target.id,
          authorId: gate.userId,
          body: `Closed by pull request #${pr.number}.`,
        });
      }
    } catch {
      /* never block merge on close-keyword failures */
    }

    await audit({
      userId: gate.userId,
      repositoryId: gate.repoId,
      action: "pr.merged",
      targetType: "pull_request",
      targetId: pr.id,
      metadata: { source: "mcp", number, sha: headSha },
    });

    // Resolved post-merge SHA (best effort).
    let mergedSha: string | null = null;
    try {
      mergedSha = await resolveRef(owner, repo, pr.baseBranch);
    } catch {
      mergedSha = null;
    }

    // Block M3 — informational payload: when the risk score is high or
    // critical, include the score + summary in the response even on a
    // successful merge so the caller has the audit context. Low/medium
    // bands stay quiet to keep response noise low.
    const response: {
      merged: true;
      sha: string;
      riskScore?: ReturnType<typeof serialisePrRiskForResponse>;
    } = {
      merged: true,
      sha: mergedSha ?? headSha,
    };
    if (risk && (risk.band === "high" || risk.band === "critical")) {
      response.riskScore = serialisePrRiskForResponse(risk);
    }
    return response;
  },
};

/**
 * Compact serialiser for embedding a PrRiskScore in an MCP response.
 * Keeps the surface stable + JSON-RPC-safe (Date → ISO string).
 */
function serialisePrRiskForResponse(risk: PrRiskScore) {
  return {
    score: risk.score,
    band: risk.band,
    aiSummary: risk.aiSummary,
    commitSha: risk.commitSha,
    signals: risk.signals,
    generatedAt:
      risk.generatedAt instanceof Date
        ? risk.generatedAt.toISOString()
        : String(risk.generatedAt),
  };
}

// ---------------------------------------------------------------------------
// gluecron_close_pr
// ---------------------------------------------------------------------------

const closePr: McpToolHandler = {
  tool: {
    name: "gluecron_close_pr",
    description:
      "Close an open pull request without merging. Requires authenticated caller with write access. Idempotent. Returns {state}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        number: { type: "number", description: "PR number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  async run(args, ctx) {
    const owner = argString(args, "owner");
    const repo = argString(args, "repo");
    const number = argNumber(args, "number");

    const gate = await gateWriteAccess({ owner, repo }, ctx, "gluecron_close_pr");
    const pr = await loadPrByNumber(gate.repoId, number);
    if (!pr) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `pr not found: ${owner}/${repo}#${number}`
      );
    }

    if (pr.state === "open") {
      await db
        .update(pullRequests)
        .set({
          state: "closed",
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(pullRequests.id, pr.id));

      await audit({
        userId: gate.userId,
        repositoryId: gate.repoId,
        action: "pr.closed",
        targetType: "pull_request",
        targetId: pr.id,
        metadata: { source: "mcp", number },
      });
    }

    return { state: pr.state === "merged" ? "merged" : "closed" };
  },
};

function sqlExpr(expr: string) {
  return drizzleSql.raw(expr);
}

// ---------------------------------------------------------------------------
// Default tool registry
// ---------------------------------------------------------------------------

export function defaultTools(): Record<string, McpToolHandler> {
  return {
    [repoSearch.tool.name]: repoSearch,
    [repoReadFile.tool.name]: repoReadFile,
    [repoListIssues.tool.name]: repoListIssues,
    [repoExplain.tool.name]: repoExplain,
    [repoHealth.tool.name]: repoHealth,
    // Block K1 — write surface
    [createIssue.tool.name]: createIssue,
    [commentIssue.tool.name]: commentIssue,
    [closeIssue.tool.name]: closeIssue,
    [reopenIssue.tool.name]: reopenIssue,
    [createPr.tool.name]: createPr,
    [getPr.tool.name]: getPr,
    [listPrs.tool.name]: listPrs,
    [commentPr.tool.name]: commentPr,
    [mergePr.tool.name]: mergePr,
    [closePr.tool.name]: closePr,
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
  repoHealth,
  // Block K1 — write surface
  createIssue,
  commentIssue,
  closeIssue,
  reopenIssue,
  createPr,
  getPr,
  listPrs,
  commentPr,
  mergePr,
  closePr,
  gateWriteAccess,
  resolveAccessibleRepo,
};

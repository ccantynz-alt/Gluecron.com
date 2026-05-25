/**
 * Expanded MCP tool surface — wraps every meaningful Gluecron action so
 * any AI tool-use loop can drive the platform end-to-end.
 *
 * Each tool here is a THIN wrapper around an existing lib helper or a
 * REST handler's underlying primitives — we never duplicate business
 * logic. Auth/gating reuses the shared helpers exported from
 * `mcp-tools.ts`.
 *
 * Categories (per the build spec):
 *
 *   REPOS         fork / delete / update / search / clone_url
 *   ISSUES        close / reopen / label / unlabel / assign / search
 *   PRS           close / request_changes / search / open_draft /
 *                 generate_description
 *   FILES & GIT   read_file / write_file / delete_file / list_tree /
 *                 get_commit / create_branch / atomic_multi_file_commit
 *   AI WORKFLOWS  ship_spec / voice_to_pr / refactor_across_repos /
 *                 explain_repo / chat_with_repo / chat_continue /
 *                 generate_tests / generate_commit_message /
 *                 generate_release_notes / propose_migration /
 *                 propose_doc_update
 *   CI / DEPLOYS  trigger_workflow / get_workflow_run /
 *                 get_workflow_logs / cancel_workflow_run /
 *                 get_preview_url / provision_pr_sandbox
 *   AGENTS        create_agent_session / acquire_lease /
 *                 release_lease / get_agent_budget
 *   SEMANTIC      semantic_search / find_symbol
 *   INSIGHTS      pr_status_summary / repo_health / ai_cost_summary
 *
 * Scope contract:
 *   - Read-only tools accept any authenticated caller (anonymous works
 *     on public repos via the existing `resolveAccessibleRepo` flow).
 *   - Write tools require `repo` scope.
 *   - Destructive tools (delete_repo) require `admin` scope.
 */

import { and, eq, like, or, desc, asc } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  users,
  issues,
  issueComments,
  pullRequests,
  prComments,
  labels,
  issueLabels,
  workflows,
  workflowRuns,
  workflowJobs,
} from "../db/schema";
import {
  repoExists,
  getRepoPath,
  getBlob,
  getTree,
  getTreeRecursive,
  getCommit,
  resolveRef,
  refExists,
  objectExists,
  updateRef,
  writeBlob,
  createOrUpdateFileOnBranch,
  getBlobShaAtPath,
} from "../git/repository";
import { join } from "path";
import { mkdir, unlink, rm } from "fs/promises";
import { config } from "./config";
import { McpError, ERR_INVALID_PARAMS, ERR_METHOD_NOT_FOUND } from "./mcp";
import type { McpContext } from "./mcp";
import type { McpToolHandler } from "./mcp-tools";
import {
  mcpArgString,
  mcpArgNumber,
  mcpGateWriteAccess,
  mcpResolveAccessibleRepo,
  mcpRequireAuthedCtx,
  mcpLoadPrByNumber,
  mcpLoadIssueByNumber,
  mcpPrUrl,
  mcpIssueUrl,
} from "./mcp-tools";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Require a scope on the caller's token. Session-cookie callers receive
 * `["repo","user","admin"]` so they always pass. Anonymous and limited
 * PATs may fail here. When `ctx.scopes` is undefined we treat the context
 * as legacy-permissive (matches the pre-expansion behaviour of the
 * existing 15-tool surface).
 */
function requireScope(ctx: McpContext, scope: string, toolName: string): void {
  // Undefined scopes → legacy/permissive. Anonymous (no userId) is caught
  // separately by `requireAuthedCtx` further upstream.
  if (ctx.scopes === undefined) return;
  if (ctx.scopes.includes(scope) || ctx.scopes.includes("admin")) return;
  throw new McpError(
    ERR_INVALID_PARAMS,
    `tool ${toolName} requires '${scope}' scope (token carries: ${ctx.scopes.join(",") || "none"})`
  );
}

function argBool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  return fallback;
}

function argStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

// ---------------------------------------------------------------------------
// REPOS
// ---------------------------------------------------------------------------

const forkRepo: McpToolHandler = {
  tool: {
    name: "gluecron_fork_repo",
    description:
      "Fork a repository to the authenticated caller's namespace. Mirrors POST /:owner/:repo/fork. Returns {owner, repo, url}. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Source repo owner" },
        repo: { type: "string", description: "Source repo name" },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const userId = mcpRequireAuthedCtx(ctx, "gluecron_fork_repo");
    requireScope(ctx, "repo", "gluecron_fork_repo");

    const info = await mcpResolveAccessibleRepo(owner, repo, userId);

    const [me] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!me) throw new McpError(ERR_INVALID_PARAMS, "caller user not found");

    if (me.username === owner) {
      throw new McpError(ERR_INVALID_PARAMS, "cannot fork your own repository");
    }
    if (await repoExists(me.username, repo)) {
      throw new McpError(
        ERR_INVALID_PARAMS,
        `${me.username}/${repo} already exists`
      );
    }

    const sourcePath = getRepoPath(owner, repo);
    const destPath = join(config.gitReposPath, me.username, `${repo}.git`);

    const proc = Bun.spawn(["git", "clone", "--bare", sourcePath, destPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new McpError(ERR_INVALID_PARAMS, "git clone --bare failed");
    }

    const [sourceRepo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, info.repoId))
      .limit(1);
    if (!sourceRepo) throw new McpError(ERR_METHOD_NOT_FOUND, "source repo row missing");

    const [newRepo] = await db
      .insert(repositories)
      .values({
        name: repo,
        ownerId: me.id,
        description: sourceRepo.description
          ? `Fork of ${owner}/${repo} — ${sourceRepo.description}`
          : `Fork of ${owner}/${repo}`,
        isPrivate: false,
        defaultBranch: sourceRepo.defaultBranch,
        diskPath: destPath,
        forkedFromId: sourceRepo.id,
      })
      .returning();

    if (newRepo) {
      try {
        const { bootstrapRepository } = await import("./repo-bootstrap");
        await bootstrapRepository({
          repositoryId: newRepo.id,
          ownerUserId: me.id,
          defaultBranch: sourceRepo.defaultBranch,
          skipWelcomeIssue: true,
        });
      } catch {
        /* bootstrap is non-fatal */
      }
    }

    try {
      await db
        .update(repositories)
        .set({ forkCount: (sourceRepo.forkCount ?? 0) + 1 })
        .where(eq(repositories.id, sourceRepo.id));
    } catch {
      /* non-fatal */
    }

    return {
      owner: me.username,
      repo,
      url: `/${me.username}/${repo}`,
    };
  },
};

const deleteRepo: McpToolHandler = {
  tool: {
    name: "gluecron_delete_repo",
    description:
      "Permanently delete a repository row (git data on disk is left untouched). Owner-only. Requires 'admin' scope. Returns {deleted: true}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    requireScope(ctx, "admin", "gluecron_delete_repo");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_delete_repo");

    if (gate.ownerId !== gate.userId) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `no admin access to ${owner}/${repo}`
      );
    }

    await db.delete(repositories).where(eq(repositories.id, gate.repoId));
    return { deleted: true };
  },
};

const updateRepo: McpToolHandler = {
  tool: {
    name: "gluecron_update_repo",
    description:
      "Update repository description / visibility / default_branch. Owner-only. Requires 'repo' scope. Returns {ok: true}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
        description: { type: "string", description: "New description (optional)" },
        is_private: { type: "boolean", description: "Set visibility (optional)" },
        default_branch: { type: "string", description: "Set default branch (optional)" },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    requireScope(ctx, "repo", "gluecron_update_repo");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_update_repo");

    if (gate.ownerId !== gate.userId) {
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `no admin access to ${owner}/${repo}`
      );
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof args.description === "string") updates.description = args.description;
    if (typeof args.is_private === "boolean") updates.isPrivate = args.is_private;
    if (typeof args.default_branch === "string") updates.defaultBranch = args.default_branch;
    if (Object.keys(updates).length === 1) {
      return { ok: true, noop: true };
    }
    await db.update(repositories).set(updates).where(eq(repositories.id, gate.repoId));
    return { ok: true };
  },
};

const searchRepos: McpToolHandler = {
  tool: {
    name: "gluecron_search_repos",
    description:
      "Full-text search of public repositories by name/description. Mirrors GET /api/v2/search/repos. Returns ranked rows.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword" },
        sort: { type: "string", description: "stars | updated | name (default: stars)" },
        limit: { type: "number", description: "Max results (1-100, default 30)" },
      },
      required: ["query"],
    },
  },
  async run(args) {
    const q = mcpArgString(args, "query");
    const sort = mcpArgString(args, "sort", "stars");
    const limit = Math.max(1, Math.min(100, mcpArgNumber(args, "limit", 30)));
    const orderBy =
      sort === "updated"
        ? desc(repositories.updatedAt)
        : sort === "name"
          ? asc(repositories.name)
          : desc(repositories.starCount);
    const pattern = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        description: repositories.description,
        stars: repositories.starCount,
        forks: repositories.forkCount,
        ownerName: users.username,
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
      .orderBy(orderBy)
      .limit(limit);
    return {
      total: rows.length,
      repos: rows.map((r) => ({
        fullName: `${r.ownerName}/${r.name}`,
        description: r.description || "",
        stars: r.stars,
        forks: r.forks,
      })),
    };
  },
};

const cloneUrl: McpToolHandler = {
  tool: {
    name: "gluecron_clone_url",
    description:
      "Return the authenticated HTTPS clone URL for a repo + a credential-helper hint. Use this instead of embedding tokens in URLs. Returns {url, hint}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner username" },
        repo: { type: "string", description: "Repo name" },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    // Verify access; rejects private-without-access via the privacy
    // contract.
    await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const base = config.appBaseUrl?.replace(/\/$/, "") || "https://gluecron.com";
    return {
      url: `${base}/${owner}/${repo}.git`,
      hint:
        "Use a credential helper rather than embedding a PAT in the URL:\n" +
        `  git -c credential.helper='!f() { echo "username=token"; echo "password=$GLUECRON_PAT"; }; f' clone ${base}/${owner}/${repo}.git`,
    };
  },
};

// ---------------------------------------------------------------------------
// ISSUES — label/unlabel/assign/search (close/reopen already live in mcp-tools)
// ---------------------------------------------------------------------------

const labelIssue: McpToolHandler = {
  tool: {
    name: "gluecron_label_issue",
    description:
      "Attach one or more labels to an issue. Labels are created if they don't yet exist on the repo. Requires 'repo' scope. Returns {labels}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
        labels: { type: "array", description: "Label names (strings)" },
      },
      required: ["owner", "repo", "number", "labels"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const number = mcpArgNumber(args, "number");
    const labelNames = argStringArray(args, "labels");
    if (labelNames.length === 0) {
      throw new McpError(ERR_INVALID_PARAMS, "labels must be a non-empty array of strings");
    }
    requireScope(ctx, "repo", "gluecron_label_issue");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_label_issue");
    const issue = await mcpLoadIssueByNumber(gate.repoId, number);
    if (!issue) {
      throw new McpError(ERR_METHOD_NOT_FOUND, `issue not found: ${owner}/${repo}#${number}`);
    }

    const applied: string[] = [];
    for (const name of labelNames) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      // Ensure label row exists.
      let [labelRow] = await db
        .select()
        .from(labels)
        .where(and(eq(labels.repositoryId, gate.repoId), eq(labels.name, trimmed)))
        .limit(1);
      if (!labelRow) {
        const inserted = await db
          .insert(labels)
          .values({ repositoryId: gate.repoId, name: trimmed })
          .returning();
        labelRow = inserted[0];
      }
      if (!labelRow) continue;
      try {
        await db
          .insert(issueLabels)
          .values({ issueId: issue.id, labelId: labelRow.id });
      } catch {
        /* unique violation — already attached */
      }
      applied.push(trimmed);
    }
    return { labels: applied };
  },
};

const unlabelIssue: McpToolHandler = {
  tool: {
    name: "gluecron_unlabel_issue",
    description:
      "Detach a label from an issue. Idempotent. Requires 'repo' scope. Returns {removed: boolean}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
        label: { type: "string" },
      },
      required: ["owner", "repo", "number", "label"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const number = mcpArgNumber(args, "number");
    const labelName = mcpArgString(args, "label");
    requireScope(ctx, "repo", "gluecron_unlabel_issue");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_unlabel_issue");
    const issue = await mcpLoadIssueByNumber(gate.repoId, number);
    if (!issue) {
      throw new McpError(ERR_METHOD_NOT_FOUND, `issue not found: ${owner}/${repo}#${number}`);
    }
    const [labelRow] = await db
      .select()
      .from(labels)
      .where(and(eq(labels.repositoryId, gate.repoId), eq(labels.name, labelName)))
      .limit(1);
    if (!labelRow) return { removed: false };
    const result = await db
      .delete(issueLabels)
      .where(and(eq(issueLabels.issueId, issue.id), eq(issueLabels.labelId, labelRow.id)))
      .returning({ id: issueLabels.id });
    return { removed: result.length > 0 };
  },
};

const assignIssue: McpToolHandler = {
  tool: {
    name: "gluecron_assign_issue",
    description:
      "Assign an issue to a user. Gluecron does not yet have a dedicated assignee table; assignment is modelled as an `assignee:<username>` label so it integrates with existing label tooling. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
        assignee: { type: "string", description: "Username to assign" },
      },
      required: ["owner", "repo", "number", "assignee"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const number = mcpArgNumber(args, "number");
    const assignee = mcpArgString(args, "assignee");
    return await labelIssue.run(
      { owner, repo, number, labels: [`assignee:${assignee}`] },
      ctx
    );
  },
};

const searchIssues: McpToolHandler = {
  tool: {
    name: "gluecron_search_issues",
    description:
      "Search issues by title/body keyword on a single repo, filtered by state. Returns ranked rows.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        query: { type: "string", description: "Search keyword" },
        state: { type: "string", description: "open | closed | all (default open)" },
        limit: { type: "number" },
      },
      required: ["owner", "repo", "query"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const q = mcpArgString(args, "query");
    const state = mcpArgString(args, "state", "open");
    const limit = Math.max(1, Math.min(100, mcpArgNumber(args, "limit", 25)));
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const pattern = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    const stateClause =
      state === "all"
        ? eq(issues.repositoryId, info.repoId)
        : and(eq(issues.repositoryId, info.repoId), eq(issues.state, state));
    const rows = await db
      .select({
        number: issues.number,
        title: issues.title,
        body: issues.body,
        state: issues.state,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          stateClause,
          or(like(issues.title, pattern), like(issues.body, pattern))
        )
      )
      .orderBy(desc(issues.createdAt))
      .limit(limit);
    return {
      total: rows.length,
      issues: rows.map((r) => ({
        number: r.number,
        title: r.title,
        body: r.body || "",
        state: r.state,
        url: mcpIssueUrl(owner, repo, r.number),
        createdAt: r.createdAt,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// PRS — close (already), request_changes, search, draft, generate_description
// ---------------------------------------------------------------------------

const requestChanges: McpToolHandler = {
  tool: {
    name: "gluecron_request_changes",
    description:
      "Post a 'changes requested' AI-review comment on a PR. The comment is tagged with isAiReview=true so the gate-checker recognises it. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
        body: { type: "string", description: "Review body (Markdown)" },
      },
      required: ["owner", "repo", "number", "body"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const number = mcpArgNumber(args, "number");
    const body = mcpArgString(args, "body");
    requireScope(ctx, "repo", "gluecron_request_changes");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_request_changes");
    const pr = await mcpLoadPrByNumber(gate.repoId, number);
    if (!pr) {
      throw new McpError(ERR_METHOD_NOT_FOUND, `pr not found: ${owner}/${repo}#${number}`);
    }
    const formatted = `**Changes requested**\n\n${body}`;
    const [inserted] = await db
      .insert(prComments)
      .values({
        pullRequestId: pr.id,
        authorId: gate.userId,
        body: formatted,
        isAiReview: true,
      })
      .returning();
    return { commentId: inserted.id };
  },
};

const searchPrs: McpToolHandler = {
  tool: {
    name: "gluecron_search_prs",
    description: "Search pull requests by title/body keyword on a repo.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        query: { type: "string" },
        state: { type: "string", description: "open|closed|merged|all (default open)" },
        limit: { type: "number" },
      },
      required: ["owner", "repo", "query"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const q = mcpArgString(args, "query");
    const state = mcpArgString(args, "state", "open");
    const limit = Math.max(1, Math.min(100, mcpArgNumber(args, "limit", 25)));
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const pattern = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    const stateClause =
      state === "all"
        ? eq(pullRequests.repositoryId, info.repoId)
        : and(eq(pullRequests.repositoryId, info.repoId), eq(pullRequests.state, state));
    const rows = await db
      .select({
        number: pullRequests.number,
        title: pullRequests.title,
        body: pullRequests.body,
        state: pullRequests.state,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
        isDraft: pullRequests.isDraft,
        createdAt: pullRequests.createdAt,
      })
      .from(pullRequests)
      .where(
        and(
          stateClause,
          or(like(pullRequests.title, pattern), like(pullRequests.body, pattern))
        )
      )
      .orderBy(desc(pullRequests.createdAt))
      .limit(limit);
    return {
      total: rows.length,
      prs: rows.map((p) => ({
        number: p.number,
        title: p.title,
        body: p.body || "",
        state: p.state,
        baseBranch: p.baseBranch,
        headBranch: p.headBranch,
        isDraft: p.isDraft,
        url: mcpPrUrl(owner, repo, p.number),
        createdAt: p.createdAt,
      })),
    };
  },
};

const openDraftPr: McpToolHandler = {
  tool: {
    name: "gluecron_open_draft_pr",
    description:
      "Open a draft pull request. Same payload as gluecron_create_pr but forces is_draft=true. Useful for AI-in-progress PRs that shouldn't run mergeability checks yet.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        head_branch: { type: "string" },
        base_branch: { type: "string" },
      },
      required: ["owner", "repo", "title", "head_branch"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const title = mcpArgString(args, "title");
    const body = mcpArgString(args, "body", "");
    const headBranch = mcpArgString(args, "head_branch");
    requireScope(ctx, "repo", "gluecron_open_draft_pr");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_open_draft_pr");
    const baseBranch = mcpArgString(args, "base_branch", gate.defaultBranch);
    if (baseBranch === headBranch) {
      throw new McpError(ERR_INVALID_PARAMS, "base and head branches must be different");
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
        isDraft: true,
      })
      .returning();
    return { number: pr.number, url: mcpPrUrl(owner, repo, pr.number), isDraft: true };
  },
};

const generatePrDescription: McpToolHandler = {
  tool: {
    name: "gluecron_generate_pr_description",
    description:
      "Generate an AI commit-message-style description for a diff. Uses src/lib/ai-commit-message.ts under the hood; gracefully degrades to a heuristic when ANTHROPIC_API_KEY is missing. Returns {subject, body}.",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string", description: "Unified-diff body" },
        style: {
          type: "string",
          description: "'conventional' (default) or 'plain'",
        },
      },
      required: ["diff"],
    },
  },
  async run(args) {
    const diff = mcpArgString(args, "diff");
    const style = mcpArgString(args, "style", "conventional");
    const { generateCommitMessage } = await import("./ai-commit-message");
    const msg = await generateCommitMessage(diff, {
      style: style === "plain" ? "plain" : "conventional",
    });
    return msg;
  },
};

// ---------------------------------------------------------------------------
// FILES & GIT PLUMBING
// ---------------------------------------------------------------------------

const readFile: McpToolHandler = {
  tool: {
    name: "gluecron_read_file",
    description:
      "Read a file from a repo at a given ref. Mirrors GET /api/v2/repos/:owner/:repo/contents/:path. Returns {path, size, content, encoding}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        ref: { type: "string", description: "Branch / tag / sha (default HEAD)" },
        path: { type: "string" },
        encoding: { type: "string", description: "'utf8' (default) or 'base64'" },
      },
      required: ["owner", "repo", "path"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const ref = mcpArgString(args, "ref", "HEAD");
    const filePath = mcpArgString(args, "path");
    await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const blob = await getBlob(owner, repo, ref, filePath);
    if (!blob) {
      throw new McpError(ERR_METHOD_NOT_FOUND, `path not found: ${owner}/${repo}@${ref}:${filePath}`);
    }
    return {
      path: filePath,
      size: blob.size,
      isBinary: blob.isBinary,
      content: blob.isBinary ? null : blob.content,
      encoding: blob.isBinary ? null : "utf8",
    };
  },
};

const writeFile: McpToolHandler = {
  tool: {
    name: "gluecron_write_file",
    description:
      "Create or update a file on a branch via git plumbing. Wraps `createOrUpdateFileOnBranch`. Pass `content` as a UTF-8 string OR `content_base64` for binary. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string" },
        branch: { type: "string" },
        message: { type: "string", description: "Commit message" },
        content: { type: "string", description: "UTF-8 file body (optional)" },
        content_base64: { type: "string", description: "Base64 file body (optional)" },
        expect_blob_sha: {
          type: "string",
          description: "Optimistic-concurrency check: existing blob sha must match.",
        },
      },
      required: ["owner", "repo", "path", "branch", "message"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const filePath = mcpArgString(args, "path");
    const branch = mcpArgString(args, "branch");
    const message = mcpArgString(args, "message");
    requireScope(ctx, "repo", "gluecron_write_file");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_write_file");

    let bytes: Uint8Array;
    if (typeof args.content === "string") {
      bytes = new TextEncoder().encode(args.content);
    } else if (typeof args.content_base64 === "string") {
      try {
        bytes = new Uint8Array(Buffer.from(args.content_base64, "base64"));
      } catch {
        throw new McpError(ERR_INVALID_PARAMS, "content_base64 is not valid base64");
      }
    } else {
      throw new McpError(ERR_INVALID_PARAMS, "either content or content_base64 is required");
    }

    const [author] = await db
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(eq(users.id, gate.userId))
      .limit(1);
    if (!author) throw new McpError(ERR_INVALID_PARAMS, "author lookup failed");

    const expectBlobSha =
      typeof args.expect_blob_sha === "string" ? args.expect_blob_sha : null;

    const res = await createOrUpdateFileOnBranch({
      owner,
      name: repo,
      branch,
      filePath,
      bytes,
      message,
      authorName: author.username,
      authorEmail: author.email || `${author.username}@users.noreply.gluecron`,
      expectBlobSha,
    });
    if ("error" in res) {
      if (res.error === "sha-mismatch") {
        throw new McpError(ERR_INVALID_PARAMS, "sha does not match current blob at path");
      }
      throw new McpError(ERR_INVALID_PARAMS, `write failed: ${res.error}`);
    }
    return {
      commitSha: res.commitSha,
      blobSha: res.blobSha,
      parentSha: res.parentSha,
      branch,
      path: filePath,
    };
  },
};

const deleteFile: McpToolHandler = {
  tool: {
    name: "gluecron_delete_file",
    description:
      "Delete a file from a branch via git plumbing. Requires the existing blob sha (optimistic concurrency) and 'repo' scope. Mirrors DELETE /api/v2/contents.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string" },
        branch: { type: "string" },
        message: { type: "string" },
        sha: { type: "string", description: "Current blob sha (40-hex)" },
      },
      required: ["owner", "repo", "path", "branch", "message", "sha"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const filePath = mcpArgString(args, "path");
    const branch = mcpArgString(args, "branch");
    const message = mcpArgString(args, "message");
    const expectSha = mcpArgString(args, "sha");
    if (!/^[0-9a-f]{40}$/.test(expectSha)) {
      throw new McpError(ERR_INVALID_PARAMS, "sha must be a 40-char lowercase hex string");
    }
    requireScope(ctx, "repo", "gluecron_delete_file");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_delete_file");

    const fullRef = `refs/heads/${branch}`;
    const repoDir = getRepoPath(owner, repo);
    const parentSha = await resolveRef(owner, repo, fullRef);
    if (!parentSha) throw new McpError(ERR_METHOD_NOT_FOUND, "branch not found");
    const existing = await getBlobShaAtPath(owner, repo, branch, filePath);
    if (!existing) throw new McpError(ERR_METHOD_NOT_FOUND, "file not found");
    if (existing !== expectSha) {
      throw new McpError(ERR_INVALID_PARAMS, "sha does not match current blob at path");
    }

    const [author] = await db
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(eq(users.id, gate.userId))
      .limit(1);
    if (!author) throw new McpError(ERR_INVALID_PARAMS, "author lookup failed");

    // Stand up a transient index + work-tree dir so git's safety checks pass.
    const tmpIndex = join(
      repoDir,
      `index.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
    );
    const tmpWorkTree = join(
      repoDir,
      `worktree.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
    );
    await mkdir(tmpWorkTree, { recursive: true });
    const env = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      GIT_DIR: repoDir,
      GIT_WORK_TREE: tmpWorkTree,
      GIT_AUTHOR_NAME: author.username,
      GIT_AUTHOR_EMAIL: author.email || `${author.username}@users.noreply.gluecron`,
      GIT_COMMITTER_NAME: author.username,
      GIT_COMMITTER_EMAIL: author.email || `${author.username}@users.noreply.gluecron`,
    };
    const cleanup = async () => {
      try {
        await unlink(tmpIndex).catch(() => {});
        await rm(tmpWorkTree, { recursive: true, force: true }).catch(() => {});
      } catch {
        /* ignore */
      }
    };

    const run = async (cmd: string[]): Promise<{ code: number; out: string }> => {
      const proc = Bun.spawn(cmd, {
        cwd: repoDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      return { code, out };
    };

    try {
      const rt = await run(["git", "read-tree", parentSha]);
      if (rt.code !== 0) {
        await cleanup();
        throw new McpError(ERR_INVALID_PARAMS, "read-tree failed");
      }
      const ui = await run(["git", "update-index", "--remove", filePath]);
      if (ui.code !== 0) {
        await cleanup();
        throw new McpError(ERR_INVALID_PARAMS, "update-index --remove failed");
      }
      const wt = await run(["git", "write-tree"]);
      const newTree = wt.out.trim();
      if (wt.code !== 0 || !/^[0-9a-f]{40}$/.test(newTree)) {
        await cleanup();
        throw new McpError(ERR_INVALID_PARAMS, "write-tree failed");
      }
      const ct = await run([
        "git",
        "commit-tree",
        newTree,
        "-p",
        parentSha,
        "-m",
        message,
      ]);
      const commitSha = ct.out.trim();
      if (ct.code !== 0 || !/^[0-9a-f]{40}$/.test(commitSha)) {
        await cleanup();
        throw new McpError(ERR_INVALID_PARAMS, "commit-tree failed");
      }
      const ok = await updateRef(owner, repo, fullRef, commitSha, parentSha);
      await cleanup();
      if (!ok) throw new McpError(ERR_INVALID_PARAMS, "update-ref failed");
      return { commitSha, branch, deletedPath: filePath };
    } catch (err) {
      await cleanup();
      throw err;
    }
  },
};

const listTree: McpToolHandler = {
  tool: {
    name: "gluecron_list_tree",
    description:
      "List directory contents at a ref. Optionally `recursive: true` returns the full file list. Mirrors GET /api/v2/repos/.../tree/:ref.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        ref: { type: "string", description: "Branch / tag / sha" },
        path: { type: "string", description: "Sub-path within the repo" },
        recursive: { type: "boolean" },
      },
      required: ["owner", "repo", "ref"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const ref = mcpArgString(args, "ref");
    const path = mcpArgString(args, "path", "");
    const recursive = argBool(args, "recursive", false);
    await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    if (recursive) {
      const out = await getTreeRecursive(owner, repo, ref, 50_000);
      if (!out) throw new McpError(ERR_METHOD_NOT_FOUND, "ref not found");
      return out;
    }
    const tree = await getTree(owner, repo, ref, path);
    return { path, ref, entries: tree };
  },
};

const getCommitTool: McpToolHandler = {
  tool: {
    name: "gluecron_get_commit",
    description: "Fetch a single commit's metadata by SHA. Mirrors GET /api/v2/repos/.../commits/:sha.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        sha: { type: "string", description: "Commit SHA" },
      },
      required: ["owner", "repo", "sha"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const sha = mcpArgString(args, "sha");
    await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const commit = await getCommit(owner, repo, sha);
    if (!commit) throw new McpError(ERR_METHOD_NOT_FOUND, `commit not found: ${sha}`);
    return commit;
  },
};

const createBranch: McpToolHandler = {
  tool: {
    name: "gluecron_create_branch",
    description:
      "Create a new branch ref pointing at an existing sha. Mirrors POST /api/v2/repos/.../git/refs. Requires 'repo' scope. Returns {ref, sha}.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string", description: "New branch name (short form)" },
        sha: { type: "string", description: "Target commit sha (40-hex)" },
      },
      required: ["owner", "repo", "branch", "sha"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const branchName = mcpArgString(args, "branch");
    const sha = mcpArgString(args, "sha");
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new McpError(ERR_INVALID_PARAMS, "sha must be a 40-char lowercase hex string");
    }
    requireScope(ctx, "repo", "gluecron_create_branch");
    await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_create_branch");

    if (!(await objectExists(owner, repo, sha))) {
      throw new McpError(ERR_INVALID_PARAMS, `sha not found in repository: ${sha}`);
    }
    const ref = `refs/heads/${branchName}`;
    if (await refExists(owner, repo, ref)) {
      const existing = await resolveRef(owner, repo, ref);
      if (existing === sha) return { ref, sha, alreadyExists: true };
      throw new McpError(ERR_INVALID_PARAMS, `ref already exists: ${ref}`);
    }
    const ok = await updateRef(owner, repo, ref, sha);
    if (!ok) throw new McpError(ERR_INVALID_PARAMS, "update-ref failed");
    return { ref, sha };
  },
};

const atomicMultiFileCommit: McpToolHandler = {
  tool: {
    name: "gluecron_atomic_multi_file_commit",
    description:
      "Apply a set of file writes + deletes as a single atomic commit on a branch (creates the branch if it doesn't exist). The killer agent tool: blob/tree/commit/ref-update sequence. Each change is `{path, content?, content_base64?, deleted?}`. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        base_branch: {
          type: "string",
          description: "Branch to fork from when `branch` doesn't yet exist (default: repo default).",
        },
        message: { type: "string" },
        changes: {
          type: "array",
          description: "Array of {path, content?|content_base64?, deleted?} entries.",
        },
      },
      required: ["owner", "repo", "branch", "message", "changes"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const branch = mcpArgString(args, "branch");
    const message = mcpArgString(args, "message");
    requireScope(ctx, "repo", "gluecron_atomic_multi_file_commit");
    const gate = await mcpGateWriteAccess(
      { owner, repo },
      ctx,
      "gluecron_atomic_multi_file_commit"
    );
    const baseBranch = mcpArgString(args, "base_branch", gate.defaultBranch);

    const rawChanges = Array.isArray(args.changes) ? args.changes : [];
    if (rawChanges.length === 0) {
      throw new McpError(ERR_INVALID_PARAMS, "changes must be a non-empty array");
    }
    type Change = {
      path: string;
      bytes?: Uint8Array;
      deleted: boolean;
    };
    const changes: Change[] = [];
    for (const entry of rawChanges) {
      if (!entry || typeof entry !== "object") {
        throw new McpError(ERR_INVALID_PARAMS, "each change must be an object");
      }
      const e = entry as Record<string, unknown>;
      const path = typeof e.path === "string" ? e.path.trim() : "";
      if (!path) {
        throw new McpError(ERR_INVALID_PARAMS, "change.path is required");
      }
      const deleted = e.deleted === true;
      let bytes: Uint8Array | undefined;
      if (!deleted) {
        if (typeof e.content === "string") {
          bytes = new TextEncoder().encode(e.content);
        } else if (typeof e.content_base64 === "string") {
          try {
            bytes = new Uint8Array(Buffer.from(e.content_base64, "base64"));
          } catch {
            throw new McpError(ERR_INVALID_PARAMS, `bad base64 for ${path}`);
          }
        } else {
          throw new McpError(
            ERR_INVALID_PARAMS,
            `change.${path}: provide content, content_base64, or deleted:true`
          );
        }
      }
      changes.push({ path, bytes, deleted });
    }

    const repoDir = getRepoPath(owner, repo);
    const fullRef = `refs/heads/${branch}`;

    // Resolve parent — branch exists OR fall back to base_branch HEAD.
    let parentSha: string | null = null;
    if (await refExists(owner, repo, fullRef)) {
      parentSha = await resolveRef(owner, repo, fullRef);
    } else {
      parentSha = await resolveRef(owner, repo, baseBranch);
      if (!parentSha) {
        throw new McpError(
          ERR_INVALID_PARAMS,
          `base_branch ${baseBranch} does not exist`
        );
      }
    }

    const [author] = await db
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(eq(users.id, gate.userId))
      .limit(1);
    if (!author) throw new McpError(ERR_INVALID_PARAMS, "author lookup failed");

    const tmpIndex = join(
      repoDir,
      `index.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
    );
    const tmpWorkTree = join(
      repoDir,
      `worktree.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
    );
    await mkdir(tmpWorkTree, { recursive: true });
    const env = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      GIT_DIR: repoDir,
      GIT_WORK_TREE: tmpWorkTree,
      GIT_AUTHOR_NAME: author.username,
      GIT_AUTHOR_EMAIL: author.email || `${author.username}@users.noreply.gluecron`,
      GIT_COMMITTER_NAME: author.username,
      GIT_COMMITTER_EMAIL: author.email || `${author.username}@users.noreply.gluecron`,
    };
    const cleanup = async () => {
      await unlink(tmpIndex).catch(() => {});
      await rm(tmpWorkTree, { recursive: true, force: true }).catch(() => {});
    };
    const run = async (cmd: string[]): Promise<{ code: number; out: string }> => {
      const proc = Bun.spawn(cmd, { cwd: repoDir, env, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      return { code, out };
    };

    try {
      // 1. Seed the index from the parent tree.
      if (parentSha) {
        const rt = await run(["git", "read-tree", parentSha]);
        if (rt.code !== 0) {
          await cleanup();
          throw new McpError(ERR_INVALID_PARAMS, "read-tree failed");
        }
      }

      // 2. Apply each change.
      for (const change of changes) {
        if (change.deleted) {
          const ui = await run(["git", "update-index", "--remove", change.path]);
          if (ui.code !== 0) {
            await cleanup();
            throw new McpError(
              ERR_INVALID_PARAMS,
              `delete failed: ${change.path}`
            );
          }
        } else {
          const blobSha = await writeBlob(owner, repo, change.bytes!);
          if (!blobSha) {
            await cleanup();
            throw new McpError(ERR_INVALID_PARAMS, `write-blob failed: ${change.path}`);
          }
          const ui = await run([
            "git",
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${blobSha},${change.path}`,
          ]);
          if (ui.code !== 0) {
            await cleanup();
            throw new McpError(ERR_INVALID_PARAMS, `update-index failed: ${change.path}`);
          }
        }
      }

      // 3. write-tree → commit-tree → update-ref.
      const wt = await run(["git", "write-tree"]);
      const newTree = wt.out.trim();
      if (wt.code !== 0 || !/^[0-9a-f]{40}$/.test(newTree)) {
        await cleanup();
        throw new McpError(ERR_INVALID_PARAMS, "write-tree failed");
      }
      const ctArgs = parentSha
        ? ["git", "commit-tree", newTree, "-p", parentSha, "-m", message]
        : ["git", "commit-tree", newTree, "-m", message];
      const ct = await run(ctArgs);
      const commitSha = ct.out.trim();
      if (ct.code !== 0 || !/^[0-9a-f]{40}$/.test(commitSha)) {
        await cleanup();
        throw new McpError(ERR_INVALID_PARAMS, "commit-tree failed");
      }
      const ok = await updateRef(owner, repo, fullRef, commitSha, parentSha || undefined);
      await cleanup();
      if (!ok) throw new McpError(ERR_INVALID_PARAMS, "update-ref failed");

      return {
        commitSha,
        branch,
        parentSha,
        files: changes.map((c) => ({ path: c.path, deleted: c.deleted })),
      };
    } catch (err) {
      await cleanup();
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// AI WORKFLOWS
// ---------------------------------------------------------------------------

const shipSpec: McpToolHandler = {
  tool: {
    name: "gluecron_ship_spec",
    description:
      "Drop a spec file in .gluecron/specs/ with status: ready so the autopilot picks it up. Wraps voice-to-pr.shipAsSpec — handle both voice + manual specs. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string", description: "Spec body (Markdown)" },
      },
      required: ["owner", "repo", "title", "body"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const title = mcpArgString(args, "title");
    const body = mcpArgString(args, "body");
    requireScope(ctx, "repo", "gluecron_ship_spec");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_ship_spec");
    const { shipAsSpec } = await import("./voice-to-pr");
    // We use voice-to-pr's `shipAsSpec` even for non-voice specs — it
    // builds the front-matter + commits via createOrUpdateFileOnBranch.
    const transcript = `${title}\n\n${body}`;
    const res = await shipAsSpec({
      repositoryId: gate.repoId,
      userId: gate.userId,
      transcript,
      interpretation: { kind: "spec", title, body_markdown: body },
    });
    if (!res.ok) {
      throw new McpError(ERR_INVALID_PARAMS, res.error);
    }
    return res;
  },
};

const voiceToPr: McpToolHandler = {
  tool: {
    name: "gluecron_voice_to_pr",
    description:
      "Interpret a free-form voice transcript and either ship it as a spec or create an issue (caller picks via `as`). Wraps src/lib/voice-to-pr.ts. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        transcript: { type: "string" },
        as: {
          type: "string",
          description: "'spec' or 'issue' (default: auto via interpretVoiceTranscript)",
        },
      },
      required: ["owner", "repo", "transcript"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const transcript = mcpArgString(args, "transcript");
    const as = mcpArgString(args, "as", "auto");
    requireScope(ctx, "repo", "gluecron_voice_to_pr");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_voice_to_pr");

    const { interpretVoiceTranscript, shipAsSpec, createIssueFromVoice } =
      await import("./voice-to-pr");

    let intent: "spec" | "issue";
    let interpretation;
    if (as === "spec" || as === "issue") {
      const interp = await interpretVoiceTranscript({ transcript });
      interpretation = interp.ok ? interp.suggestion : undefined;
      intent = as;
    } else {
      const interp = await interpretVoiceTranscript({ transcript });
      if (!interp.ok) {
        throw new McpError(ERR_INVALID_PARAMS, interp.error);
      }
      interpretation = interp.suggestion;
      intent = interp.suggestion.kind === "issue" ? "issue" : "spec";
    }

    if (intent === "spec") {
      const res = await shipAsSpec({
        repositoryId: gate.repoId,
        userId: gate.userId,
        transcript,
        interpretation,
      });
      if (!res.ok) throw new McpError(ERR_INVALID_PARAMS, res.error);
      return { kind: "spec", ...res };
    }
    const res = await createIssueFromVoice({
      repositoryId: gate.repoId,
      userId: gate.userId,
      transcript,
      interpretation,
    });
    if (!res.ok) throw new McpError(ERR_INVALID_PARAMS, res.error);
    return { kind: "issue", ...res };
  },
};

const refactorAcrossRepos: McpToolHandler = {
  tool: {
    name: "gluecron_refactor_across_repos",
    description:
      "Plan + execute a refactor that spans multiple repos owned by the caller. Wraps src/lib/multi-repo-refactor.ts. `dry_run: true` returns the plan only. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Natural-language description" },
        repository_ids: {
          type: "array",
          description: "Optional explicit repo IDs to scope the refactor to.",
        },
        dry_run: {
          type: "boolean",
          description: "When true, returns the plan and does NOT execute.",
        },
      },
      required: ["description"],
    },
  },
  async run(args, ctx) {
    const description = mcpArgString(args, "description");
    const userId = mcpRequireAuthedCtx(ctx, "gluecron_refactor_across_repos");
    requireScope(ctx, "repo", "gluecron_refactor_across_repos");
    const dryRun = argBool(args, "dry_run", false);
    const ids = argStringArray(args, "repository_ids");
    const { planRefactor, executeRefactor } = await import("./multi-repo-refactor");
    const planRes = await planRefactor({
      userId,
      description,
      repositoryIds: ids.length ? ids : undefined,
    });
    if (!planRes.ok) throw new McpError(ERR_INVALID_PARAMS, planRes.error);
    if (dryRun) return { plan: planRes.plan, refactor: planRes.refactor, executed: false };
    const exec = await executeRefactor({ refactorId: planRes.refactor.id });
    if (!exec.ok) throw new McpError(ERR_INVALID_PARAMS, exec.error);
    return {
      plan: planRes.plan,
      refactor: exec.refactor,
      children: exec.children,
      executed: true,
    };
  },
};

const explainRepo: McpToolHandler = {
  tool: {
    name: "gluecron_explain_repo",
    description:
      "Return the cached AI 'explain this codebase' Markdown for a repo. Pure read — never triggers a new generation (use the web UI for that).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const { codebaseExplanations } = await import("../db/schema");
    const [row] = await db
      .select()
      .from(codebaseExplanations)
      .where(
        eq(
          codebaseExplanations.repositoryId,
          (await mcpResolveAccessibleRepo(owner, repo, ctx.userId)).repoId
        )
      )
      .orderBy(desc(codebaseExplanations.generatedAt))
      .limit(1);
    if (!row) return { explanation: null };
    return {
      commitSha: row.commitSha,
      generatedAt: row.generatedAt,
      markdown: row.markdown,
    };
  },
};

const chatWithRepo: McpToolHandler = {
  tool: {
    name: "gluecron_chat_with_repo",
    description:
      "Start a new chat with a repo: creates a chat row, sends the first user message, streams + persists the assistant reply. Returns {chat_id, reply}. Requires authentication.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        message: { type: "string", description: "Initial user message" },
        title: { type: "string", description: "Chat title (optional)" },
      },
      required: ["owner", "repo", "message"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const userMessage = mcpArgString(args, "message");
    const title = mcpArgString(args, "title", "");
    const userId = mcpRequireAuthedCtx(ctx, "gluecron_chat_with_repo");
    const info = await mcpResolveAccessibleRepo(owner, repo, userId);
    const { createChat, appendUserMessage, streamAssistantReply } = await import(
      "./repo-chat"
    );
    const chat = await createChat({
      repositoryId: info.repoId,
      ownerUserId: userId,
      title: title || userMessage.slice(0, 80),
    });
    if (!chat) throw new McpError(ERR_INVALID_PARAMS, "chat creation failed");
    await appendUserMessage(chat.id, userMessage);
    const reply = await streamAssistantReply({
      chatId: chat.id,
      repoId: info.repoId,
      userMessage,
    });
    return {
      chat_id: chat.id,
      reply: reply ? { id: reply.id, content: reply.content, citations: reply.citations } : null,
    };
  },
};

const chatContinue: McpToolHandler = {
  tool: {
    name: "gluecron_chat_continue",
    description:
      "Send another message to an existing repo chat. Returns the assistant's reply.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["chat_id", "message"],
    },
  },
  async run(args, ctx) {
    const chatId = mcpArgString(args, "chat_id");
    const userMessage = mcpArgString(args, "message");
    const userId = mcpRequireAuthedCtx(ctx, "gluecron_chat_continue");
    const { getChatForUser, appendUserMessage, streamAssistantReply } = await import(
      "./repo-chat"
    );
    const chat = await getChatForUser(chatId, userId);
    if (!chat) throw new McpError(ERR_METHOD_NOT_FOUND, "chat not found");
    await appendUserMessage(chatId, userMessage);
    const reply = await streamAssistantReply({
      chatId,
      repoId: chat.repositoryId,
      userMessage,
    });
    return {
      chat_id: chatId,
      reply: reply ? { id: reply.id, content: reply.content, citations: reply.citations } : null,
    };
  },
};

const generateTests: McpToolHandler = {
  tool: {
    name: "gluecron_generate_tests",
    description:
      "Generate tests for a PR via Claude. Wraps src/lib/ai-test-generator.generateTestsForPr. Mode 'follow-up-pr' opens a new PR; 'append-commit' commits onto the head branch. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number", description: "PR number" },
        mode: { type: "string", description: "'follow-up-pr' or 'append-commit'" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const number = mcpArgNumber(args, "number");
    const mode = mcpArgString(args, "mode", "follow-up-pr");
    if (mode !== "follow-up-pr" && mode !== "append-commit") {
      throw new McpError(ERR_INVALID_PARAMS, "mode must be follow-up-pr|append-commit");
    }
    requireScope(ctx, "repo", "gluecron_generate_tests");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_generate_tests");
    const pr = await mcpLoadPrByNumber(gate.repoId, number);
    if (!pr) throw new McpError(ERR_METHOD_NOT_FOUND, "pr not found");
    const { generateTestsForPr } = await import("./ai-test-generator");
    const res = await generateTestsForPr({ prId: pr.id, mode });
    if (!res.ok) throw new McpError(ERR_INVALID_PARAMS, res.error || "test generation failed");
    return res;
  },
};

const generateCommitMessageTool: McpToolHandler = {
  tool: {
    name: "gluecron_generate_commit_message",
    description:
      "Generate a commit message for a diff. Same engine as gluecron_generate_pr_description but explicit for the commit-message use case.",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string" },
        style: { type: "string", description: "'conventional' (default) or 'plain'" },
      },
      required: ["diff"],
    },
  },
  async run(args) {
    const diff = mcpArgString(args, "diff");
    const style = mcpArgString(args, "style", "conventional");
    const { generateCommitMessage } = await import("./ai-commit-message");
    return await generateCommitMessage(diff, {
      style: style === "plain" ? "plain" : "conventional",
    });
  },
};

const generateReleaseNotes: McpToolHandler = {
  tool: {
    name: "gluecron_generate_release_notes",
    description:
      "Generate release notes between two tags. Wraps src/lib/ai-release-notes.generateReleaseNotes. Returns the rendered Markdown + section data.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        from_tag: { type: "string", description: "Previous tag (optional)" },
        to_tag: { type: "string", description: "New tag" },
      },
      required: ["owner", "repo", "to_tag"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const toTag = mcpArgString(args, "to_tag");
    const fromTag = mcpArgString(args, "from_tag", "");
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const { generateReleaseNotes: gen } = await import("./ai-release-notes");
    return await gen({
      repositoryId: info.repoId,
      fromTag: fromTag || null,
      toTag,
    });
  },
};

const proposeMigration: McpToolHandler = {
  tool: {
    name: "gluecron_propose_migration",
    description:
      "Propose a dependency-upgrade PR. Wraps src/lib/migration-assistant.proposeMajorMigration. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        dependency: { type: "string" },
        from_version: { type: "string" },
        to_version: { type: "string" },
        base_sha: { type: "string", description: "Commit sha to fork from" },
        changelog: { type: "string", description: "Optional changelog text" },
      },
      required: ["owner", "repo", "dependency", "from_version", "to_version", "base_sha"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const dependency = mcpArgString(args, "dependency");
    const fromVersion = mcpArgString(args, "from_version");
    const toVersion = mcpArgString(args, "to_version");
    const baseSha = mcpArgString(args, "base_sha");
    const changelog = mcpArgString(args, "changelog", "");
    requireScope(ctx, "repo", "gluecron_propose_migration");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_propose_migration");
    const { proposeMajorMigration } = await import("./migration-assistant");
    const res = await proposeMajorMigration({
      repositoryId: gate.repoId,
      dependency,
      fromVersion,
      toVersion,
      baseSha,
      changelog: changelog || null,
    });
    if (!res) {
      throw new McpError(
        ERR_INVALID_PARAMS,
        "migration proposal returned null (no manifest, throttle, or AI failure)"
      );
    }
    return res;
  },
};

const proposeDocUpdate: McpToolHandler = {
  tool: {
    name: "gluecron_propose_doc_update",
    description:
      "Manual trigger for the AI doc-update flow: scans tracked sections on the default branch and opens a PR rewriting stale prose. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    requireScope(ctx, "repo", "gluecron_propose_doc_update");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_propose_doc_update");
    const { runDocDriftCheckForRepo } = await import("./ai-doc-updater");
    const res = await runDocDriftCheckForRepo(gate.repoId);
    return res ?? { proposed: 0, note: "no drift detected or AI unavailable" };
  },
};

// ---------------------------------------------------------------------------
// CI / DEPLOYS
// ---------------------------------------------------------------------------

const triggerWorkflow: McpToolHandler = {
  tool: {
    name: "gluecron_trigger_workflow",
    description:
      "Dispatch a workflow_dispatch run. Mirrors POST /api/v2/repos/.../actions/workflows/:filename/dispatches. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        filename: { type: "string", description: "Workflow filename (e.g. ci.yml)" },
        ref: { type: "string", description: "Branch / tag / sha (default: repo default branch)" },
        inputs: { type: "object", description: "Workflow inputs (object)" },
      },
      required: ["owner", "repo", "filename"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const filename = mcpArgString(args, "filename");
    requireScope(ctx, "repo", "gluecron_trigger_workflow");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_trigger_workflow");

    // Match the api-v2 helper: stored workflow path is
    // `.gluecron/workflows/<filename>`; we match by trailing basename.
    const candidates = await db
      .select()
      .from(workflows)
      .where(eq(workflows.repositoryId, gate.repoId));
    const wfRow = candidates.find((row) => {
      const idx = row.path.lastIndexOf("/");
      const base = idx >= 0 ? row.path.slice(idx + 1) : row.path;
      return base === filename;
    });
    if (!wfRow) throw new McpError(ERR_METHOD_NOT_FOUND, `workflow not found: ${filename}`);

    let parsedObj: Record<string, unknown> = {};
    try {
      const v = JSON.parse(wfRow.parsed);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsedObj = v as Record<string, unknown>;
      }
    } catch {
      /* */
    }

    // Inline-copy of the dispatch-spec extractor in src/routes/api-v2.ts
    // (private to that module). Same shape, same semantics — keeping the
    // logic local avoids an export-shuffle in the api-v2 module.
    const rawOn = parsedObj.on as
      | string
      | string[]
      | Record<string, unknown>
      | null
      | undefined;
    type DispatchInputSpec = { required?: boolean; default?: unknown };
    let dispatchEnabled = false;
    let dispatchInputs: Record<string, DispatchInputSpec> | null = null;
    if (typeof rawOn === "string") {
      dispatchEnabled = rawOn === "workflow_dispatch";
    } else if (Array.isArray(rawOn)) {
      dispatchEnabled = rawOn.includes("workflow_dispatch");
    } else if (rawOn && typeof rawOn === "object") {
      const slot = (rawOn as Record<string, unknown>)["workflow_dispatch"];
      if (slot !== undefined) {
        dispatchEnabled = true;
        if (slot && typeof slot === "object") {
          const inputs = (slot as Record<string, unknown>).inputs;
          if (inputs && typeof inputs === "object" && !Array.isArray(inputs)) {
            dispatchInputs = inputs as Record<string, DispatchInputSpec>;
          }
        }
      }
    }
    if (!dispatchEnabled) {
      throw new McpError(ERR_INVALID_PARAMS, "workflow has no workflow_dispatch trigger");
    }

    const providedInputs =
      args.inputs && typeof args.inputs === "object" && !Array.isArray(args.inputs)
        ? (args.inputs as Record<string, unknown>)
        : undefined;
    if (dispatchInputs) {
      const missing: string[] = [];
      for (const [n, spec] of Object.entries(dispatchInputs)) {
        if (!spec || typeof spec !== "object") continue;
        const typed = spec as DispatchInputSpec;
        const has =
          !!providedInputs &&
          Object.prototype.hasOwnProperty.call(providedInputs, n) &&
          providedInputs[n] !== undefined &&
          providedInputs[n] !== null;
        if (typed.required && !has && typed.default === undefined) {
          missing.push(n);
        }
      }
      if (missing.length) {
        throw new McpError(
          ERR_INVALID_PARAMS,
          `missing required workflow inputs: ${missing.join(",")}`
        );
      }
    }

    const refIn = mcpArgString(args, "ref", gate.defaultBranch);
    const commitSha = await resolveRef(owner, repo, refIn);
    if (!commitSha) {
      throw new McpError(ERR_INVALID_PARAMS, `ref not found: ${refIn}`);
    }
    const { enqueueRun } = await import("./workflow-runner");
    const runId = await enqueueRun({
      workflowId: wfRow.id,
      repositoryId: gate.repoId,
      event: "workflow_dispatch",
      ref: refIn,
      commitSha,
      triggeredBy: gate.userId,
    });
    if (!runId) throw new McpError(ERR_INVALID_PARAMS, "enqueueRun failed");
    return { runId, workflowName: wfRow.name, ref: refIn, commitSha };
  },
};

const getWorkflowRun: McpToolHandler = {
  tool: {
    name: "gluecron_get_workflow_run",
    description: "Fetch a workflow run's metadata + status. Mirrors GET /api/v2/repos/.../actions/runs/:id.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        run_id: { type: "string" },
      },
      required: ["owner", "repo", "run_id"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const runId = mcpArgString(args, "run_id");
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (!run || run.repositoryId !== info.repoId) {
      throw new McpError(ERR_METHOD_NOT_FOUND, "run not found");
    }
    return run;
  },
};

const getWorkflowLogs: McpToolHandler = {
  tool: {
    name: "gluecron_get_workflow_logs",
    description:
      "Return concatenated per-job logs for a workflow run, plus per-job metadata. JSON-friendly companion to the ZIP-download endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        run_id: { type: "string" },
      },
      required: ["owner", "repo", "run_id"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const runId = mcpArgString(args, "run_id");
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (!run || run.repositoryId !== info.repoId) {
      throw new McpError(ERR_METHOD_NOT_FOUND, "run not found");
    }
    const jobs = await db
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.runId, run.id))
      .orderBy(asc(workflowJobs.jobOrder));
    return {
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        logs: j.logs || "",
      })),
    };
  },
};

const cancelWorkflowRun: McpToolHandler = {
  tool: {
    name: "gluecron_cancel_workflow_run",
    description: "Cancel a queued/running workflow run. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        run_id: { type: "string" },
      },
      required: ["owner", "repo", "run_id"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const runId = mcpArgString(args, "run_id");
    requireScope(ctx, "repo", "gluecron_cancel_workflow_run");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_cancel_workflow_run");
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (!run || run.repositoryId !== gate.repoId) {
      throw new McpError(ERR_METHOD_NOT_FOUND, "run not found");
    }
    if (run.status !== "queued" && run.status !== "running") {
      return { cancelled: false, reason: `run is ${run.status}` };
    }
    const now = new Date();
    await db
      .update(workflowRuns)
      .set({ status: "cancelled", conclusion: "cancelled", finishedAt: now })
      .where(eq(workflowRuns.id, run.id));
    await db
      .update(workflowJobs)
      .set({ status: "cancelled", conclusion: "cancelled", finishedAt: now })
      .where(eq(workflowJobs.runId, run.id));
    return { cancelled: true };
  },
};

const getPreviewUrl: McpToolHandler = {
  tool: {
    name: "gluecron_get_preview_url",
    description:
      "Return the branch-preview URL + status for a (repo, branch) pair. Wraps branch-previews.getPreviewForBranch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
      },
      required: ["owner", "repo", "branch"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const branch = mcpArgString(args, "branch");
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const { getPreviewForBranch, previewStatusLabel, formatExpiresIn, buildPreviewUrl } =
      await import("./branch-previews");
    const row = await getPreviewForBranch(info.repoId, branch);
    if (!row) {
      return {
        exists: false,
        url: buildPreviewUrl(owner, repo, branch),
        status: "missing",
      };
    }
    return {
      exists: true,
      url: row.previewUrl,
      status: row.status,
      statusLabel: previewStatusLabel(row.status),
      expiresAt: row.expiresAt,
      expiresIn: formatExpiresIn(row.expiresAt),
    };
  },
};

const provisionPrSandbox: McpToolHandler = {
  tool: {
    name: "gluecron_provision_pr_sandbox",
    description:
      "Provision (or re-provision) a sandbox for a PR. Wraps pr-sandbox.provisionSandbox. Requires 'repo' scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const number = mcpArgNumber(args, "number");
    requireScope(ctx, "repo", "gluecron_provision_pr_sandbox");
    const gate = await mcpGateWriteAccess({ owner, repo }, ctx, "gluecron_provision_pr_sandbox");
    const pr = await mcpLoadPrByNumber(gate.repoId, number);
    if (!pr) throw new McpError(ERR_METHOD_NOT_FOUND, "pr not found");
    const { provisionSandbox } = await import("./pr-sandbox");
    const row = await provisionSandbox({ prId: pr.id });
    if (!row) throw new McpError(ERR_INVALID_PARAMS, "provision failed");
    return row;
  },
};

// ---------------------------------------------------------------------------
// AGENTS
// ---------------------------------------------------------------------------

const createAgentSession: McpToolHandler = {
  tool: {
    name: "gluecron_create_agent_session",
    description:
      "Mint a new agent-multiplayer session. Returns the plaintext `token` exactly once (store it). Requires 'admin' scope.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable session name (unique per owner)" },
        repository_id: { type: "string", description: "Optional repo to scope to" },
        branch_namespace: { type: "string", description: "Optional branch namespace override" },
        budget_cents_per_day: { type: "number", description: "Daily budget cap in cents (default 500)" },
      },
      required: ["name"],
    },
  },
  async run(args, ctx) {
    const userId = mcpRequireAuthedCtx(ctx, "gluecron_create_agent_session");
    requireScope(ctx, "admin", "gluecron_create_agent_session");
    const name = mcpArgString(args, "name");
    const { createAgentSession } = await import("./agent-multiplayer");
    const res = await createAgentSession({
      ownerUserId: userId,
      name,
      repositoryId:
        typeof args.repository_id === "string" ? args.repository_id : null,
      branchNamespace:
        typeof args.branch_namespace === "string" ? args.branch_namespace : undefined,
      budgetCentsPerDay:
        typeof args.budget_cents_per_day === "number"
          ? args.budget_cents_per_day
          : undefined,
    });
    if (!res) throw new McpError(ERR_INVALID_PARAMS, "session creation failed");
    return {
      session: { id: res.session.id, name: res.session.name },
      token: res.token,
      warning: "Token is shown exactly once — store it now.",
    };
  },
};

const acquireLease: McpToolHandler = {
  tool: {
    name: "gluecron_acquire_lease",
    description:
      "Grab an exclusive lease on a target (e.g. a PR or branch) for an agent session. Returns null when another agent holds an active lease.",
    inputSchema: {
      type: "object",
      properties: {
        agent_session_id: { type: "string" },
        target_type: { type: "string", description: "e.g. 'pull_request', 'branch'" },
        target_id: { type: "string" },
        duration_ms: { type: "number", description: "Lease duration (default 5 minutes)" },
      },
      required: ["agent_session_id", "target_type", "target_id"],
    },
  },
  async run(args, ctx) {
    mcpRequireAuthedCtx(ctx, "gluecron_acquire_lease");
    requireScope(ctx, "repo", "gluecron_acquire_lease");
    const sessionId = mcpArgString(args, "agent_session_id");
    const targetType = mcpArgString(args, "target_type");
    const targetId = mcpArgString(args, "target_id");
    const durationMs =
      typeof args.duration_ms === "number" ? args.duration_ms : undefined;
    const { acquireLease } = await import("./agent-multiplayer");
    const lease = await acquireLease(sessionId, targetType, targetId, durationMs);
    return { lease };
  },
};

const releaseLeaseTool: McpToolHandler = {
  tool: {
    name: "gluecron_release_lease",
    description: "Release a lease by id. Idempotent. Returns {released}.",
    inputSchema: {
      type: "object",
      properties: { lease_id: { type: "string" } },
      required: ["lease_id"],
    },
  },
  async run(args, ctx) {
    mcpRequireAuthedCtx(ctx, "gluecron_release_lease");
    requireScope(ctx, "repo", "gluecron_release_lease");
    const leaseId = mcpArgString(args, "lease_id");
    const { releaseLease } = await import("./agent-multiplayer");
    return { released: await releaseLease(leaseId) };
  },
};

const getAgentBudget: McpToolHandler = {
  tool: {
    name: "gluecron_get_agent_budget",
    description: "Return spent / cap / remaining cents for an agent session.",
    inputSchema: {
      type: "object",
      properties: { agent_session_id: { type: "string" } },
      required: ["agent_session_id"],
    },
  },
  async run(args, ctx) {
    mcpRequireAuthedCtx(ctx, "gluecron_get_agent_budget");
    const sessionId = mcpArgString(args, "agent_session_id");
    const { getAgentUsage } = await import("./agent-multiplayer");
    return await getAgentUsage(sessionId);
  },
};

// ---------------------------------------------------------------------------
// SEMANTIC
// ---------------------------------------------------------------------------

const semanticSearch: McpToolHandler = {
  tool: {
    name: "gluecron_semantic_search",
    description:
      "Query the per-repo vector index (Voyage embeddings when configured, hash fallback otherwise). Wraps src/lib/semantic-search.searchRepository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["owner", "repo", "query"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const query = mcpArgString(args, "query");
    const limit = mcpArgNumber(args, "limit", 20);
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const { searchRepository } = await import("./semantic-search");
    const hits = await searchRepository({
      repositoryId: info.repoId,
      query,
      limit,
    });
    return { hits };
  },
};

const findSymbol: McpToolHandler = {
  tool: {
    name: "gluecron_find_symbol",
    description:
      "Find definitions of a symbol by name within a repo. Wraps src/lib/symbols.findDefinitions.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        name: { type: "string", description: "Symbol name" },
      },
      required: ["owner", "repo", "name"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const name = mcpArgString(args, "name");
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const { findDefinitions } = await import("./symbols");
    const defs = await findDefinitions(info.repoId, name);
    return { definitions: defs };
  },
};

// ---------------------------------------------------------------------------
// INSIGHTS
// ---------------------------------------------------------------------------

const prStatusSummary: McpToolHandler = {
  tool: {
    name: "gluecron_pr_status_summary",
    description:
      "Compute a one-shot status summary for a PR: state, risk score, AI-review verdicts (trio), gate signals. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
      },
      required: ["owner", "repo", "number"],
    },
  },
  async run(args, ctx) {
    const owner = mcpArgString(args, "owner");
    const repo = mcpArgString(args, "repo");
    const number = mcpArgNumber(args, "number");
    const info = await mcpResolveAccessibleRepo(owner, repo, ctx.userId);
    const pr = await mcpLoadPrByNumber(info.repoId, number);
    if (!pr) throw new McpError(ERR_METHOD_NOT_FOUND, "pr not found");
    const { getLatestCachedPrRisk } = await import("./pr-risk");
    const risk = await getLatestCachedPrRisk(pr.id);
    const aiComments = await db
      .select({ body: prComments.body, isAiReview: prComments.isAiReview })
      .from(prComments)
      .where(and(eq(prComments.pullRequestId, pr.id), eq(prComments.isAiReview, true)));
    const { TRIO_SUMMARY_MARKER } = await import("./ai-review-trio");
    const trioSummary = aiComments.find((c) => c.body.includes(TRIO_SUMMARY_MARKER));
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: pr.isDraft,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      risk: risk
        ? { score: risk.score, band: risk.band, summary: risk.aiSummary }
        : null,
      aiReviewCount: aiComments.length,
      trioSummary: trioSummary ? trioSummary.body : null,
      url: mcpPrUrl(owner, repo, pr.number),
    };
  },
};

const aiCostSummary: McpToolHandler = {
  tool: {
    name: "gluecron_ai_cost_summary",
    description:
      "Return AI spend rollups. Scope by one of: user_id (self), repo {owner,repo}, or agent_session_id. Defaults to caller's user spend.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "'user' (default) | 'repo' | 'agent'" },
        owner: { type: "string" },
        repo: { type: "string" },
        agent_session_id: { type: "string" },
      },
    },
  },
  async run(args, ctx) {
    const scope = mcpArgString(args, "scope", "user");
    const userId = mcpRequireAuthedCtx(ctx, "gluecron_ai_cost_summary");
    const {
      summarizeCostsForUser,
      summarizeCostsForRepo,
      summarizeCostsForAgent,
    } = await import("./ai-cost-tracker");
    if (scope === "repo") {
      const owner = mcpArgString(args, "owner");
      const repo = mcpArgString(args, "repo");
      const info = await mcpResolveAccessibleRepo(owner, repo, userId);
      return await summarizeCostsForRepo(info.repoId);
    }
    if (scope === "agent") {
      const sessionId = mcpArgString(args, "agent_session_id");
      return await summarizeCostsForAgent(sessionId);
    }
    return await summarizeCostsForUser(userId);
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every expanded tool keyed by name. Merged into `defaultTools()` in
 * `mcp-tools.ts` so the MCP HTTP route advertises all of them.
 */
export function expandedTools(): Record<string, McpToolHandler> {
  return {
    [forkRepo.tool.name]: forkRepo,
    [deleteRepo.tool.name]: deleteRepo,
    [updateRepo.tool.name]: updateRepo,
    [searchRepos.tool.name]: searchRepos,
    [cloneUrl.tool.name]: cloneUrl,

    [labelIssue.tool.name]: labelIssue,
    [unlabelIssue.tool.name]: unlabelIssue,
    [assignIssue.tool.name]: assignIssue,
    [searchIssues.tool.name]: searchIssues,

    [requestChanges.tool.name]: requestChanges,
    [searchPrs.tool.name]: searchPrs,
    [openDraftPr.tool.name]: openDraftPr,
    [generatePrDescription.tool.name]: generatePrDescription,

    [readFile.tool.name]: readFile,
    [writeFile.tool.name]: writeFile,
    [deleteFile.tool.name]: deleteFile,
    [listTree.tool.name]: listTree,
    [getCommitTool.tool.name]: getCommitTool,
    [createBranch.tool.name]: createBranch,
    [atomicMultiFileCommit.tool.name]: atomicMultiFileCommit,

    [shipSpec.tool.name]: shipSpec,
    [voiceToPr.tool.name]: voiceToPr,
    [refactorAcrossRepos.tool.name]: refactorAcrossRepos,
    [explainRepo.tool.name]: explainRepo,
    [chatWithRepo.tool.name]: chatWithRepo,
    [chatContinue.tool.name]: chatContinue,
    [generateTests.tool.name]: generateTests,
    [generateCommitMessageTool.tool.name]: generateCommitMessageTool,
    [generateReleaseNotes.tool.name]: generateReleaseNotes,
    [proposeMigration.tool.name]: proposeMigration,
    [proposeDocUpdate.tool.name]: proposeDocUpdate,

    [triggerWorkflow.tool.name]: triggerWorkflow,
    [getWorkflowRun.tool.name]: getWorkflowRun,
    [getWorkflowLogs.tool.name]: getWorkflowLogs,
    [cancelWorkflowRun.tool.name]: cancelWorkflowRun,
    [getPreviewUrl.tool.name]: getPreviewUrl,
    [provisionPrSandbox.tool.name]: provisionPrSandbox,

    [createAgentSession.tool.name]: createAgentSession,
    [acquireLease.tool.name]: acquireLease,
    [releaseLeaseTool.tool.name]: releaseLeaseTool,
    [getAgentBudget.tool.name]: getAgentBudget,

    [semanticSearch.tool.name]: semanticSearch,
    [findSymbol.tool.name]: findSymbol,

    [prStatusSummary.tool.name]: prStatusSummary,
    [aiCostSummary.tool.name]: aiCostSummary,
  };
}

/** Test-only export of the per-tool handlers. */
export const __expandedTest = {
  forkRepo,
  deleteRepo,
  updateRepo,
  searchRepos,
  cloneUrl,
  labelIssue,
  unlabelIssue,
  assignIssue,
  searchIssues,
  requestChanges,
  searchPrs,
  openDraftPr,
  generatePrDescription,
  readFile,
  writeFile,
  deleteFile,
  listTree,
  getCommitTool,
  createBranch,
  atomicMultiFileCommit,
  shipSpec,
  voiceToPr,
  refactorAcrossRepos,
  explainRepo,
  chatWithRepo,
  chatContinue,
  generateTests,
  generateCommitMessageTool,
  generateReleaseNotes,
  proposeMigration,
  proposeDocUpdate,
  triggerWorkflow,
  getWorkflowRun,
  getWorkflowLogs,
  cancelWorkflowRun,
  getPreviewUrl,
  provisionPrSandbox,
  createAgentSession,
  acquireLease,
  releaseLeaseTool,
  getAgentBudget,
  semanticSearch,
  findSymbol,
  prStatusSummary,
  aiCostSummary,
  requireScope,
};

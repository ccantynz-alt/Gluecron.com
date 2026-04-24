/**
 * MCP (Model Context Protocol) tool definitions and implementations.
 *
 * Each tool has:
 *   - name: unique identifier
 *   - description: human/model readable explanation (required by MCP spec)
 *   - inputSchema: JSON Schema for the arguments
 *   - handler: async function that receives (args, user) and returns a result
 *
 * The route (src/routes/mcp.ts) dispatches tools/call to handler() and
 * wraps errors in JSON-RPC error objects.
 */

import { eq, and, desc, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  users,
  issues,
  issueLabels,
  labels,
  pullRequests,
  prComments,
  gateRuns,
} from "../db/schema";
import type { User } from "../db/schema";
import {
  getTree,
  getBlob,
  listCommits,
  searchCode,
  getRepoPath,
} from "../git/repository";
import { loadRepoByPath } from "./namespace";
import { explainCodebase, getCachedExplanation } from "./ai-explain";
import { triggerAiReview } from "./ai-review";

// --------------------------------------------------------------------------
// Shared error helpers
// --------------------------------------------------------------------------

export class McpToolError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

function notFound(msg: string): never {
  throw new McpToolError(-32004, msg);
}

function unauthorized(msg = "Authentication required"): never {
  throw new McpToolError(-32001, msg);
}

function invalidParams(msg: string): never {
  throw new McpToolError(-32602, msg);
}

// --------------------------------------------------------------------------
// Helper: resolve owner username → user row
// --------------------------------------------------------------------------

async function resolveOwnerUser(username: string): Promise<User> {
  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!u) notFound(`User '${username}' not found`);
  return u;
}

// --------------------------------------------------------------------------
// Helper: load repo + enforce visibility
// --------------------------------------------------------------------------

async function loadAndCheckRepo(
  owner: string,
  repoName: string,
  caller: User | null
) {
  const repo = await loadRepoByPath(owner, repoName);
  if (!repo) notFound(`Repository '${owner}/${repoName}' not found`);
  if (repo.isPrivate) {
    if (!caller) unauthorized(`Repository '${owner}/${repoName}' is private`);
    // caller must be the owner (org-owned repos not checked here for brevity)
    if (repo.ownerId !== caller.id) {
      unauthorized(`Access denied to private repository '${owner}/${repoName}'`);
    }
  }
  return repo;
}

// --------------------------------------------------------------------------
// Tool type
// --------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, user: User | null) => Promise<unknown>;
}

// --------------------------------------------------------------------------
// Tool: list_repositories
// --------------------------------------------------------------------------

const listRepositoriesTool: McpTool = {
  name: "list_repositories",
  description:
    "List repositories owned by a Gluecron user. If username is omitted the authenticated user's repos are returned.",
  inputSchema: {
    type: "object",
    properties: {
      username: {
        type: "string",
        description: "Username whose repositories to list. Defaults to the authenticated user.",
      },
    },
  },
  async handler(args, user) {
    const usernameArg = args.username as string | undefined;
    let targetUser: User;
    if (usernameArg) {
      targetUser = await resolveOwnerUser(usernameArg);
    } else {
      if (!user) unauthorized("Provide a username or authenticate");
      targetUser = user;
    }

    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        description: repositories.description,
        isPrivate: repositories.isPrivate,
        defaultBranch: repositories.defaultBranch,
        stars: repositories.starCount,
        createdAt: repositories.createdAt,
        updatedAt: repositories.updatedAt,
        pushedAt: repositories.pushedAt,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, targetUser.id),
          // Only show private repos to the owner themselves
          user?.id === targetUser.id
            ? undefined
            : eq(repositories.isPrivate, false)
        )
      )
      .orderBy(desc(repositories.updatedAt));

    return rows.map((r) => ({
      owner: targetUser.username,
      name: r.name,
      description: r.description ?? null,
      isPrivate: r.isPrivate,
      defaultBranch: r.defaultBranch,
      stars: r.stars,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      pushedAt: r.pushedAt ?? null,
    }));
  },
};

// --------------------------------------------------------------------------
// Tool: get_repository
// --------------------------------------------------------------------------

const getRepositoryTool: McpTool = {
  name: "get_repository",
  description:
    "Get full details for a repository including description, default branch, star/fork/issue counts, and recent activity.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      name: { type: "string", description: "Repository name" },
    },
    required: ["owner", "name"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.name as string;
    if (!owner || !repoName) invalidParams("owner and name are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);

    // Recent activity
    const activity = await db
      .select()
      .from(
        (await import("../db/schema")).activityFeed
      )
      .where(eq((await import("../db/schema")).activityFeed.repositoryId, repo.id))
      .orderBy(desc((await import("../db/schema")).activityFeed.createdAt))
      .limit(10);

    return {
      id: repo.id,
      owner,
      name: repo.name,
      description: repo.description ?? null,
      isPrivate: repo.isPrivate,
      isArchived: repo.isArchived,
      isTemplate: repo.isTemplate,
      defaultBranch: repo.defaultBranch,
      stars: repo.starCount,
      forks: repo.forkCount,
      openIssues: repo.issueCount,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
      pushedAt: repo.pushedAt ?? null,
      recentActivity: activity.map((a) => ({
        action: a.action,
        targetType: a.targetType ?? null,
        targetId: a.targetId ?? null,
        createdAt: a.createdAt,
      })),
    };
  },
};

// --------------------------------------------------------------------------
// Tool: get_file_contents
// --------------------------------------------------------------------------

const getFileContentsTool: McpTool = {
  name: "get_file_contents",
  description: "Get the contents of a file in a repository at a given ref (branch, tag, or commit SHA).",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      path: { type: "string", description: "File path within the repository" },
      ref: {
        type: "string",
        description: "Branch, tag, or commit SHA. Defaults to the repository default branch.",
      },
    },
    required: ["owner", "repo", "path"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    const filePath = args.path as string;
    if (!owner || !repoName || !filePath) invalidParams("owner, repo, and path are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);
    const ref = (args.ref as string | undefined) || repo.defaultBranch;

    const blob = await getBlob(owner, repoName, ref, filePath);
    if (!blob) notFound(`File '${filePath}' not found at ref '${ref}'`);

    if (blob.isBinary) {
      return {
        content: "",
        encoding: "binary",
        size: blob.size,
        path: filePath,
        isBinary: true,
      };
    }

    return {
      content: blob.content,
      encoding: "utf8",
      size: blob.size,
      path: filePath,
      isBinary: false,
    };
  },
};

// --------------------------------------------------------------------------
// Tool: list_files
// --------------------------------------------------------------------------

const listFilesTool: McpTool = {
  name: "list_files",
  description: "List files and directories in a repository at a given path and ref.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      path: {
        type: "string",
        description: "Directory path to list. Defaults to the root directory.",
      },
      ref: {
        type: "string",
        description: "Branch, tag, or commit SHA. Defaults to the repository default branch.",
      },
    },
    required: ["owner", "repo"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    if (!owner || !repoName) invalidParams("owner and repo are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);
    const ref = (args.ref as string | undefined) || repo.defaultBranch;
    const treePath = (args.path as string | undefined) || "";

    const entries = await getTree(owner, repoName, ref, treePath);

    return entries.map((e) => {
      const entryPath = treePath ? `${treePath}/${e.name}` : e.name;
      return {
        name: e.name,
        path: entryPath,
        type: e.type === "tree" ? "dir" : "file",
        size: e.type === "blob" ? (e.size ?? null) : null,
        sha: e.sha,
      };
    });
  },
};

// --------------------------------------------------------------------------
// Tool: search_code
// --------------------------------------------------------------------------

const searchCodeTool: McpTool = {
  name: "search_code",
  description: "Search for a string or pattern in the source code of a repository.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      query: { type: "string", description: "Search query string (passed to git grep)" },
      ref: {
        type: "string",
        description: "Branch, tag, or commit SHA. Defaults to the repository default branch.",
      },
    },
    required: ["owner", "repo", "query"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    const query = args.query as string;
    if (!owner || !repoName || !query) invalidParams("owner, repo, and query are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);
    const ref = (args.ref as string | undefined) || repo.defaultBranch;

    const matches = await searchCode(owner, repoName, ref, query);

    return matches.map((m) => ({
      file: m.file,
      line: m.lineNum,
      content: m.line,
    }));
  },
};

// --------------------------------------------------------------------------
// Tool: list_commits
// --------------------------------------------------------------------------

const listCommitsTool: McpTool = {
  name: "list_commits",
  description: "List recent commits on a branch of a repository.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      branch: {
        type: "string",
        description: "Branch name. Defaults to the repository default branch.",
      },
      limit: {
        type: "number",
        description: "Maximum number of commits to return (1–100). Defaults to 20.",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["owner", "repo"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    if (!owner || !repoName) invalidParams("owner and repo are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);
    const branch = (args.branch as string | undefined) || repo.defaultBranch;
    const limit = Math.min(100, Math.max(1, (args.limit as number | undefined) ?? 20));

    const commits = await listCommits(owner, repoName, branch, limit);

    return commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      author: c.author,
      authorEmail: c.authorEmail,
      date: c.date,
      parentShas: c.parentShas,
    }));
  },
};

// --------------------------------------------------------------------------
// Tool: get_gate_status
// --------------------------------------------------------------------------

const getGateStatusTool: McpTool = {
  name: "get_gate_status",
  description:
    "Get the current gate status for a repository — the latest result for each configured gate (GateTest, AI Review, Secret Scan, etc.).",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
    },
    required: ["owner", "repo"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    if (!owner || !repoName) invalidParams("owner and repo are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);

    // Get all gate runs ordered newest-first and deduplicate by gate name
    const runs = await db
      .select()
      .from(gateRuns)
      .where(eq(gateRuns.repositoryId, repo.id))
      .orderBy(desc(gateRuns.createdAt))
      .limit(200);

    // Latest run per gate name
    const latestByGate = new Map<string, typeof runs[0]>();
    for (const run of runs) {
      if (!latestByGate.has(run.gateName)) {
        latestByGate.set(run.gateName, run);
      }
    }

    const gates = Array.from(latestByGate.values()).map((r) => ({
      name: r.gateName,
      status: r.status,
      summary: r.summary ?? null,
      commitSha: r.commitSha,
      updatedAt: r.completedAt ?? r.createdAt,
    }));

    // Derive overall status
    let overall: "green" | "red" | "pending" = "green";
    for (const g of gates) {
      if (g.status === "failed") { overall = "red"; break; }
      if (g.status === "pending" || g.status === "running") overall = "pending";
    }
    if (gates.length === 0) overall = "pending";

    return { overall, gates };
  },
};

// --------------------------------------------------------------------------
// Tool: list_pull_requests
// --------------------------------------------------------------------------

const listPullRequestsTool: McpTool = {
  name: "list_pull_requests",
  description: "List pull requests for a repository, optionally filtered by state.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      state: {
        type: "string",
        enum: ["open", "closed", "merged"],
        description: "Filter by state. Defaults to 'open'.",
      },
    },
    required: ["owner", "repo"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    if (!owner || !repoName) invalidParams("owner and repo are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);
    const state = (args.state as string | undefined) || "open";

    const prs = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        state: pullRequests.state,
        authorId: pullRequests.authorId,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
        createdAt: pullRequests.createdAt,
        mergedAt: pullRequests.mergedAt,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repo.id),
          eq(pullRequests.state, state)
        )
      )
      .orderBy(desc(pullRequests.createdAt))
      .limit(50);

    if (prs.length === 0) return [];

    // Collect author user data
    const authorIds = [...new Set(prs.map((p) => p.authorId))];
    const authorRows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, authorIds));
    const authorMap = new Map(authorRows.map((u) => [u.id, u.username]));

    // Latest AI review comment per PR
    const prIds = prs.map((p) => p.id);
    const aiComments = await db
      .select({
        pullRequestId: prComments.pullRequestId,
        body: prComments.body,
        createdAt: prComments.createdAt,
      })
      .from(prComments)
      .where(
        and(
          inArray(prComments.pullRequestId, prIds),
          eq(prComments.isAiReview, true)
        )
      )
      .orderBy(desc(prComments.createdAt));

    // Latest AI comment per PR
    const aiReviewMap = new Map<string, string>();
    for (const c of aiComments) {
      if (!aiReviewMap.has(c.pullRequestId)) {
        aiReviewMap.set(c.pullRequestId, c.body);
      }
    }

    return prs.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      author: authorMap.get(p.authorId) ?? null,
      baseBranch: p.baseBranch,
      headBranch: p.headBranch,
      createdAt: p.createdAt,
      mergedAt: p.mergedAt ?? null,
      aiReviewSummary: aiReviewMap.get(p.id) ?? null,
    }));
  },
};

// --------------------------------------------------------------------------
// Tool: list_issues
// --------------------------------------------------------------------------

const listIssuesTool: McpTool = {
  name: "list_issues",
  description: "List issues for a repository, optionally filtered by state.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      state: {
        type: "string",
        enum: ["open", "closed"],
        description: "Filter by state. Defaults to 'open'.",
      },
    },
    required: ["owner", "repo"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    if (!owner || !repoName) invalidParams("owner and repo are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);
    const state = (args.state as string | undefined) || "open";

    const issueRows = await db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        state: issues.state,
        authorId: issues.authorId,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, repo.id),
          eq(issues.state, state)
        )
      )
      .orderBy(desc(issues.createdAt))
      .limit(50);

    if (issueRows.length === 0) return [];

    // Collect author usernames
    const authorIds = [...new Set(issueRows.map((i) => i.authorId))];
    const authorRows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, authorIds));
    const authorMap = new Map(authorRows.map((u) => [u.id, u.username]));

    // Load labels for all issues in one join
    const issueIds = issueRows.map((i) => i.id);
    const labelJoinRows = await db
      .select({
        issueId: issueLabels.issueId,
        labelName: labels.name,
        labelColor: labels.color,
      })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(inArray(issueLabels.issueId, issueIds));

    // Group labels by issue
    const labelsMap = new Map<string, Array<{ name: string; color: string }>>();
    for (const row of labelJoinRows) {
      const existing = labelsMap.get(row.issueId) ?? [];
      existing.push({ name: row.labelName, color: row.labelColor });
      labelsMap.set(row.issueId, existing);
    }

    return issueRows.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: authorMap.get(i.authorId) ?? null,
      labels: labelsMap.get(i.id) ?? [],
      createdAt: i.createdAt,
    }));
  },
};

// --------------------------------------------------------------------------
// Tool: create_issue
// --------------------------------------------------------------------------

const createIssueTool: McpTool = {
  name: "create_issue",
  description: "Create a new issue in a repository. Requires authentication.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body (Markdown)" },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Label names to apply to the issue",
      },
    },
    required: ["owner", "repo", "title"],
  },
  async handler(args, user) {
    if (!user) unauthorized("Creating issues requires authentication");

    const owner = args.owner as string;
    const repoName = args.repo as string;
    const title = args.title as string;
    if (!owner || !repoName || !title) invalidParams("owner, repo, and title are required");
    if (title.trim().length === 0) invalidParams("title cannot be empty");

    const repo = await loadAndCheckRepo(owner, repoName, user);
    const body = (args.body as string | undefined) ?? null;
    const labelNames = (args.labels as string[] | undefined) ?? [];

    // Insert issue
    const [newIssue] = await db
      .insert(issues)
      .values({
        repositoryId: repo.id,
        authorId: user.id,
        title: title.trim(),
        body,
        state: "open",
      })
      .returning({ id: issues.id, number: issues.number });

    if (!newIssue) throw new McpToolError(-32603, "Failed to create issue");

    // Apply labels if any
    if (labelNames.length > 0) {
      const labelRows = await db
        .select({ id: labels.id, name: labels.name })
        .from(labels)
        .where(
          and(
            eq(labels.repositoryId, repo.id),
            inArray(labels.name, labelNames)
          )
        );

      if (labelRows.length > 0) {
        await db.insert(issueLabels).values(
          labelRows.map((l) => ({ issueId: newIssue.id, labelId: l.id }))
        );
      }
    }

    // Bump issue count on repo (best-effort)
    db.update(repositories)
      .set({ issueCount: repo.issueCount + 1 })
      .where(eq(repositories.id, repo.id))
      .catch(() => {});

    return {
      number: newIssue.number,
      url: `/${owner}/${repoName}/issues/${newIssue.number}`,
    };
  },
};

// --------------------------------------------------------------------------
// Tool: explain_codebase
// --------------------------------------------------------------------------

const explainCodebaseTool: McpTool = {
  name: "explain_codebase",
  description:
    "Generate (or return a cached) AI-powered explanation of what a repository does, its architecture, and key files. Results are cached per commit SHA.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
    },
    required: ["owner", "repo"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    if (!owner || !repoName) invalidParams("owner and repo are required");

    const repo = await loadAndCheckRepo(owner, repoName, user);

    // Get latest commit SHA on default branch
    const commits = await listCommits(owner, repoName, repo.defaultBranch, 1);
    const commitSha = commits[0]?.sha ?? "HEAD";

    // Check cache first
    const cached = await getCachedExplanation(repo.id, commitSha);
    if (cached) {
      return {
        explanation: cached.markdown,
        summary: cached.summary,
        generatedAt: new Date().toISOString(),
        cached: true,
      };
    }

    // Generate fresh
    const result = await explainCodebase({
      owner,
      repo: repoName,
      repositoryId: repo.id,
      commitSha,
    });

    return {
      explanation: result.markdown,
      summary: result.summary,
      generatedAt: new Date().toISOString(),
      cached: result.cached,
    };
  },
};

// --------------------------------------------------------------------------
// Tool: get_branch_diff
// --------------------------------------------------------------------------

const getBranchDiffTool: McpTool = {
  name: "get_branch_diff",
  description:
    "Get the diff between two branches or refs, including per-file addition/deletion stats and the raw diff (truncated to 50 KB).",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      base: { type: "string", description: "Base branch or ref" },
      head: { type: "string", description: "Head branch or ref" },
    },
    required: ["owner", "repo", "base", "head"],
  },
  async handler(args, user) {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    const base = args.base as string;
    const head = args.head as string;
    if (!owner || !repoName || !base || !head) {
      invalidParams("owner, repo, base, and head are required");
    }

    const repo = await loadAndCheckRepo(owner, repoName, user);
    const repoDir = getRepoPath(owner, repoName);

    // Raw diff
    const diffProc = Bun.spawn(["git", "diff", `${base}...${head}`], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const rawDiffFull = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    // Numstat for per-file summary
    const statProc = Bun.spawn(
      ["git", "diff", "--numstat", `${base}...${head}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const numstatRaw = await new Response(statProc.stdout).text();
    await statProc.exited;

    const files = numstatRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [add, del, filePath] = line.split("\t");
        return {
          path: filePath ?? "",
          additions: add === "-" ? 0 : parseInt(add, 10) || 0,
          deletions: del === "-" ? 0 : parseInt(del, 10) || 0,
        };
      });

    const MAX_DIFF_BYTES = 50 * 1024; // 50 KB
    const rawDiff =
      rawDiffFull.length > MAX_DIFF_BYTES
        ? rawDiffFull.slice(0, MAX_DIFF_BYTES) + "\n... (diff truncated at 50 KB)"
        : rawDiffFull;

    return { files, rawDiff };
  },
};

// --------------------------------------------------------------------------
// Tool: trigger_ai_review
// --------------------------------------------------------------------------

const triggerAiReviewTool: McpTool = {
  name: "trigger_ai_review",
  description:
    "Trigger an AI code review for a pull request. The caller must be authenticated and must be the repository owner or the PR author.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner username" },
      repo: { type: "string", description: "Repository name" },
      prNumber: { type: "number", description: "Pull request number" },
    },
    required: ["owner", "repo", "prNumber"],
  },
  async handler(args, user) {
    if (!user) unauthorized("Triggering AI review requires authentication");

    const owner = args.owner as string;
    const repoName = args.repo as string;
    const prNumber = args.prNumber as number;
    if (!owner || !repoName || !prNumber) {
      invalidParams("owner, repo, and prNumber are required");
    }

    const repo = await loadAndCheckRepo(owner, repoName, user);

    // Load PR
    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repo.id),
          eq(pullRequests.number, prNumber)
        )
      )
      .limit(1);

    if (!pr) notFound(`Pull request #${prNumber} not found`);

    // Authorization: repo owner or PR author
    if (user.id !== repo.ownerId && user.id !== pr.authorId) {
      unauthorized("Only the repository owner or PR author can trigger an AI review");
    }

    // Fire-and-forget
    triggerAiReview(
      owner,
      repoName,
      pr.id,
      pr.title,
      pr.body ?? "",
      pr.baseBranch,
      pr.headBranch
    ).catch((err) => {
      console.error("[mcp] triggerAiReview error:", err);
    });

    return { queued: true, prId: pr.id };
  },
};

// --------------------------------------------------------------------------
// Tool registry
// --------------------------------------------------------------------------

export const MCP_TOOLS: McpTool[] = [
  listRepositoriesTool,
  getRepositoryTool,
  getFileContentsTool,
  listFilesTool,
  searchCodeTool,
  listCommitsTool,
  getGateStatusTool,
  listPullRequestsTool,
  listIssuesTool,
  createIssueTool,
  explainCodebaseTool,
  getBranchDiffTool,
  triggerAiReviewTool,
];

export const MCP_TOOL_MAP = new Map<string, McpTool>(
  MCP_TOOLS.map((t) => [t.name, t])
);

/**
 * Serialise a tool for the tools/list response.
 */
export function serializeTool(tool: McpTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

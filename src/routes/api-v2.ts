/**
 * Comprehensive REST API v2 — full CRUD for all resources.
 *
 * Authentication: Bearer token (API tokens) or session cookie.
 * Rate limited: 100 requests/minute per IP.
 * All responses are JSON.
 */

import { Hono } from "hono";
import { join } from "path";
import { eq, and, desc, asc, sql, like, or } from "drizzle-orm";
import { deflateRawSync } from "node:zlib";
import { db } from "../db";
import {
  users,
  repositories,
  issues,
  issueComments,
  pullRequests,
  prComments,
  stars,
  labels,
  issueLabels,
  activityFeed,
  webhooks,
  repoTopics,
  workflows,
  workflowRuns,
  workflowJobs,
} from "../db/schema";
import { enqueueRun } from "../lib/workflow-runner";
import {
  listBranches,
  getDefaultBranch,
  getDefaultBranchFresh,
  getTree,
  getTreeRecursive,
  getBlob,
  getCommit,
  listCommits,
  getDiff,
  searchCode,
  repoExists,
  initBareRepo,
  resolveRef,
  catBlobBytes,
  refExists,
  objectExists,
  updateRef,
  writeBlob,
  getBlobShaAtPath,
  getRepoPath,
  createOrUpdateFileOnBranch,
} from "../git/repository";
import { config } from "../lib/config";
import { apiAuth, requireApiAuth, requireScope } from "../middleware/api-auth";
import type { ApiAuthEnv } from "../middleware/api-auth";
import {
  agentAuth,
  enforceAgentBranchNamespace,
} from "../middleware/agent-auth";
import type { AgentAuthEnv } from "../middleware/agent-auth";
import { apiRateLimit, searchRateLimit } from "../middleware/rate-limit";
import { postCommitStatusHandler } from "./commit-statuses";
import { apiTokens } from "../db/schema";
import { audit } from "../lib/notify";
import {
  computeAiSavingsForUser,
  computeLifetimeAiSavingsForUser,
} from "../lib/ai-hours-saved";

const apiv2 = new Hono<ApiAuthEnv & AgentAuthEnv>().basePath("/api/v2");

// Apply auth and rate limiting to all v2 routes.
//
// Agent-multiplayer v1: `agentAuth` runs BEFORE `apiAuth` so that an
// `agt_` Bearer token is detected and stashed at `c.get("agent")`
// without consuming the token in apiAuth (which only recognises PAT
// + session). Non-agent tokens fall straight through. The
// branch-namespace guard runs on PATCH /git/refs/heads/* only.
apiv2.use("*", apiRateLimit);
apiv2.use("*", agentAuth);
apiv2.use("*", apiAuth);
apiv2.use(
  "/repos/:owner/:repo/git/refs/heads/:branch",
  enforceAgentBranchNamespace
);

// ─── Helper ─────────────────────────────────────────────────────────────────

async function resolveRepo(ownerName: string, repoName: string) {
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return null;

  const [repo] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName)))
    .limit(1);
  if (!repo) return null;

  return { owner, repo };
}

// ─── Auth (install-token) ───────────────────────────────────────────────────
//
// POST /api/v2/auth/install-token
//
// Mint a new personal access token from a one-command install script
// (`scripts/install.sh`). Session-cookie auth ONLY — Bearer tokens are
// explicitly rejected so existing PATs cannot escalate into a fan-out of new
// PATs. The plaintext token value is returned exactly once and never persisted.
//
// Audit-logged as `auth.install_token.created`.

function generateInstallToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    "glc_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function hashInstallToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

apiv2.post("/auth/install-token", async (c) => {
  // Reject Bearer-token callers outright. The whole point of this endpoint
  // is preventing token escalation, so we check the raw header rather than
  // relying on whatever the middleware decided.
  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return c.json(
      {
        error: "Session authentication required",
        hint: "This endpoint refuses Bearer tokens — sign in with a session cookie.",
      },
      401
    );
  }

  const user = c.get("user");
  const authMethod = c.get("authMethod");
  if (!user || authMethod !== "session") {
    return c.json(
      {
        error: "Session authentication required",
        hint: "Sign in via /login first; install-token mints PATs only over the session cookie.",
      },
      401
    );
  }

  let body: { name?: unknown; scope?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty / unparseable body is allowed — we fall back to defaults.
    body = {};
  }

  const shortStamp = Math.floor(Date.now() / 1000)
    .toString(36)
    .slice(-6);
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim().slice(0, 80)
      : `gluecron-install-${shortStamp}`;

  const requested = typeof body.scope === "string" ? body.scope : "admin";
  const scope = requested === "repo" ? "repo" : "admin";
  // Mirror existing PAT semantics: a comma-separated list. `admin` implies
  // everything; `repo` keeps it narrow.
  const scopes = scope === "admin" ? "admin,repo,user" : "repo";

  const token = generateInstallToken();
  const tokenHash = await hashInstallToken(token);
  const tokenPrefix = token.slice(0, 12);

  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: user.id,
      name,
      tokenHash,
      tokenPrefix,
      scopes,
    })
    .returning();

  await audit({
    userId: user.id,
    action: "auth.install_token.created",
    targetType: "api_token",
    targetId: row?.id,
    ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || undefined,
    userAgent: c.req.header("user-agent") || undefined,
    metadata: { name, scope, prefix: tokenPrefix },
  });

  return c.json(
    {
      token,
      id: row?.id,
      name,
      scope,
      scopes,
      expiresAt: row?.expiresAt ?? null,
    },
    201
  );
});

// ─── Users ──────────────────────────────────────────────────────────────────

apiv2.get("/user", requireApiAuth, (c) => {
  const user = c.get("user")!;
  return c.json({
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
  });
});

apiv2.get("/users/:username", async (c) => {
  const { username } = c.req.param();
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      bio: users.bio,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json(user);
});

/**
 * Block L9 — AI hours-saved counter, exposed for the dashboard widget,
 * VS Code extension, and CLI. Returns the same numbers the web UI shows.
 * No special scope — any authenticated token can read its own counter.
 */
apiv2.get("/me/ai-savings", requireApiAuth, async (c) => {
  const user = c.get("user")!;
  const [window, lifetime] = await Promise.all([
    computeAiSavingsForUser(user.id, { windowHours: 168 }),
    computeLifetimeAiSavingsForUser(user.id),
  ]);
  return c.json({
    window: {
      hours: window.windowHours,
      hoursSaved: window.hoursSaved,
      breakdown: window.breakdown,
    },
    lifetime: {
      hoursSaved: lifetime.hoursSaved,
      breakdown: lifetime.breakdown,
      sinceCreatedAt: lifetime.sinceCreatedAt.toISOString(),
    },
  });
});

apiv2.patch("/user", requireApiAuth, requireScope("user"), async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    displayName?: string;
    bio?: string;
    avatarUrl?: string;
  }>();

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.displayName !== undefined) updates.displayName = body.displayName;
  if (body.bio !== undefined) updates.bio = body.bio;
  if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;

  await db.update(users).set(updates).where(eq(users.id, user.id));
  return c.json({ ok: true });
});

// ─── Repositories ───────────────────────────────────────────────────────────

apiv2.get("/users/:username/repos", async (c) => {
  const { username } = c.req.param();
  const sort = c.req.query("sort") || "updated";
  const [owner] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!owner) return c.json({ error: "User not found" }, 404);

  const currentUser = c.get("user");
  const orderBy = sort === "stars" ? desc(repositories.starCount) :
                  sort === "name" ? asc(repositories.name) :
                  desc(repositories.updatedAt);

  let repoList = await db
    .select()
    .from(repositories)
    .where(eq(repositories.ownerId, owner.id))
    .orderBy(orderBy);

  // Only show private repos to owner
  if (!currentUser || currentUser.id !== owner.id) {
    repoList = repoList.filter((r: any) => !r.isPrivate);
  }

  return c.json(repoList);
});

apiv2.post("/repos", requireApiAuth, requireScope("repo"), async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    name: string;
    description?: string;
    isPrivate?: boolean;
  }>();

  if (!body.name || !/^[a-zA-Z0-9._-]+$/.test(body.name)) {
    return c.json({ error: "Invalid repository name" }, 400);
  }

  // P4 — plan-quota gate. 402 Payment Required is the canonical HTTP
  // signal that the client should branch on (e.g. show an upgrade CTA).
  const { checkRepoCreateAllowed } = await import("../lib/repo-create-gate");
  const gate = await checkRepoCreateAllowed(user.id);
  if (!gate.ok) {
    return c.json({ error: gate.reason, upgrade_url: gate.upgradeUrl }, 402);
  }

  if (await repoExists(user.username, body.name)) {
    return c.json({ error: "Repository already exists" }, 409);
  }

  const diskPath = await initBareRepo(user.username, body.name);
  const result = await db
    .insert(repositories)
    .values({
      name: body.name,
      ownerId: user.id,
      description: body.description || null,
      isPrivate: body.isPrivate || false,
      diskPath,
    })
    .returning();

  return c.json(result[0], 201);
});

apiv2.get("/repos/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();
  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const currentUser = c.get("user");
  if ((resolved.repo as any).isPrivate && (!currentUser || currentUser.id !== resolved.owner.id)) {
    return c.json({ error: "Not found" }, 404);
  }

  // Cache-free fresh read of HEAD's ref — needed by GateTest.
  const defaultBranch = await getDefaultBranchFresh(owner, repo);

  return c.json({
    ...(resolved.repo as any),
    defaultBranch,
    owner: {
      id: (resolved.owner as any).id,
      login: (resolved.owner as any).username,
    },
  });
});

apiv2.patch("/repos/:owner/:repo", requireApiAuth, requireScope("repo"), async (c) => {
  const { owner, repo } = c.req.param();
  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const user = c.get("user")!;
  if (user.id !== resolved.owner.id) {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{
    description?: string;
    isPrivate?: boolean;
    defaultBranch?: string;
  }>();

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.description !== undefined) updates.description = body.description;
  if (body.isPrivate !== undefined) updates.isPrivate = body.isPrivate;
  if (body.defaultBranch !== undefined) updates.defaultBranch = body.defaultBranch;

  await db.update(repositories).set(updates).where(eq(repositories.id, (resolved.repo as any).id));
  return c.json({ ok: true });
});

apiv2.delete("/repos/:owner/:repo", requireApiAuth, requireScope("admin"), async (c) => {
  const { owner, repo } = c.req.param();
  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const user = c.get("user")!;
  if (user.id !== resolved.owner.id) {
    return c.json({ error: "Permission denied" }, 403);
  }

  await db.delete(repositories).where(eq(repositories.id, (resolved.repo as any).id));
  return c.json({ ok: true });
});

// ─── Branches ───────────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/branches", async (c) => {
  const { owner, repo } = c.req.param();
  if (!(await repoExists(owner, repo))) {
    return c.json({ error: "Not found" }, 404);
  }

  const branches = await listBranches(owner, repo);
  const defaultBranch = await getDefaultBranch(owner, repo);

  return c.json(
    branches.map((name) => ({
      name,
      isDefault: name === defaultBranch,
    }))
  );
});

// ─── Commits ────────────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/commits", async (c) => {
  const { owner, repo } = c.req.param();
  const ref = c.req.query("ref") || c.req.query("sha") || "HEAD";
  const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  if (!(await repoExists(owner, repo))) {
    return c.json({ error: "Not found" }, 404);
  }

  const commits = await listCommits(owner, repo, ref, limit, offset);
  return c.json(commits);
});

apiv2.get("/repos/:owner/:repo/commits/:sha", async (c) => {
  const { owner, repo, sha } = c.req.param();
  if (!(await repoExists(owner, repo))) {
    return c.json({ error: "Not found" }, 404);
  }

  const commit = await getCommit(owner, repo, sha);
  if (!commit) return c.json({ error: "Commit not found" }, 404);

  const { files } = await getDiff(owner, repo, sha);
  return c.json({ ...commit, files });
});

// ─── Tree & Files ───────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/tree/:ref", async (c) => {
  const { owner, repo } = c.req.param();
  const ref = c.req.param("ref");
  const path = c.req.query("path") || "";
  const recursive = c.req.query("recursive");

  if (!(await repoExists(owner, repo))) {
    return c.json({ error: "Not found" }, 404);
  }

  if (recursive === "1" || recursive === "true") {
    const result = await getTreeRecursive(owner, repo, ref, 50_000);
    if (!result) return c.json({ error: "Ref not found" }, 404);
    return c.json(result);
  }

  const tree = await getTree(owner, repo, ref, path);
  return c.json(tree);
});

const CONTENTS_MAX_BYTES = 10 * 1024 * 1024;

apiv2.get("/repos/:owner/:repo/contents/:path{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const filePath = c.req.param("path");
  const ref = c.req.query("ref") || "HEAD";
  const encoding = c.req.query("encoding") || "utf8";

  if (!(await repoExists(owner, repo))) {
    return c.json({ error: "Not found" }, 404);
  }

  if (encoding === "base64") {
    const got = await catBlobBytes(owner, repo, ref, filePath);
    if (!got) return c.json({ error: "File not found" }, 404);
    if (got.size > CONTENTS_MAX_BYTES) {
      return c.json(
        { error: `File too large (${got.size} bytes, max ${CONTENTS_MAX_BYTES})` },
        413
      );
    }
    const content = Buffer.from(got.bytes).toString("base64");
    return c.json({
      path: filePath,
      size: got.size,
      sha: got.sha,
      encoding: "base64",
      content,
    });
  }

  const blob = await getBlob(owner, repo, ref, filePath);
  if (!blob) return c.json({ error: "File not found" }, 404);
  if (blob.size > CONTENTS_MAX_BYTES) {
    return c.json(
      { error: `File too large (${blob.size} bytes, max ${CONTENTS_MAX_BYTES})` },
      413
    );
  }

  return c.json({
    path: filePath,
    size: blob.size,
    isBinary: blob.isBinary,
    content: blob.isBinary ? null : blob.content,
    encoding: blob.isBinary ? null : "utf8",
  });
});

// ─── Semantic search ────────────────────────────────────────────────────────
//
// Continuous semantic index — see src/lib/semantic-index.ts. Every push
// embeds the changed files into pgvector. This endpoint ranks them by
// cosine similarity to the query.
//
// Public repos: anonymous read is allowed.
// Private repos: requireApiAuth + requireScope("repo") (plus the same
//                owner-only check the rest of /repos/:owner/:repo enforces).
//
// Returns `[]` (not 5xx) when pgvector is missing or the index is empty,
// so callers can treat absence as "no hits" rather than a hard error.

apiv2.get("/repos/:owner/:repo/semantic-search", async (c) => {
  const { owner, repo } = c.req.param();
  const q = (c.req.query("q") || "").trim();
  const limit = Math.max(1, Math.min(parseInt(c.req.query("limit") || "20"), 100));

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  // Private-repo gate: requireApiAuth + requireScope("repo") + owner match.
  // We can't compose Hono middleware conditionally per-request, so we
  // inline the same checks the apiv2 middleware would have applied.
  if ((resolved.repo as any).isPrivate) {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: "Authentication required", hint: "Use Authorization: Bearer <token> header" },
        401
      );
    }
    const scopes = (c.get("tokenScopes") as string[] | undefined) || [];
    // tokenScopes is [] for unauthenticated; ["repo","user","admin"] for
    // session-cookie auth (web UI); whatever scopes the PAT carries
    // otherwise. The "admin" wildcard skips the scope check.
    if (
      scopes.length > 0 &&
      !scopes.includes("repo") &&
      !scopes.includes("admin")
    ) {
      return c.json({ error: "Insufficient scope. Required: repo" }, 403);
    }
    if (user.id !== resolved.owner.id) {
      return c.json({ error: "Not found" }, 404);
    }
  }

  if (!q) return c.json([]);

  const { searchSemantic, semanticIndexProvider } = await import(
    "../lib/semantic-index"
  );
  const hits = await searchSemantic({
    repositoryId: (resolved.repo as any).id,
    query: q,
    limit,
  });

  // Shape matches the task spec: { file_path, snippet, score, blob_sha }.
  const payload = hits.map((h) => ({
    file_path: h.filePath,
    snippet: h.snippet,
    score: h.score,
    blob_sha: h.blobSha,
  }));

  // Surface the provider so clients can detect graceful-degrade mode.
  c.header("X-Gluecron-Semantic-Provider", semanticIndexProvider());
  return c.json(payload);
});

// ─── Issues ─────────────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/issues", async (c) => {
  const { owner, repo } = c.req.param();
  const state = c.req.query("state") || "open";
  const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const issueList = await db
    .select({
      issue: issues,
      author: { username: users.username, id: users.id },
    })
    .from(issues)
    .innerJoin(users, eq(issues.authorId, users.id))
    .where(and(eq(issues.repositoryId, (resolved.repo as any).id), eq(issues.state, state)))
    .orderBy(desc(issues.createdAt))
    .limit(limit);

  return c.json(issueList.map(({ issue, author }) => ({ ...issue, author })));
});

apiv2.post("/repos/:owner/:repo/issues", requireApiAuth, requireScope("repo"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const body = await c.req.json<{ title: string; body?: string }>();

  if (!body.title?.trim()) {
    return c.json({ error: "Title is required" }, 400);
  }

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const result = await db
    .insert(issues)
    .values({
      repositoryId: (resolved.repo as any).id,
      authorId: user.id,
      title: body.title.trim(),
      body: body.body?.trim() || null,
    })
    .returning();

  return c.json(result[0], 201);
});

apiv2.get("/repos/:owner/:repo/issues/:number", async (c) => {
  const { owner, repo } = c.req.param();
  const num = parseInt(c.req.param("number"), 10);

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.repositoryId, (resolved.repo as any).id), eq(issues.number, num)))
    .limit(1);

  if (!issue) return c.json({ error: "Issue not found" }, 404);

  const comments = await db
    .select({
      comment: issueComments,
      author: { username: users.username },
    })
    .from(issueComments)
    .innerJoin(users, eq(issueComments.authorId, users.id))
    .where(eq(issueComments.issueId, issue.id))
    .orderBy(asc(issueComments.createdAt));

  return c.json({
    ...issue,
    comments: comments.map(({ comment, author }) => ({ ...comment, author })),
  });
});

apiv2.patch("/repos/:owner/:repo/issues/:number", requireApiAuth, requireScope("repo"), async (c) => {
  const { owner, repo } = c.req.param();
  const num = parseInt(c.req.param("number"), 10);
  const body = await c.req.json<{ title?: string; body?: string; state?: "open" | "closed" }>();

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.body !== undefined) updates.body = body.body;
  if (body.state === "closed") {
    updates.state = "closed";
    updates.closedAt = new Date();
  } else if (body.state === "open") {
    updates.state = "open";
    updates.closedAt = null;
  }

  await db
    .update(issues)
    .set(updates)
    .where(and(eq(issues.repositoryId, (resolved.repo as any).id), eq(issues.number, num)));

  return c.json({ ok: true });
});

apiv2.post("/repos/:owner/:repo/issues/:number/comments", requireApiAuth, requireScope("repo"), async (c) => {
  const { owner, repo } = c.req.param();
  const num = parseInt(c.req.param("number"), 10);
  const user = c.get("user")!;
  const body = await c.req.json<{ body: string }>();

  if (!body.body?.trim()) {
    return c.json({ error: "Comment body is required" }, 400);
  }

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.repositoryId, (resolved.repo as any).id), eq(issues.number, num)))
    .limit(1);

  if (!issue) return c.json({ error: "Issue not found" }, 404);

  const result = await db
    .insert(issueComments)
    .values({
      issueId: issue.id,
      authorId: user.id,
      body: body.body.trim(),
    })
    .returning();

  return c.json(result[0], 201);
});

// ─── Pull Requests ──────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/pulls", async (c) => {
  const { owner, repo } = c.req.param();
  const state = c.req.query("state") || "open";
  // Match the issue-list pagination contract: default 30, max 100,
  // 0-indexed offset for cursor-style scrolling. Bounded so a buggy
  // client can't accidentally pull the whole table.
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const prList = await db
    .select({
      pr: pullRequests,
      author: { username: users.username },
    })
    .from(pullRequests)
    .innerJoin(users, eq(pullRequests.authorId, users.id))
    .where(and(eq(pullRequests.repositoryId, (resolved.repo as any).id), eq(pullRequests.state, state)))
    .orderBy(desc(pullRequests.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(prList.map(({ pr, author }) => ({ ...pr, author })));
});

apiv2.post("/repos/:owner/:repo/pulls", requireApiAuth, requireScope("repo"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const body = await c.req.json<{
    title: string;
    body?: string;
    baseBranch: string;
    headBranch: string;
  }>();

  if (!body.title?.trim() || !body.baseBranch || !body.headBranch) {
    return c.json({ error: "title, baseBranch, and headBranch are required" }, 400);
  }

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const result = await db
    .insert(pullRequests)
    .values({
      repositoryId: (resolved.repo as any).id,
      authorId: user.id,
      title: body.title.trim(),
      body: body.body?.trim() || null,
      baseBranch: body.baseBranch,
      headBranch: body.headBranch,
    })
    .returning();

  return c.json(result[0], 201);
});

apiv2.get("/repos/:owner/:repo/pulls/:number", async (c) => {
  const { owner, repo } = c.req.param();
  const num = parseInt(c.req.param("number"), 10);

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repositoryId, (resolved.repo as any).id), eq(pullRequests.number, num)))
    .limit(1);

  if (!pr) return c.json({ error: "PR not found" }, 404);

  const comments = await db
    .select({
      comment: prComments,
      author: { username: users.username },
    })
    .from(prComments)
    .innerJoin(users, eq(prComments.authorId, users.id))
    .where(eq(prComments.pullRequestId, pr.id))
    .orderBy(asc(prComments.createdAt));

  return c.json({
    ...pr,
    comments: comments.map(({ comment, author }) => ({ ...comment, author })),
  });
});

// ─── PR Comments (GateTest integration) ────────────────────────────────────

apiv2.post(
  "/repos/:owner/:repo/pulls/:number/comments",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const num = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;

    let body: { body?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    if (!body.body?.trim()) {
      return c.json({ error: "Comment body is required" }, 400);
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (user.id !== (resolved.owner as any).id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, (resolved.repo as any).id),
          eq(pullRequests.number, num)
        )
      )
      .limit(1);
    if (!pr) return c.json({ error: "PR not found" }, 404);

    const [comment] = await db
      .insert(prComments)
      .values({
        pullRequestId: pr.id,
        authorId: user.id,
        body: body.body.trim(),
      })
      .returning();

    return c.json({ ok: true, comment }, 201);
  }
);

// ─── Git refs — create branch / tag from sha ────────────────────────────────

apiv2.post(
  "/repos/:owner/:repo/git/refs",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    let body: { ref?: string; sha?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const ref = body.ref?.trim();
    const sha = body.sha?.trim();

    if (!ref || !/^refs\/(heads|tags)\/.+/.test(ref)) {
      return c.json({ error: "ref must be of the form refs/heads/... or refs/tags/..." }, 400);
    }
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
      return c.json({ error: "sha must be a 40-char lowercase hex string" }, 400);
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (user.id !== (resolved.owner as any).id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Verify sha reachable.
    if (!(await objectExists(owner, repo, sha))) {
      return c.json({ error: "sha not found in repository" }, 400);
    }

    // Conflict check: if ref already exists, the existing sha must match.
    if (await refExists(owner, repo, ref)) {
      const existing = await resolveRef(owner, repo, ref);
      if (existing !== sha) {
        return c.json({ error: "ref already exists", existing }, 409);
      }
    }

    const ok = await updateRef(owner, repo, ref, sha);
    if (!ok) return c.json({ error: "Failed to create ref" }, 500);

    return c.json({ ok: true, ref, sha }, 201);
  }
);

// ─── Contents PUT — create/update a file via git plumbing ────────────────────

apiv2.put(
  "/repos/:owner/:repo/contents/:path{.+$}",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const filePath = c.req.param("path");
    const user = c.get("user")!;

    let body: {
      message?: string;
      content?: string;
      branch?: string;
      sha?: string | null;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const message = body.message?.trim();
    const branch = body.branch?.trim();
    const base64 = body.content;

    if (!message) return c.json({ error: "message is required" }, 400);
    if (!branch) return c.json({ error: "branch is required" }, 400);
    if (typeof base64 !== "string") return c.json({ error: "content (base64) is required" }, 400);

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(base64, "base64"));
    } catch {
      return c.json({ error: "content is not valid base64" }, 400);
    }
    if (bytes.length > CONTENTS_MAX_BYTES) {
      return c.json({ error: "File too large" }, 413);
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (user.id !== (resolved.owner as any).id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const result = await createOrUpdateFileOnBranch({
      owner,
      name: repo,
      branch,
      filePath,
      bytes,
      message,
      authorName: (user as any).displayName || user.username,
      authorEmail: user.email,
      expectBlobSha: body.sha ?? null,
    });

    if ("error" in result) {
      if (result.error === "sha-mismatch") {
        return c.json({ error: "sha does not match current blob at path" }, 409);
      }
      return c.json({ error: "Failed to write file" }, 500);
    }

    return c.json(
      {
        ok: true,
        commit: { sha: result.commitSha, message },
        content: { path: filePath, sha: result.blobSha },
      },
      201
    );
  }
);

// ─── Helper: shell out to git in a bare repo ─────────────────────────────────
//
// Mirrors the pattern in src/git/repository.ts. Kept inline here so the
// plumbing endpoints below don't have to leak through the helper module.

async function runGit(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string>; stdin?: Uint8Array }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: opts.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function htmlUrlForCommit(owner: string, repo: string, sha: string): string {
  return `${config.appBaseUrl}/${owner}/${repo}/commit/${sha}`;
}

// ─── Contents DELETE — remove a file via git plumbing ────────────────────────
//
// Body: { message, sha, branch? }
// - `sha` is the current blob sha at `:path`; mismatch → 409 (optimistic
//   concurrency, matches GitHub's `DELETE /repos/.../contents/...` semantics).
// - `branch` defaults to the repo's default branch.

apiv2.delete(
  "/repos/:owner/:repo/contents/:path{.+$}",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const filePath = c.req.param("path");
    const user = c.get("user")!;

    let body: { message?: string; sha?: string; branch?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const message = body.message?.trim();
    const expectSha = body.sha?.trim();
    if (!message) return c.json({ error: "message is required" }, 400);
    if (!expectSha || !/^[0-9a-f]{40}$/.test(expectSha)) {
      return c.json({ error: "sha is required (40-hex)" }, 400);
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (user.id !== (resolved.owner as any).id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const branch =
      body.branch?.trim() ||
      (await getDefaultBranchFresh(owner, repo)) ||
      "main";
    const fullRef = `refs/heads/${branch}`;
    const repoDir = getRepoPath(owner, repo);

    // Resolve current parent + existing blob sha at that path.
    const parentSha = await resolveRef(owner, repo, fullRef);
    if (!parentSha) return c.json({ error: "Branch not found" }, 404);

    const existingBlobSha = await getBlobShaAtPath(owner, repo, branch, filePath);
    if (!existingBlobSha) return c.json({ error: "File not found" }, 404);
    if (existingBlobSha !== expectSha) {
      return c.json({ error: "sha does not match current blob at path" }, 409);
    }

    const tmpIndex = join(
      repoDir,
      `index.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
    );
    // `update-index --remove` checks `is_inside_work_tree()`, so a bare
    // repo needs a transient stand-in. Empty directory is sufficient —
    // git only consults it for safety checks, never writes blobs through it.
    const tmpWorkTree = join(
      repoDir,
      `worktree.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
    );
    const { mkdir } = await import("fs/promises");
    await mkdir(tmpWorkTree, { recursive: true });

    const authorName = (user as any).displayName || user.username;
    const authorEmail = user.email;
    const env = {
      GIT_INDEX_FILE: tmpIndex,
      GIT_DIR: repoDir,
      GIT_WORK_TREE: tmpWorkTree,
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    };

    const cleanup = async () => {
      try {
        const { unlink, rm } = await import("fs/promises");
        await unlink(tmpIndex).catch(() => {});
        await rm(tmpWorkTree, { recursive: true, force: true }).catch(() => {});
      } catch {
        /* ignore */
      }
    };

    try {
      const rt = await runGit(["git", "read-tree", parentSha], {
        cwd: repoDir,
        env,
      });
      if (rt.exitCode !== 0) {
        await cleanup();
        return c.json({ error: "Failed to read base tree" }, 500);
      }

      const ui = await runGit(
        ["git", "update-index", "--remove", filePath],
        { cwd: repoDir, env }
      );
      if (ui.exitCode !== 0) {
        await cleanup();
        return c.json({ error: "Failed to remove path from index" }, 500);
      }

      const wt = await runGit(["git", "write-tree"], { cwd: repoDir, env });
      const newTreeSha = wt.stdout.trim();
      if (wt.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(newTreeSha)) {
        await cleanup();
        return c.json({ error: "Failed to write tree" }, 500);
      }

      const ct = await runGit(
        ["git", "commit-tree", newTreeSha, "-p", parentSha, "-m", message],
        { cwd: repoDir, env }
      );
      const commitSha = ct.stdout.trim();
      if (ct.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commitSha)) {
        await cleanup();
        return c.json({ error: "Failed to create commit" }, 500);
      }

      const ok = await updateRef(owner, repo, fullRef, commitSha, parentSha);
      if (!ok) {
        await cleanup();
        return c.json({ error: "Failed to update ref" }, 500);
      }

      await cleanup();
      return c.json({
        commit: {
          sha: commitSha,
          message,
          html_url: htmlUrlForCommit(owner, repo, commitSha),
          author: { name: authorName, email: authorEmail },
        },
      });
    } catch {
      await cleanup();
      return c.json({ error: "Failed to delete file" }, 500);
    }
  }
);

// ─── Git plumbing: refs / commits / blobs / trees ────────────────────────────

// GET /repos/:owner/:repo/git/refs/heads/:branch
apiv2.get(
  "/repos/:owner/:repo/git/refs/heads/:branch{.+$}",
  async (c) => {
    const { owner, repo } = c.req.param();
    const branch = c.req.param("branch");
    if (!(await repoExists(owner, repo))) {
      return c.json({ error: "Not found" }, 404);
    }
    const fullRef = `refs/heads/${branch}`;
    const sha = await resolveRef(owner, repo, fullRef);
    if (!sha) return c.json({ error: "Reference not found" }, 404);
    return c.json({
      ref: fullRef,
      object: { sha, type: "commit" },
    });
  }
);

// GET /repos/:owner/:repo/git/commits/:sha
apiv2.get("/repos/:owner/:repo/git/commits/:sha", async (c) => {
  const { owner, repo, sha } = c.req.param();
  if (!(await repoExists(owner, repo))) {
    return c.json({ error: "Not found" }, 404);
  }
  const commit = await getCommit(owner, repo, sha);
  if (!commit) return c.json({ error: "Commit not found" }, 404);

  // Resolve tree sha for the commit (cat-file <sha>^{tree}).
  const repoDir = getRepoPath(owner, repo);
  const { stdout: treeOut } = await runGit(
    ["git", "rev-parse", `${commit.sha}^{tree}`],
    { cwd: repoDir }
  );
  const treeSha = treeOut.trim();

  return c.json({
    sha: commit.sha,
    tree: { sha: treeSha },
    parents: commit.parentShas.map((p) => ({ sha: p })),
    message: commit.message,
    author: {
      name: commit.author,
      email: commit.authorEmail,
      date: commit.date,
    },
  });
});

// POST /repos/:owner/:repo/git/blobs
apiv2.post(
  "/repos/:owner/:repo/git/blobs",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    let body: { content?: string; encoding?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const content = body.content;
    const encoding = (body.encoding || "utf-8").toLowerCase();
    if (typeof content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }
    if (encoding !== "utf-8" && encoding !== "utf8" && encoding !== "base64") {
      return c.json({ error: "encoding must be 'utf-8' or 'base64'" }, 400);
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (user.id !== (resolved.owner as any).id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    let bytes: Uint8Array;
    try {
      if (encoding === "base64") {
        bytes = new Uint8Array(Buffer.from(content, "base64"));
      } else {
        bytes = new TextEncoder().encode(content);
      }
    } catch {
      return c.json({ error: "Failed to decode content" }, 400);
    }

    const sha = await writeBlob(owner, repo, bytes);
    if (!sha) return c.json({ error: "Failed to write blob" }, 500);

    return c.json(
      {
        sha,
        url: `${config.appBaseUrl}/api/v2/repos/${owner}/${repo}/git/blobs/${sha}`,
        size: bytes.length,
      },
      201
    );
  }
);

// POST /repos/:owner/:repo/git/trees
//
// Body: { base_tree?: <tree_sha>, tree: [{ path, mode, type: "blob", sha: <blob_sha> | null }] }
// `sha: null` removes the entry from base_tree.
apiv2.post(
  "/repos/:owner/:repo/git/trees",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    let body: {
      base_tree?: string;
      tree?: Array<{
        path?: string;
        mode?: string;
        type?: string;
        sha?: string | null;
      }>;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    if (!Array.isArray(body.tree)) {
      return c.json({ error: "tree array is required" }, 400);
    }
    for (const entry of body.tree) {
      if (!entry.path || typeof entry.path !== "string") {
        return c.json({ error: "each tree entry needs a path" }, 400);
      }
      if (!entry.mode || typeof entry.mode !== "string") {
        return c.json({ error: "each tree entry needs a mode" }, 400);
      }
      if (entry.sha !== null && typeof entry.sha !== "string") {
        return c.json(
          { error: "each tree entry needs sha (40-hex) or null to delete" },
          400
        );
      }
      if (typeof entry.sha === "string" && !/^[0-9a-f]{40}$/.test(entry.sha)) {
        return c.json({ error: "sha must be 40-hex" }, 400);
      }
    }
    if (body.base_tree && !/^[0-9a-f]{40}$/.test(body.base_tree)) {
      return c.json({ error: "base_tree must be 40-hex" }, 400);
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (user.id !== (resolved.owner as any).id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const repoDir = getRepoPath(owner, repo);
    const tmpIndex = join(
      repoDir,
      `index.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
    );
    const env = { GIT_INDEX_FILE: tmpIndex };

    const cleanup = async () => {
      try {
        const { unlink } = await import("fs/promises");
        await unlink(tmpIndex);
      } catch {
        /* ignore */
      }
    };

    try {
      if (body.base_tree) {
        const rt = await runGit(["git", "read-tree", body.base_tree], {
          cwd: repoDir,
          env,
        });
        if (rt.exitCode !== 0) {
          await cleanup();
          return c.json({ error: "base_tree not found" }, 404);
        }
      }

      for (const entry of body.tree) {
        if (entry.sha === null) {
          const r = await runGit(
            ["git", "update-index", "--remove", entry.path!],
            { cwd: repoDir, env }
          );
          if (r.exitCode !== 0) {
            await cleanup();
            return c.json(
              { error: `Failed to remove ${entry.path}` },
              422
            );
          }
        } else {
          const r = await runGit(
            [
              "git",
              "update-index",
              "--add",
              "--cacheinfo",
              `${entry.mode},${entry.sha},${entry.path}`,
            ],
            { cwd: repoDir, env }
          );
          if (r.exitCode !== 0) {
            await cleanup();
            return c.json(
              { error: `Failed to add ${entry.path}` },
              422
            );
          }
        }
      }

      const wt = await runGit(["git", "write-tree"], { cwd: repoDir, env });
      const treeSha = wt.stdout.trim();
      if (wt.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(treeSha)) {
        await cleanup();
        return c.json({ error: "Failed to write tree" }, 500);
      }

      // List entries in the new tree (one level deep, matching GitHub's
      // POST /git/trees response shape).
      const ls = await runGit(["git", "ls-tree", treeSha], { cwd: repoDir });
      const entries: Array<{
        path: string;
        mode: string;
        type: string;
        sha: string;
      }> = [];
      for (const line of ls.stdout.split("\n").filter(Boolean)) {
        const m = line.match(
          /^(\d+)\s+(blob|tree|commit)\s+([0-9a-f]+)\t(.+)$/
        );
        if (m) {
          entries.push({
            mode: m[1],
            type: m[2],
            sha: m[3],
            path: m[4],
          });
        }
      }

      await cleanup();
      return c.json(
        {
          sha: treeSha,
          url: `${config.appBaseUrl}/api/v2/repos/${owner}/${repo}/git/trees/${treeSha}`,
          tree: entries,
        },
        201
      );
    } catch {
      await cleanup();
      return c.json({ error: "Failed to write tree" }, 500);
    }
  }
);

// POST /repos/:owner/:repo/git/commits
//
// Body: { message, tree, parents: [<sha>] }
apiv2.post(
  "/repos/:owner/:repo/git/commits",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    let body: { message?: string; tree?: string; parents?: string[] } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const message = body.message?.trim();
    const tree = body.tree?.trim();
    const parents = Array.isArray(body.parents) ? body.parents : [];

    if (!message) return c.json({ error: "message is required" }, 400);
    if (!tree || !/^[0-9a-f]{40}$/.test(tree)) {
      return c.json({ error: "tree must be 40-hex" }, 400);
    }
    for (const p of parents) {
      if (typeof p !== "string" || !/^[0-9a-f]{40}$/.test(p)) {
        return c.json({ error: "each parent must be 40-hex" }, 400);
      }
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (user.id !== (resolved.owner as any).id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Verify tree object exists.
    if (!(await objectExists(owner, repo, tree))) {
      return c.json({ error: "tree not found in repository" }, 422);
    }
    for (const p of parents) {
      if (!(await objectExists(owner, repo, p))) {
        return c.json({ error: `parent ${p} not found in repository` }, 422);
      }
    }

    const repoDir = getRepoPath(owner, repo);
    const authorName = (user as any).displayName || user.username;
    const authorEmail = user.email;
    const env = {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    };

    const args = ["git", "commit-tree", tree];
    for (const p of parents) {
      args.push("-p", p);
    }
    args.push("-m", message);

    const ct = await runGit(args, { cwd: repoDir, env });
    const commitSha = ct.stdout.trim();
    if (ct.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commitSha)) {
      return c.json({ error: "Failed to create commit" }, 500);
    }

    // Re-read the new commit's recorded date so the response carries the
    // exact ISO timestamp git wrote into the object.
    const recorded = await getCommit(owner, repo, commitSha);
    const date = recorded?.date ?? new Date().toISOString();

    return c.json(
      {
        sha: commitSha,
        tree: { sha: tree },
        message,
        parents: parents.map((p) => ({ sha: p })),
        author: { name: authorName, email: authorEmail, date },
        html_url: htmlUrlForCommit(owner, repo, commitSha),
      },
      201
    );
  }
);

// PATCH /repos/:owner/:repo/git/refs/heads/:branch
//
// Body: { sha: <new_commit>, force?: false }
apiv2.patch(
  "/repos/:owner/:repo/git/refs/heads/:branch{.+$}",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const branch = c.req.param("branch");
    const user = c.get("user")!;

    let body: { sha?: string; force?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const newSha = body.sha?.trim();
    const force = body.force === true;
    if (!newSha || !/^[0-9a-f]{40}$/.test(newSha)) {
      return c.json({ error: "sha must be 40-hex" }, 400);
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not found" }, 404);
    if (user.id !== (resolved.owner as any).id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const fullRef = `refs/heads/${branch}`;
    const currentSha = await resolveRef(owner, repo, fullRef);
    if (!currentSha) return c.json({ error: "Reference not found" }, 404);

    if (!(await objectExists(owner, repo, newSha))) {
      return c.json({ error: "sha not found in repository" }, 422);
    }

    if (!force) {
      // Fast-forward check: currentSha must be an ancestor of newSha.
      const repoDir = getRepoPath(owner, repo);
      const ff = await runGit(
        ["git", "merge-base", "--is-ancestor", currentSha, newSha],
        { cwd: repoDir }
      );
      if (ff.exitCode !== 0) {
        return c.json(
          { error: "Update is not a fast-forward" },
          422
        );
      }
    }

    const ok = force
      ? await updateRef(owner, repo, fullRef, newSha)
      : await updateRef(owner, repo, fullRef, newSha, currentSha);
    if (!ok) return c.json({ error: "Failed to update ref" }, 500);

    return c.json({
      ref: fullRef,
      object: { sha: newSha, type: "commit" },
    });
  }
);

// ─── v2 alias for commit-status POST ─────────────────────────────────────────
// Reuses the handler from src/routes/commit-statuses.ts (v1 mount).
apiv2.post(
  "/repos/:owner/:repo/statuses/:sha",
  requireApiAuth,
  requireScope("repo"),
  postCommitStatusHandler
);

// ─── Stars ──────────────────────────────────────────────────────────────────

apiv2.put("/repos/:owner/:repo/star", requireApiAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const repoId = (resolved.repo as any).id;
  const [existing] = await db
    .select()
    .from(stars)
    .where(and(eq(stars.userId, user.id), eq(stars.repositoryId, repoId)))
    .limit(1);

  if (!existing) {
    await db.insert(stars).values({ userId: user.id, repositoryId: repoId });
    await db
      .update(repositories)
      .set({ starCount: sql`${repositories.starCount} + 1` })
      .where(eq(repositories.id, repoId));
  }

  return c.json({ starred: true });
});

apiv2.delete("/repos/:owner/:repo/star", requireApiAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const repoId = (resolved.repo as any).id;
  const [existing] = await db
    .select()
    .from(stars)
    .where(and(eq(stars.userId, user.id), eq(stars.repositoryId, repoId)))
    .limit(1);

  if (existing) {
    await db.delete(stars).where(eq(stars.id, existing.id));
    await db
      .update(repositories)
      .set({ starCount: sql`GREATEST(${repositories.starCount} - 1, 0)` })
      .where(eq(repositories.id, repoId));
  }

  return c.json({ starred: false });
});

// ─── Labels ─────────────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/labels", async (c) => {
  const { owner, repo } = c.req.param();
  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const labelList = await db
    .select()
    .from(labels)
    .where(eq(labels.repositoryId, (resolved.repo as any).id))
    .orderBy(asc(labels.name));

  return c.json(labelList);
});

apiv2.post("/repos/:owner/:repo/labels", requireApiAuth, requireScope("repo"), async (c) => {
  const { owner, repo } = c.req.param();
  const body = await c.req.json<{ name: string; color?: string; description?: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Label name is required" }, 400);
  }

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const result = await db
    .insert(labels)
    .values({
      repositoryId: (resolved.repo as any).id,
      name: body.name.trim(),
      color: body.color || "#8b949e",
      description: body.description || null,
    })
    .returning();

  return c.json(result[0], 201);
});

// ─── Search ─────────────────────────────────────────────────────────────────

apiv2.get("/search/repos", searchRateLimit, async (c) => {
  const q = c.req.query("q") || "";
  const sort = c.req.query("sort") || "stars";
  const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);

  if (!q.trim()) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  const orderBy = sort === "updated" ? desc(repositories.updatedAt) :
                  sort === "name" ? asc(repositories.name) :
                  desc(repositories.starCount);

  const results = await db
    .select({
      repo: repositories,
      owner: { username: users.username },
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(
      and(
        eq(repositories.isPrivate, false),
        or(
          like(repositories.name, `%${q}%`),
          like(repositories.description, `%${q}%`)
        )
      )
    )
    .orderBy(orderBy)
    .limit(limit);

  return c.json(results.map(({ repo, owner }) => ({ ...repo, owner })));
});

apiv2.get("/repos/:owner/:repo/search/code", searchRateLimit, async (c) => {
  const { owner, repo } = c.req.param();
  const q = c.req.query("q") || "";

  if (!q.trim()) return c.json({ error: "Query parameter 'q' is required" }, 400);
  if (!(await repoExists(owner, repo))) return c.json({ error: "Not found" }, 404);

  const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
  const results = await searchCode(owner, repo, defaultBranch, q.trim());
  return c.json(results);
});

// ─── Activity Feed ──────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/activity", async (c) => {
  const { owner, repo } = c.req.param();
  const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const activity = await db
    .select()
    .from(activityFeed)
    .where(eq(activityFeed.repositoryId, (resolved.repo as any).id))
    .orderBy(desc(activityFeed.createdAt))
    .limit(limit);

  return c.json(activity);
});

// ─── Topics ─────────────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/topics", async (c) => {
  const { owner, repo } = c.req.param();
  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);

  const topicsList = await db
    .select()
    .from(repoTopics)
    .where(eq(repoTopics.repositoryId, (resolved.repo as any).id));

  return c.json(topicsList.map((t: any) => t.topic));
});

apiv2.put("/repos/:owner/:repo/topics", requireApiAuth, requireScope("repo"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const body = await c.req.json<{ topics: string[] }>();

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);
  if (user.id !== resolved.owner.id) return c.json({ error: "Permission denied" }, 403);

  const repoId = (resolved.repo as any).id;

  // Clear existing topics and insert new ones
  await db.delete(repoTopics).where(eq(repoTopics.repositoryId, repoId));
  if (body.topics && body.topics.length > 0) {
    await db.insert(repoTopics).values(
      body.topics.slice(0, 20).map((topic: string) => ({
        repositoryId: repoId,
        topic: topic.toLowerCase().trim(),
      }))
    );
  }

  return c.json({ ok: true });
});

// ─── Webhooks ───────────────────────────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/webhooks", requireApiAuth, requireScope("repo"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);
  if (user.id !== resolved.owner.id) return c.json({ error: "Permission denied" }, 403);

  const hookList = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.repositoryId, (resolved.repo as any).id));

  return c.json(hookList);
});

apiv2.post("/repos/:owner/:repo/webhooks", requireApiAuth, requireScope("admin"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const body = await c.req.json<{
    url: string;
    secret?: string;
    events?: string;
  }>();

  if (!body.url) return c.json({ error: "URL is required" }, 400);

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not found" }, 404);
  if (user.id !== resolved.owner.id) return c.json({ error: "Permission denied" }, 403);

  const result = await db
    .insert(webhooks)
    .values({
      repositoryId: (resolved.repo as any).id,
      url: body.url,
      secret: body.secret || null,
      events: body.events || "push",
    })
    .returning();

  return c.json(result[0], 201);
});

// ─── Actions / Workflows ────────────────────────────────────────────────────
//
// GitHub-Actions-compatible REST surface (subset).
//
//   POST /repos/:owner/:repo/actions/workflows/:filename/dispatches
//   GET  /repos/:owner/:repo/actions/workflows/:filename/runs
//   GET  /repos/:owner/:repo/actions/runs/:run_id
//   GET  /repos/:owner/:repo/actions/runs/:run_id/logs            (.zip)
//   POST /repos/:owner/:repo/actions/runs/:run_id/cancel
//
// Shapes follow GitHub REST v3 — snake_case fields, HTML URLs back to the
// gluecron run page, identical status-code semantics (204 for dispatch, 202
// for cancel, 409 for already-terminal, 422 for bad inputs).

type ParsedOn =
  | string
  | string[]
  | Record<string, unknown>
  | null
  | undefined;

type DispatchInputSpec = {
  type?: string;
  required?: boolean;
  default?: unknown;
  options?: unknown[];
  description?: string;
};

/**
 * Pull the workflow_dispatch slice out of whatever shape `parsed.on` happens
 * to be. The v1 parser normalises `on` to a `string[]`, but the extended
 * parser may store an object — and YAML in the wild can be either form. We
 * accept all three: scalar string, array of event names, mapping keyed by
 * event name.
 */
function extractDispatchSpec(rawOn: ParsedOn): {
  enabled: boolean;
  inputs: Record<string, DispatchInputSpec> | null;
} {
  if (rawOn == null) return { enabled: false, inputs: null };
  if (typeof rawOn === "string") {
    return { enabled: rawOn === "workflow_dispatch", inputs: null };
  }
  if (Array.isArray(rawOn)) {
    return { enabled: rawOn.includes("workflow_dispatch"), inputs: null };
  }
  if (typeof rawOn === "object") {
    const slot = (rawOn as Record<string, unknown>)["workflow_dispatch"];
    if (slot === undefined) return { enabled: false, inputs: null };
    // `workflow_dispatch:` with no children is a valid trigger declaration.
    if (slot == null || typeof slot !== "object") {
      return { enabled: true, inputs: null };
    }
    const inputs = (slot as Record<string, unknown>).inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      return { enabled: true, inputs: null };
    }
    return {
      enabled: true,
      inputs: inputs as Record<string, DispatchInputSpec>,
    };
  }
  return { enabled: false, inputs: null };
}

function validateDispatchInputs(
  schema: Record<string, DispatchInputSpec> | null,
  provided: Record<string, unknown> | undefined
): { ok: true } | { ok: false; details: string[] } {
  if (!schema) return { ok: true };
  const details: string[] = [];
  const supplied = provided ?? {};
  for (const [name, spec] of Object.entries(schema)) {
    if (!spec || typeof spec !== "object") continue;
    const present =
      Object.prototype.hasOwnProperty.call(supplied, name) &&
      supplied[name] !== undefined &&
      supplied[name] !== null;
    if (spec.required && !present) {
      // No default → required input is missing.
      if (spec.default === undefined) {
        details.push(`Missing required input: ${name}`);
      }
    }
  }
  if (details.length) return { ok: false, details };
  return { ok: true };
}

/**
 * Look up a workflow row by repository + the basename of its `path` column.
 * Stored path is `.gluecron/workflows/<filename>`; we match the trailing
 * segment so callers don't need to know our on-disk layout.
 */
async function findWorkflowByFilename(
  repositoryId: string,
  filename: string
): Promise<typeof workflows.$inferSelect | null> {
  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.repositoryId, repositoryId));
  for (const row of rows) {
    const idx = row.path.lastIndexOf("/");
    const base = idx >= 0 ? row.path.slice(idx + 1) : row.path;
    if (base === filename) return row;
  }
  return null;
}

function runHtmlUrl(owner: string, repo: string, runId: string): string {
  return `https://gluecron.com/${owner}/${repo}/actions/runs/${runId}`;
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function serializeRun(
  run: typeof workflowRuns.$inferSelect,
  workflowName: string,
  owner: string,
  repo: string
): Record<string, unknown> {
  // GitHub returns `head_branch` as the short branch name (no refs/heads/).
  let head_branch: string | null = null;
  if (run.ref) {
    head_branch = run.ref.startsWith("refs/heads/")
      ? run.ref.slice("refs/heads/".length)
      : run.ref;
  }
  return {
    id: run.id,
    name: workflowName,
    head_branch,
    head_sha: run.commitSha,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    created_at: toIso(run.queuedAt),
    updated_at:
      toIso(run.finishedAt) ?? toIso(run.startedAt) ?? toIso(run.queuedAt),
    run_started_at: toIso(run.startedAt),
    html_url: runHtmlUrl(owner, repo, run.id),
  };
}

// ─── 1. POST /actions/workflows/:filename/dispatches ────────────────────────

apiv2.post(
  "/repos/:owner/:repo/actions/workflows/:filename/dispatches",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo, filename } = c.req.param();
    const user = c.get("user")!;

    let body: { ref?: unknown; inputs?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not Found" }, 404);

    const repoRow = resolved.repo as any;
    const workflowRow = await findWorkflowByFilename(repoRow.id, filename);
    if (!workflowRow) return c.json({ error: "Not Found" }, 404);

    // Parse the stored workflow JSON to look at its triggers + input schema.
    let parsedObj: Record<string, unknown> = {};
    try {
      const v = JSON.parse(workflowRow.parsed);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsedObj = v as Record<string, unknown>;
      }
    } catch {
      // Treat unparseable parsed-blob as no triggers — falls through to 422.
    }

    const spec = extractDispatchSpec(parsedObj.on as ParsedOn);
    if (!spec.enabled) {
      return c.json(
        { error: "Workflow does not have a 'workflow_dispatch' trigger." },
        422
      );
    }

    const providedInputs =
      body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : undefined;
    const inputCheck = validateDispatchInputs(spec.inputs, providedInputs);
    if (!inputCheck.ok) {
      return c.json(
        { error: "Invalid workflow inputs", details: inputCheck.details },
        422
      );
    }

    // Resolve the ref → commit SHA. Default to repo default_branch.
    const refIn =
      typeof body.ref === "string" && body.ref.trim().length > 0
        ? body.ref.trim()
        : repoRow.defaultBranch || "main";
    const commitSha = await resolveRef(owner, repo, refIn);
    if (!commitSha) {
      return c.json({ error: `Ref not found: ${refIn}` }, 422);
    }

    const runId = await enqueueRun({
      workflowId: workflowRow.id,
      repositoryId: repoRow.id,
      event: "workflow_dispatch",
      ref: refIn,
      commitSha,
      triggeredBy: user.id,
    });
    if (!runId) {
      return c.json({ error: "Failed to enqueue run" }, 500);
    }

    // GitHub returns 204 No Content with no body on success.
    return c.body(null, 204);
  }
);

// ─── 2. GET /actions/workflows/:filename/runs ───────────────────────────────

apiv2.get(
  "/repos/:owner/:repo/actions/workflows/:filename/runs",
  async (c) => {
    const { owner, repo, filename } = c.req.param();
    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not Found" }, 404);

    const repoRow = resolved.repo as any;
    const workflowRow = await findWorkflowByFilename(repoRow.id, filename);
    if (!workflowRow) return c.json({ error: "Not Found" }, 404);

    const perPage = Math.min(
      100,
      Math.max(1, parseInt(c.req.query("per_page") || "30", 10) || 30)
    );
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
    const offset = (page - 1) * perPage;
    const branch = c.req.query("branch");
    const headSha = c.req.query("head_sha");

    const conditions = [eq(workflowRuns.workflowId, workflowRow.id)];
    if (branch) {
      // Accept either short branch name or fully-qualified refs/heads/...
      const refValue = branch.startsWith("refs/")
        ? branch
        : `refs/heads/${branch}`;
      conditions.push(eq(workflowRuns.ref, refValue));
    }
    if (headSha) conditions.push(eq(workflowRuns.commitSha, headSha));

    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(where);
    const total_count = Number(n) || 0;

    const rows = await db
      .select()
      .from(workflowRuns)
      .where(where)
      .orderBy(desc(workflowRuns.queuedAt))
      .limit(perPage)
      .offset(offset);

    return c.json({
      total_count,
      workflow_runs: rows.map((r) =>
        serializeRun(r, workflowRow.name, owner, repo)
      ),
    });
  }
);

// ─── 3. GET /actions/runs/:run_id ───────────────────────────────────────────

apiv2.get("/repos/:owner/:repo/actions/runs/:run_id", async (c) => {
  const { owner, repo, run_id } = c.req.param();
  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not Found" }, 404);

  const repoRow = resolved.repo as any;
  const [run] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, run_id))
    .limit(1);
  if (!run) return c.json({ error: "Not Found" }, 404);
  // Don't leak runs across repos.
  if (run.repositoryId !== repoRow.id) {
    return c.json({ error: "Not Found" }, 404);
  }

  const [wf] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, run.workflowId))
    .limit(1);
  const workflowName = wf?.name ?? "";

  return c.json(serializeRun(run, workflowName, owner, repo));
});

// ─── 4. GET /actions/runs/:run_id/logs — ZIP of per-job logs ────────────────
//
// Reuses the same in-process zip writer pattern as `connect-claude.tsx` —
// PKZIP 2.0, no zip64, deflateRawSync with STORED fallback when compression
// would inflate. The handler is self-contained so the dxt downloader stays
// the canonical reference.

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

type ZipEntry = { name: string; data: Uint8Array };

function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;

    let method = 8;
    let compressed: Uint8Array;
    try {
      const out = deflateRawSync(entry.data);
      compressed = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
      if (compressed.length >= uncompressedSize) {
        method = 0;
        compressed = entry.data;
      }
    } catch {
      method = 0;
      compressed = entry.data;
    }
    const compressedSize = compressed.length;

    const local = new Uint8Array(30 + nameBytes.length + compressedSize);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const centralOffset = offset;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);

  const total =
    localParts.reduce((n, p) => n + p.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.length;
  }
  for (const p of centralParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(end, pos);
  return out;
}

apiv2.get("/repos/:owner/:repo/actions/runs/:run_id/logs", async (c) => {
  const { owner, repo, run_id } = c.req.param();
  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.json({ error: "Not Found" }, 404);

  const repoRow = resolved.repo as any;
  const [run] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, run_id))
    .limit(1);
  if (!run || run.repositoryId !== repoRow.id) {
    return c.json({ error: "Not Found" }, 404);
  }

  const jobs = await db
    .select()
    .from(workflowJobs)
    .where(eq(workflowJobs.runId, run.id))
    .orderBy(asc(workflowJobs.jobOrder));

  // 404 when there's truly nothing to package up — matches GitHub's behaviour
  // for runs that never produced logs.
  const usable = jobs.filter(
    (j) => typeof j.logs === "string" && j.logs.length > 0
  );
  if (usable.length === 0) {
    return c.json({ error: "Not Found" }, 404);
  }

  // Make filenames safe + unique. Collisions get a numeric suffix.
  const seen = new Set<string>();
  const entries: ZipEntry[] = [];
  for (const job of usable) {
    let base = (job.name || "job").replace(/[^a-zA-Z0-9_.-]+/g, "_");
    if (!base) base = "job";
    let filename = `${base}.log`;
    let n = 1;
    while (seen.has(filename)) {
      filename = `${base}-${++n}.log`;
    }
    seen.add(filename);
    entries.push({
      name: filename,
      data: new TextEncoder().encode(job.logs),
    });
  }

  const zip = buildZip(entries);
  // Wrap the bytes in a Blob so Response's BodyInit type is happy across
  // both Bun's `globalThis.Response` and Hono's. Uint8Array works at
  // runtime but trips strict TS — cast to BlobPart resolves the
  // ArrayBufferLike/ArrayBuffer mismatch on `.buffer`.
  return new Response(new Blob([zip as BlobPart], { type: "application/zip" }), {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="run-${run.id}-logs.zip"`,
      "Content-Length": String(zip.length),
    },
  });
});

// ─── 5. POST /actions/runs/:run_id/cancel ───────────────────────────────────

apiv2.post(
  "/repos/:owner/:repo/actions/runs/:run_id/cancel",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const { owner, repo, run_id } = c.req.param();
    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.json({ error: "Not Found" }, 404);

    const repoRow = resolved.repo as any;
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, run_id))
      .limit(1);
    if (!run || run.repositoryId !== repoRow.id) {
      return c.json({ error: "Not Found" }, 404);
    }

    // Already-terminal states are a 409 Conflict per GitHub semantics. We
    // only allow queued → cancelled and running → cancelled transitions.
    if (run.status !== "queued" && run.status !== "running") {
      return c.json(
        {
          error:
            "Cannot cancel workflow run in its current state",
          status: run.status,
        },
        409
      );
    }

    const now = new Date();
    await db
      .update(workflowRuns)
      .set({
        status: "cancelled",
        conclusion: "cancelled",
        finishedAt: now,
      })
      .where(
        and(
          eq(workflowRuns.id, run.id),
          eq(workflowRuns.repositoryId, repoRow.id)
        )
      );
    await db
      .update(workflowJobs)
      .set({
        status: "cancelled",
        conclusion: "cancelled",
        finishedAt: now,
      })
      .where(eq(workflowJobs.runId, run.id));

    return c.json({}, 202);
  }
);

// ─── API Info ───────────────────────────────────────────────────────────────

apiv2.get("/", (c) => {
  return c.json({
    name: "gluecron API",
    version: "2.0",
    documentation: "/api/docs",
    endpoints: {
      auth: {
        "POST /api/v2/auth/install-token":
          "Mint a PAT for one-command install (session-cookie auth only)",
      },
      users: {
        "GET /api/v2/user": "Get authenticated user",
        "GET /api/v2/users/:username": "Get user by username",
        "PATCH /api/v2/user": "Update authenticated user profile",
        "GET /api/v2/me/ai-savings":
          "AI hours-saved counter (window + lifetime, Block L9)",
      },
      repositories: {
        "GET /api/v2/users/:username/repos": "List user repositories",
        "POST /api/v2/repos": "Create repository",
        "GET /api/v2/repos/:owner/:repo": "Get repository",
        "PATCH /api/v2/repos/:owner/:repo": "Update repository",
        "DELETE /api/v2/repos/:owner/:repo": "Delete repository",
      },
      branches: {
        "GET /api/v2/repos/:owner/:repo/branches": "List branches",
      },
      commits: {
        "GET /api/v2/repos/:owner/:repo/commits": "List commits",
        "GET /api/v2/repos/:owner/:repo/commits/:sha": "Get commit with diff",
      },
      files: {
        "GET /api/v2/repos/:owner/:repo/tree/:ref": "Get file tree (supports ?recursive=1)",
        "GET /api/v2/repos/:owner/:repo/contents/:path": "Get file contents (supports ?encoding=base64)",
        "PUT /api/v2/repos/:owner/:repo/contents/:path": "Create or update a file on a branch",
        "DELETE /api/v2/repos/:owner/:repo/contents/:path": "Delete a file on a branch",
      },
      git: {
        "POST /api/v2/repos/:owner/:repo/git/refs": "Create a branch or tag pointing at a sha",
        "GET /api/v2/repos/:owner/:repo/git/refs/heads/:branch": "Get a branch ref",
        "PATCH /api/v2/repos/:owner/:repo/git/refs/heads/:branch": "Move a branch ref (fast-forward by default)",
        "GET /api/v2/repos/:owner/:repo/git/commits/:sha": "Get a raw git commit object",
        "POST /api/v2/repos/:owner/:repo/git/commits": "Create a commit from a tree + parents",
        "POST /api/v2/repos/:owner/:repo/git/blobs": "Write a blob from utf-8 or base64 content",
        "POST /api/v2/repos/:owner/:repo/git/trees": "Build a tree from entries (optionally based on base_tree)",
      },
      statuses: {
        "POST /api/v2/repos/:owner/:repo/statuses/:sha": "Post commit status (v2 alias)",
      },
      issues: {
        "GET /api/v2/repos/:owner/:repo/issues": "List issues",
        "POST /api/v2/repos/:owner/:repo/issues": "Create issue",
        "GET /api/v2/repos/:owner/:repo/issues/:number": "Get issue with comments",
        "PATCH /api/v2/repos/:owner/:repo/issues/:number": "Update issue",
        "POST /api/v2/repos/:owner/:repo/issues/:number/comments": "Add comment",
      },
      pullRequests: {
        "GET /api/v2/repos/:owner/:repo/pulls": "List pull requests",
        "POST /api/v2/repos/:owner/:repo/pulls": "Create pull request",
        "GET /api/v2/repos/:owner/:repo/pulls/:number": "Get PR with comments",
        "POST /api/v2/repos/:owner/:repo/pulls/:number/comments": "Add PR comment",
      },
      stars: {
        "PUT /api/v2/repos/:owner/:repo/star": "Star repository",
        "DELETE /api/v2/repos/:owner/:repo/star": "Unstar repository",
      },
      labels: {
        "GET /api/v2/repos/:owner/:repo/labels": "List labels",
        "POST /api/v2/repos/:owner/:repo/labels": "Create label",
      },
      search: {
        "GET /api/v2/search/repos": "Search repositories",
        "GET /api/v2/repos/:owner/:repo/search/code": "Search code in repo",
      },
      topics: {
        "GET /api/v2/repos/:owner/:repo/topics": "Get topics",
        "PUT /api/v2/repos/:owner/:repo/topics": "Set topics",
      },
      webhooks: {
        "GET /api/v2/repos/:owner/:repo/webhooks": "List webhooks",
        "POST /api/v2/repos/:owner/:repo/webhooks": "Create webhook",
      },
      activity: {
        "GET /api/v2/repos/:owner/:repo/activity": "Get activity feed",
      },
      actions: {
        "POST /api/v2/repos/:owner/:repo/actions/workflows/:filename/dispatches":
          "Dispatch a workflow run (204 No Content)",
        "GET /api/v2/repos/:owner/:repo/actions/workflows/:filename/runs":
          "List runs of a workflow (paginated: per_page, page; filters: branch, head_sha)",
        "GET /api/v2/repos/:owner/:repo/actions/runs/:run_id":
          "Get a single workflow run",
        "GET /api/v2/repos/:owner/:repo/actions/runs/:run_id/logs":
          "Download per-job logs as a .zip archive",
        "POST /api/v2/repos/:owner/:repo/actions/runs/:run_id/cancel":
          "Cancel a queued or running workflow run (202 Accepted)",
      },
    },
    authentication: {
      method: "Bearer token",
      header: "Authorization: Bearer <your-token>",
      createApiKey: "Visit /settings/tokens to create a personal access key",
    },
    rateLimit: {
      api: "100 requests/minute",
      search: "30 requests/minute",
      auth: "10 requests/minute",
    },
  });
});

export default apiv2;

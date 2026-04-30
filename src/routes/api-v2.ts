/**
 * Comprehensive REST API v2 — full CRUD for all resources.
 *
 * Authentication: Bearer token (API tokens) or session cookie.
 * Rate limited: 100 requests/minute per IP.
 * All responses are JSON.
 */

import { Hono } from "hono";
import { eq, and, desc, asc, sql, like, or } from "drizzle-orm";
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
} from "../db/schema";
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
  createOrUpdateFileOnBranch,
} from "../git/repository";
import { apiAuth, requireApiAuth, requireScope } from "../middleware/api-auth";
import type { ApiAuthEnv } from "../middleware/api-auth";
import { apiRateLimit, searchRateLimit } from "../middleware/rate-limit";
import { postCommitStatusHandler } from "./commit-statuses";

const apiv2 = new Hono<ApiAuthEnv>().basePath("/api/v2");

// Apply auth and rate limiting to all v2 routes
apiv2.use("*", apiRateLimit);
apiv2.use("*", apiAuth);

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
    .orderBy(desc(pullRequests.createdAt));

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

// ─── API Info ───────────────────────────────────────────────────────────────

apiv2.get("/", (c) => {
  return c.json({
    name: "gluecron API",
    version: "2.0",
    documentation: "/api/docs",
    endpoints: {
      users: {
        "GET /api/v2/user": "Get authenticated user",
        "GET /api/v2/users/:username": "Get user by username",
        "PATCH /api/v2/user": "Update authenticated user profile",
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
      },
      git: {
        "POST /api/v2/repos/:owner/:repo/git/refs": "Create a branch or tag pointing at a sha",
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

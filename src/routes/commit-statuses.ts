/**
 * Block J8 — Commit status API (GitHub-parity).
 *
 * External CI / automation systems POST statuses against a (repo, sha, context)
 * triple. Reads are public for public repos (softAuth visibility check) and
 * writes require repo-owner auth (session / OAuth / PAT accepted by
 * requireAuth).
 *
 *   POST /api/v1/repos/:owner/:repo/statuses/:sha
 *     body: { state, context?, description?, target_url? }
 *     200: { ok: true, status }
 *     400: invalid state / sha
 *     401/403: auth / permission
 *
 *   GET  /api/v1/repos/:owner/:repo/commits/:sha/statuses
 *     200: { total, statuses: [...] }
 *
 *   GET  /api/v1/repos/:owner/:repo/commits/:sha/status
 *     200: { state, total, counts, contexts }
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  combinedStatus,
  isValidSha,
  isValidState,
  listStatuses,
  setStatus,
} from "../lib/commit-statuses";

const statuses = new Hono<AuthEnv>();

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
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// POST status
// ---------------------------------------------------------------------------
/**
 * Handler body for POST <prefix>/repos/:owner/:repo/statuses/:sha — shared
 * between the v1 mount here (session/OAuth/PAT via softAuth+requireAuth) and
 * the v2 alias in `src/routes/api-v2.ts` (PAT via apiAuth+requireApiAuth +
 * `repo` scope). The behaviour is identical; the only difference is which
 * middleware stack authenticates the user.
 */
export async function postCommitStatusHandler(c: any) {
  const { owner: ownerName, repo: repoName, sha } = c.req.param();
  const user = c.get("user")!;
  if (!isValidSha(sha)) {
    return c.json({ error: "Invalid sha" }, 400);
  }
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.json({ error: "Repository not found" }, 404);
  if (resolved.owner.id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const state = body.state;
  if (!isValidState(state)) {
    return c.json(
      {
        error:
          "Invalid state; must be one of pending, success, failure, error",
      },
      400
    );
  }

  const row = await setStatus({
    repositoryId: resolved.repo.id,
    commitSha: sha,
    state,
    context: body.context ?? body.Context ?? "default",
    description: body.description ?? null,
    targetUrl: body.target_url ?? body.targetUrl ?? null,
    creatorId: user.id,
  });

  if (!row) return c.json({ error: "Could not save status" }, 500);

  return c.json({ ok: true, status: row });
}

statuses.post(
  "/api/v1/repos/:owner/:repo/statuses/:sha",
  softAuth,
  requireAuth,
  postCommitStatusHandler
);

// ---------------------------------------------------------------------------
// GET statuses list
// ---------------------------------------------------------------------------
statuses.get(
  "/api/v1/repos/:owner/:repo/commits/:sha/statuses",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, sha } = c.req.param();
    if (!isValidSha(sha)) return c.json({ error: "Invalid sha" }, 400);
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.json({ error: "Repository not found" }, 404);
    const user = c.get("user");
    if (resolved.repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const rows = await listStatuses(resolved.repo.id, sha);
    return c.json({ total: rows.length, statuses: rows });
  }
);

// ---------------------------------------------------------------------------
// GET combined status
// ---------------------------------------------------------------------------
statuses.get(
  "/api/v1/repos/:owner/:repo/commits/:sha/status",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, sha } = c.req.param();
    if (!isValidSha(sha)) return c.json({ error: "Invalid sha" }, 400);
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.json({ error: "Repository not found" }, 404);
    const user = c.get("user");
    if (resolved.repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const combined = await combinedStatus(resolved.repo.id, sha);
    return c.json(combined);
  }
);

export default statuses;

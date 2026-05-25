/**
 * PR sandbox routes (migration 0067).
 *
 * Exposes the runnable per-PR sandbox lifecycle to the web + API:
 *
 *   POST /:owner/:repo/pulls/:number/sandbox/provision  — owner triggers
 *   POST /:owner/:repo/pulls/:number/sandbox/destroy    — owner triggers
 *   GET  /:owner/:repo/pulls/:number/sandbox            — JSON status poll
 *
 * Provision returns JSON `{ ok, sandbox }` so the PR detail page can show
 * an inline status without a hard reload. Destroy flips the row to
 * 'destroyed' and returns JSON. The GET poll is anonymous-safe (read
 * access only) so a public PR's sandbox status can be shown to drive-by
 * viewers without forcing a login.
 *
 * No view rendering happens here — the PR detail page lives in pulls.tsx
 * and reads the same `getSandboxForPr` helper for its server-rendered
 * card. That keeps this file free of JSX + the locked layout/component
 * surfaces.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { pullRequests, repositories, users } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  destroySandbox,
  getSandboxForPr,
  provisionSandbox,
  sandboxStatusLabel,
} from "../lib/pr-sandbox";

const prSandboxRoutes = new Hono<AuthEnv>();

/**
 * Resolve `<owner>/<repo>` to a repository row, with an `ownerId`-matched
 * users.username for permission checks. Mirrors the `resolveRepo` helper
 * in pulls.tsx but kept private here so the two route files stay
 * independent.
 */
async function resolveRepoRow(ownerName: string, repoName: string) {
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

/** Resolve a PR by `(repoId, number)`. Returns null if not found. */
async function resolvePr(repoId: string, n: number) {
  if (!Number.isFinite(n)) return null;
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(eq(pullRequests.repositoryId, repoId), eq(pullRequests.number, n))
    )
    .limit(1);
  return pr ?? null;
}

/** Compact JSON shape returned by every endpoint. */
function jsonShape(
  row: Awaited<ReturnType<typeof getSandboxForPr>>
): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    statusLabel: sandboxStatusLabel(row.status),
    sandboxUrl: row.sandboxUrl,
    expiresAt: row.expiresAt?.toISOString?.() ?? null,
    provisionedAt: row.provisionedAt?.toISOString?.() ?? null,
    destroyedAt: row.destroyedAt?.toISOString?.() ?? null,
    errorMessage: row.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// POST /:owner/:repo/pulls/:number/sandbox/provision
// ---------------------------------------------------------------------------
prSandboxRoutes.post(
  "/:owner/:repo/pulls/:number/sandbox/provision",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const n = parseInt(c.req.param("number"), 10);
    const resolved = await resolveRepoRow(ownerName, repoName);
    if (!resolved) return c.json({ ok: false, error: "Repo not found" }, 404);
    const pr = await resolvePr(resolved.repo.id, n);
    if (!pr) return c.json({ ok: false, error: "PR not found" }, 404);

    const row = await provisionSandbox({ prId: pr.id });
    if (!row) {
      return c.json(
        { ok: false, error: "Sandbox provisioning failed (DB unavailable?)" },
        500
      );
    }
    return c.json({ ok: true, sandbox: jsonShape(row) });
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/pulls/:number/sandbox/destroy
// ---------------------------------------------------------------------------
prSandboxRoutes.post(
  "/:owner/:repo/pulls/:number/sandbox/destroy",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const n = parseInt(c.req.param("number"), 10);
    const resolved = await resolveRepoRow(ownerName, repoName);
    if (!resolved) return c.json({ ok: false, error: "Repo not found" }, 404);
    const pr = await resolvePr(resolved.repo.id, n);
    if (!pr) return c.json({ ok: false, error: "PR not found" }, 404);

    const existing = await getSandboxForPr(pr.id);
    if (!existing) {
      return c.json({ ok: true, sandbox: null });
    }
    await destroySandbox(existing.id);
    const after = await getSandboxForPr(pr.id);
    return c.json({ ok: true, sandbox: jsonShape(after) });
  }
);

// ---------------------------------------------------------------------------
// GET /:owner/:repo/pulls/:number/sandbox — JSON status
// ---------------------------------------------------------------------------
prSandboxRoutes.get(
  "/:owner/:repo/pulls/:number/sandbox",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const n = parseInt(c.req.param("number"), 10);
    const resolved = await resolveRepoRow(ownerName, repoName);
    if (!resolved) return c.json({ ok: false, error: "Repo not found" }, 404);
    const pr = await resolvePr(resolved.repo.id, n);
    if (!pr) return c.json({ ok: false, error: "PR not found" }, 404);

    const row = await getSandboxForPr(pr.id);
    return c.json({ ok: true, sandbox: jsonShape(row) });
  }
);

export default prSandboxRoutes;

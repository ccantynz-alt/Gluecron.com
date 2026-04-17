/**
 * Block K9 — Production + test signal ingestion API.
 *
 * External systems (Crontech runtime, Gatetest runner, Sentry bridge) POST
 * per-commit error signals here; the Gluecron web + agent layers consume
 * them to annotate commits and drive fix loops.
 *
 *   POST /api/v1/signals/error
 *     body: { repo: "owner/name", commit_sha, source, kind, message,
 *             stack_trace?, deploy_id?, environment?, severity?,
 *             sample_payload? }
 *     200: { id, status, count }
 *     400: invalid sha / missing fields / unknown repo format
 *     401: no valid auth
 *     403: token lacks contents:read AND isn't the repo owner
 *     404: repo not found
 *
 *   GET  /api/v1/repos/:owner/:repo/signals
 *     200: { total, signals: [...] }  -- open only
 *
 *   GET  /api/v1/repos/:owner/:repo/commits/:sha/signals
 *     200: { total, signals: [...] }
 *
 *   POST /api/v1/signals/:id/dismiss    (owner only, audit-logged)
 *   POST /api/v1/signals/:id/resolve    (owner only, audit-logged)
 *
 * Auth: accepts three bearer-token flavours in Authorization:
 *   - glc_*   personal access tokens (PAT) via softAuth-resolved user
 *   - glct_*  OAuth access tokens
 *   - ghi_*   marketplace install tokens (verifyInstallToken)
 * Session cookies also work. Un-authenticated POSTs return 401 JSON
 * rather than a /login redirect — API clients don't follow HTML.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  verifyInstallToken,
  hasPermission,
  type Permission,
} from "../lib/marketplace";
import { audit } from "../lib/notify";
import {
  _getProdSignalsTable,
  dismissSignal,
  isValidSha,
  listOpenSignalsForRepo,
  listSignalsForCommit,
  recordSignal,
  resolveSignal,
  sanitiseKind,
  sanitiseSeverity,
  sanitiseSource,
} from "../lib/prod-signals";

const signals = new Hono<AuthEnv>();

type AuthPrincipal =
  | { kind: "user"; userId: string; scopes: string[] }
  | { kind: "install"; permissions: Permission[]; botUsername: string };

/**
 * Resolve the caller. Prefers install token (ghi_*) when present since
 * marketplace tokens are the canonical cross-org write path. Falls back
 * to the softAuth-resolved user / PAT / OAuth token / session cookie.
 */
async function resolveAuth(c: any): Promise<AuthPrincipal | null> {
  const authHeader = c.req.header("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer.startsWith("ghi_")) {
      const install = await verifyInstallToken(bearer);
      if (!install) return null;
      return {
        kind: "install",
        permissions: install.permissions,
        botUsername: install.botUsername,
      };
    }
  }
  const user = c.get("user");
  if (user) {
    const scopes = (c.get("oauthScopes") as string[] | undefined) || [];
    return { kind: "user", userId: user.id, scopes };
  }
  return null;
}

async function resolveRepoByName(ownerName: string, repoName: string) {
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

function parseRepoSlug(raw: unknown): { owner: string; name: string } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name };
}

function canWriteRepo(
  principal: AuthPrincipal,
  repoOwnerId: string
): boolean {
  if (principal.kind === "user") return principal.userId === repoOwnerId;
  // Install tokens need contents:read (or higher — write implies read)
  return hasPermission(principal.permissions, "contents:read");
}

// ---------------------------------------------------------------------------
// POST ingest
// ---------------------------------------------------------------------------
signals.post("/api/v1/signals/error", softAuth, async (c) => {
  const principal = await resolveAuth(c);
  if (!principal) {
    return c.json({ error: "Authentication required" }, 401);
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const slug = parseRepoSlug(body.repo ?? body.repository);
  if (!slug) {
    return c.json(
      { error: "Missing or malformed 'repo' (expected 'owner/name')" },
      400
    );
  }

  const sha = String(body.commit_sha ?? body.commitSha ?? "").toLowerCase();
  if (!isValidSha(sha)) {
    return c.json({ error: "Invalid commit_sha" }, 400);
  }

  const message = String(body.message ?? "");
  if (!message.trim()) {
    return c.json({ error: "'message' is required" }, 400);
  }

  const resolved = await resolveRepoByName(slug.owner, slug.name);
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!canWriteRepo(principal, resolved.owner.id)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const result = await recordSignal({
    repositoryId: resolved.repo.id,
    commitSha: sha,
    source: sanitiseSource(body.source),
    kind: sanitiseKind(body.kind),
    severity: sanitiseSeverity(body.severity),
    message,
    stackTrace:
      typeof body.stack_trace === "string"
        ? body.stack_trace
        : typeof body.stackTrace === "string"
          ? body.stackTrace
          : null,
    deployId:
      typeof body.deploy_id === "string"
        ? body.deploy_id
        : typeof body.deployId === "string"
          ? body.deployId
          : null,
    environment:
      typeof body.environment === "string" ? body.environment : null,
    samplePayload:
      typeof body.sample_payload === "string"
        ? body.sample_payload
        : typeof body.samplePayload === "string"
          ? body.samplePayload
          : null,
  });

  if (!result) {
    return c.json({ error: "Could not record signal" }, 500);
  }

  return c.json({
    id: result.id,
    status: result.status,
    count: result.count,
  });
});

// ---------------------------------------------------------------------------
// GET list (open signals for a repo)
// ---------------------------------------------------------------------------
signals.get("/api/v1/repos/:owner/:repo/signals", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const resolved = await resolveRepoByName(ownerName, repoName);
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  const user = c.get("user");
  if (resolved.repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const rows = await listOpenSignalsForRepo(resolved.repo.id);
  return c.json({ total: rows.length, signals: rows });
});

// ---------------------------------------------------------------------------
// GET list for a specific commit
// ---------------------------------------------------------------------------
signals.get(
  "/api/v1/repos/:owner/:repo/commits/:sha/signals",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, sha } = c.req.param();
    if (!isValidSha(sha)) return c.json({ error: "Invalid sha" }, 400);
    const resolved = await resolveRepoByName(ownerName, repoName);
    if (!resolved) return c.json({ error: "Repository not found" }, 404);

    const user = c.get("user");
    if (resolved.repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const rows = await listSignalsForCommit(resolved.repo.id, sha);
    return c.json({ total: rows.length, signals: rows });
  }
);

// ---------------------------------------------------------------------------
// POST dismiss
// ---------------------------------------------------------------------------
signals.post("/api/v1/signals/:id/dismiss", softAuth, async (c) => {
  const principal = await resolveAuth(c);
  if (!principal) return c.json({ error: "Authentication required" }, 401);
  if (principal.kind !== "user") {
    return c.json({ error: "Only repo owners can dismiss" }, 403);
  }

  const id = c.req.param("id");
  const prodSignals = await _getProdSignalsTable();
  const [row] = await db
    .select()
    .from(prodSignals)
    .where(eq(prodSignals.id, id))
    .limit(1);
  if (!row) return c.json({ error: "Signal not found" }, 404);

  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, row.repositoryId))
    .limit(1);
  if (!repo) return c.json({ error: "Signal not found" }, 404);
  if (repo.ownerId !== principal.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const ok = await dismissSignal(id);
  if (!ok) return c.json({ error: "Could not dismiss" }, 500);

  await audit({
    userId: principal.userId,
    repositoryId: repo.id,
    action: "signal.dismiss",
    targetType: "prod_signal",
    targetId: id,
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST resolve
// ---------------------------------------------------------------------------
signals.post("/api/v1/signals/:id/resolve", softAuth, async (c) => {
  const principal = await resolveAuth(c);
  if (!principal) return c.json({ error: "Authentication required" }, 401);
  if (principal.kind !== "user") {
    return c.json({ error: "Only repo owners can resolve" }, 403);
  }

  const id = c.req.param("id");

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const [row] = await db
    .select()
    .from(prodSignals)
    .where(eq(prodSignals.id, id))
    .limit(1);
  if (!row) return c.json({ error: "Signal not found" }, 404);

  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, row.repositoryId))
    .limit(1);
  if (!repo) return c.json({ error: "Signal not found" }, 404);
  if (repo.ownerId !== principal.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const resolvedByCommit =
    typeof body.resolved_by_commit === "string"
      ? body.resolved_by_commit
      : typeof body.resolvedByCommit === "string"
        ? body.resolvedByCommit
        : null;

  const ok = await resolveSignal(id, resolvedByCommit);
  if (!ok) return c.json({ error: "Could not resolve" }, 500);

  await audit({
    userId: principal.userId,
    repositoryId: repo.id,
    action: "signal.resolve",
    targetType: "prod_signal",
    targetId: id,
    metadata: resolvedByCommit ? { resolvedByCommit } : undefined,
  });
  return c.json({ ok: true });
});

export default signals;

/**
 * REST API for workflow run artifacts (Block C1 / Sprint 1 — Agent 6).
 *
 * Mount point: `/api/v1/...` — the main thread wires this in via
 * `app.route('/', artifactsRoutes)` in `app.tsx` (out of scope for this agent).
 *
 * Endpoints
 * ---------
 *   POST   /api/v1/runs/:runId/artifacts       → create artifact (multipart or JSON+base64)
 *   GET    /api/v1/runs/:runId/artifacts       → list artifact metadata
 *   GET    /api/v1/artifacts/:artifactId/download → download binary
 *   DELETE /api/v1/artifacts/:artifactId       → delete
 *
 * Auth
 * ----
 * `Authorization: Bearer <glc_...>` PAT. The token row in `api_tokens`
 * carries comma-separated scopes (see `src/routes/tokens.tsx`). For write
 * operations we require the token to have `repo` / `write` / `admin`; for
 * deletes we require `admin`. List/download allow public-repo anonymous
 * access (falls back to session cookie or unauthenticated for public repos).
 *
 * NOTE: we intentionally DO NOT use the existing `requireAuth` middleware
 * here — it redirects cookie-less requests to `/login` which is wrong for
 * an API client. Instead we resolve the bearer ourselves at the top of each
 * handler.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  apiTokens,
  repositories,
  users,
  workflowRuns,
} from "../db/schema";
import type { User } from "../db/schema";
import { sha256Hex } from "../lib/oauth";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  uploadArtifact,
  listArtifacts,
  downloadArtifact,
  deleteArtifact,
  getRunRepositoryId,
  getArtifactRunId,
  MAX_ARTIFACT_BYTES,
} from "../lib/workflow-artifacts";

const app = new Hono<AuthEnv>();

// Soft-auth so that public-repo GET requests with no creds still resolve
// `c.get("user") === null` cleanly (rather than touching the DB inside each
// handler). Write/delete handlers re-resolve the bearer themselves below
// because they also need the PAT scope list.
app.use("/api/v1/runs/*", softAuth);
app.use("/api/v1/artifacts/*", softAuth);

// ---------------------------------------------------------------------------
// Bearer-PAT helper (~30 lines per sprint notes).
// Returns the user + scopes if the header carries a valid `glc_` PAT, else
// null. We don't handle `glct_` OAuth tokens here — the API surface for
// workflow artifacts is PAT-oriented.
// ---------------------------------------------------------------------------

async function resolveBearer(
  authHeader: string | undefined
): Promise<{ user: User; scopes: string[] } | null> {
  if (!authHeader) return null;
  const lower = authHeader.toLowerCase();
  if (!lower.startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token.startsWith("glc_")) return null;
  try {
    const hash = await sha256Hex(token);
    const [row] = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!user) return null;
    const scopes = row.scopes
      ? row.scopes.split(/[,\s]+/).filter(Boolean)
      : [];
    return { user, scopes };
  } catch (err) {
    console.error("[workflow-artifacts] resolveBearer:", err);
    return null;
  }
}

/** Scope checks. Our PATs use names like `repo` / `user` / `admin`. We also
 * accept the literal names from the spec (`read` / `write` / `admin`) so the
 * action runner and CI clients can pick whichever feels natural. */
function hasReadScope(scopes: string[]): boolean {
  return (
    scopes.includes("repo") ||
    scopes.includes("read") ||
    scopes.includes("write") ||
    scopes.includes("admin")
  );
}
function hasWriteScope(scopes: string[]): boolean {
  return (
    scopes.includes("repo") ||
    scopes.includes("write") ||
    scopes.includes("admin")
  );
}
function hasAdminScope(scopes: string[]): boolean {
  return scopes.includes("admin");
}

async function loadRepoOwner(repositoryId: string): Promise<
  | { id: string; ownerId: string; isPrivate: boolean }
  | null
> {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        ownerId: repositories.ownerId,
        isPrivate: repositories.isPrivate,
      })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[workflow-artifacts] loadRepoOwner:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/runs/:runId/artifacts — upload
// ---------------------------------------------------------------------------

app.post("/api/v1/runs/:runId/artifacts", async (c) => {
  const runId = c.req.param("runId");

  const bearer = await resolveBearer(c.req.header("authorization"));
  if (!bearer) {
    return c.json({ error: "authentication required" }, 401);
  }
  if (!hasWriteScope(bearer.scopes)) {
    return c.json({ error: "token missing write scope" }, 403);
  }

  const repositoryId = await getRunRepositoryId(runId);
  if (!repositoryId) {
    return c.json({ error: "run not found" }, 404);
  }
  const repo = await loadRepoOwner(repositoryId);
  if (!repo) {
    return c.json({ error: "repository not found" }, 404);
  }
  if (repo.ownerId !== bearer.user.id) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Parse body — either multipart/form-data or JSON with base64 `content`.
  const ctype = (c.req.header("content-type") || "").toLowerCase();
  let name: string | undefined;
  let jobId: string | undefined;
  let contentType: string | undefined;
  let content: Buffer | undefined;

  try {
    if (ctype.startsWith("application/json")) {
      const body = await c.req.json<{
        name?: string;
        jobId?: string;
        contentType?: string;
        content?: string; // base64
      }>();
      name = body.name;
      jobId = body.jobId;
      contentType = body.contentType;
      if (typeof body.content === "string") {
        content = Buffer.from(body.content, "base64");
      }
    } else {
      // Treat everything else (multipart, x-www-form-urlencoded) as form data.
      const form = await c.req.parseBody({ all: false });
      const n = form["name"];
      const j = form["jobId"];
      const ct = form["contentType"];
      const f = form["content"];
      if (typeof n === "string") name = n;
      if (typeof j === "string") jobId = j;
      if (typeof ct === "string") contentType = ct;
      if (f instanceof File) {
        const ab = await f.arrayBuffer();
        content = Buffer.from(ab);
        if (!contentType) contentType = f.type || undefined;
        if (!name) name = f.name;
      } else if (typeof f === "string") {
        // Fallback: raw text content in a form field.
        content = Buffer.from(f, "utf8");
      }
    }
  } catch (err) {
    console.error("[workflow-artifacts] parse body:", err);
    return c.json({ error: "invalid request body" }, 400);
  }

  if (!name) return c.json({ error: "name is required" }, 400);
  if (!jobId) return c.json({ error: "jobId is required" }, 400);
  if (!content) return c.json({ error: "content is required" }, 400);

  if (content.byteLength > MAX_ARTIFACT_BYTES) {
    return c.json({ error: "payload exceeds 100MB limit" }, 413);
  }

  const result = await uploadArtifact({
    runId,
    jobId,
    name,
    content,
    contentType,
  });
  if (!result.ok) {
    // Treat validation errors as 400; other helper errors as 500.
    const msg = result.error;
    const status =
      msg.startsWith("name ") ||
      msg.includes("exceeds") ||
      msg.includes("required")
        ? 400
        : 500;
    return c.json({ error: msg }, status);
  }

  return c.json(
    {
      id: result.artifactId,
      name,
      size: content.byteLength,
      contentType: contentType || "application/octet-stream",
      downloadUrl: `/api/v1/artifacts/${result.artifactId}/download`,
    },
    201
  );
});

// ---------------------------------------------------------------------------
// GET /api/v1/runs/:runId/artifacts — list
// ---------------------------------------------------------------------------

app.get("/api/v1/runs/:runId/artifacts", async (c) => {
  const runId = c.req.param("runId");
  const repositoryId = await getRunRepositoryId(runId);
  if (!repositoryId) return c.json({ error: "run not found" }, 404);
  const repo = await loadRepoOwner(repositoryId);
  if (!repo) return c.json({ error: "repository not found" }, 404);

  const bearer = await resolveBearer(c.req.header("authorization"));
  const cookieUser = c.get("user");

  // Auth logic:
  //   - public repo → anyone with a valid bearer OR cookie session reads.
  //     Also allow totally-anonymous reads (matches packages + web UI style
  //     for public resources).
  //   - private repo → require bearer with read scope OR cookie session,
  //     AND caller must be the repo owner.
  if (repo.isPrivate) {
    let userId: string | null = null;
    if (bearer) {
      if (!hasReadScope(bearer.scopes)) {
        return c.json({ error: "token missing read scope" }, 403);
      }
      userId = bearer.user.id;
    } else if (cookieUser) {
      userId = cookieUser.id;
    } else {
      return c.json({ error: "authentication required" }, 401);
    }
    if (userId !== repo.ownerId) {
      return c.json({ error: "forbidden" }, 403);
    }
  } else if (bearer && !hasReadScope(bearer.scopes)) {
    // Public repo but caller presented a weird-scoped token. Don't silently
    // upgrade — reject.
    return c.json({ error: "token missing read scope" }, 403);
  }

  const result = await listArtifacts(runId);
  if (!result.ok) return c.json({ error: result.error }, 500);
  return c.json({ artifacts: result.artifacts });
});

// ---------------------------------------------------------------------------
// GET /api/v1/artifacts/:artifactId/download — binary download
// ---------------------------------------------------------------------------

app.get("/api/v1/artifacts/:artifactId/download", async (c) => {
  const artifactId = c.req.param("artifactId");

  const runId = await getArtifactRunId(artifactId);
  if (!runId) return c.json({ error: "not found" }, 404);
  const repositoryId = await getRunRepositoryId(runId);
  if (!repositoryId) return c.json({ error: "not found" }, 404);
  const repo = await loadRepoOwner(repositoryId);
  if (!repo) return c.json({ error: "not found" }, 404);

  const bearer = await resolveBearer(c.req.header("authorization"));
  const cookieUser = c.get("user");

  if (repo.isPrivate) {
    let userId: string | null = null;
    if (bearer) {
      if (!hasReadScope(bearer.scopes)) {
        return c.json({ error: "token missing read scope" }, 403);
      }
      userId = bearer.user.id;
    } else if (cookieUser) {
      userId = cookieUser.id;
    } else {
      return c.json({ error: "authentication required" }, 401);
    }
    if (userId !== repo.ownerId) {
      return c.json({ error: "forbidden" }, 403);
    }
  } else if (bearer && !hasReadScope(bearer.scopes)) {
    return c.json({ error: "token missing read scope" }, 403);
  }

  const result = await downloadArtifact(artifactId);
  if (!result.ok) {
    const status = result.error === "not found" ? 404 : 500;
    return c.json({ error: result.error }, status);
  }

  // Sanitize filename for Content-Disposition. Artifact name regex is
  // already `[A-Za-z0-9._-]+` so nothing dangerous can slip in, but we still
  // strip any stray quotes/newlines defensively.
  const safeName = result.name.replace(/["\r\n]/g, "");

  return new Response(result.content as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(result.content.byteLength),
      "Cache-Control": "private, max-age=0, no-store",
    },
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/artifacts/:artifactId
// ---------------------------------------------------------------------------

app.delete("/api/v1/artifacts/:artifactId", async (c) => {
  const artifactId = c.req.param("artifactId");

  const bearer = await resolveBearer(c.req.header("authorization"));
  if (!bearer) return c.json({ error: "authentication required" }, 401);
  if (!hasAdminScope(bearer.scopes)) {
    return c.json({ error: "admin scope required" }, 403);
  }

  const runId = await getArtifactRunId(artifactId);
  if (!runId) return c.body(null, 404);
  const repositoryId = await getRunRepositoryId(runId);
  if (!repositoryId) return c.body(null, 404);
  const repo = await loadRepoOwner(repositoryId);
  if (!repo) return c.body(null, 404);
  if (repo.ownerId !== bearer.user.id) {
    return c.json({ error: "forbidden" }, 403);
  }

  const result = await deleteArtifact(artifactId);
  if (!result.ok) {
    const status = result.error === "not found" ? 404 : 500;
    return c.json({ error: result.error }, status);
  }
  return c.body(null, 204);
});

export default app;

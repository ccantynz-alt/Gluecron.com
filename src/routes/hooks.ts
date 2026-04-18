/**
 * Inbound API hooks — endpoints that external systems (GateTest, CI runners,
 * Crontech deploy) call into to report async results.
 *
 * Security: every hook is authenticated via a shared-secret Bearer token OR
 * HMAC signature over the raw body. Configure secrets via env vars:
 *   GATETEST_CALLBACK_SECRET   — bearer token GateTest must present
 *   GATETEST_HMAC_SECRET       — optional HMAC-SHA256 secret over the raw body
 *
 * Endpoints:
 *   POST /api/hooks/gatetest         — GateTest scan result callback
 *   POST /api/hooks/gatetest/status  — periodic status / heartbeat (optional)
 *
 * The GateTest service should POST JSON of shape:
 *   {
 *     "repository": "owner/repo",
 *     "sha": "<full-commit-sha>",
 *     "ref": "refs/heads/main",
 *     "pullRequestNumber": 42,          // optional
 *     "status": "passed" | "failed" | "error",
 *     "summary": "12 tests passed, 0 failed",
 *     "details": { ... }                // optional, persisted as JSON
 *   }
 *
 * Response: 200 OK with {ok:true, gateRunId} on success, 401 on auth failure,
 * 400 on malformed payload, 404 if the repo is unknown.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "../db";
import {
  apiTokens,
  gateRuns,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { notify, audit } from "../lib/notify";

const hooks = new Hono();

interface GateTestPayload {
  repository?: string;
  sha?: string;
  ref?: string;
  pullRequestNumber?: number;
  status?: "passed" | "failed" | "error" | "success";
  summary?: string;
  details?: unknown;
  durationMs?: number;
}

function constantTimeEq(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  try {
    return timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

function verifyGateTestAuth(c: any, rawBody: string): { ok: boolean; error?: string } {
  const bearerSecret = process.env.GATETEST_CALLBACK_SECRET || "";
  const hmacSecret = process.env.GATETEST_HMAC_SECRET || "";

  // If no secret is configured, refuse by default — do NOT allow anonymous writes.
  if (!bearerSecret && !hmacSecret) {
    return {
      ok: false,
      error:
        "Callback endpoint not configured: set GATETEST_CALLBACK_SECRET or GATETEST_HMAC_SECRET",
    };
  }

  // Bearer auth (simpler, preferred for server-to-server)
  if (bearerSecret) {
    const auth = c.req.header("authorization") || "";
    if (auth.startsWith("Bearer ")) {
      const token = auth.slice(7).trim();
      if (constantTimeEq(token, bearerSecret)) return { ok: true };
    }
    // Alternative header for tools that don't send Authorization
    const xTok = c.req.header("x-gatetest-token") || "";
    if (xTok && constantTimeEq(xTok, bearerSecret)) return { ok: true };
  }

  // HMAC signature over the raw body
  if (hmacSecret) {
    const sigHeader =
      c.req.header("x-gatetest-signature") ||
      c.req.header("x-signature-sha256") ||
      "";
    if (sigHeader) {
      const expected =
        "sha256=" +
        createHmac("sha256", hmacSecret).update(rawBody).digest("hex");
      if (constantTimeEq(sigHeader, expected)) return { ok: true };
    }
  }

  return { ok: false, error: "Invalid or missing GateTest credentials" };
}

async function resolveRepo(full: string): Promise<{ id: string; ownerId: string; name: string } | null> {
  if (!full || !full.includes("/")) return null;
  const [owner, name] = full.split("/", 2);
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        ownerId: repositories.ownerId,
        name: repositories.name,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, name)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

async function resolvePullRequestId(
  repositoryId: string,
  number: number | undefined
): Promise<string | null> {
  if (!number) return null;
  try {
    const [row] = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.number, number)
        )
      )
      .limit(1);
    return row?.id || null;
  } catch {
    return null;
  }
}

/**
 * POST /api/hooks/gatetest
 * Async scan result callback from GateTest.
 */
hooks.post("/api/hooks/gatetest", async (c) => {
  const rawBody = await c.req.text();

  const auth = verifyGateTestAuth(c, rawBody);
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error || "Unauthorized" }, 401);
  }

  let payload: GateTestPayload;
  try {
    payload = JSON.parse(rawBody) as GateTestPayload;
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!payload.repository || !payload.sha || !payload.status) {
    return c.json(
      {
        ok: false,
        error: "Required fields: repository (owner/name), sha, status",
      },
      400
    );
  }

  const repo = await resolveRepo(payload.repository);
  if (!repo) {
    return c.json(
      { ok: false, error: `Unknown repository: ${payload.repository}` },
      404
    );
  }

  const normalisedStatus =
    payload.status === "passed" || payload.status === "success"
      ? "passed"
      : payload.status === "failed"
        ? "failed"
        : "failed"; // treat "error" as a hard fail

  const pullRequestId = await resolvePullRequestId(
    repo.id,
    payload.pullRequestNumber
  );

  let gateRunId: string | null = null;
  try {
    const [row] = await db
      .insert(gateRuns)
      .values({
        repositoryId: repo.id,
        pullRequestId: pullRequestId || undefined,
        commitSha: payload.sha,
        ref: payload.ref || "refs/heads/main",
        gateName: "GateTest",
        status: normalisedStatus,
        summary: payload.summary || `GateTest reported ${normalisedStatus}`,
        details: payload.details ? JSON.stringify(payload.details) : null,
        durationMs: payload.durationMs,
        completedAt: new Date(),
      })
      .returning({ id: gateRuns.id });
    gateRunId = row?.id || null;
  } catch (err) {
    console.error("[hooks/gatetest] insert failed:", err);
    return c.json({ ok: false, error: "Failed to record gate run" }, 500);
  }

  // Notify the repo owner on failure
  if (normalisedStatus === "failed") {
    try {
      await notify(repo.ownerId, {
        kind: "gate_failed",
        title: `GateTest failed on ${payload.repository}`,
        body: payload.summary || "GateTest reported failure via callback",
        repositoryId: repo.id,
      });
    } catch (err) {
      console.error("[hooks/gatetest] notify failed:", err);
    }
  }

  try {
    await audit({
      userId: null,
      action: "gate_callback",
      repositoryId: repo.id,
      metadata: {
        gateName: "GateTest",
        sha: payload.sha,
        status: normalisedStatus,
        source: "gatetest-callback",
      },
    });
  } catch {
    /* swallow */
  }

  return c.json({ ok: true, gateRunId });
});

/**
 * GET /api/hooks/gatetest/recent
 * Small read-only endpoint GateTest can hit to verify connectivity +
 * see the 10 most recent gate runs for sanity checks.
 */
hooks.get("/api/hooks/gatetest/recent", async (c) => {
  const rawBody = "";
  const auth = verifyGateTestAuth(c, rawBody);
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error || "Unauthorized" }, 401);
  }

  try {
    const rows = await db
      .select({
        id: gateRuns.id,
        gateName: gateRuns.gateName,
        status: gateRuns.status,
        summary: gateRuns.summary,
        createdAt: gateRuns.createdAt,
      })
      .from(gateRuns)
      .orderBy(desc(gateRuns.createdAt))
      .limit(10);
    return c.json({ ok: true, runs: rows });
  } catch (err) {
    console.error("[hooks/gatetest] recent failed:", err);
    return c.json({ ok: false, error: "DB error" }, 500);
  }
});

/**
 * GET /api/hooks/ping
 * Unauthenticated liveness — for GateTest to probe reachability without
 * needing credentials. Returns 200 + version info.
 */
hooks.get("/api/hooks/ping", (c) => {
  return c.json({
    ok: true,
    service: "gluecron",
    hooks: ["gatetest", "gatetest/recent", "api/v1/gate-runs (backup)"],
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Backup API: personal-access-token path
//
// If for any reason the shared-secret callback path is unavailable,
// GateTest can authenticate with a standard GlueCron personal access token
// and POST the same payload to /api/v1/gate-runs.
//
// Advantages of the backup path:
//   - no new secrets to provision (reuses existing PAT infra)
//   - scoped per-user (audit trail points at a real account)
//   - revocable from /settings/tokens
//
// Trade-off: slightly heavier auth (DB lookup per call), so prefer
// /api/hooks/gatetest for high-volume traffic.
// ---------------------------------------------------------------------------

async function hashPat(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyPatAuth(
  c: any
): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const auth = c.req.header("authorization") || "";
  const rawToken =
    (auth.startsWith("Bearer ") ? auth.slice(7) : "").trim() ||
    (c.req.header("x-api-token") || "").trim();
  if (!rawToken) {
    return { ok: false, error: "Missing Bearer token" };
  }
  if (!rawToken.startsWith("glc_")) {
    return { ok: false, error: "Invalid token format" };
  }
  try {
    const hashed = await hashPat(rawToken);
    const [row] = await db
      .select({ id: apiTokens.id, userId: apiTokens.userId, expiresAt: apiTokens.expiresAt })
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hashed))
      .limit(1);
    if (!row) return { ok: false, error: "Unknown token" };
    if (row.expiresAt && row.expiresAt < new Date()) {
      return { ok: false, error: "Token expired" };
    }
    // Update last-used timestamp (fire and forget)
    db.update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, row.id))
      .catch(() => {});
    return { ok: true, userId: row.userId };
  } catch {
    return { ok: false, error: "Auth lookup failed" };
  }
}

/**
 * POST /api/v1/gate-runs
 * Backup path — accepts a personal access token and records a gate run.
 * Identical payload shape to /api/hooks/gatetest.
 */
hooks.post("/api/v1/gate-runs", async (c) => {
  const rawBody = await c.req.text();

  const auth = await verifyPatAuth(c);
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error || "Unauthorized" }, 401);
  }

  let payload: GateTestPayload & { gateName?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!payload.repository || !payload.sha || !payload.status) {
    return c.json(
      { ok: false, error: "Required: repository, sha, status" },
      400
    );
  }

  const repo = await resolveRepo(payload.repository);
  if (!repo) {
    return c.json(
      { ok: false, error: `Unknown repository: ${payload.repository}` },
      404
    );
  }

  // Scope check: the PAT's owner must own the repo OR have admin/write scope.
  // For MVP, require the token owner to match the repo owner.
  if (repo.ownerId !== auth.userId) {
    return c.json(
      { ok: false, error: "Token does not own this repository" },
      403
    );
  }

  const normalisedStatus =
    payload.status === "passed" || payload.status === "success"
      ? "passed"
      : payload.status === "failed"
        ? "failed"
        : "failed";

  const pullRequestId = await resolvePullRequestId(
    repo.id,
    payload.pullRequestNumber
  );

  let gateRunId: string | null = null;
  try {
    const [row] = await db
      .insert(gateRuns)
      .values({
        repositoryId: repo.id,
        pullRequestId: pullRequestId || undefined,
        commitSha: payload.sha,
        ref: payload.ref || "refs/heads/main",
        gateName: payload.gateName || "GateTest",
        status: normalisedStatus,
        summary: payload.summary || `${payload.gateName || "GateTest"} reported ${normalisedStatus}`,
        details: payload.details ? JSON.stringify(payload.details) : null,
        durationMs: payload.durationMs,
        completedAt: new Date(),
      })
      .returning({ id: gateRuns.id });
    gateRunId = row?.id || null;
  } catch (err) {
    console.error("[hooks/backup] insert failed:", err);
    return c.json({ ok: false, error: "Failed to record gate run" }, 500);
  }

  if (normalisedStatus === "failed") {
    try {
      await notify(repo.ownerId, {
        kind: "gate_failed",
        title: `${payload.gateName || "GateTest"} failed on ${payload.repository}`,
        body: payload.summary || "Gate failure reported via backup API",
        repositoryId: repo.id,
      });
    } catch {
      /* swallow */
    }
  }

  try {
    await audit({
      userId: auth.userId,
      action: "gate_callback_backup",
      repositoryId: repo.id,
      metadata: {
        gateName: payload.gateName || "GateTest",
        sha: payload.sha,
        status: normalisedStatus,
        source: "pat-api",
      },
    });
  } catch {
    /* swallow */
  }

  return c.json({ ok: true, gateRunId });
});

/**
 * GET /api/v1/gate-runs?repository=owner/name&limit=20
 * Backup read path — list recent gate runs for a repo (PAT-authed).
 */
hooks.get("/api/v1/gate-runs", async (c) => {
  const auth = await verifyPatAuth(c);
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error || "Unauthorized" }, 401);
  }

  const repoFull = c.req.query("repository") || "";
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 20)));
  if (!repoFull) {
    return c.json({ ok: false, error: "Query param 'repository' required" }, 400);
  }

  const repo = await resolveRepo(repoFull);
  if (!repo) return c.json({ ok: false, error: "Unknown repository" }, 404);
  if (repo.ownerId !== auth.userId) {
    return c.json({ ok: false, error: "Forbidden" }, 403);
  }

  try {
    const rows = await db
      .select()
      .from(gateRuns)
      .where(eq(gateRuns.repositoryId, repo.id))
      .orderBy(desc(gateRuns.createdAt))
      .limit(limit);
    return c.json({ ok: true, runs: rows });
  } catch {
    return c.json({ ok: false, error: "DB error" }, 500);
  }
});

export default hooks;

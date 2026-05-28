/**
 * Claude Code Integration Receiver
 *
 * Lets any Claude Code session or repository report into Gluecron with zero
 * config. Bearer token authenticated against api_tokens (SHA-256 hash).
 *
 * Routes
 *   POST /api/claude/connect  — validate token, auto-create repo, return git remote + MCP URL
 *   GET  /api/claude/connect  — same auth, return existing connection info
 *   POST /api/claude/session  — fire-and-forget session telemetry (no auth required)
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { createHash } from "crypto";
import { db } from "../db";
import { users, repositories, activityFeed, apiTokens } from "../db/schema";
import { initBareRepo } from "../git/repository";
import { config } from "../lib/config";
import type { AuthEnv } from "../middleware/auth";

const claudeIntegration = new Hono<AuthEnv>();

// ─── Auth helper ────────────────────────────────────────────────────────────

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Extract + validate Bearer token. Returns { user, token } on success,
 * or { error } if the token is missing / invalid.
 */
async function authenticateBearer(
  authHeader: string | undefined
): Promise<
  | { ok: true; user: typeof users.$inferSelect; tokenRow: typeof apiTokens.$inferSelect }
  | { ok: false; error: string; status: 401 }
> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, error: "Missing or malformed Authorization header. Use: Bearer <token>", status: 401 };
  }

  const raw = authHeader.slice(7).trim();
  if (!raw) {
    return { ok: false, error: "Empty bearer token", status: 401 };
  }

  const tokenHash = sha256hex(raw);

  try {
    const [tokenRow] = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, tokenHash))
      .limit(1);

    if (!tokenRow) {
      return { ok: false, error: "Invalid API token", status: 401 };
    }

    if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) {
      return { ok: false, error: "API token has expired", status: 401 };
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, tokenRow.userId))
      .limit(1);

    if (!user) {
      return { ok: false, error: "Token owner not found", status: 401 };
    }

    // Touch last-used timestamp (best effort — no await)
    db.update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, tokenRow.id))
      .catch(() => {});

    return { ok: true, user, tokenRow };
  } catch (err) {
    return { ok: false, error: "Authentication failed", status: 401 };
  }
}

// ─── POST /api/claude/connect ───────────────────────────────────────────────

claudeIntegration.post("/api/claude/connect", async (c) => {
  const auth = await authenticateBearer(c.req.header("Authorization"));
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error }, auth.status);
  }

  const { user } = auth;

  let body: { username?: string; repoName?: string; description?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  // repoName is optional — if omitted, return basic connection info without a repo
  const repoName = body.repoName?.trim();
  const description = body.description?.trim() || null;

  try {
    const baseUrl = config.appBaseUrl;

    if (!repoName) {
      // No repo requested — just confirm the token is valid
      return c.json({
        ok: true,
        username: user.username,
        mcpUrl: `${baseUrl}/mcp`,
        message: "Token valid. Provide repoName to auto-create a repository.",
      });
    }

    // Validate repo name
    if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
      return c.json({ ok: false, error: "Invalid repository name. Use letters, digits, hyphens, dots, or underscores." }, 400);
    }

    // Check if repo already exists
    const [existing] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerId, user.id), eq(repositories.name, repoName)))
      .limit(1);

    if (existing) {
      const gitRemote = `${baseUrl}/${user.username}/${repoName}.git`;
      const mcpUrl = `${baseUrl}/mcp`;
      return c.json({
        ok: true,
        created: false,
        gitRemote,
        mcpUrl,
        repoId: existing.id,
        message: "Repository already exists.",
      });
    }

    // Auto-create bare repo on disk
    const diskPath = await initBareRepo(user.username, repoName);

    // Insert into repositories table
    const [repo] = await db
      .insert(repositories)
      .values({
        name: repoName,
        ownerId: user.id,
        description,
        isPrivate: false,
        diskPath,
      })
      .returning();

    if (!repo) {
      return c.json({ ok: false, error: "Failed to create repository record" }, 500);
    }

    // Log to activity feed
    await db.insert(activityFeed).values({
      repositoryId: repo.id,
      userId: user.id,
      action: "repo_created",
      targetType: "repository",
      targetId: repo.id,
      metadata: JSON.stringify({ source: "claude_connect", via: "api" }),
    }).catch(() => {});

    const gitRemote = `${baseUrl}/${user.username}/${repoName}.git`;
    const mcpUrl = `${baseUrl}/mcp`;

    return c.json({
      ok: true,
      created: true,
      gitRemote,
      mcpUrl,
      repoId: repo.id,
      message: `Repository '${repoName}' created. Push with: git push gluecron main`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Server error: ${msg}` }, 500);
  }
});

// ─── GET /api/claude/connect ────────────────────────────────────────────────

claudeIntegration.get("/api/claude/connect", async (c) => {
  const auth = await authenticateBearer(c.req.header("Authorization"));
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error }, auth.status);
  }

  const { user } = auth;
  const repoName = c.req.query("repo");

  try {
    const baseUrl = config.appBaseUrl;

    if (!repoName) {
      // List all repos for this user
      const repos = await db
        .select({ id: repositories.id, name: repositories.name, description: repositories.description, createdAt: repositories.createdAt })
        .from(repositories)
        .where(eq(repositories.ownerId, user.id));

      return c.json({
        ok: true,
        username: user.username,
        mcpUrl: `${baseUrl}/mcp`,
        repos: repos.map((r) => ({
          ...r,
          gitRemote: `${baseUrl}/${user.username}/${r.name}.git`,
        })),
      });
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerId, user.id), eq(repositories.name, repoName)))
      .limit(1);

    if (!repo) {
      return c.json({ ok: false, error: `Repository '${repoName}' not found` }, 404);
    }

    const gitRemote = `${baseUrl}/${user.username}/${repoName}.git`;
    const mcpUrl = `${baseUrl}/mcp`;

    return c.json({
      ok: true,
      username: user.username,
      repoId: repo.id,
      repoName: repo.name,
      gitRemote,
      mcpUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Server error: ${msg}` }, 500);
  }
});

// ─── POST /api/claude/session ────────────────────────────────────────────────
// Fire-and-forget telemetry. No auth required — sessions post to this.

claudeIntegration.post("/api/claude/session", async (c) => {
  let body: {
    sessionId?: string;
    repoName?: string;
    event?: "start" | "push" | "issue" | "pr";
    payload?: unknown;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { sessionId, repoName, event, payload } = body;

  if (!event || !["start", "push", "issue", "pr"].includes(event)) {
    return c.json({ ok: false, error: "event must be one of: start, push, issue, pr" }, 400);
  }

  // Best-effort: look up the repo if repoName is provided (need owner resolution via query param or body)
  try {
    let repositoryId: string | null = null;
    let userId: string | null = null;

    if (repoName) {
      // Try to find via owner in payload or query string
      const ownerHint =
        (payload && typeof payload === "object" && "owner" in payload
          ? (payload as Record<string, unknown>).owner
          : undefined) as string | undefined;

      if (ownerHint) {
        const [ownerRow] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, ownerHint))
          .limit(1);

        if (ownerRow) {
          userId = ownerRow.id;
          const [repo] = await db
            .select({ id: repositories.id })
            .from(repositories)
            .where(and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repoName)))
            .limit(1);
          if (repo) repositoryId = repo.id;
        }
      }
    }

    if (repositoryId) {
      await db.insert(activityFeed).values({
        repositoryId,
        userId: userId ?? undefined,
        action: "claude_session",
        targetType: "session",
        targetId: sessionId ?? null,
        metadata: JSON.stringify({ sessionId, event, repoName, payload }),
      });
    }
    // If no repo found, silently swallow (fire-and-forget)
  } catch {
    // Intentionally swallowed — telemetry must not block callers
  }

  return c.json({ ok: true });
});

export default claudeIntegration;

/**
 * Repo access middleware — resolves a viewer's effective access level to a
 * repository and enforces a minimum-level gate on routes.
 *
 * Access hierarchy (ordered): none < read < write < admin < owner.
 *
 * The repo owner (repositories.ownerId === userId) always resolves to
 * "owner", regardless of any collaborator row. Beyond that, we look up an
 * ACCEPTED row in repo_collaborators (acceptedAt IS NOT NULL) and return the
 * stored role. If no row exists, public repos fall back to "read" for any
 * viewer (including anonymous); private repos return "none".
 *
 * The middleware factory reads `:owner` + `:repo` from the URL, looks up
 * the repository, computes the access level, stashes both on the context
 * (so downstream handlers don't re-query), and renders a 403 HTML page via
 * Layout if the caller's level is below the required minimum.
 *
 * Implementation notes:
 *  - Hono and JSX dependencies are loaded via *dynamic* `import()` inside
 *    `requireRepoAccess` so that `resolveRepoAccess` — the pure, unit-
 *    testable half — has no static hono/hono-jsx imports at module load.
 *    This lets `bun test` run the logic tests without needing the full
 *    hono runtime (notably `hono/jsx/jsx-dev-runtime`, which a given
 *    install may not have yet when the schema/parallel agent ships).
 *  - The middleware signature `(c, next) => Promise<Response | void>`
 *    matches Hono's `MiddlewareHandler` structurally without importing
 *    the type; routes can pass this directly to `.use()` / handler chains.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, repoCollaborators } from "../db/schema";
import type { Repository, User } from "../db/schema";

export type RepoAccessLevel = "none" | "read" | "write" | "admin" | "owner";

/**
 * Ordered access hierarchy. Higher index = more access. Use `ACCESS_RANK`
 * to compare two levels; callers should prefer {@link satisfiesAccess}.
 */
export const ACCESS_RANK: Record<RepoAccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
  owner: 4,
};

/** True if `actual` meets or exceeds `required`. */
export function satisfiesAccess(
  actual: RepoAccessLevel,
  required: RepoAccessLevel
): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

/**
 * Env type for Hono routes that sit behind `requireRepoAccess`. Extends the
 * existing auth variables — `user` is populated by softAuth/requireAuth,
 * `repository` and `repoAccess` are populated here.
 */
export type RepoAccessEnv = {
  Variables: {
    user: User | null;
    repository: Repository;
    repoAccess: RepoAccessLevel;
  };
};

/**
 * Pure access resolution — no HTTP, no context. Exposed so callers (e.g.
 * API responses, view-layer conditionals, tests) can ask "what can this
 * user do with this repo?" without running the middleware.
 */
export async function resolveRepoAccess(args: {
  repoId: string;
  userId: string | null;
  isPublic: boolean;
}): Promise<RepoAccessLevel> {
  const { repoId, userId, isPublic } = args;

  // Anonymous viewer: only public repos grant anything, and only "read".
  if (!userId) {
    return isPublic ? "read" : "none";
  }

  // Owner check — look up the repo row once. If the caller IS the owner,
  // short-circuit before hitting repo_collaborators.
  try {
    const [repo] = await db
      .select({ ownerId: repositories.ownerId })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (repo && repo.ownerId === userId) {
      return "owner";
    }
  } catch {
    // Fall through — if the owner lookup fails we still try the
    // collaborator path below (which may also fail, in which case we'll
    // end up at the public/private fallback).
  }

  // Accepted collaborator row wins over the public fallback.
  try {
    const [collab] = await db
      .select({ role: repoCollaborators.role })
      .from(repoCollaborators)
      .where(
        and(
          eq(repoCollaborators.repositoryId, repoId),
          eq(repoCollaborators.userId, userId),
          isNotNull(repoCollaborators.acceptedAt)
        )
      )
      .limit(1);

    if (collab) {
      return collab.role as RepoAccessLevel;
    }
  } catch {
    // Ignore — fall through to public/private fallback.
  }

  return isPublic ? "read" : "none";
}

/**
 * Middleware factory: gate a route on a minimum access level.
 *
 * Assumes the URL has `:owner` and `:repo` params. Looks up the repository,
 * 404s if it doesn't exist, resolves the viewer's access, and 403s if the
 * viewer is below `level`. On success, sets `c.var.repository` and
 * `c.var.repoAccess` for downstream handlers.
 *
 * Returns a bare `(c, next)` async function — structurally compatible with
 * Hono's `MiddlewareHandler`. Hono is loaded lazily inside the handler so
 * the unit-testable exports above don't force-import the jsx runtime.
 */
export function requireRepoAccess(
  level: "read" | "write" | "admin"
): (c: any, next: () => Promise<void>) => Promise<Response | void> {
  return async (c: any, next: () => Promise<void>) => {
    const { owner: ownerName, repo: repoName } = c.req.param() as {
      owner?: string;
      repo?: string;
    };
    const user: User | null = c.get("user") ?? null;

    if (!ownerName || !repoName) {
      return c.notFound();
    }

    // Resolve owner -> user row, then repo by (owner, name).
    let ownerRow: typeof users.$inferSelect | undefined;
    let repo: typeof repositories.$inferSelect | undefined;
    try {
      [ownerRow] = await db
        .select()
        .from(users)
        .where(eq(users.username, ownerName))
        .limit(1);

      if (!ownerRow) {
        return c.notFound();
      }

      [repo] = await db
        .select()
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, ownerRow.id),
            eq(repositories.name, repoName)
          )
        )
        .limit(1);
    } catch {
      return c.json({ error: "Service unavailable" }, 503);
    }

    if (!repo) {
      return c.notFound();
    }

    const access = await resolveRepoAccess({
      repoId: repo.id,
      userId: user?.id ?? null,
      isPublic: !repo.isPrivate,
    });

    if (!satisfiesAccess(access, level)) {
      const reason =
        access === "none"
          ? "You don't have permission to view this repository."
          : `This action requires ${level} access. You have ${access} access.`;
      // Lazy-load hono/jsx + Layout so the top of this module is safe to
      // import from unit tests that can't resolve the jsx runtime.
      const [{ jsx }, { Layout }] = await Promise.all([
        import("hono/jsx"),
        import("../views/layout"),
      ]);
      const body = jsx(
        "div",
        {
          style:
            "max-width: 600px; margin: 80px auto; padding: 24px; text-align: center;",
        },
        [
          jsx("h1", { style: "margin-bottom: 12px" }, ["403 — Access denied"]),
          jsx("p", { style: "color: var(--muted, #8b949e)" }, [reason]),
        ]
      );
      const page = jsx(
        Layout as any,
        { title: "Access denied", user },
        [body]
      );
      return c.html(page, 403);
    }

    c.set("repoAccess", access);
    c.set("repository", repo);
    return next();
  };
}

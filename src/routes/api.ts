/**
 * REST API routes for repository management.
 */

import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db";
import { users, repositories, organizations, orgMembers } from "../db/schema";
import { initBareRepo, repoExists } from "../git/repository";
import { hashPassword } from "../lib/auth";
import { orgRoleAtLeast } from "../lib/orgs";
import { softAuth } from "../middleware/auth";

const api = new Hono().basePath("/api");

// Create repository
api.post("/repos", softAuth, async (c) => {
  let body: {
    name: string;
    owner: string;
    orgSlug?: string;
    description?: string;
    isPrivate?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.name || !body.owner) {
    return c.json({ error: "name and owner are required" }, 400);
  }

  // Validate repo name
  if (!/^[a-zA-Z0-9._-]+$/.test(body.name)) {
    return c.json({ error: "Invalid repository name" }, 400);
  }

  // Auth check after input validation so bad requests still get 400
  const authUser = c.get("user");
  if (!authUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    // Find creator (user who is performing the action)
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, body.owner));

    if (!owner) {
      return c.json({ error: "Owner not found" }, 404);
    }

    // Verify the authenticated user is the requested owner
    if (authUser.id !== owner.id) {
      return c.json({ error: "Forbidden: cannot create repos for another user" }, 403);
    }

    // B2: if orgSlug supplied, place the repo in the org namespace.
    // Requires the creator to be an admin+ of the org.
    let orgId: string | null = null;
    let namespaceSlug = body.owner;
    if (body.orgSlug) {
      const [org] = await db
        .select({ id: organizations.id, slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.slug, body.orgSlug))
        .limit(1);
      if (!org) return c.json({ error: "Organization not found" }, 404);

      const [mem] = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(
          and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, owner.id))
        )
        .limit(1);
      if (!mem || !orgRoleAtLeast(mem.role, "admin")) {
        return c.json({ error: "Admin rights required on org" }, 403);
      }
      orgId = org.id;
      namespaceSlug = org.slug;
    }

    // Duplicate check: scoped to the right namespace.
    if (orgId) {
      const [existing] = await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(eq(repositories.orgId, orgId), eq(repositories.name, body.name))
        )
        .limit(1);
      if (existing) {
        return c.json({ error: "Repository already exists" }, 409);
      }
    } else {
      const [existing] = await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, owner.id),
            eq(repositories.name, body.name),
            isNull(repositories.orgId)
          )
        )
        .limit(1);
      if (existing) {
        return c.json({ error: "Repository already exists" }, 409);
      }
    }
    if (await repoExists(namespaceSlug, body.name)) {
      return c.json({ error: "Repository already exists" }, 409);
    }

    // Init bare repo on disk, keyed by the namespace slug (user or org).
    const diskPath = await initBareRepo(namespaceSlug, body.name);

    // Insert into DB
    const [repo] = await db
      .insert(repositories)
      .values({
        name: body.name,
        ownerId: owner.id,
        orgId,
        description: body.description || null,
        isPrivate: body.isPrivate || false,
        diskPath,
      })
      .returning();

    // Green-ecosystem bootstrap: settings, protection, labels, welcome issue
    if (repo) {
      const { bootstrapRepository } = await import("../lib/repo-bootstrap");
      await bootstrapRepository({
        repositoryId: repo.id,
        ownerUserId: owner.id,
      });
    }

    return c.json(repo, 201);
  } catch (err) {
    console.error("[api] POST /repos:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

// List user's repositories
api.get("/users/:username/repos", async (c) => {
  const { username } = c.req.param();
  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, username));
    if (!owner) return c.json({ error: "User not found" }, 404);

    const repos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.ownerId, owner.id));

    return c.json(repos);
  } catch (err) {
    console.error("[api] /users/:username/repos:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

// Get single repository (resolves both user- and org-owned namespaces)
api.get("/repos/:owner/:name", async (c) => {
  const { owner: ownerName, name } = c.req.param();
  try {
    const { loadRepoByPath } = await import("../lib/namespace");
    const repo = await loadRepoByPath(ownerName, name);
    if (!repo) return c.json({ error: "Not found" }, 404);
    return c.json(repo);
  } catch (err) {
    console.error("[api] /repos/:owner/:name:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

// Quick-setup: create user + repo in one call (dev convenience, disabled in production)
api.post("/setup", async (c) => {
  if (!process.env.ALLOW_SETUP_ENDPOINT) {
    return c.json({ error: "Endpoint disabled" }, 403);
  }
  let body: {
    username: string;
    email: string;
    repoName: string;
    description?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.username || !body.email || !body.repoName) {
    return c.json(
      { error: "username, email, and repoName are required" },
      400
    );
  }

  try {
    // Upsert user
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, body.username));

    if (!user) {
      [user] = await db
        .insert(users)
        .values({
          username: body.username,
          email: body.email,
          passwordHash: await hashPassword("changeme"),
        })
        .returning();
    }

    // Create repo if not exists
    if (!(await repoExists(body.username, body.repoName))) {
      const diskPath = await initBareRepo(body.username, body.repoName);
      const [repo] = await db
        .insert(repositories)
        .values({
          name: body.repoName,
          ownerId: user.id,
          description: body.description || null,
          diskPath,
        })
        .returning();
      if (repo) {
        const { bootstrapRepository } = await import("../lib/repo-bootstrap");
        await bootstrapRepository({
          repositoryId: repo.id,
          ownerUserId: user.id,
        });
      }
    }

    return c.json({
      user: user.username,
      repo: body.repoName,
      status: "ready",
    });
  } catch (err) {
    console.error("[api] POST /setup:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

export default api;

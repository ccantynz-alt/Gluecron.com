/**
 * REST API routes for repository management.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { users, repositories } from "../db/schema";
import { initBareRepo, repoExists } from "../git/repository";
import { hashPassword } from "../lib/auth";

const api = new Hono().basePath("/api");

// Create repository
api.post("/repos", async (c) => {
  let body: {
    name: string;
    owner: string;
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

  try {
    // Find owner
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, body.owner));

    if (!owner) {
      return c.json({ error: "Owner not found" }, 404);
    }

    // Check duplicate
    if (await repoExists(body.owner, body.name)) {
      return c.json({ error: "Repository already exists" }, 409);
    }

    // Init bare repo on disk
    const diskPath = await initBareRepo(body.owner, body.name);

    // Insert into DB
    const [repo] = await db
      .insert(repositories)
      .values({
        name: body.name,
        ownerId: owner.id,
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

// Get single repository
api.get("/repos/:owner/:name", async (c) => {
  const { owner: ownerName, name } = c.req.param();
  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName));
    if (!owner) return c.json({ error: "Not found" }, 404);

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.ownerId, owner.id), eq(repositories.name, name))
      );
    if (!repo) return c.json({ error: "Not found" }, 404);

    return c.json(repo);
  } catch (err) {
    console.error("[api] /repos/:owner/:name:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

// Quick-setup: create user + repo in one call (dev convenience)
api.post("/setup", async (c) => {
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

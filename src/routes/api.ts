/**
 * REST API routes for repository management.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { users, repositories } from "../db/schema";
import { initBareRepo, repoExists } from "../git/repository";

const api = new Hono().basePath("/api");

// Create repository
api.post("/repos", async (c) => {
  const body = await c.req.json<{
    name: string;
    owner: string;
    description?: string;
    isPrivate?: boolean;
  }>();

  if (!body.name || !body.owner) {
    return c.json({ error: "name and owner are required" }, 400);
  }

  // Validate repo name
  if (!/^[a-zA-Z0-9._-]+$/.test(body.name)) {
    return c.json({ error: "Invalid repository name" }, 400);
  }

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

  return c.json(repo, 201);
});

// List user's repositories
api.get("/users/:username/repos", async (c) => {
  const { username } = c.req.param();
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
});

// Get single repository
api.get("/repos/:owner/:name", async (c) => {
  const { owner: ownerName, name } = c.req.param();
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
});

// Quick-setup: create user + repo in one call (dev convenience)
api.post("/setup", async (c) => {
  const body = await c.req.json<{
    username: string;
    email: string;
    repoName: string;
    description?: string;
  }>();

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
        passwordHash: "placeholder", // TODO: real auth
      })
      .returning();
  }

  // Create repo if not exists
  if (!(await repoExists(body.username, body.repoName))) {
    const diskPath = await initBareRepo(body.username, body.repoName);
    await db.insert(repositories).values({
      name: body.repoName,
      ownerId: user.id,
      description: body.description || null,
      diskPath,
    });
  }

  return c.json({ user: user.username, repo: body.repoName, status: "ready" });
});

export default api;

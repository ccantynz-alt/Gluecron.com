/**
 * Block I2 — Template repositories.
 *
 *   POST /:owner/:repo/use-template — clone a template into a new repo owned
 *     by the current user. Similar to fork, but:
 *       - source must have `is_template = true`
 *       - destination is given a new name via the `name` form field
 *       - `forked_from_id` is NOT set (templates break lineage)
 *       - default branch is reset to a clean history (for now, we use the
 *         template's history, matching GitHub's optional `--include-all-branches`
 *         behavior from the template's default branch only)
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { activityFeed, repositories, users } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getRepoPath, repoExists } from "../git/repository";
import { config } from "../lib/config";
import { join } from "path";

const templates = new Hono<AuthEnv>();
templates.use("*", softAuth);

templates.post("/:owner/:repo/use-template", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const newName = String(body.name || "").trim();
  if (!newName) {
    return c.redirect(`/${ownerName}/${repoName}?error=Name+required`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(newName)) {
    return c.redirect(`/${ownerName}/${repoName}?error=Invalid+name`);
  }

  if (!(await repoExists(ownerName, repoName))) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }

  const [sourceOwner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!sourceOwner) return c.redirect(`/${ownerName}/${repoName}`);

  const [sourceRepo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerId, sourceOwner.id),
        eq(repositories.name, repoName)
      )
    )
    .limit(1);
  if (!sourceRepo) return c.redirect(`/${ownerName}/${repoName}`);
  if (!sourceRepo.isTemplate) {
    return c.redirect(`/${ownerName}/${repoName}?error=Not+a+template`);
  }

  // Refuse if the user already has a repo by that name
  if (await repoExists(user.username, newName)) {
    return c.redirect(`/${user.username}/${newName}`);
  }

  const sourcePath = getRepoPath(ownerName, repoName);
  const destPath = join(config.gitReposPath, user.username, `${newName}.git`);
  const proc = Bun.spawn(["git", "clone", "--bare", sourcePath, destPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  const [newRepo] = await db
    .insert(repositories)
    .values({
      name: newName,
      ownerId: user.id,
      description: sourceRepo.description
        ? `Seeded from ${ownerName}/${repoName} template`
        : `Seeded from ${ownerName}/${repoName} template`,
      isPrivate: false,
      defaultBranch: sourceRepo.defaultBranch,
      diskPath: destPath,
      // Intentionally no forkedFromId — templates break lineage
    })
    .returning();

  if (newRepo) {
    try {
      const { bootstrapRepository } = await import("../lib/repo-bootstrap");
      await bootstrapRepository({
        repositoryId: newRepo.id,
        ownerUserId: user.id,
        defaultBranch: sourceRepo.defaultBranch,
        skipWelcomeIssue: true,
      });
    } catch {
      // bootstrap failures shouldn't break the primary create
    }
    try {
      await db.insert(activityFeed).values({
        repositoryId: newRepo.id,
        userId: user.id,
        action: "created",
        metadata: JSON.stringify({
          fromTemplate: `${ownerName}/${repoName}`,
        }),
      });
    } catch {
      // best effort
    }
  }

  return c.redirect(`/${user.username}/${newName}`);
});

export default templates;

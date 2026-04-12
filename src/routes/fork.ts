/**
 * Fork route — copy a repository into your account.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, activityFeed } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getRepoPath, repoExists, initBareRepo } from "../git/repository";
import { config } from "../lib/config";
import { join } from "path";

const fork = new Hono<AuthEnv>();

fork.use("*", softAuth);

// Fork a repository
fork.post("/:owner/:repo/fork", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;

  // Can't fork your own repo
  if (ownerName === user.username) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }

  // Check source exists
  if (!(await repoExists(ownerName, repoName))) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }

  // Check if already forked
  if (await repoExists(user.username, repoName)) {
    return c.redirect(`/${user.username}/${repoName}`);
  }

  // Get source repo from DB
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

  // Clone the bare repo
  const sourcePath = getRepoPath(ownerName, repoName);
  const destPath = join(config.gitReposPath, user.username, `${repoName}.git`);

  const proc = Bun.spawn(["git", "clone", "--bare", sourcePath, destPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  // Insert into DB
  await db.insert(repositories).values({
    name: repoName,
    ownerId: user.id,
    description: sourceRepo.description
      ? `Fork of ${ownerName}/${repoName} — ${sourceRepo.description}`
      : `Fork of ${ownerName}/${repoName}`,
    isPrivate: false,
    defaultBranch: sourceRepo.defaultBranch,
    diskPath: destPath,
    forkedFromId: sourceRepo.id,
  });

  // Update fork count
  await db
    .update(repositories)
    .set({ forkCount: sourceRepo.forkCount + 1 })
    .where(eq(repositories.id, sourceRepo.id));

  // Log activity
  try {
    await db.insert(activityFeed).values({
      repositoryId: sourceRepo.id,
      userId: user.id,
      action: "fork",
      metadata: JSON.stringify({ forkOwner: user.username }),
    });
  } catch {
    // best effort
  }

  return c.redirect(`/${user.username}/${repoName}`);
});

export default fork;

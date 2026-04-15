/**
 * Repository settings — description, visibility, default branch, danger zone.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, repoTransfers } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { listBranches } from "../git/repository";
import { rm } from "fs/promises";

const repoSettings = new Hono<AuthEnv>();

repoSettings.use("*", softAuth);

// Settings page
repoSettings.get("/:owner/:repo/settings", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");

  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);

  if (!owner || owner.id !== user.id) {
    return c.html(
      <Layout title="Unauthorized" user={user}>
        <div class="empty-state">
          <h2>Unauthorized</h2>
          <p>Only the repository owner can access settings.</p>
        </div>
      </Layout>,
      403
    );
  }

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);

  if (!repo) return c.notFound();

  const branches = await listBranches(ownerName, repoName);

  return c.html(
    <Layout title={`Settings — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div style="max-width: 600px">
        <h2 style="margin-bottom: 20px">Repository settings</h2>
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        {error && (
          <div class="auth-error">{decodeURIComponent(error)}</div>
        )}

        <form
          method="POST"
          action={`/${ownerName}/${repoName}/settings`}
        >
          <div class="form-group">
            <label for="description">Description</label>
            <input
              type="text"
              id="description"
              name="description"
              value={repo.description || ""}
              placeholder="A short description"
            />
          </div>
          <div class="form-group">
            <label for="default_branch">Default branch</label>
            <select id="default_branch" name="default_branch">
              {branches.length === 0 ? (
                <option value={repo.defaultBranch}>
                  {repo.defaultBranch}
                </option>
              ) : (
                branches.map((b) => (
                  <option value={b} selected={b === repo.defaultBranch}>
                    {b}
                  </option>
                ))
              )}
            </select>
            <div style="margin-top: 6px; font-size: 12px">
              <a href={`/${ownerName}/${repoName}/settings/branches`}>
                Manage branches (rename, …)
              </a>
            </div>
          </div>
          <div class="form-group">
            <label>Visibility</label>
            <div class="visibility-options">
              <label class="visibility-option">
                <input
                  type="radio"
                  name="visibility"
                  value="public"
                  checked={!repo.isPrivate}
                />
                <div class="vis-label">Public</div>
              </label>
              <label class="visibility-option">
                <input
                  type="radio"
                  name="visibility"
                  value="private"
                  checked={repo.isPrivate}
                />
                <div class="vis-label">Private</div>
              </label>
            </div>
          </div>
          <button type="submit" class="btn btn-primary">
            Save changes
          </button>
        </form>

        <div
          style="margin-top: 32px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius)"
        >
          <h3 style="margin-bottom: 8px">Template repository</h3>
          <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 12px">
            {repo.isTemplate
              ? "This repository is a template. Users can click \u201cUse this template\u201d to create a new repository with the same files."
              : "Mark this repository as a template so others can seed new repositories from its files."}
          </p>
          <form
            method="POST"
            action={`/${ownerName}/${repoName}/settings/template`}
          >
            <input
              type="hidden"
              name="template"
              value={repo.isTemplate ? "0" : "1"}
            />
            <button type="submit" class="btn">
              {repo.isTemplate
                ? "Unmark as template"
                : "Mark as template"}
            </button>
          </form>
        </div>

        <div
          style="margin-top: 20px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius)"
        >
          <h3 style="margin-bottom: 8px">Transfer ownership</h3>
          <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 12px">
            Transfer this repository to another user. The new owner can
            accept or decline the transfer by attempting to view it.
          </p>
          <form
            method="POST"
            action={`/${ownerName}/${repoName}/settings/transfer`}
            onsubmit="return confirm('Transfer this repository? The new owner will have full control.')"
          >
            <input
              type="text"
              name="new_owner"
              placeholder="new-owner-username"
              required
              style="width:60%"
            />{" "}
            <button type="submit" class="btn">
              Transfer
            </button>
          </form>
        </div>

        <div
          style="margin-top: 20px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius)"
        >
          <h3 style="margin-bottom: 8px">
            {repo.isArchived ? "Unarchive repository" : "Archive repository"}
          </h3>
          <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 12px">
            {repo.isArchived
              ? "This repository is archived and read-only. Unarchive to allow pushes and issue/PR activity again."
              : "Mark this repository as archived. It will become read-only — no pushes, no new issues or PRs. You can unarchive at any time."}
          </p>
          <form
            method="POST"
            action={`/${ownerName}/${repoName}/settings/archive`}
          >
            <input
              type="hidden"
              name="archive"
              value={repo.isArchived ? "0" : "1"}
            />
            <button type="submit" class="btn">
              {repo.isArchived ? "Unarchive" : "Archive"} this repository
            </button>
          </form>
        </div>

        <div
          style="margin-top: 20px; padding: 20px; border: 1px solid var(--red); border-radius: var(--radius)"
        >
          <h3 style="color: var(--red); margin-bottom: 12px">Danger zone</h3>
          <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 12px">
            Permanently delete this repository and all its data.
          </p>
          <form
            method="POST"
            action={`/${ownerName}/${repoName}/settings/delete`}
            onsubmit="return confirm('Are you sure? This cannot be undone.')"
          >
            <button type="submit" class="btn btn-danger">
              Delete this repository
            </button>
          </form>
        </div>
      </div>
    </Layout>
  );
});

// Save settings
repoSettings.post("/:owner/:repo/settings", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);

  if (!owner || owner.id !== user.id) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }

  await db
    .update(repositories)
    .set({
      description: String(body.description || "").trim() || null,
      defaultBranch: String(body.default_branch || "main"),
      isPrivate: body.visibility === "private",
      updatedAt: new Date(),
    })
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    );

  return c.redirect(
    `/${ownerName}/${repoName}/settings?success=Settings+saved`
  );
});

// Toggle template flag
repoSettings.post(
  "/:owner/:repo/settings/template",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const target = String(body.template || "1") === "1";
    await db
      .update(repositories)
      .set({ isTemplate: target, updatedAt: new Date() })
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      );
    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=${
        target ? "Marked+as+template" : "Unmarked+as+template"
      }`
    );
  }
);

// Transfer repository to a new owner (by username)
repoSettings.post(
  "/:owner/:repo/settings/transfer",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const newOwnerName = String(body.new_owner || "").trim();
    if (!newOwnerName) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=New+owner+required`
      );
    }
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const [newOwner] = await db
      .select()
      .from(users)
      .where(eq(users.username, newOwnerName))
      .limit(1);
    if (!newOwner) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=User+not+found`
      );
    }
    if (newOwner.id === owner.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=Same+owner`
      );
    }
    // Reject if new owner already has a repo by this name
    const [conflict] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, newOwner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (conflict) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=Target+owner+already+has+a+repo+by+that+name`
      );
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.notFound();
    await db
      .update(repositories)
      .set({ ownerId: newOwner.id, orgId: null, updatedAt: new Date() })
      .where(eq(repositories.id, repo.id));
    await db.insert(repoTransfers).values({
      repositoryId: repo.id,
      fromOwnerId: owner.id,
      fromOrgId: repo.orgId,
      toOwnerId: newOwner.id,
      toOrgId: null,
      initiatedBy: user.id,
    });
    return c.redirect(`/${newOwnerName}/${repoName}`);
  }
);

// Archive / unarchive repository
repoSettings.post(
  "/:owner/:repo/settings/archive",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const target = String(body.archive || "1") === "1";
    await db
      .update(repositories)
      .set({ isArchived: target, updatedAt: new Date() })
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      );
    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=${
        target ? "Repository+archived" : "Repository+unarchived"
      }`
    );
  }
);

// Delete repository
repoSettings.post(
  "/:owner/:repo/settings/delete",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);

    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);

    if (!repo) return c.redirect(`/${ownerName}`);

    // Delete from disk
    try {
      await rm(repo.diskPath, { recursive: true, force: true });
    } catch {
      // Disk cleanup best-effort
    }

    // Delete from DB (cascades to stars, issues, etc.)
    await db.delete(repositories).where(eq(repositories.id, repo.id));

    return c.redirect(`/${ownerName}`);
  }
);

export default repoSettings;

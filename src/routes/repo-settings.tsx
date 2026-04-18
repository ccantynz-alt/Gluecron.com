/**
 * Repository settings — description, visibility, default branch, danger zone.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { listBranches } from "../git/repository";
import { rm } from "fs/promises";
import {
  Container,
  Form,
  FormGroup,
  Input,
  Select,
  Button,
  Alert,
  EmptyState,
  Section,
  Text,
} from "../views/ui";

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
        <EmptyState title="Unauthorized">
          <p>Only the repository owner can access settings.</p>
        </EmptyState>
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
      <Container maxWidth={600}>
        <h2 style="margin-bottom: 20px">Repository settings</h2>
        {success && (
          <Alert variant="success">{decodeURIComponent(success)}</Alert>
        )}
        {error && (
          <Alert variant="error">{decodeURIComponent(error)}</Alert>
        )}

        <Form
          action={`/${ownerName}/${repoName}/settings`}
          method="POST"
        >
          <FormGroup label="Description" htmlFor="description">
            <Input
              name="description"
              id="description"
              value={repo.description || ""}
              placeholder="A short description"
            />
          </FormGroup>
          <FormGroup label="Default branch" htmlFor="default_branch">
            <Select name="default_branch" id="default_branch" value={repo.defaultBranch}>
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
            </Select>
          </FormGroup>
          <FormGroup label="Visibility">
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
          </FormGroup>
          <Button type="submit" variant="primary">
            Save changes
          </Button>
        </Form>

        <div
          style="margin-top: 40px; padding: 20px; border: 1px solid var(--red); border-radius: var(--radius)"
        >
          <h3 style="color: var(--red); margin-bottom: 12px">Danger zone</h3>
          <Text size={14} muted style="display:block;margin-bottom:12px">
            Permanently delete this repository and all its data.
          </Text>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/delete`}
            onsubmit="return confirm('Are you sure? This cannot be undone.')"
          >
            <Button type="submit" variant="danger">
              Delete this repository
            </Button>
          </form>
        </div>
      </Container>
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

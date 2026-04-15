/**
 * Environments settings + approval routes (Block C4).
 *
 *   GET  /:owner/:repo/settings/environments           list + create form (owner-only)
 *   POST /:owner/:repo/settings/environments           create
 *   POST /:owner/:repo/settings/environments/:envId    update
 *   POST /:owner/:repo/settings/environments/:envId/delete
 *
 *   POST /:owner/:repo/deployments/:deploymentId/approve  approve a pending deploy
 *   POST /:owner/:repo/deployments/:deploymentId/reject   reject a pending deploy
 *
 * Approve/reject live under /deployments/:id/... so they don't collide with
 * the existing `GET /:owner/:repo/deployments/:id` detail page.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  environments,
  deployments,
  repositories,
  users,
} from "../db/schema";
import type { Environment } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import { audit, notify } from "../lib/notify";
import {
  allowedBranchesOf,
  computeApprovalState,
  getEnvironmentById,
  getEnvironmentByName,
  isReviewer,
  listEnvironments,
  recordApproval,
  reviewerIdsOf,
} from "../lib/environments";

const r = new Hono<AuthEnv>();
r.use("*", softAuth);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadRepo(owner: string, repo: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        ownerId: repositories.ownerId,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[environments] loadRepo failed:", err);
    return null;
  }
}

function splitCsv(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function resolveUsernamesToIds(usernames: string[]): Promise<string[]> {
  if (usernames.length === 0) return [];
  try {
    const rows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.username, usernames));
    return rows.map((r) => r.id);
  } catch (err) {
    console.error("[environments] resolve usernames failed:", err);
    return [];
  }
}

async function idsToUsernames(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  try {
    const rows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, ids));
    const map = new Map(rows.map((r) => [r.id, r.username]));
    return ids.map((id) => map.get(id) || id);
  } catch {
    return ids;
  }
}

// ---------------------------------------------------------------------------
// GET /:owner/:repo/settings/environments
// ---------------------------------------------------------------------------

r.get("/:owner/:repo/settings/environments", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const envs = await listEnvironments(repoRow.id);
  const unread = await getUnreadCount(user.id);
  const success = c.req.query("success");
  const err = c.req.query("error");

  // Resolve reviewer IDs → usernames per env for display.
  const envUsernames: Record<string, string[]> = {};
  for (const env of envs) {
    envUsernames[env.id] = await idsToUsernames(reviewerIdsOf(env));
  }

  return c.html(
    <Layout
      title={`Environments — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user.username}
      />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <h3>Environments</h3>
        <a href={`/${owner}/${repo}/deployments`} class="btn btn-sm">
          Back to deployments
        </a>
      </div>
      {success && <div class="auth-success">{decodeURIComponent(success)}</div>}
      {err && <div class="auth-error">{decodeURIComponent(err)}</div>}

      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px">
        Require human approval before a deploy to this environment runs.
        Branch patterns restrict which refs may target the environment.
      </p>

      <div class="panel" style="margin-bottom: 24px">
        {envs.length === 0 ? (
          <div class="panel-empty">No environments yet.</div>
        ) : (
          envs.map((env) => {
            const reviewers = envUsernames[env.id] || [];
            const branches = allowedBranchesOf(env);
            return (
              <form
                method="post"
                action={`/${owner}/${repo}/settings/environments/${env.id}`}
                class="panel-item"
                style="flex-direction: column; align-items: stretch; gap: 8px"
              >
                <div
                  style="display: flex; justify-content: space-between; align-items: center"
                >
                  <strong style="font-size: 15px">{env.name}</strong>
                  <div style="display: flex; gap: 6px">
                    <button type="submit" class="btn btn-sm btn-primary">
                      Save
                    </button>
                  </div>
                </div>
                <div class="form-group" style="margin: 0">
                  <label style="display: flex; align-items: center; gap: 6px">
                    <input
                      type="checkbox"
                      name="requireApproval"
                      value="1"
                      checked={env.requireApproval}
                    />
                    Require approval before deploy
                  </label>
                </div>
                <div class="form-group" style="margin: 0">
                  <label>Reviewers (comma-separated usernames)</label>
                  <input
                    type="text"
                    name="reviewers"
                    value={reviewers.join(", ")}
                    placeholder="alice, bob"
                  />
                </div>
                <div class="form-group" style="margin: 0">
                  <label>Wait timer (minutes)</label>
                  <input
                    type="number"
                    name="waitTimerMinutes"
                    min="0"
                    max="1440"
                    value={String(env.waitTimerMinutes)}
                    style="width: 120px"
                  />
                </div>
                <div class="form-group" style="margin: 0">
                  <label>Allowed branches (comma-separated glob patterns)</label>
                  <input
                    type="text"
                    name="allowedBranches"
                    value={branches.join(", ")}
                    placeholder="main, release/*"
                  />
                </div>
                <div style="display: flex; justify-content: flex-end">
                  <button
                    type="submit"
                    formaction={`/${owner}/${repo}/settings/environments/${env.id}/delete`}
                    class="btn btn-sm btn-danger"
                    onclick="return confirm('Delete this environment?')"
                  >
                    Delete
                  </button>
                </div>
              </form>
            );
          })
        )}
      </div>

      <h3 style="margin-top: 24px; margin-bottom: 12px">New environment</h3>
      <form
        method="post"
        action={`/${owner}/${repo}/settings/environments`}
        class="panel"
        style="padding: 16px"
      >
        <div class="form-group">
          <label>Name</label>
          <input
            type="text"
            name="name"
            required
            placeholder="production"
          />
        </div>
        <div class="form-group">
          <label style="display: flex; align-items: center; gap: 6px">
            <input
              type="checkbox"
              name="requireApproval"
              value="1"
              checked
            />
            Require approval
          </label>
        </div>
        <div class="form-group">
          <label>Reviewers (comma-separated usernames)</label>
          <input type="text" name="reviewers" placeholder="alice, bob" />
        </div>
        <div class="form-group">
          <label>Wait timer (minutes)</label>
          <input
            type="number"
            name="waitTimerMinutes"
            min="0"
            max="1440"
            value="0"
            style="width: 120px"
          />
        </div>
        <div class="form-group">
          <label>Allowed branches (comma-separated glob patterns)</label>
          <input
            type="text"
            name="allowedBranches"
            placeholder="main, release/*"
          />
        </div>
        <button type="submit" class="btn btn-primary">
          Create environment
        </button>
      </form>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/settings/environments      (create)
// ---------------------------------------------------------------------------

r.post("/:owner/:repo/settings/environments", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  if (!name) {
    return c.redirect(
      `/${owner}/${repo}/settings/environments?error=${encodeURIComponent(
        "Name required"
      )}`
    );
  }
  const requireApproval = body.requireApproval === "1" || body.requireApproval === "on";
  const reviewers = await resolveUsernamesToIds(splitCsv(body.reviewers));
  const waitTimerMinutes = Math.max(
    0,
    Math.min(1440, parseInt(String(body.waitTimerMinutes || "0"), 10) || 0)
  );
  const allowedBranches = splitCsv(body.allowedBranches);

  try {
    await db.insert(environments).values({
      repositoryId: repoRow.id,
      name,
      requireApproval,
      reviewers: JSON.stringify(reviewers),
      waitTimerMinutes,
      allowedBranches: JSON.stringify(allowedBranches),
    });
  } catch (err) {
    console.error("[environments] create failed:", err);
    return c.redirect(
      `/${owner}/${repo}/settings/environments?error=${encodeURIComponent(
        "Could not create (duplicate name?)"
      )}`
    );
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "environment.create",
    targetType: "environment",
    metadata: { name, requireApproval, reviewers, allowedBranches },
  });

  return c.redirect(
    `/${owner}/${repo}/settings/environments?success=${encodeURIComponent(
      "Environment created"
    )}`
  );
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/settings/environments/:envId  (update)
// ---------------------------------------------------------------------------

r.post("/:owner/:repo/settings/environments/:envId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, envId } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const env = await getEnvironmentById(repoRow.id, envId);
  if (!env) return c.notFound();

  const body = await c.req.parseBody();
  const requireApproval =
    body.requireApproval === "1" || body.requireApproval === "on";
  const reviewers = await resolveUsernamesToIds(splitCsv(body.reviewers));
  const waitTimerMinutes = Math.max(
    0,
    Math.min(1440, parseInt(String(body.waitTimerMinutes || "0"), 10) || 0)
  );
  const allowedBranches = splitCsv(body.allowedBranches);

  try {
    await db
      .update(environments)
      .set({
        requireApproval,
        reviewers: JSON.stringify(reviewers),
        waitTimerMinutes,
        allowedBranches: JSON.stringify(allowedBranches),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(environments.id, envId),
          eq(environments.repositoryId, repoRow.id)
        )
      );
  } catch (err) {
    console.error("[environments] update failed:", err);
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "environment.update",
    targetType: "environment",
    targetId: envId,
    metadata: { requireApproval, reviewers, allowedBranches, waitTimerMinutes },
  });

  return c.redirect(
    `/${owner}/${repo}/settings/environments?success=${encodeURIComponent(
      "Environment updated"
    )}`
  );
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/settings/environments/:envId/delete
// ---------------------------------------------------------------------------

r.post(
  "/:owner/:repo/settings/environments/:envId/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, envId } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}`);
    }

    try {
      await db
        .delete(environments)
        .where(
          and(
            eq(environments.id, envId),
            eq(environments.repositoryId, repoRow.id)
          )
        );
    } catch (err) {
      console.error("[environments] delete failed:", err);
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "environment.delete",
      targetType: "environment",
      targetId: envId,
    });

    return c.redirect(
      `/${owner}/${repo}/settings/environments?success=${encodeURIComponent(
        "Environment removed"
      )}`
    );
  }
);

// ---------------------------------------------------------------------------
// Approve/reject a pending deployment
// ---------------------------------------------------------------------------

async function loadDeployment(repositoryId: string, deploymentId: string) {
  try {
    const [row] = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.id, deploymentId),
          eq(deployments.repositoryId, repositoryId)
        )
      )
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[environments] loadDeployment failed:", err);
    return null;
  }
}

async function decide(
  c: Context<AuthEnv>,
  decision: "approved" | "rejected"
) {
  const user = c.get("user")!;
  const { owner, repo, deploymentId } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const deployment = await loadDeployment(repoRow.id, deploymentId);
  if (!deployment) return c.notFound();

  const envName = deployment.environment;
  const env = await getEnvironmentByName(repoRow.id, envName);
  if (!env) {
    // No env configured — nothing to approve. Treat as 404 for safety.
    return c.notFound();
  }

  const allowed = await isReviewer(env, user.id);
  if (!allowed) {
    return c.redirect(
      `/${owner}/${repo}/deployments/${deploymentId}?error=${encodeURIComponent(
        "Not a reviewer"
      )}`
    );
  }

  const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const comment = typeof body.comment === "string" ? body.comment : undefined;

  const inserted = await recordApproval({
    deploymentId,
    userId: user.id,
    decision,
    comment,
  });

  // Re-read state and flip the deployment row accordingly.
  const state = await computeApprovalState(deploymentId, env);
  let newStatus: string | null = null;
  if (state.rejected) {
    newStatus = "rejected";
  } else if (state.approved && deployment.status === "pending_approval") {
    newStatus = "pending"; // hand off to existing deployer
  }

  if (newStatus) {
    try {
      await db
        .update(deployments)
        .set({
          status: newStatus,
          blockedReason: newStatus === "rejected" ? "rejected by reviewer" : null,
        })
        .where(eq(deployments.id, deploymentId));
    } catch (err) {
      console.error("[environments] deployment status flip failed:", err);
    }
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: decision === "approved" ? "deployment.approve" : "deployment.reject",
    targetType: "deployment",
    targetId: deploymentId,
    metadata: { recorded: !!inserted, newStatus },
  });

  if (deployment.triggeredBy && deployment.triggeredBy !== user.id) {
    try {
      await notify(deployment.triggeredBy, {
        kind: "deployment_approval",
        title:
          decision === "approved"
            ? `Deploy to ${envName} approved`
            : `Deploy to ${envName} rejected`,
        body:
          decision === "approved"
            ? `${user.username} approved the deploy of ${deployment.commitSha.slice(0, 7)}.`
            : `${user.username} rejected the deploy of ${deployment.commitSha.slice(0, 7)}.`,
        url: `/${owner}/${repo}/deployments/${deploymentId}`,
        repositoryId: repoRow.id,
      });
    } catch (err) {
      console.error("[environments] notify triggeredBy failed:", err);
    }
  }

  return c.redirect(`/${owner}/${repo}/deployments/${deploymentId}`);
}

r.post(
  "/:owner/:repo/deployments/:deploymentId/approve",
  requireAuth,
  async (c) => decide(c, "approved")
);

r.post(
  "/:owner/:repo/deployments/:deploymentId/reject",
  requireAuth,
  async (c) => decide(c, "rejected")
);

export default r;

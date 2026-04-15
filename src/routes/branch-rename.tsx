/**
 * Block J24 — Branch rename.
 *
 * Owner-only. Renames a branch on disk and cascades the rename to:
 *   - repositories.defaultBranch (when renaming the default branch)
 *   - pull_requests.base_branch / head_branch
 *   - merge_queue_entries.base_branch
 *   - branch_protection.pattern (exact matches only — globs untouched)
 *   - HEAD symbolic-ref (via setHeadBranch) when default renames
 *
 * Pure validation lives in src/lib/branch-rename.ts. This file does the
 * IO. Every DB update is audited.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  users,
  pullRequests,
  mergeQueueEntries,
  branchProtection,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  listBranches,
  getDefaultBranch,
  renameBranch as gitRenameBranch,
  setHeadBranch,
} from "../git/repository";
import {
  planRename,
  branchValidationMessage,
  shouldRewriteProtectionPattern,
} from "../lib/branch-rename";
import { audit } from "../lib/notify";

const branchRenameRoutes = new Hono<AuthEnv>();

branchRenameRoutes.use("*", softAuth);

async function resolveOwned(
  c: Parameters<
    Parameters<typeof branchRenameRoutes.get>[1]
  >[0],
  ownerName: string,
  repoName: string
): Promise<{ owner: typeof users.$inferSelect; repo: typeof repositories.$inferSelect } | null> {
  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) return null;
    const user = c.get("user");
    if (!user || user.id !== owner.id) return null;
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
    if (!repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

// GET: branch management page — lists branches with per-row "Rename" form.
branchRenameRoutes.get(
  "/:owner/:repo/settings/branches",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const error = c.req.query("error");
    const success = c.req.query("success");

    const resolved = await resolveOwned(c, ownerName, repoName);
    if (!resolved) {
      return c.html(
        <Layout title="Unauthorized" user={user}>
          <div class="empty-state">
            <h2>Unauthorized</h2>
            <p>Only the repository owner can manage branches.</p>
          </div>
        </Layout>,
        403
      );
    }

    const branches = await listBranches(ownerName, repoName);
    const defaultBranch =
      (await getDefaultBranch(ownerName, repoName)) ||
      resolved.repo.defaultBranch;

    return c.html(
      <Layout
        title={`Branches — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <div style="max-width: 720px">
          <h2 style="margin-bottom: 16px">Branches</h2>
          {error && (
            <div class="auth-error">{decodeURIComponent(error)}</div>
          )}
          {success && (
            <div class="auth-success">{decodeURIComponent(success)}</div>
          )}
          <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px">
            Renaming a branch updates open PRs that target it, branch
            protection rules with an exact-match pattern, and the default
            branch pointer (if applicable). History is preserved — only
            the ref name changes.
          </p>
          {branches.length === 0 ? (
            <div class="empty-state">
              <p>No branches yet. Push some commits to get started.</p>
            </div>
          ) : (
            <table style="width: 100%; border-collapse: collapse">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border)">
                    Branch
                  </th>
                  <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border)">
                    Rename
                  </th>
                </tr>
              </thead>
              <tbody>
                {branches.map((b) => (
                  <tr>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); font-family: var(--font-mono); font-size: 13px">
                      {b}
                      {b === defaultBranch && (
                        <span
                          class="issue-badge badge-open"
                          style="margin-left: 8px; font-size: 10px; padding: 1px 6px"
                        >
                          default
                        </span>
                      )}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right">
                      <form
                        method="POST"
                        action={`/${ownerName}/${repoName}/settings/branches/rename`}
                        style="display: inline-flex; gap: 6px"
                      >
                        <input type="hidden" name="from" value={b} />
                        <input
                          type="text"
                          name="to"
                          placeholder="new name"
                          required
                          style="padding: 4px 8px; font-size: 12px; width: 180px"
                        />
                        <button
                          type="submit"
                          class="btn"
                          style="padding: 4px 10px; font-size: 12px"
                        >
                          Rename
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Layout>
    );
  }
);

// POST: perform the rename.
branchRenameRoutes.post(
  "/:owner/:repo/settings/branches/rename",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const from = String(body.from || "").trim();
    const to = String(body.to || "").trim();
    const base = `/${ownerName}/${repoName}/settings/branches`;

    const resolved = await resolveOwned(c, ownerName, repoName);
    if (!resolved) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const existing = await listBranches(ownerName, repoName);
    const defaultBranch =
      (await getDefaultBranch(ownerName, repoName)) ||
      resolved.repo.defaultBranch;

    const plan = planRename({
      from,
      to,
      existingBranches: existing,
      defaultBranch,
    });
    if (!plan.ok) {
      const msg = (() => {
        switch (plan.reason) {
          case "same_name":
            return "New name must differ from the current name.";
          case "from_missing":
            return `Branch '${from}' does not exist.`;
          case "to_exists":
            return `A branch named '${to}' already exists.`;
          case "invalid_from":
            return `Source name is invalid: ${
              plan.detail ? branchValidationMessage(plan.detail) : "invalid"
            }`;
          case "invalid_to":
            return plan.detail
              ? branchValidationMessage(plan.detail)
              : "Invalid branch name.";
        }
      })();
      return c.redirect(`${base}?error=${encodeURIComponent(msg)}`);
    }

    // Git: move the ref. If that fails the repo state is untouched.
    const moved = await gitRenameBranch(ownerName, repoName, plan.from, plan.to);
    if (!moved) {
      return c.redirect(
        `${base}?error=${encodeURIComponent("git rename failed — check repository state.")}`
      );
    }

    // If we just renamed the default branch, point HEAD at the new name
    // and persist the new default on the repositories row.
    let cascadeErr: string | null = null;
    try {
      if (plan.updatesDefault) {
        await setHeadBranch(ownerName, repoName, plan.to);
        await db
          .update(repositories)
          .set({ defaultBranch: plan.to, updatedAt: new Date() })
          .where(eq(repositories.id, resolved.repo.id));
      }

      // PRs: rewrite base_branch + head_branch on both sides.
      await db
        .update(pullRequests)
        .set({ baseBranch: plan.to, updatedAt: new Date() })
        .where(
          and(
            eq(pullRequests.repositoryId, resolved.repo.id),
            eq(pullRequests.baseBranch, plan.from)
          )
        );
      await db
        .update(pullRequests)
        .set({ headBranch: plan.to, updatedAt: new Date() })
        .where(
          and(
            eq(pullRequests.repositoryId, resolved.repo.id),
            eq(pullRequests.headBranch, plan.from)
          )
        );

      // Merge queue entries pinned to the old base.
      await db
        .update(mergeQueueEntries)
        .set({ baseBranch: plan.to })
        .where(
          and(
            eq(mergeQueueEntries.repositoryId, resolved.repo.id),
            eq(mergeQueueEntries.baseBranch, plan.from)
          )
        );

      // Branch protection: only rewrite exact matches (never globs).
      const protections = await db
        .select()
        .from(branchProtection)
        .where(eq(branchProtection.repositoryId, resolved.repo.id));
      for (const p of protections) {
        if (shouldRewriteProtectionPattern(p.pattern, plan.from)) {
          try {
            await db
              .update(branchProtection)
              .set({ pattern: plan.to, updatedAt: new Date() })
              .where(eq(branchProtection.id, p.id));
          } catch {
            // Unique constraint on (repo, pattern) — skip if a rule
            // already exists for the new name.
          }
        }
      }
    } catch (err) {
      cascadeErr =
        err instanceof Error ? err.message : "cascade update failed";
    }

    try {
      await audit({
        userId: user.id,
        repositoryId: resolved.repo.id,
        action: "branch.rename",
        targetId: resolved.repo.id,
        metadata: {
          from: plan.from,
          to: plan.to,
          updatesDefault: plan.updatesDefault,
        },
      });
    } catch {
      // audit failures must never block the operation.
    }

    if (cascadeErr) {
      return c.redirect(
        `${base}?error=${encodeURIComponent(
          `Branch renamed but some cascades failed: ${cascadeErr}`
        )}`
      );
    }
    return c.redirect(
      `${base}?success=${encodeURIComponent(
        `Renamed '${plan.from}' → '${plan.to}'.`
      )}`
    );
  }
);

export default branchRenameRoutes;

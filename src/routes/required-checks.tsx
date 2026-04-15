/**
 * Block E6 — Required status checks matrix settings UI.
 *
 *   GET  /:owner/:repo/gates/protection/:id/checks          — manage required checks
 *   POST /:owner/:repo/gates/protection/:id/checks          — add a check name
 *   POST /:owner/:repo/gates/protection/:id/checks/:cid/delete — remove
 *
 * Required checks are scoped to a single branch-protection rule. Adding a
 * check tells the merge handler "in addition to green gates, the check with
 * this name must have a passing gate_run OR workflow_run against the head
 * commit". Name matching is exact (case-sensitive); callers typically use
 * workflow `name:` or the gate kinds (e.g. `GateTest`, `AI Review`).
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  branchProtection,
  branchRequiredChecks,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { listRequiredChecks } from "../lib/branch-protection";
import { audit } from "../lib/notify";

const required = new Hono<AuthEnv>();
required.use("*", softAuth);

async function loadRepo(ownerName: string, repoName: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

async function loadRule(repositoryId: string, ruleId: string) {
  try {
    const [rule] = await db
      .select()
      .from(branchProtection)
      .where(
        and(
          eq(branchProtection.id, ruleId),
          eq(branchProtection.repositoryId, repositoryId)
        )
      )
      .limit(1);
    return rule || null;
  } catch {
    return null;
  }
}

required.get(
  "/:owner/:repo/gates/protection/:id/checks",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/gates`);
    }
    const rule = await loadRule(repoRow.id, id);
    if (!rule) {
      return c.redirect(
        `/${owner}/${repo}/gates/settings?error=${encodeURIComponent("Rule not found")}`
      );
    }

    const checks = await listRequiredChecks(rule.id);
    const success = c.req.query("success");
    const error = c.req.query("error");

    return c.html(
      <Layout title={`Required checks — ${rule.pattern}`} user={user}>
        <RepoHeader
          owner={owner}
          repo={repo}
          starCount={repoRow.starCount}
          forkCount={repoRow.forkCount}
          currentUser={user.username}
        />
        <RepoNav owner={owner} repo={repo} active="gates" />

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3>
            Required checks · <code>{rule.pattern}</code>
          </h3>
          <a href={`/${owner}/${repo}/gates/settings`} class="btn btn-sm">
            Back to protection
          </a>
        </div>

        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
          Merges into branches matching this rule require a passing run for
          each named check. Names match against <code>gate_runs.gate_name</code>{" "}
          (e.g. <code>GateTest</code>, <code>AI Review</code>,{" "}
          <code>Secret Scan</code>, <code>Type Check</code>) or the{" "}
          <code>name:</code> field of a workflow in{" "}
          <code>.gluecron/workflows/*.yml</code>.
        </p>

        {success && <div class="auth-success">{decodeURIComponent(success)}</div>}
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}

        <div class="panel" style="margin-bottom:16px">
          {checks.length === 0 ? (
            <div class="panel-empty">No required checks configured.</div>
          ) : (
            checks.map((ch) => (
              <div class="panel-item" style="justify-content:space-between">
                <code
                  style="background:var(--bg-tertiary);padding:2px 8px;border-radius:3px"
                >
                  {ch.checkName}
                </code>
                <form
                  method="post"
                  action={`/${owner}/${repo}/gates/protection/${rule.id}/checks/${ch.id}/delete`}
                  onsubmit="return confirm('Remove this required check?')"
                >
                  <button type="submit" class="btn btn-sm btn-danger">
                    Remove
                  </button>
                </form>
              </div>
            ))
          )}
        </div>

        <form
          method="post"
          action={`/${owner}/${repo}/gates/protection/${rule.id}/checks`}
          class="panel"
          style="padding:16px"
        >
          <div class="form-group">
            <label>Check name</label>
            <input
              type="text"
              name="checkName"
              required
              placeholder="GateTest"
              style="font-family:var(--font-mono)"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Add required check
          </button>
        </form>
      </Layout>
    );
  }
);

required.post(
  "/:owner/:repo/gates/protection/:id/checks",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/gates`);
    }
    const rule = await loadRule(repoRow.id, id);
    if (!rule) {
      return c.redirect(
        `/${owner}/${repo}/gates/settings?error=${encodeURIComponent("Rule not found")}`
      );
    }

    const body = await c.req.parseBody();
    const checkName = String(body.checkName || "").trim();
    if (!checkName) {
      return c.redirect(
        `/${owner}/${repo}/gates/protection/${rule.id}/checks?error=${encodeURIComponent("Name required")}`
      );
    }

    try {
      await db
        .insert(branchRequiredChecks)
        .values({ branchProtectionId: rule.id, checkName });
    } catch (err) {
      // Likely a unique-index collision — treat as success.
      console.error("[required-checks] insert:", err);
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "branch_required_checks.create",
      targetId: rule.id,
      metadata: { checkName, pattern: rule.pattern },
    });

    return c.redirect(
      `/${owner}/${repo}/gates/protection/${rule.id}/checks?success=${encodeURIComponent("Check added")}`
    );
  }
);

required.post(
  "/:owner/:repo/gates/protection/:id/checks/:cid/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id, cid } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/gates`);
    }
    const rule = await loadRule(repoRow.id, id);
    if (!rule) {
      return c.redirect(
        `/${owner}/${repo}/gates/settings?error=${encodeURIComponent("Rule not found")}`
      );
    }

    try {
      await db
        .delete(branchRequiredChecks)
        .where(
          and(
            eq(branchRequiredChecks.id, cid),
            eq(branchRequiredChecks.branchProtectionId, rule.id)
          )
        );
    } catch (err) {
      console.error("[required-checks] delete:", err);
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "branch_required_checks.delete",
      targetId: rule.id,
    });

    return c.redirect(
      `/${owner}/${repo}/gates/protection/${rule.id}/checks?success=${encodeURIComponent("Check removed")}`
    );
  }
);

export default required;

/**
 * Block J6 — Ruleset management UI.
 *
 *   GET  /:owner/:repo/settings/rulesets            — list + create
 *   POST /:owner/:repo/settings/rulesets            — create
 *   GET  /:owner/:repo/settings/rulesets/:id        — detail, add rules
 *   POST /:owner/:repo/settings/rulesets/:id        — update enforcement
 *   POST /:owner/:repo/settings/rulesets/:id/delete
 *   POST /:owner/:repo/settings/rulesets/:id/rules  — add rule
 *   POST /:owner/:repo/settings/rulesets/:id/rules/:rid/delete
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { audit } from "../lib/notify";
import {
  RULE_TYPES,
  addRule,
  createRuleset,
  deleteRule,
  deleteRuleset,
  getRuleset,
  listRulesetsForRepo,
  parseParams,
  updateRulesetEnforcement,
} from "../lib/rulesets";

const rulesets = new Hono<AuthEnv>();
rulesets.use("*", softAuth);

async function gate(c: any) {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return c.notFound();
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return c.notFound();
  if (user.id !== repo.ownerId) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }
  return { user, owner, repo, ownerName, repoName };
}

function ruleDescription(type: string, params: Record<string, unknown>): string {
  switch (type) {
    case "commit_message_pattern":
      return `commit message ${params.require === false ? "MUST NOT" : "must"} match /${params.pattern || ""}/`;
    case "branch_name_pattern":
      return `branch name ${params.require === false ? "MUST NOT" : "must"} match /${params.pattern || ""}/`;
    case "tag_name_pattern":
      return `tag name ${params.require === false ? "MUST NOT" : "must"} match /${params.pattern || ""}/`;
    case "blocked_file_paths":
      return `blocks changes to: ${(params.paths as string[] | undefined)?.join(", ") || "(none)"}`;
    case "max_file_size":
      return `max blob size ${params.bytes || 0}B`;
    case "forbid_force_push":
      return "force push forbidden";
    default:
      return type;
  }
}

// ---------- List + create ----------

rulesets.get("/:owner/:repo/settings/rulesets", requireAuth, async (c) => {
  const ctx = await gate(c);
  if (ctx instanceof Response) return ctx;
  const { ownerName, repoName, repo, user } = ctx;
  const all = await listRulesetsForRepo(repo.id);
  const message = c.req.query("message");
  const error = c.req.query("error");
  return c.html(
    <Layout title={`Rulesets — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="settings" />
      <div class="settings-container">
        <h2>Rulesets</h2>
        <p style="color:var(--text-muted)">
          Policy engine that extends branch protection. Each ruleset contains
          multiple rules (commit messages, branch/tag names, blocked paths,
          max file size, force-push bans). Enforcement modes:
          <strong> active</strong> blocks, <strong>evaluate</strong> only logs,
          <strong> disabled</strong> is inert.
        </p>
        {message && (
          <div class="auth-success" style="margin-top:12px">
            {decodeURIComponent(message)}
          </div>
        )}
        {error && (
          <div class="auth-error" style="margin-top:12px">
            {decodeURIComponent(error)}
          </div>
        )}

        <h3 style="margin-top:24px">Existing rulesets</h3>
        {all.length === 0 ? (
          <div class="panel-empty" style="padding:16px">
            No rulesets yet.
          </div>
        ) : (
          <div class="panel">
            {all.map((rs) => (
              <div
                class="panel-item"
                style="flex-direction:column;align-items:stretch;gap:4px"
              >
                <div style="display:flex;justify-content:space-between;gap:12px">
                  <div>
                    <a
                      href={`/${ownerName}/${repoName}/settings/rulesets/${rs.id}`}
                      style="font-weight:600"
                    >
                      {rs.name}
                    </a>
                    <span
                      style={`margin-left:8px;font-size:10px;padding:2px 6px;border-radius:3px;background:${
                        rs.enforcement === "active"
                          ? "var(--red)"
                          : rs.enforcement === "evaluate"
                          ? "var(--yellow)"
                          : "var(--bg-subtle)"
                      };color:#fff;text-transform:uppercase`}
                    >
                      {rs.enforcement}
                    </span>
                    <span
                      style="margin-left:8px;color:var(--text-muted);font-size:12px"
                    >
                      {rs.rules.length} rule
                      {rs.rules.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <h3 style="margin-top:24px">New ruleset</h3>
        <form
          method="POST"
          action={`/${ownerName}/${repoName}/settings/rulesets`}
          class="auth-form"
          style="max-width:520px"
        >
          <div class="form-group">
            <label for="rs-name">Name</label>
            <input
              type="text"
              id="rs-name"
              name="name"
              placeholder="e.g. release-branches"
              required
              maxLength={120}
            />
          </div>
          <div class="form-group">
            <label for="rs-enf">Enforcement</label>
            <select id="rs-enf" name="enforcement" required>
              <option value="active">active — block on violation</option>
              <option value="evaluate">evaluate — log only</option>
              <option value="disabled">disabled</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary">
            Create ruleset
          </button>
        </form>
      </div>
    </Layout>
  );
});

rulesets.post("/:owner/:repo/settings/rulesets", requireAuth, async (c) => {
  const ctx = await gate(c);
  if (ctx instanceof Response) return ctx;
  const { ownerName, repoName, repo, user } = ctx;
  const body = await c.req.parseBody();
  const name = String(body.name || "");
  const enforcement = String(body.enforcement || "active") as
    | "active"
    | "evaluate"
    | "disabled";
  const result = await createRuleset({
    repositoryId: repo.id,
    name,
    enforcement,
    createdBy: user.id,
  });
  const base = `/${ownerName}/${repoName}/settings/rulesets`;
  if (!result.ok) {
    return c.redirect(`${base}?error=${encodeURIComponent(result.error)}`);
  }
  await audit({
    userId: user.id,
    repositoryId: repo.id,
    action: "ruleset.create",
    targetId: result.id,
    metadata: { name, enforcement },
  });
  return c.redirect(`${base}/${result.id}`);
});

// ---------- Detail ----------

rulesets.get(
  "/:owner/:repo/settings/rulesets/:id",
  requireAuth,
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const rs = await getRuleset(id, repo.id);
    if (!rs) return c.notFound();
    const base = `/${ownerName}/${repoName}/settings/rulesets/${id}`;
    const message = c.req.query("message");
    const error = c.req.query("error");
    return c.html(
      <Layout
        title={`Ruleset ${rs.name} — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="settings" />
        <div class="settings-container">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
            <div>
              <h2 style="margin:0">{rs.name}</h2>
              <span
                style={`font-size:10px;padding:2px 6px;border-radius:3px;background:${
                  rs.enforcement === "active"
                    ? "var(--red)"
                    : rs.enforcement === "evaluate"
                    ? "var(--yellow)"
                    : "var(--bg-subtle)"
                };color:#fff;text-transform:uppercase`}
              >
                {rs.enforcement}
              </span>
            </div>
            <a
              href={`/${ownerName}/${repoName}/settings/rulesets`}
              class="btn btn-sm"
            >
              ← Back
            </a>
          </div>

          {message && (
            <div class="auth-success" style="margin-top:12px">
              {decodeURIComponent(message)}
            </div>
          )}
          {error && (
            <div class="auth-error" style="margin-top:12px">
              {decodeURIComponent(error)}
            </div>
          )}

          <h3 style="margin-top:24px">Enforcement</h3>
          <form
            method="POST"
            action={base}
            style="display:flex;gap:8px;align-items:center"
          >
            <select name="enforcement">
              <option
                value="active"
                selected={rs.enforcement === "active" as any}
              >
                active
              </option>
              <option
                value="evaluate"
                selected={rs.enforcement === "evaluate" as any}
              >
                evaluate
              </option>
              <option
                value="disabled"
                selected={rs.enforcement === "disabled" as any}
              >
                disabled
              </option>
            </select>
            <button type="submit" class="btn btn-primary btn-sm">
              Update
            </button>
          </form>

          <h3 style="margin-top:24px">Rules</h3>
          {rs.rules.length === 0 ? (
            <div class="panel-empty" style="padding:16px">
              No rules in this ruleset.
            </div>
          ) : (
            <div class="panel">
              {rs.rules.map((r) => {
                const params = parseParams(r.params);
                return (
                  <div
                    class="panel-item"
                    style="flex-direction:column;align-items:stretch;gap:4px"
                  >
                    <div style="display:flex;justify-content:space-between;gap:8px">
                      <div>
                        <span
                          style="font-size:10px;padding:2px 6px;border-radius:3px;background:var(--bg-subtle);text-transform:uppercase;margin-right:6px"
                        >
                          {r.ruleType}
                        </span>
                        <span>{ruleDescription(r.ruleType, params)}</span>
                      </div>
                      <form
                        method="POST"
                        action={`${base}/rules/${r.id}/delete`}
                      >
                        <button
                          type="submit"
                          class="btn btn-sm"
                          style="font-size:11px"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <h3 style="margin-top:24px">Add rule</h3>
          <form
            method="POST"
            action={`${base}/rules`}
            class="auth-form"
            style="max-width:640px"
          >
            <div class="form-group">
              <label for="rt">Rule type</label>
              <select id="rt" name="rule_type" required>
                {RULE_TYPES.map((t) => (
                  <option value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label for="rp">
                Params (JSON) — e.g.{" "}
                <code>{`{"pattern":"^(feat|fix|chore):"}`}</code>
              </label>
              <textarea
                id="rp"
                name="params"
                rows={4}
                placeholder="{}"
                style="font-family:var(--font-mono);font-size:12px"
              ></textarea>
            </div>
            <button type="submit" class="btn btn-primary">
              Add rule
            </button>
          </form>

          <h3 style="margin-top:24px;color:var(--red)">Danger zone</h3>
          <form method="POST" action={`${base}/delete`}>
            <button type="submit" class="btn" style="color:var(--red)">
              Delete ruleset
            </button>
          </form>
        </div>
      </Layout>
    );
  }
);

rulesets.post(
  "/:owner/:repo/settings/rulesets/:id",
  requireAuth,
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const enforcement = String(body.enforcement || "active") as
      | "active"
      | "evaluate"
      | "disabled";
    const ok = await updateRulesetEnforcement(id, repo.id, enforcement);
    if (ok) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "ruleset.update",
        targetId: id,
        metadata: { enforcement },
      });
    }
    const base = `/${ownerName}/${repoName}/settings/rulesets/${id}`;
    return c.redirect(
      `${base}?${ok ? "message" : "error"}=${encodeURIComponent(
        ok ? "Updated." : "Update failed"
      )}`
    );
  }
);

rulesets.post(
  "/:owner/:repo/settings/rulesets/:id/delete",
  requireAuth,
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const ok = await deleteRuleset(id, repo.id);
    if (ok) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "ruleset.delete",
        targetId: id,
      });
    }
    const base = `/${ownerName}/${repoName}/settings/rulesets`;
    return c.redirect(
      `${base}?${ok ? "message" : "error"}=${encodeURIComponent(
        ok ? "Ruleset deleted." : "Delete failed"
      )}`
    );
  }
);

rulesets.post(
  "/:owner/:repo/settings/rulesets/:id/rules",
  requireAuth,
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const ruleType = String(body.rule_type || "") as any;
    const params = parseParams(String(body.params || "{}"));
    const base = `/${ownerName}/${repoName}/settings/rulesets/${id}`;
    const result = await addRule({
      rulesetId: id,
      repositoryId: repo.id,
      ruleType,
      params,
    });
    if (!result.ok) {
      return c.redirect(`${base}?error=${encodeURIComponent(result.error)}`);
    }
    await audit({
      userId: user.id,
      repositoryId: repo.id,
      action: "ruleset.rule.add",
      targetId: result.id,
      metadata: { ruleType, params },
    });
    return c.redirect(`${base}?message=${encodeURIComponent("Rule added.")}`);
  }
);

rulesets.post(
  "/:owner/:repo/settings/rulesets/:id/rules/:rid/delete",
  requireAuth,
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const rid = c.req.param("rid");
    const ok = await deleteRule(rid, id, repo.id);
    if (ok) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "ruleset.rule.delete",
        targetId: rid,
      });
    }
    const base = `/${ownerName}/${repoName}/settings/rulesets/${id}`;
    return c.redirect(
      `${base}?${ok ? "message" : "error"}=${encodeURIComponent(
        ok ? "Rule removed." : "Delete failed"
      )}`
    );
  }
);

export default rulesets;

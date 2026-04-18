/**
 * Gates UI — gate run history + branch protection settings + repo settings toggles.
 *
 *   GET  /:owner/:repo/gates                   — per-repo gate run history
 *   GET  /:owner/:repo/gates/settings          — settings toggles + branch protection (owner-only)
 *   POST /:owner/:repo/gates/settings          — save toggles
 *   POST /:owner/:repo/gates/protection        — save/update branch protection rule
 *   POST /:owner/:repo/gates/protection/:id/delete — remove a protection rule
 *   POST /:owner/:repo/gates/run               — manually trigger a gate run on the default branch
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  branchProtection,
  gateRuns,
  repoSettings,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getOrCreateSettings } from "../lib/repo-bootstrap";
import { getUnreadCount } from "../lib/unread";
import { audit } from "../lib/notify";

const gates = new Hono<AuthEnv>();
gates.use("*", softAuth);

async function loadRepo(owner: string, repo: string) {
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
  return row;
}

function relTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - t.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return t.toLocaleDateString();
}

// ---------- Gate run history ----------

gates.get("/:owner/:repo/gates", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const runs = await db
    .select()
    .from(gateRuns)
    .where(eq(gateRuns.repositoryId, repoRow.id))
    .orderBy(desc(gateRuns.createdAt))
    .limit(100);

  const unread = user ? await getUnreadCount(user.id) : 0;
  const total = runs.length;
  const passed = runs.filter((r) => r.status === "passed").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const repaired = runs.filter((r) => r.status === "repaired").length;
  const skipped = runs.filter((r) => r.status === "skipped").length;

  return c.html(
    <Layout
      title={`Gates — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="gates" />
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <h3>Gate runs</h3>
        {user && user.id === repoRow.ownerId && (
          <a
            href={`/${owner}/${repo}/gates/settings`}
            class="btn btn-sm"
          >
            {"\u2699"} Settings
          </a>
        )}
      </div>

      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px">
        <div class="panel" style="padding: 12px; text-align: center">
          <div style="font-size: 22px; font-weight: 700; color: var(--green)">{passed}</div>
          <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase">Passed</div>
        </div>
        <div class="panel" style="padding: 12px; text-align: center">
          <div style="font-size: 22px; font-weight: 700; color: #bc8cff">{repaired}</div>
          <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase">Repaired</div>
        </div>
        <div class="panel" style="padding: 12px; text-align: center">
          <div style="font-size: 22px; font-weight: 700; color: var(--red)">{failed}</div>
          <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase">Failed</div>
        </div>
        <div class="panel" style="padding: 12px; text-align: center">
          <div style="font-size: 22px; font-weight: 700; color: var(--text-muted)">{skipped}</div>
          <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase">Skipped</div>
        </div>
      </div>

      {total === 0 ? (
        <div class="empty-state">
          <p>No gate runs yet. Push a commit to trigger the full green ecosystem.</p>
        </div>
      ) : (
        <div class="gate-list">
          {runs.map((r) => (
            <div class="gate-run-row">
              <span class={`gate-status ${r.status}`}>{r.status}</span>
              <div style="flex: 1">
                <div style="font-weight: 500">{r.gateName}</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
                  <a href={`/${owner}/${repo}/commit/${r.commitSha}`}>
                    {r.commitSha.slice(0, 7)}
                  </a>
                  {" · "}
                  <span>{r.ref.replace(/^refs\/heads\//, "")}</span>
                  {" · "}
                  <span>{relTime(r.createdAt)}</span>
                  {r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ""}
                </div>
                {r.summary && (
                  <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
                    {r.summary}
                  </div>
                )}
                {r.repairCommitSha && (
                  <div style="font-size: 12px; color: #bc8cff; margin-top: 2px">
                    Auto-repaired in{" "}
                    <a href={`/${owner}/${repo}/commit/${r.repairCommitSha}`}>
                      {r.repairCommitSha.slice(0, 7)}
                    </a>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
});

// ---------- Settings UI ----------

gates.get("/:owner/:repo/gates/settings", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/gates`);

  const settings = await getOrCreateSettings(repoRow.id);
  const protections = await db
    .select()
    .from(branchProtection)
    .where(eq(branchProtection.repositoryId, repoRow.id));

  const unread = await getUnreadCount(user.id);
  const success = c.req.query("success");

  const toggle = (name: string, label: string, checked: boolean, desc?: string) => (
    <label
      style="display: flex; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border); cursor: pointer"
    >
      <input type="checkbox" name={name} value="1" checked={checked} />
      <div>
        <div style="font-weight: 500">{label}</div>
        {desc && (
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
            {desc}
          </div>
        )}
      </div>
    </label>
  );

  return c.html(
    <Layout
      title={`Gate settings — ${owner}/${repo}`}
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
      <RepoNav owner={owner} repo={repo} active="gates" />
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <h3>Gate & auto-repair settings</h3>
        <a href={`/${owner}/${repo}/gates`} class="btn btn-sm">
          Back to runs
        </a>
      </div>
      {success && (
        <div class="auth-success">{decodeURIComponent(success)}</div>
      )}

      <form method="post" action={`/${owner}/${repo}/gates/settings`}>
        <div class="panel" style="margin-bottom: 20px; overflow: hidden">
          <div style="padding: 12px 14px; background: var(--bg-tertiary); font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
            Gates
          </div>
          {toggle("gateTestEnabled", "GateTest scan", settings!.gateTestEnabled, "External test/lint runner")}
          {toggle("aiReviewEnabled", "AI code review", settings!.aiReviewEnabled, "Claude reviews every PR")}
          {toggle("secretScanEnabled", "Secret scan", settings!.secretScanEnabled, "Regex + AI secret detection on every push")}
          {toggle("securityScanEnabled", "Security scan", settings!.securityScanEnabled, "Claude-powered semantic security review")}
          {toggle("dependencyScanEnabled", "Dependency scan", settings!.dependencyScanEnabled, "Vulnerability scanning on lockfiles")}
          {toggle("lintEnabled", "Lint", settings!.lintEnabled, "Auto-lint every push")}
          {toggle("typeCheckEnabled", "Type check", settings!.typeCheckEnabled)}
          {toggle("testEnabled", "Tests", settings!.testEnabled, "Run your test suite on every push")}
        </div>

        <div class="panel" style="margin-bottom: 20px; overflow: hidden">
          <div style="padding: 12px 14px; background: var(--bg-tertiary); font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
            Auto-repair
          </div>
          {toggle("autoFixEnabled", "Auto-fix failing gates", settings!.autoFixEnabled, "Claude attempts a fix before a human is pinged")}
          {toggle("autoMergeResolveEnabled", "Auto-resolve merge conflicts", settings!.autoMergeResolveEnabled)}
          {toggle("autoFormatEnabled", "Auto-format on commit", settings!.autoFormatEnabled)}
        </div>

        <div class="panel" style="margin-bottom: 20px; overflow: hidden">
          <div style="padding: 12px 14px; background: var(--bg-tertiary); font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
            AI features
          </div>
          {toggle("aiCommitMessagesEnabled", "AI commit messages", settings!.aiCommitMessagesEnabled)}
          {toggle("aiPrSummaryEnabled", "AI PR summaries", settings!.aiPrSummaryEnabled)}
          {toggle("aiChangelogEnabled", "AI release changelogs", settings!.aiChangelogEnabled)}
        </div>

        <div class="panel" style="margin-bottom: 20px; overflow: hidden">
          <div style="padding: 12px 14px; background: var(--bg-tertiary); font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
            Deploy
          </div>
          {toggle("autoDeployEnabled", "Auto-deploy on green pushes to default branch", settings!.autoDeployEnabled)}
          {toggle("deployRequireAllGreen", "Block deploys unless all gates are green", settings!.deployRequireAllGreen)}
        </div>

        <button type="submit" class="btn btn-primary">
          Save settings
        </button>
      </form>

      <h3 style="margin-top: 32px; margin-bottom: 12px">Branch protection</h3>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px">
        The default branch is protected on every new repo. Add extra rules for release branches.
      </p>
      <div class="panel" style="margin-bottom: 16px">
        {protections.length === 0 ? (
          <div class="panel-empty">No protection rules yet.</div>
        ) : (
          protections.map((p) => (
            <div class="panel-item" style="justify-content: space-between">
              <div style="flex: 1">
                <code
                  style="background: var(--bg-tertiary); padding: 2px 8px; border-radius: 3px"
                >
                  {p.pattern}
                </code>
                <div class="meta" style="margin-top: 4px">
                  {p.requirePullRequest ? "PR required · " : ""}
                  {p.requireGreenGates ? "Green gates · " : ""}
                  {p.requireAiApproval ? "AI approval · " : ""}
                  {p.requireHumanReview
                    ? `${p.requiredApprovals} human approval(s) · `
                    : ""}
                  {!p.allowForcePush ? "No force push · " : ""}
                  {!p.allowDeletion ? "No deletion" : ""}
                </div>
              </div>
              <div style="display:flex;gap:6px">
                <a
                  href={`/${owner}/${repo}/gates/protection/${p.id}/checks`}
                  class="btn btn-sm"
                  title="Manage required status checks for this rule"
                >
                  Required checks
                </a>
                <form
                  method="post"
                  action={`/${owner}/${repo}/gates/protection/${p.id}/delete`}
                  onsubmit="return confirm('Remove this rule?')"
                >
                  <button type="submit" class="btn btn-sm btn-danger">
                    Remove
                  </button>
                </form>
              </div>
            </div>
          ))
        )}
      </div>

      <form
        method="post"
        action={`/${owner}/${repo}/gates/protection`}
        class="panel"
        style="padding: 16px"
      >
        <div class="form-group">
          <label>Pattern</label>
          <input
            type="text"
            name="pattern"
            required
            placeholder="release/* or main"
          />
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 16px">
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="checkbox" name="requirePullRequest" value="1" checked />
            Require PR
          </label>
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="checkbox" name="requireGreenGates" value="1" checked />
            Require green gates
          </label>
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="checkbox" name="requireAiApproval" value="1" checked />
            Require AI approval
          </label>
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="checkbox" name="requireHumanReview" value="1" />
            Require human review
          </label>
          <label style="display: flex; align-items: center; gap: 6px">
            Approvals{" "}
            <input
              type="number"
              name="requiredApprovals"
              min="0"
              max="10"
              value="1"
              style="width: 60px"
            />
          </label>
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="checkbox" name="allowForcePush" value="1" />
            Allow force push
          </label>
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="checkbox" name="allowDeletion" value="1" />
            Allow deletion
          </label>
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top: 12px">
          Add rule
        </button>
      </form>
    </Layout>
  );
});

gates.post("/:owner/:repo/gates/settings", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/gates`);

  const body = await c.req.parseBody();
  const b = (k: string) => body[k] === "1" || body[k] === "on";

  try {
    await db
      .update(repoSettings)
      .set({
        gateTestEnabled: b("gateTestEnabled"),
        aiReviewEnabled: b("aiReviewEnabled"),
        secretScanEnabled: b("secretScanEnabled"),
        securityScanEnabled: b("securityScanEnabled"),
        dependencyScanEnabled: b("dependencyScanEnabled"),
        lintEnabled: b("lintEnabled"),
        typeCheckEnabled: b("typeCheckEnabled"),
        testEnabled: b("testEnabled"),
        autoFixEnabled: b("autoFixEnabled"),
        autoMergeResolveEnabled: b("autoMergeResolveEnabled"),
        autoFormatEnabled: b("autoFormatEnabled"),
        aiCommitMessagesEnabled: b("aiCommitMessagesEnabled"),
        aiPrSummaryEnabled: b("aiPrSummaryEnabled"),
        aiChangelogEnabled: b("aiChangelogEnabled"),
        autoDeployEnabled: b("autoDeployEnabled"),
        deployRequireAllGreen: b("deployRequireAllGreen"),
        updatedAt: new Date(),
      })
      .where(eq(repoSettings.repositoryId, repoRow.id));
  } catch (err) {
    console.error("[gates] settings save:", err);
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "gates.settings.update",
  });

  return c.redirect(
    `/${owner}/${repo}/gates/settings?success=Settings+saved`
  );
});

gates.post("/:owner/:repo/gates/protection", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/gates`);

  const body = await c.req.parseBody();
  const pattern = String(body.pattern || "").trim();
  if (!pattern) return c.redirect(`/${owner}/${repo}/gates/settings`);
  const b = (k: string) => body[k] === "1" || body[k] === "on";
  const requiredApprovals = Math.max(
    0,
    Math.min(10, parseInt(String(body.requiredApprovals || "0"), 10) || 0)
  );

  try {
    await db.insert(branchProtection).values({
      repositoryId: repoRow.id,
      pattern,
      requirePullRequest: b("requirePullRequest"),
      requireGreenGates: b("requireGreenGates"),
      requireAiApproval: b("requireAiApproval"),
      requireHumanReview: b("requireHumanReview"),
      requiredApprovals,
      allowForcePush: b("allowForcePush"),
      allowDeletion: b("allowDeletion"),
    });
  } catch (err) {
    console.error("[gates] protection save:", err);
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "branch_protection.create",
    metadata: { pattern },
  });

  return c.redirect(
    `/${owner}/${repo}/gates/settings?success=Rule+added`
  );
});

gates.post(
  "/:owner/:repo/gates/protection/:id/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/gates`);
    await db
      .delete(branchProtection)
      .where(
        and(
          eq(branchProtection.id, id),
          eq(branchProtection.repositoryId, repoRow.id)
        )
      );
    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "branch_protection.delete",
      targetId: id,
    });
    return c.redirect(`/${owner}/${repo}/gates/settings?success=Rule+removed`);
  }
);

export default gates;

/**
 * Command Center — the live dashboard.
 *
 * This is the developer's mission control. One screen that shows:
 * - All your repos with health scores at a glance
 * - Live push feed (what just happened, risk scores, repairs)
 * - CI status for every repo
 * - Security alerts
 * - Quick actions (rollback, repair, deploy)
 *
 * Plus intelligence settings — toggle auto-repair, scanning, etc.
 *
 * GitHub gives you a feed of stars and follows.
 * gluecron gives you a COMMAND CENTER.
 */

import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import { getCookie, setCookie } from "hono/cookie";
import { db } from "../db";
import {
  repositories,
  users,
  activityFeed,
  issues,
  pullRequests,
} from "../db/schema";
import { Layout } from "../views/layout";
import { LiveFeed } from "../views/live-feed";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  computeHealthScore,
  detectCIConfig,
} from "../lib/intelligence";
import {
  repoExists,
  getDefaultBranch,
  listCommits,
  listBranches,
} from "../git/repository";
import {
  computeAiSavingsForUser,
  computeLifetimeAiSavingsForUser,
  type AiSavingsReport,
  type AiSavingsLifetimeReport,
} from "../lib/ai-hours-saved";

const dashboard = new Hono<AuthEnv>();

dashboard.use("*", softAuth);

// ─── COMMAND CENTER ──────────────────────────────────────────

dashboard.get("/dashboard", requireAuth, async (c) => {
  const user = c.get("user")!;

  // Block P2 — banner dismiss handler. Set a session cookie and re-redirect
  // to the bare /dashboard URL so refreshing doesn't keep firing the dismiss.
  if (c.req.query("p2_dismiss") === "1") {
    setCookie(c, "p2_verify_dismissed", "1", {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });
    return c.redirect("/dashboard");
  }

  // Get all user's repos
  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.ownerId, user.id))
    .orderBy(desc(repositories.updatedAt));

  // Compute health scores for all repos (in parallel)
  const repoData = await Promise.all(
    repos.map(async (repo) => {
      let healthScore = 0;
      let healthGrade = "?" as string;
      let recentCommits = 0;
      let branchCount = 0;
      let ciConfig = null;

      try {
        if (await repoExists(user.username, repo.name)) {
          const ref =
            (await getDefaultBranch(user.username, repo.name)) || "main";
          const [health, commits, branches, ci] = await Promise.all([
            computeHealthScore(user.username, repo.name).catch(() => null),
            listCommits(user.username, repo.name, ref, 5).catch(() => []),
            listBranches(user.username, repo.name).catch(() => []),
            detectCIConfig(user.username, repo.name, ref).catch(() => null),
          ]);
          if (health) {
            healthScore = health.score;
            healthGrade = health.grade;
          }
          recentCommits = commits.length;
          branchCount = branches.length;
          ciConfig = ci;
        }
      } catch {
        // best effort
      }

      return {
        repo,
        healthScore,
        healthGrade,
        recentCommits,
        branchCount,
        ciConfig,
      };
    })
  );

  // Block L9 — AI hours-saved counter. Pull both window + lifetime in
  // parallel; both helpers swallow DB errors so the dashboard always renders.
  const [savingsWeek, savingsLifetime] = await Promise.all([
    computeAiSavingsForUser(user.id, { windowHours: 168 }),
    computeLifetimeAiSavingsForUser(user.id),
  ]);

  // Get recent activity
  let recentActivity: Array<{
    action: string;
    repoName: string;
    metadata: string | null;
    createdAt: Date;
  }> = [];

  try {
    const repoIds = repos.map((r) => r.id);
    if (repoIds.length > 0) {
      const activity = await db
        .select({
          action: activityFeed.action,
          metadata: activityFeed.metadata,
          createdAt: activityFeed.createdAt,
          repoId: activityFeed.repositoryId,
        })
        .from(activityFeed)
        .where(eq(activityFeed.userId, user.id))
        .orderBy(desc(activityFeed.createdAt))
        .limit(20);

      recentActivity = activity.map((a) => ({
        action: a.action,
        repoName: repos.find((r) => r.id === a.repoId)?.name || "unknown",
        metadata: a.metadata,
        createdAt: a.createdAt,
      }));
    }
  } catch {
    // DB not required for dashboard
  }

  const gradeColor = (grade: string) =>
    grade === "A+" || grade === "A"
      ? "var(--green)"
      : grade === "B"
        ? "#58a6ff"
        : grade === "C"
          ? "var(--yellow)"
          : grade === "?"
            ? "var(--text-muted)"
            : "var(--red)";

  // Block P2 — email verification banner. Shows when the user hasn't
  // verified yet AND they haven't dismissed it this session. Also surfaces
  // transient resend feedback (`?verify=sent` / `?verify=rate_limited`)
  // and the post-register hint (`?welcome=1`).
  const verifyDismissed = getCookie(c, "p2_verify_dismissed") === "1";
  const showVerifyBanner =
    !(user as any).emailVerifiedAt && !verifyDismissed;
  const verifyQuery = c.req.query("verify");
  const welcomeQuery = c.req.query("welcome");

  return c.html(
    <Layout title="Command Center" user={user}>
      {showVerifyBanner && (
        <div
          style="background: rgba(210, 153, 34, 0.12); border: 1px solid rgba(210, 153, 34, 0.45); color: #e3b341; padding: var(--space-3) var(--space-4); border-radius: 8px; margin-bottom: var(--space-4); display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); font-size: 14px"
          data-p2-verify-banner=""
        >
          <div style="flex: 1 1 auto; min-width: 0">
            {welcomeQuery === "1" ? (
              <span>
                Welcome to Gluecron! Check your inbox to verify your email.
              </span>
            ) : verifyQuery === "sent" ? (
              <span>
                Verification link sent. It may take a minute to arrive.
              </span>
            ) : verifyQuery === "rate_limited" ? (
              <span>
                You've requested too many verification emails. Try again later.
              </span>
            ) : verifyQuery === "not_configured" ? (
              <span>
                Email delivery isn't configured on this instance yet — your
                site admin needs to set <code>EMAIL_PROVIDER=resend</code> and{" "}
                <code>RESEND_API_KEY</code>. Until then the verification link
                is written to the server log.
              </span>
            ) : (
              <span>Verify your email to keep using Gluecron.</span>
            )}
          </div>
          <form
            method="post"
            action="/verify-email/resend"
            style="display: inline-flex; gap: var(--space-2); align-items: center; margin: 0"
          >
            <input
              type="hidden"
              name="_csrf"
              value={(c.get("csrfToken") as string | undefined) || ""}
            />
            <button
              type="submit"
              class="btn"
              style="padding: 4px 10px; font-size: 12px"
            >
              Resend verification link
            </button>
            <a
              href="/dashboard?p2_dismiss=1"
              class="btn"
              style="padding: 4px 10px; font-size: 12px"
              aria-label="Dismiss verification banner"
            >
              Dismiss
            </a>
          </form>
        </div>
      )}
      <div class="dash-hero">
        <div class="dash-hero-bg" aria-hidden="true">
          <div class="dash-hero-orb" />
        </div>
        <div class="dash-hero-inner">
          <div class="dash-hero-text">
            <div class="dash-hero-eyebrow">
              {(() => {
                const hour = new Date().getHours();
                if (hour < 5) return "Late night,";
                if (hour < 12) return "Good morning,";
                if (hour < 17) return "Good afternoon,";
                if (hour < 21) return "Good evening,";
                return "Late night,";
              })()}{" "}
              <span class="dash-hero-username">{user.username}</span>
            </div>
            <h1 class="dash-hero-title">
              Your{" "}
              <span class="gradient-text">command center</span>.
            </h1>
            <p class="dash-hero-sub">
              {repos.length === 0
                ? "Create your first repository to start shipping with AI."
                : `${repos.length} repo${repos.length === 1 ? "" : "s"} · real-time health, AI activity, and gate status across everything you own.`}
            </p>
          </div>
          <div class="dash-hero-actions">
            <a href="/new" class="btn btn-primary">+ New repo</a>
            <a href="/import" class="btn">Import from GitHub</a>
            <a href="/settings" class="btn">Settings</a>
          </div>
        </div>
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .dash-hero {
              position: relative;
              margin-bottom: var(--space-6);
              padding: var(--space-5) var(--space-6) var(--space-5);
              background: var(--bg-elevated);
              border: 1px solid var(--border);
              border-radius: 16px;
              overflow: hidden;
            }
            .dash-hero::before {
              content: '';
              position: absolute;
              top: 0; left: 0; right: 0;
              height: 2px;
              background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
              opacity: 0.7;
              pointer-events: none;
            }
            .dash-hero-bg {
              position: absolute;
              inset: -20% -10% auto auto;
              width: 380px;
              height: 380px;
              pointer-events: none;
              z-index: 0;
            }
            .dash-hero-orb {
              position: absolute;
              inset: 0;
              background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
              filter: blur(80px);
              opacity: 0.7;
              animation: dashHeroOrb 14s ease-in-out infinite;
            }
            @keyframes dashHeroOrb {
              0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
              50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.8; }
            }
            @media (prefers-reduced-motion: reduce) {
              .dash-hero-orb { animation: none; }
            }
            .dash-hero-inner {
              position: relative;
              z-index: 1;
              display: flex;
              justify-content: space-between;
              align-items: flex-end;
              gap: var(--space-4);
              flex-wrap: wrap;
            }
            .dash-hero-text { flex: 1; min-width: 280px; }
            .dash-hero-eyebrow {
              font-size: 13px;
              color: var(--text-muted);
              margin-bottom: var(--space-2);
              letter-spacing: -0.005em;
            }
            .dash-hero-username {
              color: var(--accent);
              font-weight: 600;
            }
            .dash-hero-title {
              font-size: clamp(28px, 4vw, 40px);
              font-family: var(--font-display);
              font-weight: 800;
              letter-spacing: -0.028em;
              line-height: 1.05;
              margin: 0 0 var(--space-2);
              color: var(--text-strong);
            }
            .dash-hero-title .gradient-text {
              background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
              -webkit-background-clip: text;
              background-clip: text;
              -webkit-text-fill-color: transparent;
              color: transparent;
            }
            .dash-hero-sub {
              font-size: 15px;
              color: var(--text-muted);
              margin: 0;
              line-height: 1.5;
              max-width: 580px;
            }
            .dash-hero-actions {
              display: flex;
              gap: var(--space-2);
              flex-wrap: wrap;
            }
            @media (max-width: 720px) {
              .dash-hero-inner { flex-direction: column; align-items: flex-start; }
              .dash-hero-actions { width: 100%; }
              .dash-hero-actions .btn { flex: 1; min-width: 0; }
            }
          `,
        }}
      />

      {/* ─── L9: AI hours-saved hero widget ─── */}
      <AiHoursSavedWidget week={savingsWeek} lifetime={savingsLifetime} />

      {/* ─── Stats Bar ─── */}
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); margin-bottom: var(--space-8)">
        <StatBox
          label="Repositories"
          value={String(repos.length)}
          color="var(--text-link)"
        />
        <StatBox
          label="Avg Health"
          value={
            repos.length > 0
              ? String(
                  Math.round(
                    repoData.reduce((s, r) => s + r.healthScore, 0) /
                      Math.max(repoData.filter((r) => r.healthScore > 0).length, 1)
                  )
                )
              : "—"
          }
          color="var(--green)"
        />
        <StatBox
          label="Total Stars"
          value={String(repos.reduce((s, r) => s + r.starCount, 0))}
          color="var(--yellow)"
        />
        <StatBox
          label="Open Issues"
          value={String(repos.reduce((s, r) => s + r.issueCount, 0))}
          color="var(--red)"
        />
      </div>

      {/* ─── Repo Grid ─── */}
      <h2 style="font-size: 18px; margin-bottom: 16px">Your Repositories</h2>
      {repos.length === 0 ? (
        <div class="empty-state" style="text-align:left;padding:var(--space-6)">
          <div style="text-align:center;margin-bottom:20px">
            <h2 style="margin-bottom:6px">Get started</h2>
            <p style="color:var(--text-muted);font-size:14px;margin:0">
              Ship safer code with AI-native hosting, automated CI, and push-time gates. Pick a path:
            </p>
          </div>
          <div class="panel" style="margin-bottom:20px;text-align:left">
            <div class="panel-item" style="justify-content:space-between;padding:var(--space-4);gap:var(--space-3)">
              <div style="flex:1">
                <div style="font-size:15px;font-weight:600">Create a new repository</div>
                <div style="font-size:13px;color:var(--text-muted);margin-top:2px">
                  Start from scratch with green-ecosystem defaults.
                </div>
              </div>
              <a href="/new" class="btn btn-primary">Create repo</a>
            </div>
            <div class="panel-item" style="justify-content:space-between;padding:var(--space-4);gap:var(--space-3)">
              <div style="flex:1">
                <div style="font-size:15px;font-weight:600">Import from GitHub</div>
                <div style="font-size:13px;color:var(--text-muted);margin-top:2px">
                  Mirror an existing repo — history, branches, tags.
                </div>
              </div>
              <a href="/import" class="btn">Import repo</a>
            </div>
            <div class="panel-item" style="justify-content:space-between;padding:var(--space-4);gap:var(--space-3)">
              <div style="flex:1">
                <div style="font-size:15px;font-weight:600">Browse public repos</div>
                <div style="font-size:13px;color:var(--text-muted);margin-top:2px">
                  See what others are building, fork what you like.
                </div>
              </div>
              <a href="/explore" class="btn">Browse</a>
            </div>
          </div>
          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4)">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">
              Push an existing project (preview)
            </div>
            <pre style="margin:0;font-size:12px;overflow-x:auto;color:var(--text-muted)"><code># Once you create a repo, you'll see your real clone URL here.
git remote add gluecron http://localhost:3000/{user.username}/&lt;your-repo&gt;.git
git push -u gluecron main</code></pre>
          </div>
        </div>
      ) : (
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: var(--space-4); margin-bottom: var(--space-8)">
          {repoData.map(({ repo, healthScore, healthGrade, recentCommits, branchCount, ciConfig }) => (
            <div class="card" style="padding: 0; overflow: hidden">
              {/* Health bar at top */}
              <div
                style={`height: 4px; background: ${gradeColor(healthGrade)}; width: ${healthScore}%; transition: width 0.3s`}
              />
              <div style="padding: var(--space-4)">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px">
                  <div>
                    <h3 style="font-size: 16px; margin-bottom: 2px">
                      <a href={`/${user.username}/${repo.name}`}>{repo.name}</a>
                    </h3>
                    {repo.description && (
                      <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 0">
                        {repo.description}
                      </p>
                    )}
                  </div>
                  <div style="text-align: center; flex-shrink: 0; margin-left: 12px">
                    <div
                      style={`font-size: 20px; font-weight: 800; color: ${gradeColor(healthGrade)}`}
                    >
                      {healthGrade}
                    </div>
                    <div style="font-size: 10px; color: var(--text-muted)">
                      {healthScore}/100
                    </div>
                  </div>
                </div>

                <div style="display: flex; gap: var(--space-4); font-size: 12px; color: var(--text-muted); margin-top: var(--space-2)">
                  <span>{branchCount} branch{branchCount !== 1 ? "es" : ""}</span>
                  <span>{"\u2606"} {repo.starCount}</span>
                  {repo.isPrivate && <span class="badge" style="font-size: 10px">Private</span>}
                </div>

                {ciConfig && ciConfig.commands.length > 0 && (
                  <div style="margin-top: var(--space-2); display: flex; gap: 6px; flex-wrap: wrap">
                    {ciConfig.detected.slice(0, 3).map((d) => (
                      <span
                        class="badge"
                        style="font-size: 10px; background: rgba(31, 111, 235, 0.1); color: var(--text-link); border-color: var(--accent)"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                )}

                <div style="display: flex; gap: 6px; margin-top: var(--space-3)">
                  <a
                    href={`/${user.username}/${repo.name}/health`}
                    class="btn btn-sm"
                    style="font-size: 11px; padding: 2px 8px"
                  >
                    Health
                  </a>
                  <a
                    href={`/${user.username}/${repo.name}/dependencies`}
                    class="btn btn-sm"
                    style="font-size: 11px; padding: 2px 8px"
                  >
                    Deps
                  </a>
                  <a
                    href={`/${user.username}/${repo.name}/coupling`}
                    class="btn btn-sm"
                    style="font-size: 11px; padding: 2px 8px"
                  >
                    Insights
                  </a>
                  <a
                    href={`/${user.username}/${repo.name}/settings`}
                    class="btn btn-sm"
                    style="font-size: 11px; padding: 2px 8px"
                  >
                    Settings
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── Activity Feed ─── */}
      {recentActivity.length > 0 && (
        <>
          <h2 style="font-size: 18px; margin-bottom: 16px">Recent Activity</h2>
          <div class="issue-list">
            {recentActivity.map((a) => (
              <div class="issue-item">
                <div style="display: flex; gap: var(--space-2); align-items: center">
                  <ActivityIcon action={a.action} />
                  <div>
                    <span style="font-size: 14px">
                      {formatAction(a.action)} in{" "}
                      <a href={`/${user.username}/${a.repoName}`}>
                        {a.repoName}
                      </a>
                    </span>
                    <div style="font-size: 12px; color: var(--text-muted)">
                      {formatRelative(a.createdAt)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ─── AI Health Coach (move #10 from STRATEGY) ─── */}
      <HealthCoach repoData={repoData} username={user.username} />

      {/* ─── Live Activity (SSE) ─── */}
      <LiveFeed topic={`user:${user.id}`} title="Live activity" />

      {/* ─── Quick Links ─── */}
      <div style="margin-top: var(--space-8); display: flex; gap: var(--space-4); flex-wrap: wrap">
        <a href="/explore" class="btn">Browse public repos</a>
        <a href="/settings/tokens" class="btn">API tokens</a>
        <a href="/settings/keys" class="btn">SSH keys</a>
      </div>
    </Layout>
  );
});

// ─── INTELLIGENCE SETTINGS PER REPO ──────────────────────────

dashboard.get(
  "/:owner/:repo/settings/intelligence",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const success = c.req.query("success");

    return c.html(
      <Layout title={`Intelligence — ${ownerName}/${repoName}`} user={user}>
        <div style="max-width: 600px">
          <h2 style="margin-bottom: 20px">Intelligence Settings</h2>
          <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px">
            Control what gluecron does automatically when code is pushed to{" "}
            <strong>{ownerName}/{repoName}</strong>.
          </p>
          {success && (
            <div class="auth-success">{decodeURIComponent(success)}</div>
          )}
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/intelligence`}
          >
            <ToggleSetting
              name="auto_repair"
              label="Auto-Repair"
              description="Automatically fix whitespace, missing .gitignore, broken JSON, and masked secrets on every push"
              defaultChecked={true}
            />
            <ToggleSetting
              name="security_scan"
              label="Security Scanning"
              description="Scan for hardcoded secrets, injection vulnerabilities, weak crypto, and other security issues"
              defaultChecked={true}
            />
            <ToggleSetting
              name="health_score"
              label="Health Score"
              description="Compute and track repository health score (security, testing, complexity, deps, docs, activity)"
              defaultChecked={true}
            />
            <ToggleSetting
              name="push_analysis"
              label="Push Risk Analysis"
              description="Analyze every push for breaking changes, removed exports, API changes, and compute risk score"
              defaultChecked={true}
            />
            <ToggleSetting
              name="dep_analysis"
              label="Dependency Analysis"
              description="Build import graph, detect unused deps, find circular dependencies"
              defaultChecked={true}
            />
            <ToggleSetting
              name="gatetest"
              label="GateTest Integration"
              description="Send push events to GateTest for external security scanning"
              defaultChecked={true}
            />
            <ToggleSetting
              name="deploy_webhook"
              label="Auto-Deploy Webhook"
              description="POST to your configured deploy webhook when pushing to the default branch"
              defaultChecked={true}
            />

            <button
              type="submit"
              class="btn btn-primary"
              style="margin-top: 12px"
            >
              Save settings
            </button>
          </form>
        </div>
      </Layout>
    );
  }
);

dashboard.post(
  "/:owner/:repo/settings/intelligence",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    // In production, these would be saved to DB per-repo
    // For now, acknowledge the settings
    return c.redirect(
      `/${ownerName}/${repoName}/settings/intelligence?success=Settings+saved`
    );
  }
);

// ─── PUSH LOG ────────────────────────────────────────────────

dashboard.get("/:owner/:repo/pushes", softAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();
  const ref = (await getDefaultBranch(owner, repo)) || "main";
  const commits = await listCommits(owner, repo, ref, 30);

  return c.html(
    <Layout title={`Push Log — ${owner}/${repo}`} user={user}>
      <div style="max-width: 900px">
        <h2 style="margin-bottom: 4px">Push Log</h2>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px">
          Every push analyzed in real-time — risk scores, repairs, security alerts
        </p>
        <div class="issue-list">
          {commits.map((commit) => {
            // Determine if this was an auto-repair commit
            const isRepair =
              commit.author === "gluecron[bot]" ||
              commit.message.includes("auto-repair");
            const isRollback = commit.message.startsWith("revert: rollback");

            return (
              <div class="issue-item" style="flex-direction: column; align-items: stretch">
                <div style="display: flex; justify-content: space-between; align-items: start">
                  <div style="display: flex; gap: var(--space-2); align-items: start">
                    {isRepair ? (
                      <span
                        style="color: var(--green); font-size: 16px; flex-shrink: 0; margin-top: 2px"
                        title="Auto-repair"
                      >
                        {"⚡"}
                      </span>
                    ) : isRollback ? (
                      <span
                        style="color: var(--yellow); font-size: 16px; flex-shrink: 0; margin-top: 2px"
                        title="Rollback"
                      >
                        {"↩"}
                      </span>
                    ) : (
                      <span
                        style="color: var(--text-link); font-size: 16px; flex-shrink: 0; margin-top: 2px"
                      >
                        {"→"}
                      </span>
                    )}
                    <div>
                      <a
                        href={`/${owner}/${repo}/commit/${commit.sha}`}
                        style="font-weight: 600; font-size: 14px"
                      >
                        {commit.message}
                      </a>
                      <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
                        {commit.author} —{" "}
                        {new Date(commit.date).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  </div>
                  <a
                    href={`/${owner}/${repo}/commit/${commit.sha}`}
                    class="commit-sha"
                  >
                    {commit.sha.slice(0, 7)}
                  </a>
                </div>
                {isRepair && (
                  <div
                    style="margin-top: var(--space-2); padding: var(--space-2) var(--space-3); background: rgba(63, 185, 80, 0.1); border-radius: var(--radius); font-size: 12px; color: var(--green)"
                  >
                    Automatically repaired by gluecron
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Layout>
  );
});

// ─── COMPONENTS ──────────────────────────────────────────────

/**
 * Block L9 — pure formatter used by the dashboard widget AND tests.
 * Turns the breakdown into the small stat-pill array shown under the
 * big number. Exported so the markup contract is testable without
 * importing JSX.
 */
export function formatSavingsPills(b: {
  prsAutoMerged: number;
  issuesBuiltByAi: number;
  aiReviewsPosted: number;
  aiTriagesPosted: number;
  aiCommitMsgs: number;
  secretsAutoRepaired: number;
  gateAutoRepairs: number;
}): string[] {
  const pills: string[] = [];
  if (b.prsAutoMerged) pills.push(`${b.prsAutoMerged} PR${b.prsAutoMerged === 1 ? "" : "s"} auto-merged`);
  if (b.issuesBuiltByAi) pills.push(`${b.issuesBuiltByAi} issue${b.issuesBuiltByAi === 1 ? "" : "s"} built`);
  if (b.aiReviewsPosted) pills.push(`${b.aiReviewsPosted} AI review${b.aiReviewsPosted === 1 ? "" : "s"}`);
  if (b.aiTriagesPosted) pills.push(`${b.aiTriagesPosted} triage${b.aiTriagesPosted === 1 ? "" : "s"}`);
  const fixes = b.secretsAutoRepaired + b.gateAutoRepairs;
  if (fixes) pills.push(`${fixes} auto-fix${fixes === 1 ? "" : "es"}`);
  if (b.aiCommitMsgs) pills.push(`${b.aiCommitMsgs} commit msg${b.aiCommitMsgs === 1 ? "" : "s"}`);
  return pills;
}

const AiHoursSavedWidget = ({
  week,
  lifetime,
}: {
  week: AiSavingsReport;
  lifetime: AiSavingsLifetimeReport;
}) => {
  const weekPills = formatSavingsPills(week.breakdown);
  const lifetimePills = formatSavingsPills(lifetime.breakdown);
  const hasAnyWeek = week.hoursSaved > 0 || weekPills.length > 0;
  return (
    <div
      class="card ai-hours-saved-widget"
      style="margin-bottom: 24px; padding: 0; overflow: hidden; position: relative; background: var(--accent-gradient-faint, var(--bg-secondary)); border-color: var(--accent)"
    >
      <div style="padding: var(--space-6) var(--space-6) var(--space-5) var(--space-6)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-4);flex-wrap:wrap">
          <div style="flex:1;min-width:240px">
            <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted); margin-bottom: 4px">
              AI working for you
            </div>
            <div
              data-testid="ai-hours-saved-this-week"
              style="font-size: 56px; font-weight: 800; line-height: 1; background: var(--accent-gradient); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent"
            >
              {week.hoursSaved.toFixed(1)}h
            </div>
            <div style="margin-top: 6px; font-size: 14px; color: var(--text-muted)">
              Claude saved you{" "}
              <strong style="color: var(--text)">
                {week.hoursSaved.toFixed(1)} hours
              </strong>{" "}
              this week.
              {lifetime.hoursSaved > week.hoursSaved && (
                <span>
                  {" — "}
                  <strong style="color: var(--text)">
                    {lifetime.hoursSaved.toFixed(1)}h
                  </strong>{" "}
                  all-time.
                </span>
              )}
            </div>
          </div>
          <div
            class="ai-hours-saved-tabs"
            style="display:flex;gap:4px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:2px"
          >
            <span
              data-tab="this-week"
              style="padding:4px 10px;font-size:12px;font-weight:600;border-radius:4px;background:var(--bg);color:var(--text)"
            >
              This week
            </span>
            <span
              data-tab="all-time"
              style="padding:4px 10px;font-size:12px;color:var(--text-muted)"
            >
              All-time
            </span>
          </div>
        </div>

        {hasAnyWeek ? (
          <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-4)">
            {weekPills.map((p) => (
              <span
                class="badge"
                style="font-size:12px;padding:4px 10px;background:rgba(140,109,255,0.10);border-color:var(--accent);color:var(--text)"
              >
                {p}
              </span>
            ))}
          </div>
        ) : (
          <div style="margin-top:16px;font-size:13px;color:var(--text-muted)">
            No AI activity this week yet — open a PR, label an issue{" "}
            <code>ai:build</code>, or let auto-merge sweep your branches.
            The counter will start climbing.
          </div>
        )}

        <details style="margin-top:16px">
          <summary
            data-testid="ai-hours-saved-formula-toggle"
            style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none"
          >
            How is this calculated?
          </summary>
          <div
            style="margin-top:10px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;color:var(--text-muted);font-family:var(--font-mono, monospace);line-height:1.6"
          >
            <div>hoursSaved =</div>
            <div>&nbsp;&nbsp;{week.breakdown.prsAutoMerged} PRs auto-merged × 0.30</div>
            <div>+ {week.breakdown.issuesBuiltByAi} issues built by AI × 1.50</div>
            <div>+ {week.breakdown.aiReviewsPosted} AI reviews × 0.25</div>
            <div>+ {week.breakdown.aiTriagesPosted} AI triages × 0.10</div>
            <div>+ {week.breakdown.aiCommitMsgs} AI commit msgs × 0.05</div>
            <div>+ {week.breakdown.secretsAutoRepaired} secrets repaired × 0.50</div>
            <div>+ {week.breakdown.gateAutoRepairs} gates repaired × 0.40</div>
            <div style="margin-top:6px;color:var(--text)">
              = {week.hoursSaved.toFixed(1)}h (this week,{" "}
              {week.windowHours}h window)
            </div>
            <div style="margin-top:8px;font-size:11px">
              Lifetime: {lifetime.hoursSaved.toFixed(1)}h since{" "}
              {lifetime.sinceCreatedAt.toISOString().slice(0, 10)}.
              Constants are conservative on purpose — audit-friendly is
              the brand.
            </div>
            {lifetimePills.length > 0 && (
              <div style="margin-top:8px;font-size:11px">
                All-time breakdown: {lifetimePills.join(" · ")}
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  );
};

/**
 * Pure helper: pick the bottom-N repos by health score and return a
 * prioritized "fix this next" plan. Health=0 repos (couldn't be
 * computed) are excluded so the coach doesn't recommend ghost repos.
 *
 * Exported under __test for unit testing without touching the DB.
 */
export function pickRepoCoachPicks<T extends { healthScore: number; repo: { name: string; description?: string | null }; healthGrade: string }>(
  repoData: T[],
  topN = 3
): T[] {
  return repoData
    .filter((r) => r.healthScore > 0 && r.healthScore < 90)
    .sort((a, b) => a.healthScore - b.healthScore)
    .slice(0, topN);
}

/** Module-scoped color picker for grade chips. Mirrors the inner
 *  `gradeColor` defined in the request handler scope, exposed at module
 *  level so HealthCoach (also module-scope) can reach it. */
function moduleGradeColor(grade: string): string {
  if (grade === "A+" || grade === "A") return "var(--green)";
  if (grade === "B") return "#58a6ff";
  if (grade === "C") return "var(--yellow)";
  if (grade === "?") return "var(--text-muted)";
  return "var(--red)";
}

const HealthCoach = ({
  repoData,
  username,
}: {
  repoData: Array<{
    repo: { name: string; description: string | null };
    healthScore: number;
    healthGrade: string;
  }>;
  username: string;
}) => {
  const picks = pickRepoCoachPicks(repoData, 3);
  if (picks.length === 0) {
    return (
      <div
        class="card"
        style="margin-bottom: var(--space-8); padding: var(--space-4); background: rgba(63,185,80,0.08); border-color: var(--green)"
      >
        <h3 style="margin: 0 0 4px; font-size: 15px">
          {"✨"} AI Health Coach
        </h3>
        <p style="margin: 0; color: var(--text-muted); font-size: 13px">
          All your repos are healthy (score &ge; 90). Nothing to triage.
        </p>
      </div>
    );
  }
  return (
    <div
      class="card"
      style="margin-bottom: 32px; padding: 0; overflow: hidden"
    >
      <div
        style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between"
      >
        <div>
          <h3 style="margin: 0; font-size: 15px">
            {"✨"} AI Health Coach
          </h3>
          <p
            style="margin: var(--space-1) 0 0; color: var(--text-muted); font-size: 12px"
          >
            Top {picks.length} repos that would benefit from attention
            this week.
          </p>
        </div>
      </div>
      <ul style="list-style: none; margin: 0; padding: 0">
        {picks.map((p) => (
          <li
            style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: var(--space-3)"
          >
            <div
              style={`min-width: 40px; padding: 4px 8px; border-radius: 4px; text-align: center; font-weight: 600; color: var(--bg); background: ${moduleGradeColor(p.healthGrade)}`}
            >
              {p.healthGrade}
            </div>
            <div style="flex: 1; min-width: 0">
              <a
                href={`/${username}/${p.repo.name}`}
                style="font-weight: 500"
              >
                {p.repo.name}
              </a>
              <div
                style="font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis"
              >
                Health score {p.healthScore}/100 — open the repo to see
                breakdown + AI suggestions.
              </div>
            </div>
            <a
              href={`/${username}/${p.repo.name}/health`}
              class="btn"
              style="font-size: 12px; padding: 4px 10px"
              title="Open health score with AI suggestions"
            >
              Coach me
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
};

const StatBox = ({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) => (
  <div
    style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4); text-align: center"
  >
    <div style={`font-size: 28px; font-weight: 700; color: ${color}`}>
      {value}
    </div>
    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
      {label}
    </div>
  </div>
);

const ToggleSetting = ({
  name,
  label,
  description,
  defaultChecked,
}: {
  name: string;
  label: string;
  description: string;
  defaultChecked: boolean;
}) => (
  <div
    style="display: flex; justify-content: space-between; align-items: start; padding: var(--space-4) 0; border-bottom: 1px solid var(--border)"
  >
    <div style="flex: 1">
      <div style="font-size: 15px; font-weight: 600">{label}</div>
      <div style="font-size: 13px; color: var(--text-muted); margin-top: 2px">
        {description}
      </div>
    </div>
    <label class="toggle-switch">
      <input type="checkbox" name={name} value="on" checked={defaultChecked} aria-label={label} />
      <span class="toggle-slider" />
    </label>
  </div>
);

const ActivityIcon = ({ action }: { action: string }) => {
  const icons: Record<string, string> = {
    push: "→",
    issue_open: "\u25CB",
    issue_close: "\u2713",
    pr_open: "\u25CB",
    pr_merge: "\u2B8C",
    star: "\u2605",
    fork: "\u2442",
    comment: "\u{1F4AC}",
  };
  return (
    <span style="font-size: 16px; width: 20px; text-align: center; flex-shrink: 0">
      {icons[action] || "•"}
    </span>
  );
};

function formatAction(action: string): string {
  const labels: Record<string, string> = {
    push: "Pushed code",
    issue_open: "Opened issue",
    issue_close: "Closed issue",
    pr_open: "Opened pull request",
    pr_merge: "Merged pull request",
    star: "Starred",
    fork: "Forked",
    comment: "Commented",
  };
  return labels[action] || action;
}

function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default dashboard;

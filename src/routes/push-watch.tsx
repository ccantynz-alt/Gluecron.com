/**
 * Push Watch — per-push live status page.
 *
 * Routes:
 *   GET  /:owner/:repo/push/:sha         — HTML page for this push
 *   GET  /api/repos/:owner/:repo/push-status/:sha — JSON polling endpoint
 *
 * Shows the developer everything that happened after their push:
 * commit info, gate results, deployment status, and push-to-live latency.
 * A plain JS 5-second poller refreshes the gate/deploy cards while any
 * item is still in a non-terminal state.
 */

import { Hono } from "hono";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../db";
import {
  activityFeed,
  gateRuns,
  deployments,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { getUnreadCount } from "../lib/unread";

const pushWatchRoutes = new Hono<AuthEnv>();

// Apply soft auth on every push-watch route so the repo-access middleware can
// read the resolved user.
pushWatchRoutes.use("/:owner/:repo/push/*", softAuth);
pushWatchRoutes.use("/api/repos/:owner/:repo/push-status/*", softAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function relTime(d: Date | string | null): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - t.getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return t.toLocaleDateString();
}

function formatLatency(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSecs = Math.round(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type GateStatus = "running" | "passed" | "failed" | "repaired" | "pending" | "skipped";

function gateStatusClass(status: string): string {
  const map: Record<string, string> = {
    passed: "pw-pill-green",
    repaired: "pw-pill-teal",
    failed: "pw-pill-red",
    running: "pw-pill-yellow",
    pending: "pw-pill-gray",
    skipped: "pw-pill-gray",
  };
  return map[status] ?? "pw-pill-gray";
}

function deployStatusClass(status: string): string {
  const map: Record<string, string> = {
    success: "pw-pill-green",
    pending: "pw-pill-yellow",
    running: "pw-pill-yellow",
    failure: "pw-pill-red",
    failed: "pw-pill-red",
    blocked: "pw-pill-gray",
    waiting_timer: "pw-pill-gray",
  };
  return map[status] ?? "pw-pill-gray";
}

/** True when the gate/deploy set still has non-terminal items. */
function isInProgress(
  gates: { status: string }[],
  deploy: { status: string } | null
): boolean {
  const inFlight = new Set(["running", "pending"]);
  if (gates.some((g) => inFlight.has(g.status))) return true;
  if (deploy && inFlight.has(deploy.status)) return true;
  return false;
}

function overallBanner(
  gates: { status: string }[],
  deploy: { status: string } | null,
  latencyMs: number | null
): { icon: string; label: string; mod: string } {
  const hasFailed = gates.some((g) => g.status === "failed");
  if (hasFailed) return { icon: "✗", label: "Gate failed", mod: "pw-banner-fail" };

  const inProgress =
    gates.some((g) => ["running", "pending"].includes(g.status)) ||
    (deploy !== null && ["running", "pending"].includes(deploy.status));
  if (inProgress) return { icon: "↻", label: "In progress…", mod: "pw-banner-progress" };

  if (deploy?.status === "failure" || deploy?.status === "failed")
    return { icon: "✗", label: "Deploy failed", mod: "pw-banner-fail" };

  if (deploy?.status === "success" && latencyMs !== null)
    return { icon: "✓", label: `Live in ${formatLatency(latencyMs)}`, mod: "pw-banner-live" };

  if (gates.length > 0 && gates.every((g) => ["passed", "repaired", "skipped"].includes(g.status)))
    return { icon: "✓", label: "All gates passed", mod: "pw-banner-live" };

  return { icon: "◌", label: "No data yet", mod: "pw-banner-empty" };
}

// ---------------------------------------------------------------------------
// Data loader shared by both the page and the JSON endpoint
// ---------------------------------------------------------------------------

async function loadPushData(repoId: string, sha: string) {
  const [pushEvent] = await db
    .select()
    .from(activityFeed)
    .where(
      and(
        eq(activityFeed.repositoryId, repoId),
        or(
          // standard push action stored with targetId = sha
          and(eq(activityFeed.action, "push"), eq(activityFeed.targetId, sha)),
          // SSH push variant
          and(eq(activityFeed.action, "git.push.ssh"), eq(activityFeed.targetId, sha))
        )
      )
    )
    .orderBy(desc(activityFeed.createdAt))
    .limit(1);

  // Attempt to also find via metadata JSON if no targetId match
  let pushActivity = pushEvent ?? null;
  if (!pushActivity) {
    // Fallback: scan recent push events and check metadata for the sha
    const candidates = await db
      .select()
      .from(activityFeed)
      .where(
        and(
          eq(activityFeed.repositoryId, repoId),
          or(eq(activityFeed.action, "push"), eq(activityFeed.action, "git.push.ssh"))
        )
      )
      .orderBy(desc(activityFeed.createdAt))
      .limit(50);

    for (const row of candidates) {
      if (!row.metadata) continue;
      try {
        const m = JSON.parse(row.metadata) as Record<string, unknown>;
        if (
          m.sha === sha ||
          m.headSha === sha ||
          m.after === sha ||
          m.commitSha === sha
        ) {
          pushActivity = row;
          break;
        }
      } catch {
        // skip
      }
    }
  }

  const gates = await db
    .select()
    .from(gateRuns)
    .where(and(eq(gateRuns.repositoryId, repoId), eq(gateRuns.commitSha, sha)))
    .orderBy(desc(gateRuns.createdAt));

  const [deploy] = await db
    .select()
    .from(deployments)
    .where(
      and(eq(deployments.repositoryId, repoId), eq(deployments.commitSha, sha))
    )
    .orderBy(desc(deployments.createdAt))
    .limit(1);

  const deployment = deploy ?? null;

  let latencyMs: number | null = null;
  if (pushActivity && deployment?.completedAt && deployment.status === "success") {
    latencyMs =
      new Date(deployment.completedAt).getTime() -
      new Date(pushActivity.createdAt).getTime();
    if (latencyMs < 0) latencyMs = null;
  }

  return { pushActivity, gates, deployment, latencyMs };
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const pwStyles = `
  /* ── wrapper ── */
  .pw-wrap { max-width: 960px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  /* ── banner ── */
  .pw-banner {
    position: relative;
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 28px 32px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    margin-bottom: var(--space-5);
    overflow: hidden;
  }
  .pw-banner::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .pw-banner-orb {
    position: absolute;
    inset: -40% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.15), rgba(54,197,214,0.07) 50%, transparent 70%);
    filter: blur(70px);
    opacity: 0.6;
    pointer-events: none;
  }
  .pw-banner-live   { border-color: rgba(52,211,153,0.34);  background: linear-gradient(135deg, rgba(52,211,153,0.08) 0%, var(--bg-elevated) 55%); }
  .pw-banner-fail   { border-color: rgba(248,113,113,0.34); background: linear-gradient(135deg, rgba(248,113,113,0.08) 0%, var(--bg-elevated) 55%); }
  .pw-banner-progress { border-color: rgba(251,191,36,0.32); background: linear-gradient(135deg, rgba(251,191,36,0.07) 0%, var(--bg-elevated) 55%); }
  .pw-banner-empty  { border-color: var(--border); }

  .pw-banner-icon {
    flex-shrink: 0;
    width: 52px; height: 52px;
    border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
    font-weight: 700;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 8px 20px -8px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.15);
    position: relative; z-index: 1;
  }
  .pw-banner-live   .pw-banner-icon { background: linear-gradient(135deg, #34d399 0%, #10b981 100%); box-shadow: 0 8px 20px -8px rgba(16,185,129,0.5), inset 0 1px 0 rgba(255,255,255,0.18); }
  .pw-banner-fail   .pw-banner-icon { background: linear-gradient(135deg, #f87171 0%, #ef4444 100%); box-shadow: 0 8px 20px -8px rgba(239,68,68,0.5), inset 0 1px 0 rgba(255,255,255,0.15); }
  .pw-banner-progress .pw-banner-icon { background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%); color: #1a1206; box-shadow: 0 8px 20px -8px rgba(251,191,36,0.5), inset 0 1px 0 rgba(255,255,255,0.18); }

  .pw-banner-text { position: relative; z-index: 1; }
  .pw-banner-headline {
    font-family: var(--font-display);
    font-size: clamp(20px, 2.8vw, 26px);
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1.1;
    color: var(--text-strong);
    margin: 0 0 4px;
  }
  .pw-banner-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
  }
  .pw-banner-sub a { color: var(--accent); text-decoration: none; }
  .pw-banner-sub a:hover { text-decoration: underline; }

  /* ── section cards ── */
  .pw-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-bottom: var(--space-4);
    overflow: hidden;
  }
  .pw-card-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .pw-card-head-icon {
    width: 22px; height: 22px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.3);
  }
  .pw-card-body { padding: 20px; }

  /* ── commit card ── */
  .pw-commit {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }
  .pw-avatar {
    flex-shrink: 0;
    width: 40px; height: 40px;
    border-radius: 50%;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    display: flex; align-items: center; justify-content: center;
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    letter-spacing: -0.02em;
  }
  .pw-commit-info { flex: 1; min-width: 0; }
  .pw-commit-msg {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pw-commit-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .pw-sha {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    border-radius: 4px;
    padding: 2px 7px;
    border: 1px solid rgba(140,109,255,0.22);
  }
  .pw-branch-badge {
    font-size: 12px;
    background: rgba(54,197,214,0.10);
    color: #36c5d6;
    border-radius: 4px;
    padding: 2px 7px;
    border: 1px solid rgba(54,197,214,0.22);
  }

  /* ── gate table ── */
  .pw-gate-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  .pw-gate-table th {
    text-align: left;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0 0 10px;
    border-bottom: 1px solid var(--border);
  }
  .pw-gate-table td {
    padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    color: var(--text);
    vertical-align: middle;
  }
  .pw-gate-table tr:last-child td { border-bottom: none; }
  .pw-gate-name { font-weight: 500; color: var(--text-strong); }
  .pw-gate-dur  { font-size: 12px; color: var(--text-muted); font-family: var(--font-mono, monospace); }

  /* ── status pills ── */
  .pw-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 9999px;
    padding: 3px 9px;
    text-transform: capitalize;
    letter-spacing: 0.02em;
  }
  .pw-pill::before {
    content: '';
    width: 6px; height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }
  .pw-pill-green  { background: rgba(52,211,153,0.12); color: #34d399; border: 1px solid rgba(52,211,153,0.25); }
  .pw-pill-teal   { background: rgba(54,197,214,0.12); color: #36c5d6; border: 1px solid rgba(54,197,214,0.25); }
  .pw-pill-red    { background: rgba(248,113,113,0.12); color: #f87171; border: 1px solid rgba(248,113,113,0.25); }
  .pw-pill-yellow { background: rgba(251,191,36,0.12);  color: #fbbf24; border: 1px solid rgba(251,191,36,0.25); }
  .pw-pill-gray   { background: rgba(139,148,158,0.12); color: #8b949e; border: 1px solid rgba(139,148,158,0.22); }
  .pw-pill-spin::after {
    content: '';
    display: inline-block;
    width: 8px; height: 8px;
    border: 1.5px solid #fbbf24;
    border-top-color: transparent;
    border-radius: 50%;
    animation: pw-spin 0.8s linear infinite;
    margin-left: 2px;
  }
  @keyframes pw-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .pw-pill-spin::after { animation: none; } }

  /* ── deploy card row ── */
  .pw-deploy-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 20px;
  }
  .pw-deploy-env {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    flex: 1;
    min-width: 120px;
  }
  .pw-deploy-meta {
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ── empty state ── */
  .pw-empty {
    padding: 40px 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
  }
  .pw-empty-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 8px;
  }

  /* ── poller status ── */
  .pw-poll-bar {
    display: none;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .pw-poll-bar.pw-poll-visible { display: flex; }
  .pw-poll-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #fbbf24;
    animation: pw-pulse 1.6s ease-in-out infinite;
  }
  @keyframes pw-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
  @media (prefers-reduced-motion: reduce) { .pw-poll-dot { animation: none; } }
`;

// ---------------------------------------------------------------------------
// JSON API endpoint
// ---------------------------------------------------------------------------

pushWatchRoutes.get(
  "/api/repos/:owner/:repo/push-status/:sha",
  requireRepoAccess("read"),
  async (c) => {
    const sha = c.req.param("sha");
    const repo = c.get("repository") as { id: string };

    try {
      const { gates, deployment, latencyMs } = await loadPushData(repo.id, sha);
      return c.json({
        sha,
        gates: gates.map((g) => ({
          id: g.id,
          gateName: g.gateName,
          status: g.status,
          durationMs: g.durationMs ?? null,
          summary: g.summary ?? null,
          createdAt: g.createdAt,
          completedAt: g.completedAt ?? null,
        })),
        deployment: deployment
          ? {
              id: deployment.id,
              environment: deployment.environment,
              status: deployment.status,
              target: deployment.target ?? null,
              createdAt: deployment.createdAt,
              completedAt: deployment.completedAt ?? null,
            }
          : null,
        latencyMs,
      });
    } catch (err) {
      console.error("[push-watch] JSON endpoint error:", err);
      return c.json({ error: "Internal error" }, 500);
    }
  }
);

// ---------------------------------------------------------------------------
// Page route
// ---------------------------------------------------------------------------

pushWatchRoutes.get(
  "/:owner/:repo/push/:sha",
  requireRepoAccess("read"),
  async (c) => {
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const sha = c.req.param("sha");
    const user = c.get("user");
    const repo = c.get("repository") as {
      id: string;
      name: string;
      ownerId: string;
      starCount: number;
      forkCount: number;
      isPrivate: boolean;
    };

    const unread = user ? await getUnreadCount(user.id) : 0;

    // Load all push data
    const { pushActivity, gates, deployment, latencyMs } = await loadPushData(
      repo.id,
      sha
    );

    // Parse commit message + branch from activity metadata
    let commitMessage = "";
    let branch = "";
    let pusherName = "";

    if (pushActivity) {
      if (pushActivity.metadata) {
        try {
          const m = JSON.parse(pushActivity.metadata) as Record<string, unknown>;
          commitMessage =
            (m.commitMessage as string) ||
            (m.message as string) ||
            (m.subject as string) ||
            "";
          branch =
            (m.branch as string) ||
            (m.ref as string
              ? String(m.ref).replace("refs/heads/", "")
              : "") ||
            "";
        } catch {
          // ignore
        }
      }

      // Resolve pusher name from userId
      if (pushActivity.userId) {
        try {
          const [pusherRow] = await db
            .select({ username: users.username, displayName: users.displayName })
            .from(users)
            .where(eq(users.id, pushActivity.userId))
            .limit(1);
          if (pusherRow) {
            pusherName = pusherRow.displayName || pusherRow.username;
          }
        } catch {
          // ignore
        }
      }
    }

    const banner = overallBanner(gates, deployment, latencyMs);
    const polling = isInProgress(gates, deployment);

    // Build branch from gate ref if not found in activity
    if (!branch && gates.length > 0 && gates[0].ref) {
      branch = gates[0].ref.replace("refs/heads/", "");
    }

    const title = `Push ${shortSha(sha)} — ${owner}/${repoName}`;

    return c.html(
      <Layout
        title={title}
        user={user}
        notificationCount={unread}
      >
        <style dangerouslySetInnerHTML={{ __html: pwStyles }} />

        <div class="pw-wrap">
          <RepoHeader
            owner={owner}
            repo={repoName}
            starCount={repo.starCount}
            forkCount={repo.forkCount}
            currentUser={user?.username ?? null}
          />
          <RepoNav owner={owner} repo={repoName} active="commits" />

          {/* ── Live-update poller bar ── */}
          <div
            id="pw-poll-bar"
            class={`pw-poll-bar${polling ? " pw-poll-visible" : ""}`}
          >
            <span class="pw-poll-dot" />
            <span id="pw-poll-msg">Watching for updates…</span>
          </div>

          {/* ── Hero banner ── */}
          <div class={`pw-banner ${banner.mod}`} id="pw-banner">
            <div class="pw-banner-orb" />
            <div class="pw-banner-icon">{banner.icon}</div>
            <div class="pw-banner-text">
              <p class="pw-banner-headline" id="pw-banner-headline">
                {banner.label}
              </p>
              <p class="pw-banner-sub">
                Commit{" "}
                <a
                  href={`/${owner}/${repoName}/commit/${sha}`}
                  class="pw-sha"
                >
                  {shortSha(sha)}
                </a>
                {branch && (
                  <>
                    {" "}on <span class="pw-branch-badge">{branch}</span>
                  </>
                )}
                {pushActivity && (
                  <> · pushed {relTime(pushActivity.createdAt)}</>
                )}
              </p>
            </div>
          </div>

          {/* ── Commit card ── */}
          <div class="pw-card">
            <div class="pw-card-head">
              <span class="pw-card-head-icon">⎇</span>
              Commit
            </div>
            <div class="pw-card-body">
              {pushActivity ? (
                <div class="pw-commit">
                  <div class="pw-avatar">
                    {pusherName ? avatarInitials(pusherName) : shortSha(sha).slice(0, 2).toUpperCase()}
                  </div>
                  <div class="pw-commit-info">
                    <p class="pw-commit-msg">
                      {commitMessage || "(no commit message)"}
                    </p>
                    <div class="pw-commit-meta">
                      <span>
                        {pusherName ? (
                          <a href={`/${pusherName.toLowerCase().replace(/\s+/g, "-")}`}>
                            {pusherName}
                          </a>
                        ) : (
                          "Unknown"
                        )}
                      </span>
                      <span class="pw-sha">{shortSha(sha)}</span>
                      {branch && <span class="pw-branch-badge">{branch}</span>}
                      <span>{relTime(pushActivity.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div class="pw-empty">
                  <p class="pw-empty-title">No push event found</p>
                  <p>No activity was recorded for commit {shortSha(sha)}.</p>
                </div>
              )}
            </div>
          </div>

          {/* ── Gate results card ── */}
          <div class="pw-card" id="pw-gates-card">
            <div class="pw-card-head">
              <span class="pw-card-head-icon">✓</span>
              Gate results
            </div>
            <div class="pw-card-body" id="pw-gates-body">
              {gates.length > 0 ? (
                <table class="pw-gate-table">
                  <thead>
                    <tr>
                      <th>Gate</th>
                      <th>Status</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gates.map((g) => (
                      <tr key={g.id}>
                        <td class="pw-gate-name">{g.gateName}</td>
                        <td>
                          <span
                            class={`pw-pill ${gateStatusClass(g.status)}${
                              ["running", "pending"].includes(g.status)
                                ? " pw-pill-spin"
                                : ""
                            }`}
                          >
                            {g.status}
                          </span>
                        </td>
                        <td class="pw-gate-dur">
                          {g.durationMs != null
                            ? `${(g.durationMs / 1000).toFixed(1)}s`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div class="pw-empty">
                  <p class="pw-empty-title">No gate runs yet</p>
                  <p>Gates have not been triggered for this commit.</p>
                </div>
              )}
            </div>
          </div>

          {/* ── Deployment card ── */}
          <div class="pw-card" id="pw-deploy-card">
            <div class="pw-card-head">
              <span class="pw-card-head-icon">⬆</span>
              Deployment
            </div>
            <div class="pw-card-body" id="pw-deploy-body">
              {deployment ? (
                <div class="pw-deploy-row">
                  <span class="pw-deploy-env">{deployment.environment}</span>
                  <span
                    class={`pw-pill ${deployStatusClass(deployment.status)}${
                      ["running", "pending"].includes(deployment.status)
                        ? " pw-pill-spin"
                        : ""
                    }`}
                  >
                    {deployment.status}
                  </span>
                  {deployment.target && (
                    <span class="pw-deploy-meta">→ {deployment.target}</span>
                  )}
                  <span class="pw-deploy-meta">
                    {deployment.completedAt
                      ? relTime(deployment.completedAt)
                      : relTime(deployment.createdAt)}
                  </span>
                  {latencyMs !== null && (
                    <span class="pw-pill pw-pill-green" style="margin-left: auto;">
                      Live in {formatLatency(latencyMs)}
                    </span>
                  )}
                </div>
              ) : (
                <div class="pw-empty">
                  <p class="pw-empty-title">No deployment yet</p>
                  <p>
                    A deployment record will appear once a deploy is triggered
                    for this commit.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── 5-second poller script ── */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
(function() {
  var POLL_INTERVAL = 5000;
  var owner = ${JSON.stringify(owner)};
  var repo  = ${JSON.stringify(repoName)};
  var sha   = ${JSON.stringify(sha)};
  var url   = '/api/repos/' + owner + '/' + repo + '/push-status/' + sha;

  var isTerminal = ${JSON.stringify(!polling)};
  if (isTerminal) return;

  var pollBar = document.getElementById('pw-poll-bar');
  var pollMsg = document.getElementById('pw-poll-msg');
  var banner  = document.getElementById('pw-banner');
  var headline = document.getElementById('pw-banner-headline');

  function shortSha(s) { return s.slice(0, 7); }

  function gateStatusClass(s) {
    var m = { passed:'pw-pill-green', repaired:'pw-pill-teal', failed:'pw-pill-red',
              running:'pw-pill-yellow', pending:'pw-pill-yellow', skipped:'pw-pill-gray' };
    return m[s] || 'pw-pill-gray';
  }
  function deployStatusClass(s) {
    var m = { success:'pw-pill-green', pending:'pw-pill-yellow', running:'pw-pill-yellow',
              failure:'pw-pill-red', failed:'pw-pill-red', blocked:'pw-pill-gray', waiting_timer:'pw-pill-gray' };
    return m[s] || 'pw-pill-gray';
  }
  function formatLatency(ms) {
    if (ms < 60000) return Math.round(ms/1000) + 's';
    var s = Math.round(ms/1000); var m = Math.floor(s/60); var r = s%60;
    return r > 0 ? m + 'm ' + r + 's' : m + 'm';
  }
  function inProgress(gates, deploy) {
    var inf = ['running','pending'];
    if (gates.some(function(g){ return inf.indexOf(g.status)>=0; })) return true;
    if (deploy && inf.indexOf(deploy.status)>=0) return true;
    return false;
  }
  function overallBanner(gates, deploy, latencyMs) {
    if (gates.some(function(g){ return g.status==='failed'; }))
      return { icon:'✗', label:'Gate failed', mod:'pw-banner-fail' };
    var inf = ['running','pending'];
    if (gates.some(function(g){ return inf.indexOf(g.status)>=0; }) ||
        (deploy && inf.indexOf(deploy.status)>=0))
      return { icon:'↻', label:'In progress…', mod:'pw-banner-progress' };
    if (deploy && (deploy.status==='failure'||deploy.status==='failed'))
      return { icon:'✗', label:'Deploy failed', mod:'pw-banner-fail' };
    if (deploy && deploy.status==='success' && latencyMs!=null)
      return { icon:'✓', label:'Live in '+formatLatency(latencyMs), mod:'pw-banner-live' };
    var terminalGate = ['passed','repaired','skipped'];
    if (gates.length>0 && gates.every(function(g){ return terminalGate.indexOf(g.status)>=0; }))
      return { icon:'✓', label:'All gates passed', mod:'pw-banner-live' };
    return { icon:'◌', label:'No data yet', mod:'pw-banner-empty' };
  }

  function renderGates(gates) {
    var body = document.getElementById('pw-gates-body');
    if (!body) return;
    if (!gates.length) {
      body.innerHTML = '<div class="pw-empty"><p class="pw-empty-title">No gate runs yet</p><p>Gates have not been triggered for this commit.</p></div>';
      return;
    }
    var rows = gates.map(function(g) {
      var spin = (g.status==='running'||g.status==='pending') ? ' pw-pill-spin' : '';
      var dur = g.durationMs != null ? (g.durationMs/1000).toFixed(1)+'s' : '—';
      return '<tr><td class="pw-gate-name">'+g.gateName+'</td><td><span class="pw-pill '+gateStatusClass(g.status)+spin+'">'+g.status+'</span></td><td class="pw-gate-dur">'+dur+'</td></tr>';
    }).join('');
    body.innerHTML = '<table class="pw-gate-table"><thead><tr><th>Gate</th><th>Status</th><th>Duration</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }

  function renderDeploy(deploy, latencyMs) {
    var body = document.getElementById('pw-deploy-body');
    if (!body) return;
    if (!deploy) {
      body.innerHTML = '<div class="pw-empty"><p class="pw-empty-title">No deployment yet</p><p>A deployment record will appear once a deploy is triggered for this commit.</p></div>';
      return;
    }
    var spin = (deploy.status==='running'||deploy.status==='pending') ? ' pw-pill-spin' : '';
    var target = deploy.target ? '<span class="pw-deploy-meta">→ '+deploy.target+'</span>' : '';
    var when = deploy.completedAt || deploy.createdAt;
    var whenStr = when ? new Date(when).toLocaleTimeString() : '—';
    var latStr = latencyMs!=null ? '<span class="pw-pill pw-pill-green" style="margin-left:auto;">Live in '+formatLatency(latencyMs)+'</span>' : '';
    body.innerHTML = '<div class="pw-deploy-row"><span class="pw-deploy-env">'+deploy.environment+'</span><span class="pw-pill '+deployStatusClass(deploy.status)+spin+'">'+deploy.status+'</span>'+target+'<span class="pw-deploy-meta">'+whenStr+'</span>'+latStr+'</div>';
  }

  function updateBanner(gates, deploy, latencyMs) {
    if (!banner || !headline) return;
    var b = overallBanner(gates, deploy, latencyMs);
    banner.className = 'pw-banner ' + b.mod;
    var icon = banner.querySelector('.pw-banner-icon');
    if (icon) icon.textContent = b.icon;
    headline.textContent = b.label;
  }

  function poll() {
    fetch(url)
      .then(function(r){ return r.json(); })
      .then(function(data) {
        renderGates(data.gates || []);
        renderDeploy(data.deployment, data.latencyMs);
        updateBanner(data.gates || [], data.deployment, data.latencyMs);

        if (!inProgress(data.gates || [], data.deployment)) {
          isTerminal = true;
          if (pollBar) pollBar.classList.remove('pw-poll-visible');
          if (pollMsg) pollMsg.textContent = 'Up to date';
          return;
        }
        if (pollMsg) pollMsg.textContent = 'Watching for updates…';
        setTimeout(poll, POLL_INTERVAL);
      })
      .catch(function() {
        // silent — try again
        setTimeout(poll, POLL_INTERVAL * 2);
      });
  }

  setTimeout(poll, POLL_INTERVAL);
})();
`,
          }}
        />
      </Layout>
    );
  }
);

export default pushWatchRoutes;

/**
 * Contributors page — who contributed to this repo, commit counts.
 *
 * 2026 polish: scoped `.contrib-*` CSS that mirrors `admin-ops.tsx`
 * (section cards, gradient hairline, role pills) and `error-page.tsx`
 * (eyebrow + display headline). The RepoHeader + RepoNav above this
 * content area are left untouched.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getRepoPath, repoExists, getDefaultBranch } from "../git/repository";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const contributors = new Hono<AuthEnv>();

contributors.use("*", softAuth);

interface Contributor {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
  lastCommitAt: Date | null;
}

contributors.get("/:owner/:repo/contributors", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();

  const ref = (await getDefaultBranch(owner, repo)) || "main";
  const repoDir = getRepoPath(owner, repo);

  // Get shortlog for commit counts
  const shortlogProc = Bun.spawn(
    ["git", "shortlog", "-sne", ref],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const shortlogOut = await new Response(shortlogProc.stdout).text();
  await shortlogProc.exited;

  const contribs: Contributor[] = shortlogOut
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\t(.+?)\s+<(.+?)>$/);
      if (!match) return null;
      return {
        name: match[2],
        email: match[3],
        commits: parseInt(match[1], 10),
        additions: 0,
        deletions: 0,
        lastCommitAt: null,
      } as Contributor;
    })
    .filter((c): c is Contributor => c !== null)
    .sort((a, b) => b.commits - a.commits);

  // Per-author lines added/removed + most recent commit timestamp.
  // We use `git log --numstat --format="commit\t%aE\t%aI"` and aggregate by
  // author email so the totals line up with the shortlog grouping.
  if (contribs.length > 0) {
    try {
      const numstatProc = Bun.spawn(
        ["git", "log", "--numstat", "--format=__COMMIT__\t%aE\t%aI", ref],
        { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
      );
      const numstatOut = await new Response(numstatProc.stdout).text();
      await numstatProc.exited;

      const byEmail = new Map<string, { add: number; del: number; last: Date | null }>();
      let currentEmail: string | null = null;
      let currentDate: Date | null = null;
      for (const raw of numstatOut.split("\n")) {
        const line = raw.trimEnd();
        if (!line) continue;
        if (line.startsWith("__COMMIT__\t")) {
          const parts = line.split("\t");
          currentEmail = (parts[1] || "").toLowerCase();
          const iso = parts[2] || "";
          const d = iso ? new Date(iso) : null;
          currentDate = d && !Number.isNaN(d.getTime()) ? d : null;
          if (currentEmail && !byEmail.has(currentEmail)) {
            byEmail.set(currentEmail, { add: 0, del: 0, last: null });
          }
          if (currentEmail) {
            const bucket = byEmail.get(currentEmail)!;
            if (currentDate && (!bucket.last || currentDate > bucket.last)) {
              bucket.last = currentDate;
            }
          }
          continue;
        }
        if (!currentEmail) continue;
        // numstat: "<added>\t<removed>\t<path>" — binary files show "-".
        const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
        if (!m) continue;
        const add = m[1] === "-" ? 0 : parseInt(m[1], 10);
        const del = m[2] === "-" ? 0 : parseInt(m[2], 10);
        const bucket = byEmail.get(currentEmail)!;
        bucket.add += add;
        bucket.del += del;
      }
      for (const ctb of contribs) {
        const bucket = byEmail.get(ctb.email.toLowerCase());
        if (bucket) {
          ctb.additions = bucket.add;
          ctb.deletions = bucket.del;
          ctb.lastCommitAt = bucket.last;
        }
      }
    } catch {
      // numstat is a nice-to-have; if it fails we still render commit counts.
    }
  }

  // Get recent commit activity (last 52 weeks)
  const activityProc = Bun.spawn(
    [
      "git",
      "log",
      "--format=%aI",
      "--since=1 year ago",
      ref,
    ],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const activityOut = await new Response(activityProc.stdout).text();
  await activityProc.exited;

  // Build weekly commit counts
  const weekCounts: number[] = new Array(52).fill(0);
  const now = Date.now();
  for (const line of activityOut.trim().split("\n").filter(Boolean)) {
    const date = new Date(line);
    const weeksAgo = Math.floor(
      (now - date.getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    if (weeksAgo >= 0 && weeksAgo < 52) {
      weekCounts[51 - weeksAgo]++;
    }
  }

  const maxWeek = Math.max(...weekCounts, 1);
  const totalCommits = contribs.reduce((s, c) => s + c.commits, 0);
  const totalAdditions = contribs.reduce((s, c) => s + c.additions, 0);
  const totalDeletions = contribs.reduce((s, c) => s + c.deletions, 0);
  const yearCommits = weekCounts.reduce((s, n) => s + n, 0);

  return c.html(
    <Layout title={`Contributors — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="contrib-wrap">
        <header class="contrib-head">
          <div class="contrib-eyebrow">
            <span class="contrib-eyebrow-dot" aria-hidden="true" />
            Repository · Contributors
          </div>
          <h1 class="contrib-title">
            <span class="contrib-title-grad">Who built this.</span>
          </h1>
          <p class="contrib-sub">
            Everyone with a commit on{" "}
            <code class="contrib-ref">{ref}</code>, ranked by total commits.
            Bars below show weekly activity over the last year.
          </p>
        </header>

        {/* ─── Stats strip ─── */}
        {contribs.length > 0 && (
          <div class="contrib-stats">
            <div class="contrib-stat">
              <div class="contrib-stat-value">{contribs.length.toLocaleString()}</div>
              <div class="contrib-stat-label">Contributors</div>
            </div>
            <div class="contrib-stat">
              <div class="contrib-stat-value">{totalCommits.toLocaleString()}</div>
              <div class="contrib-stat-label">Total commits</div>
            </div>
            <div class="contrib-stat">
              <div class="contrib-stat-value contrib-add">+{totalAdditions.toLocaleString()}</div>
              <div class="contrib-stat-label">Lines added</div>
            </div>
            <div class="contrib-stat">
              <div class="contrib-stat-value contrib-del">−{totalDeletions.toLocaleString()}</div>
              <div class="contrib-stat-label">Lines removed</div>
            </div>
          </div>
        )}

        {contribs.length === 0 ? (
          <div class="contrib-empty">
            <div class="contrib-empty-orb" aria-hidden="true" />
            <div class="contrib-empty-inner">
              <div class="contrib-empty-icon" aria-hidden="true">
                <IconCommit />
              </div>
              <h3 class="contrib-empty-title">Push your first commit to see contributors</h3>
              <p class="contrib-empty-sub">
                Once anyone pushes to <code>{ref}</code>, they'll appear here
                ranked by commit count with a year of weekly activity.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* ─── Activity card ─── */}
            <section class="contrib-section">
              <header class="contrib-section-head">
                <div class="contrib-section-head-text">
                  <h2 class="contrib-section-title">
                    <span class="contrib-section-title-icon" aria-hidden="true">
                      <IconBars />
                    </span>
                    Commit activity
                  </h2>
                  <p class="contrib-section-sub">
                    Weekly commit volume on <code class="contrib-ref-inline">{ref}</code> for the
                    last 52 weeks · <strong style="color:var(--text);font-variant-numeric:tabular-nums">{yearCommits.toLocaleString()}</strong> commits this year.
                  </p>
                </div>
              </header>
              <div class="contrib-section-body">
                <div class="contrib-spark" role="img" aria-label={`${yearCommits} commits in the last 52 weeks`}>
                  {weekCounts.map((count, i) => {
                    const ratio = count / maxWeek;
                    const heightPct = count === 0 ? 4 : Math.max(8, Math.round(ratio * 100));
                    const opacity = count === 0 ? 0.14 : Math.max(0.40, ratio).toFixed(2);
                    const weeksAgo = 51 - i;
                    return (
                      <div
                        class="contrib-spark-bar"
                        title={`${count} commit${count === 1 ? "" : "s"} · ${weeksAgo}w ago`}
                        style={`height:${heightPct}%;opacity:${opacity}`}
                      />
                    );
                  })}
                </div>
                <div class="contrib-spark-axis">
                  <span>52w ago</span>
                  <span>26w ago</span>
                  <span>now</span>
                </div>
              </div>
            </section>

            {/* ─── People section ─── */}
            <section class="contrib-section">
              <header class="contrib-section-head">
                <div class="contrib-section-head-text">
                  <h2 class="contrib-section-title">
                    <span class="contrib-section-title-icon" aria-hidden="true">
                      <IconUsers />
                    </span>
                    Contributors
                    <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);font-weight:500;font-variant-numeric:tabular-nums">
                      {" "}({contribs.length})
                    </span>
                  </h2>
                  <p class="contrib-section-sub">
                    Ranked by total commits. Click a name to open their profile.
                  </p>
                </div>
              </header>
              <div class="contrib-section-body">
                <div class="contrib-grid">
                  {contribs.map((ctb, idx) => {
                    const handle = handleFromEmail(ctb.email, ctb.name);
                    const initial = (ctb.name || ctb.email || "?")[0]?.toUpperCase() ?? "?";
                    const role = idx === 0 ? "Maintainer" : "Contributor";
                    const roleClass = idx === 0 ? "contrib-pill is-maintainer" : "contrib-pill is-contributor";
                    return (
                      <div class="contrib-card">
                        <div class="contrib-rank" aria-hidden="true">
                          #{idx + 1}
                        </div>
                        <div class="contrib-avatar" aria-hidden="true">
                          {initial}
                        </div>
                        <div class="contrib-card-body">
                          <div class="contrib-card-row">
                            <a href={`/${handle}`} class="contrib-card-name">
                              {ctb.name}
                            </a>
                            <span class={roleClass}>
                              <span class="dot" aria-hidden="true" />
                              {role}
                            </span>
                          </div>
                          <div class="contrib-card-handle">@{handle}</div>
                          <div class="contrib-meta-row">
                            <span class="contrib-num">{ctb.commits.toLocaleString()}</span>
                            <span class="contrib-meta-label">commit{ctb.commits === 1 ? "" : "s"}</span>
                            {(ctb.additions > 0 || ctb.deletions > 0) && (
                              <>
                                <span class="sep">·</span>
                                <span class="contrib-add contrib-num">+{ctb.additions.toLocaleString()}</span>
                                <span class="contrib-del contrib-num">−{ctb.deletions.toLocaleString()}</span>
                              </>
                            )}
                            {ctb.lastCommitAt && (
                              <>
                                <span class="sep">·</span>
                                <span class="contrib-num" title={ctb.lastCommitAt.toISOString()}>
                                  {relativeTime(ctb.lastCommitAt)}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          </>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: contribStyles }} />
    </Layout>
  );
});

/** Derive a username-ish handle from an email — local part before "@",
 *  stripped of "+suffix" and any non-ident chars. Falls back to the author
 *  name lowercased if the email is unhelpful. */
function handleFromEmail(email: string, fallbackName: string): string {
  if (!email) return slugify(fallbackName);
  const local = email.split("@")[0] || "";
  const stripped = local.split("+")[0]!.replace(/[^a-zA-Z0-9_-]/g, "");
  if (stripped) return stripped.toLowerCase();
  return slugify(fallbackName);
}

function slugify(s: string): string {
  return (s || "anon").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "anon";
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function IconUsers() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconBars() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  );
}
function IconCommit() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <line x1="3" y1="12" x2="9" y2="12" />
      <line x1="15" y1="12" x2="21" y2="12" />
    </svg>
  );
}

// ─── Scoped CSS (.contrib-*) ────────────────────────────────────────────────

const contribStyles = `
  .contrib-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Header strip ─── */
  .contrib-head { margin-bottom: var(--space-5); }
  .contrib-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .contrib-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .contrib-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .contrib-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .contrib-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 720px;
  }
  .contrib-ref,
  .contrib-ref-inline {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 7px;
    border-radius: 6px;
    color: var(--text);
  }

  /* ─── Stats strip ─── */
  .contrib-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    margin-bottom: var(--space-5);
  }
  .contrib-stat {
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    position: relative;
    overflow: hidden;
  }
  .contrib-stat::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(140,109,255,0.40), rgba(54,197,214,0.30), transparent);
    opacity: 0.55;
    pointer-events: none;
  }
  .contrib-stat-value {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 800;
    color: var(--text-strong);
    letter-spacing: -0.018em;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .contrib-stat-label {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .contrib-add { color: #6ee7b7; }
  .contrib-del { color: #fca5a5; }

  /* ─── Section cards ─── */
  .contrib-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .contrib-section::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .contrib-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .contrib-section-head-text { flex: 1; min-width: 240px; }
  .contrib-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .contrib-section-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    flex-shrink: 0;
  }
  .contrib-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .contrib-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Sparkline ─── */
  .contrib-spark {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 80px;
    padding: 4px 0;
  }
  .contrib-spark-bar {
    flex: 1;
    min-width: 0;
    background: linear-gradient(180deg, #8c6dff 0%, #36c5d6 100%);
    border-radius: 2px 2px 1px 1px;
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .contrib-spark-bar:hover {
    opacity: 1 !important;
    transform: scaleY(1.05);
    transform-origin: bottom;
  }
  .contrib-spark-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }

  /* ─── People grid ─── */
  .contrib-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 12px;
  }
  .contrib-card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .contrib-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .contrib-rank {
    flex-shrink: 0;
    width: 30px;
    text-align: right;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 600;
    padding-top: 14px;
    font-variant-numeric: tabular-nums;
  }
  .contrib-avatar {
    width: 44px; height: 44px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.30), rgba(54,197,214,0.25));
    color: #ffffff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 17px;
    flex-shrink: 0;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
  }
  .contrib-card-body { flex: 1; min-width: 0; }
  .contrib-card-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .contrib-card-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14.5px;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
    overflow-wrap: anywhere;
  }
  .contrib-card-name:hover { color: var(--text-strong); text-decoration: underline; }
  .contrib-card-handle {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .contrib-meta-row {
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
  }
  .contrib-meta-row .sep { opacity: 0.4; }
  .contrib-meta-label { color: var(--text-muted); }
  .contrib-num {
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    font-weight: 600;
  }

  /* ─── Role pills ─── */
  .contrib-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .contrib-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .contrib-pill.is-maintainer {
    background: rgba(140,109,255,0.16);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .contrib-pill.is-contributor {
    background: rgba(148,163,184,0.16);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }

  /* ─── Empty state ─── */
  .contrib-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 48px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .contrib-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .contrib-empty-inner { position: relative; z-index: 1; }
  .contrib-empty-icon {
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
    margin-bottom: 14px;
  }
  .contrib-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .contrib-empty-sub {
    margin: 0 auto;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 480px;
    line-height: 1.5;
  }
  .contrib-empty-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.05);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 6px;
    color: var(--text);
  }
`;

export default contributors;

/**
 * Insight routes — time-travel, dependency analysis, rollback.
 *
 * These are the pages that don't exist on GitHub.
 * This is why developers will switch.
 *
 * 2026 polish: gradient-hairline hero + radial orb + stat cards + polished
 * timeline. Every class prefixed `.insights-` so this surface doesn't
 * bleed into the wider repo polish. All data fetches, queries, and
 * actions preserved exactly.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import {
  getFileTimeline,
  getFunctionTimeline,
  detectCoupledFiles,
  getRepoStory,
} from "../lib/timetravel";
import {
  buildImportGraph,
  analyzeUpgradeImpact,
  findUnusedDeps,
} from "../lib/depimpact";
import { findRollbackTarget, executeRollback } from "../lib/rollback";
import {
  repoExists,
  getDefaultBranch,
  listBranches,
} from "../git/repository";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const insights = new Hono<AuthEnv>();

insights.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.insights-`. Mirrors the
 * gradient-hairline hero + radial orb + per-card pattern from
 * `admin-integrations` and `admin-diagnose`. Stat cards use
 * `font-variant-numeric: tabular-nums` so columns of numbers line up.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .insights-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  .insights-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .insights-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .insights-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .insights-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .insights-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .insights-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .insights-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .insights-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .insights-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* Stat-card grid */
  .insights-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .insights-stat {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .insights-stat:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .insights-stat-label {
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 6px;
  }
  .insights-stat-value {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .insights-stat-value.is-warn { color: #fca5a5; }
  .insights-stat-trend {
    margin-top: 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .insights-stat-trend.is-up { color: #6ee7b7; }
  .insights-stat-trend.is-down { color: #fca5a5; }
  .insights-stat-trend .arrow { font-size: 11px; line-height: 1; }
  .insights-stat-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Section heading */
  .insights-section-head {
    margin: 0 0 var(--space-3);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .insights-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .insights-section-sub { font-size: 12.5px; color: var(--text-muted); }

  .insights-blurb {
    margin: 0 0 var(--space-3);
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.55;
  }

  /* Generic card list */
  .insights-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
  }
  .insights-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .insights-card:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .insights-card.is-warn { border-color: rgba(248,113,113,0.30); }

  .insights-card-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    flex-wrap: wrap;
  }
  .insights-card-main { min-width: 0; flex: 1; }
  .insights-card-title {
    font-family: var(--font-display);
    font-size: 14.5px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.005em;
    line-height: 1.3;
    margin: 0 0 4px;
    word-break: break-word;
  }
  .insights-card-title a { color: inherit; text-decoration: none; }
  .insights-card-title a:hover { color: var(--accent); }
  .insights-card-sub {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }
  .insights-card-meta {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .insights-card-meta .add { color: #6ee7b7; }
  .insights-card-meta .del { color: #fca5a5; }

  .insights-coupled {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    word-break: break-word;
  }
  .insights-coupled a { color: var(--accent); text-decoration: none; }
  .insights-coupled a:hover { text-decoration: underline; }
  .insights-coupled .plus { color: var(--text-muted); margin: 0 8px; }

  /* Timeline (revisions / milestones) */
  .insights-timeline {
    position: relative;
    padding-left: 22px;
    margin: 0;
    list-style: none;
  }
  .insights-timeline::before {
    content: '';
    position: absolute;
    left: 6px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background: linear-gradient(180deg, rgba(140,109,255,0.22), rgba(54,197,214,0.06));
    border-radius: 9999px;
  }
  .insights-timeline-item {
    position: relative;
    padding: 0 0 var(--space-3) 0;
  }
  .insights-timeline-dot {
    position: absolute;
    left: -22px;
    top: 6px;
    width: 12px; height: 12px;
    border-radius: 9999px;
    background: var(--text-muted);
    box-shadow: 0 0 0 3px rgba(255,255,255,0.04);
  }
  .insights-timeline-dot.is-milestone {
    background: linear-gradient(135deg, #34d399, #36c5d6);
    box-shadow: 0 0 0 4px rgba(52,211,153,0.18);
    width: 14px; height: 14px;
    left: -23px;
  }
  .insights-timeline-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .insights-timeline-card:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }

  /* Unused-deps banner */
  .insights-banner {
    margin-bottom: var(--space-4);
    padding: 12px 16px;
    border-radius: 12px;
    border: 1px solid rgba(248,113,113,0.34);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
    font-size: 13px;
    line-height: 1.55;
  }
  .insights-banner strong { color: #fecaca; font-weight: 700; }
  .insights-banner code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(248,113,113,0.22);
    padding: 1px 6px;
    border-radius: 5px;
  }
  .insights-banner-hint {
    margin-top: 6px;
    font-size: 12px;
    color: rgba(254,202,202,0.78);
  }

  /* Dep usage block */
  .insights-dep-uses {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .insights-dep-uses code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
  }
  .insights-dep-uses a { color: var(--accent); text-decoration: none; }
  .insights-dep-uses a:hover { text-decoration: underline; }
  .insights-dep-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: rgba(96,165,250,0.12);
    color: #93c5fd;
    box-shadow: inset 0 0 0 1px rgba(96,165,250,0.30);
  }
  .insights-dep-unused {
    color: #fca5a5;
    font-weight: 600;
  }

  /* Empty state — dashed orb card */
  .insights-empty {
    position: relative;
    overflow: hidden;
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 16px;
    background: rgba(255,255,255,0.012);
    color: var(--text-muted);
    margin-bottom: var(--space-5);
  }
  .insights-empty::before {
    content: '';
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.14), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .insights-empty-inner { position: relative; z-index: 1; }
  .insights-empty strong {
    display: block;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin-bottom: 4px;
  }
  .insights-empty span { font-size: 13px; }
`;

// ─── TIME TRAVEL ─────────────────────────────────────────────

// File evolution timeline
insights.get("/:owner/:repo/timeline/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const refAndPath = c.req.param("ref");

  const branches = await listBranches(owner, repo);
  let ref = "";
  let filePath = "";

  for (const branch of branches) {
    if (refAndPath.startsWith(branch + "/")) {
      ref = branch;
      filePath = refAndPath.slice(branch.length + 1);
      break;
    }
  }
  if (!ref) {
    const idx = refAndPath.indexOf("/");
    if (idx === -1) return c.notFound();
    ref = refAndPath.slice(0, idx);
    filePath = refAndPath.slice(idx + 1);
  }

  const timeline = await getFileTimeline(owner, repo, ref, filePath);
  if (!timeline) return c.notFound();

  return c.html(
    <Layout title={`Timeline: ${filePath} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />

      <div class="insights-wrap">
        <section class="insights-hero">
          <div class="insights-hero-orb" aria-hidden="true" />
          <div class="insights-hero-inner">
            <div class="insights-eyebrow">
              <span class="insights-eyebrow-dot" aria-hidden="true" />
              Time travel · {owner}/{repo}
            </div>
            <h2 class="insights-title">
              <span class="insights-title-grad">{filePath}</span>
            </h2>
            <p class="insights-sub">
              {timeline.totalRevisions} revision
              {timeline.totalRevisions !== 1 ? "s" : ""} · First seen{" "}
              {new Date(timeline.firstSeen.date).toLocaleDateString()} by{" "}
              {timeline.firstSeen.author}
            </p>
          </div>
        </section>

        <ul class="insights-timeline">
          {timeline.revisions.map((rev) => (
            <li class="insights-timeline-item">
              <span class="insights-timeline-dot" aria-hidden="true" />
              <div class="insights-timeline-card">
                <div class="insights-card-row">
                  <div class="insights-card-main">
                    <h4 class="insights-card-title">
                      <a href={`/${owner}/${repo}/commit/${rev.sha}`}>
                        {rev.message}
                      </a>
                    </h4>
                    <p class="insights-card-sub">
                      {rev.author} —{" "}
                      {new Date(rev.date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                  <div class="insights-card-meta">
                    <span class="add">+{rev.linesAdded}</span>{" "}
                    <span class="del">-{rev.linesRemoved}</span>
                    <div style="color: var(--text-muted)">{rev.sizeAfter} bytes</div>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

// Coupled files analysis (the canonical "Insights" landing surface)
insights.get("/:owner/:repo/coupling", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();
  const ref = (await getDefaultBranch(owner, repo)) || "main";

  const coupled = await detectCoupledFiles(owner, repo, ref);
  const story = await getRepoStory(owner, repo, ref);
  const milestones = story.filter((s) => s.significance !== "normal").slice(0, 20);

  // Stat-card values derived from the data we already fetched. These line up
  // with the spec (commits, files touched, milestones, coupled-pairs) so the
  // grid renders even when the repo is empty.
  const totalCommits = story.length;
  const totalAdditions = story.reduce(
    (n, s) => n + (s.stats?.additions || 0),
    0
  );
  const totalDeletions = story.reduce(
    (n, s) => n + (s.stats?.deletions || 0),
    0
  );

  return c.html(
    <Layout title={`Insights — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="insights" />

      <div class="insights-wrap">
        <section class="insights-hero">
          <div class="insights-hero-orb" aria-hidden="true" />
          <div class="insights-hero-inner">
            <div class="insights-eyebrow">
              <span class="insights-eyebrow-dot" aria-hidden="true" />
              Insights · {owner}/{repo}
            </div>
            <h2 class="insights-title">
              <span class="insights-title-grad">Code intelligence.</span>
            </h2>
            <p class="insights-sub">
              File coupling, milestone history, and contributor signals — the
              kind of intelligence GitHub doesn't ship.
            </p>
          </div>
        </section>

        <div class="insights-stats">
          <div class="insights-stat">
            <div class="insights-stat-label">Commits indexed</div>
            <div class="insights-stat-value">{totalCommits.toLocaleString()}</div>
            <div class="insights-stat-hint">On {ref}</div>
          </div>
          <div class="insights-stat">
            <div class="insights-stat-label">Lines added</div>
            <div class="insights-stat-value">{totalAdditions.toLocaleString()}</div>
            <div class="insights-stat-trend is-up">
              <span class="arrow" aria-hidden="true">▲</span>
              across history
            </div>
          </div>
          <div class="insights-stat">
            <div class="insights-stat-label">Lines removed</div>
            <div class="insights-stat-value">{totalDeletions.toLocaleString()}</div>
            <div class="insights-stat-trend is-down">
              <span class="arrow" aria-hidden="true">▼</span>
              across history
            </div>
          </div>
          <div class="insights-stat">
            <div class="insights-stat-label">Milestones</div>
            <div class="insights-stat-value">{milestones.length}</div>
            <div class="insights-stat-hint">Significant commits</div>
          </div>
        </div>

        <div class="insights-section-head">
          <h3 class="insights-section-title">Coupled files</h3>
          <span class="insights-section-sub">{coupled.length} pair{coupled.length === 1 ? "" : "s"}</span>
        </div>
        <p class="insights-blurb">
          Files that change together frequently — potential architectural
          coupling worth refactoring.
        </p>
        {coupled.length === 0 ? (
          <div class="insights-empty">
            <div class="insights-empty-inner">
              <strong>No strong coupling detected</strong>
              <span>Push more code to see relationships emerge.</span>
            </div>
          </div>
        ) : (
          <div class="insights-list">
            {coupled.map((pair) => (
              <div class="insights-card">
                <div class="insights-card-row">
                  <div class="insights-card-main">
                    <div class="insights-coupled">
                      <a href={`/${owner}/${repo}/blob/${ref}/${pair.files[0]}`}>
                        {pair.files[0]}
                      </a>
                      <span class="plus" aria-hidden="true">+</span>
                      <a href={`/${owner}/${repo}/blob/${ref}/${pair.files[1]}`}>
                        {pair.files[1]}
                      </a>
                    </div>
                  </div>
                  <div class="insights-card-meta">
                    {pair.cochanges} co-changes ({pair.percentage}%)
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div class="insights-section-head">
          <h3 class="insights-section-title">Project milestones</h3>
          <span class="insights-section-sub">{milestones.length} milestone{milestones.length === 1 ? "" : "s"}</span>
        </div>
        {milestones.length === 0 ? (
          <div class="insights-empty">
            <div class="insights-empty-inner">
              <strong>No milestones detected yet</strong>
              <span>Push code to see insights emerge.</span>
            </div>
          </div>
        ) : (
          <ul class="insights-timeline">
            {milestones.map((m) => (
              <li class="insights-timeline-item">
                <span
                  class={
                    "insights-timeline-dot" +
                    (m.significance === "milestone" ? " is-milestone" : "")
                  }
                  aria-hidden="true"
                />
                <div class="insights-timeline-card">
                  <div class="insights-card-row">
                    <div class="insights-card-main">
                      <h4 class="insights-card-title">
                        <a href={`/${owner}/${repo}/commit/${m.sha}`}>
                          {m.message}
                        </a>
                      </h4>
                      <p class="insights-card-sub">
                        {m.author} —{" "}
                        {new Date(m.date).toLocaleDateString()}
                      </p>
                    </div>
                    <div class="insights-card-meta">
                      <span class="add">+{m.stats.additions}</span>{" "}
                      <span class="del">-{m.stats.deletions}</span>
                      <div style="color: var(--text-muted)">
                        {m.stats.files} file{m.stats.files === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

// ─── DEPENDENCY INSIGHTS ─────────────────────────────────────

insights.get("/:owner/:repo/dependencies", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();
  const ref = (await getDefaultBranch(owner, repo)) || "main";

  const graph = await buildImportGraph(owner, repo, ref);
  const unused = findUnusedDeps(graph);

  return c.html(
    <Layout title={`Dependencies — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />

      <div class="insights-wrap">
        <section class="insights-hero">
          <div class="insights-hero-orb" aria-hidden="true" />
          <div class="insights-hero-inner">
            <div class="insights-eyebrow">
              <span class="insights-eyebrow-dot" aria-hidden="true" />
              Dependency intelligence · {owner}/{repo}
            </div>
            <h2 class="insights-title">
              <span class="insights-title-grad">What you depend on.</span>
            </h2>
            <p class="insights-sub">
              Static import graph across the repo — every package, how it's
              used, and which ones are dead weight.
            </p>
          </div>
        </section>

        <div class="insights-stats">
          <div class="insights-stat">
            <div class="insights-stat-label">Dependencies</div>
            <div class="insights-stat-value">{graph.externalDependencies}</div>
            <div class="insights-stat-hint">External packages</div>
          </div>
          <div class="insights-stat">
            <div class="insights-stat-label">Source files</div>
            <div class="insights-stat-value">{graph.internalModules}</div>
            <div class="insights-stat-hint">Internal modules</div>
          </div>
          <div class={"insights-stat"}>
            <div class="insights-stat-label">Unused</div>
            <div
              class={
                "insights-stat-value" + (unused.length > 0 ? " is-warn" : "")
              }
            >
              {unused.length}
            </div>
            <div class="insights-stat-hint">Installed but never imported</div>
          </div>
          <div class="insights-stat">
            <div class="insights-stat-label">Circular chains</div>
            <div
              class={
                "insights-stat-value" +
                (graph.circularDeps.length > 0 ? " is-warn" : "")
              }
            >
              {graph.circularDeps.length}
            </div>
            <div class="insights-stat-hint">Cycles in the import graph</div>
          </div>
        </div>

        {unused.length > 0 && (
          <div class="insights-banner">
            <strong>Unused dependencies:</strong>{" "}
            <code>{unused.join(", ")}</code>
            <div class="insights-banner-hint">
              These are installed but never imported. Removing them reduces
              install time and attack surface.
            </div>
          </div>
        )}

        <div class="insights-section-head">
          <h3 class="insights-section-title">Packages</h3>
          <span class="insights-section-sub">{graph.dependencies.length} total</span>
        </div>
        {graph.dependencies.length === 0 ? (
          <div class="insights-empty">
            <div class="insights-empty-inner">
              <strong>No dependencies detected</strong>
              <span>Push code with a manifest to see insights.</span>
            </div>
          </div>
        ) : (
          <div class="insights-list">
            {graph.dependencies.map((dep) => (
              <div
                class={"insights-card" + (dep.totalImports === 0 ? " is-warn" : "")}
              >
                <div class="insights-card-row">
                  <div class="insights-card-main">
                    <h4 class="insights-card-title">
                      {dep.name}{" "}
                      <span
                        style="font-size:12px;font-weight:500;color:var(--text-muted);font-family:var(--font-mono);margin-left:6px"
                      >
                        {dep.version}
                      </span>
                      {dep.isDevDep && (
                        <span class="insights-dep-badge" style="margin-left:8px">
                          dev
                        </span>
                      )}
                    </h4>
                  </div>
                  <div class="insights-card-meta">
                    {dep.totalImports === 0 ? (
                      <span class="insights-dep-unused">unused</span>
                    ) : (
                      `${dep.totalImports} import${dep.totalImports !== 1 ? "s" : ""}`
                    )}
                  </div>
                </div>
                {dep.usedIn.length > 0 && (
                  <div class="insights-dep-uses">
                    {dep.usedIn.slice(0, 3).map((usage) => (
                      <div>
                        <a href={`/${owner}/${repo}/blob/${ref}/${usage.file}`}>
                          {usage.file}:{usage.line}
                        </a>
                        <code style="margin-left:8px">
                          {"{ "}
                          {usage.importedSymbols.join(", ")}
                          {" }"}
                        </code>
                      </div>
                    ))}
                    {dep.usedIn.length > 3 && (
                      <div>+{dep.usedIn.length - 3} more</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

// ─── ROLLBACK ────────────────────────────────────────────────

insights.post("/:owner/:repo/rollback", requireAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const branch = String(body.branch || "main");
  const targetSha = String(body.target_sha || "");

  if (!targetSha) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const result = await executeRollback(owner, repo, branch, targetSha);
  if (!result.success) {
    return c.redirect(`/${owner}/${repo}?error=${encodeURIComponent(result.error || "Rollback failed")}`);
  }

  return c.redirect(`/${owner}/${repo}/commit/${result.newSha}`);
});

export default insights;

/**
 * Block I5 — Code scanning UI.
 *
 *   GET /:owner/:repo/security
 *
 * Aggregates gate_runs where the gate name contains "scan" (Secret scan,
 * Security scan, Dependency scan) and presents them as a clean alerts
 * dashboard. Data already exists — this is a surfacing layer only.
 *
 * 2026 polish: gradient-hairline hero + radial orb + scoped severity-pill
 * cards (.sec-*). Mirrors the recipe used in admin-integrations and
 * admin-diagnose. No data fetch shape, query, or action changed.
 */

import { Hono } from "hono";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { gateRuns, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const codeScanning = new Hono<AuthEnv>();
codeScanning.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.sec-` so this surface can't bleed
 * into the wider repo polish. Mirrors the gradient-hairline hero + radial
 * orb + per-card pattern from `admin-integrations` and `admin-diagnose`.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .sec-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  .sec-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .sec-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .sec-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .sec-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .sec-eyebrow {
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
  .sec-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .sec-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .sec-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .sec-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 640px;
  }

  /* Healthy banner — green gradient checkmark */
  .sec-healthy {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: var(--space-4);
    padding: 14px 18px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(52,211,153,0.10), rgba(54,197,214,0.06));
    border: 1px solid rgba(52,211,153,0.32);
    color: #bbf7d0;
  }
  .sec-healthy-icon {
    flex: 0 0 auto;
    width: 36px; height: 36px;
    border-radius: 9999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #34d399 0%, #36c5d6 100%);
    color: #04231a;
    box-shadow: 0 0 0 4px rgba(52,211,153,0.16);
  }
  .sec-healthy-text { font-size: 14px; line-height: 1.45; }
  .sec-healthy-text strong { display: block; color: #d1fae5; font-weight: 700; font-size: 14.5px; margin-bottom: 2px; }
  .sec-healthy-text span { color: rgba(187,247,208,0.85); font-size: 12.5px; }

  /* Stat grid */
  .sec-stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  @media (max-width: 640px) {
    .sec-stats { grid-template-columns: 1fr; }
  }
  .sec-stat {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .sec-stat:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .sec-stat.is-red { border-color: rgba(248,113,113,0.34); }
  .sec-stat.is-green { border-color: rgba(52,211,153,0.22); }
  .sec-stat-label {
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 6px;
  }
  .sec-stat-value {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .sec-stat.is-red .sec-stat-value { color: #fca5a5; }
  .sec-stat.is-green .sec-stat-value { color: #6ee7b7; }
  .sec-stat-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Section heading */
  .sec-section-head {
    margin: 0 0 var(--space-3);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .sec-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .sec-section-sub {
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* Card list */
  .sec-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
  }
  .sec-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .sec-card:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .sec-card.is-passed { border-color: rgba(52,211,153,0.22); }
  .sec-card.is-failed { border-color: rgba(248,113,113,0.34); }
  .sec-card.is-repaired { border-color: rgba(140,109,255,0.30); }
  .sec-card-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    flex-wrap: wrap;
  }
  .sec-card-main { min-width: 0; flex: 1; }
  .sec-card-title {
    font-family: var(--font-display);
    font-size: 14.5px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.005em;
    line-height: 1.3;
    margin: 0 0 4px;
    word-break: break-word;
  }
  .sec-card-summary {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
    margin: 0;
    word-break: break-word;
  }
  .sec-card-meta {
    margin-top: 6px;
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .sec-card-meta code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }
  .sec-card-right {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }

  /* Severity / status pill */
  .sec-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .sec-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .sec-pill.is-passed { background: rgba(52,211,153,0.14); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32); }
  .sec-pill.is-failed { background: rgba(248,113,113,0.12); color: #fca5a5; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.34); }
  .sec-pill.is-repaired { background: rgba(140,109,255,0.14); color: #c4b5fd; box-shadow: inset 0 0 0 1px rgba(140,109,255,0.34); }
  .sec-pill.is-skipped { background: rgba(148,163,184,0.10); color: #cbd5e1; box-shadow: inset 0 0 0 1px rgba(148,163,184,0.28); }
  .sec-pill.is-pending,
  .sec-pill.is-running { background: rgba(251,191,36,0.10); color: #fde68a; box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30); }

  /* Empty state — dashed orb card */
  .sec-empty {
    position: relative;
    overflow: hidden;
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 16px;
    background: rgba(255,255,255,0.012);
    color: var(--text-muted);
  }
  .sec-empty::before {
    content: '';
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.14), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .sec-empty-inner { position: relative; z-index: 1; }
  .sec-empty strong {
    display: block;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin-bottom: 4px;
  }
  .sec-empty span { font-size: 13px; }
`;

codeScanning.get("/:owner/:repo/security", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");

  const [ownerUser] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!ownerUser) return c.notFound();

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerId, ownerUser.id),
        eq(repositories.name, repoName)
      )
    )
    .limit(1);
  if (!repo) return c.notFound();
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.notFound();
  }

  // Pull the most recent 100 scan-related gate runs.
  const runs = await db
    .select()
    .from(gateRuns)
    .where(
      and(
        eq(gateRuns.repositoryId, repo.id),
        or(
          sql`lower(${gateRuns.gateName}) like '%scan%'`,
          sql`lower(${gateRuns.gateName}) like '%security%'`
        )!
      )
    )
    .orderBy(desc(gateRuns.createdAt))
    .limit(100);

  // Summarize: latest status per gate, total alerts (failed + repaired).
  const latestByName = new Map<
    string,
    { status: string; summary: string | null; sha: string; at: Date }
  >();
  for (const r of runs) {
    if (!latestByName.has(r.gateName)) {
      latestByName.set(r.gateName, {
        status: r.status,
        summary: r.summary,
        sha: r.commitSha,
        at: r.createdAt,
      });
    }
  }

  const failed = runs.filter((r) => r.status === "failed").length;
  const repaired = runs.filter((r) => r.status === "repaired").length;
  const allHealthy =
    latestByName.size > 0 &&
    failed === 0 &&
    Array.from(latestByName.values()).every(
      (info) => info.status === "passed" || info.status === "repaired"
    );

  return c.html(
    <Layout title={`Security — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader
        owner={ownerName}
        repo={repoName}
        currentUser={user?.username}
        archived={repo.isArchived}
        isTemplate={repo.isTemplate}
      />
      <RepoNav owner={ownerName} repo={repoName} active="gates" />

      <div class="sec-wrap">
        <section class="sec-hero">
          <div class="sec-hero-orb" aria-hidden="true" />
          <div class="sec-hero-inner">
            <div class="sec-eyebrow">
              <span class="sec-eyebrow-dot" aria-hidden="true" />
              Code scanning · {ownerName}/{repoName}
            </div>
            <h2 class="sec-title">
              <span class="sec-title-grad">Security overview.</span>
            </h2>
            <p class="sec-sub">
              Latest results from every configured scanner — secret detection,
              dependency audits, and security gates. {latestByName.size}{" "}
              scanner{latestByName.size === 1 ? "" : "s"} watching this repo.
            </p>
            <p class="sec-sub" style="margin-top: 8px; font-size: 13px;">
              <strong>AI patch generator:</strong> when any scanner flags a
              finding, the autopilot's patch generator can propose a fix
              PR automatically. See its live status on{" "}
              <a href="/admin/diagnose">/admin/diagnose</a> (site admins
              only) or watch for PRs authored by <code>gluecron[bot]</code>.
            </p>
          </div>
        </section>

        {allHealthy && (
          <div class="sec-healthy" role="status">
            <span class="sec-healthy-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <div class="sec-healthy-text">
              <strong>Healthy</strong>
              <span>
                Every scanner is passing on the latest commit. No action needed.
              </span>
            </div>
          </div>
        )}

        <div class="sec-stats">
          <div class="sec-stat">
            <div class="sec-stat-label">Scanners</div>
            <div class="sec-stat-value">{latestByName.size}</div>
            <div class="sec-stat-hint">Distinct gates configured</div>
          </div>
          <div class={"sec-stat " + (failed > 0 ? "is-red" : "")}>
            <div class="sec-stat-label">Failed (last 100)</div>
            <div class="sec-stat-value">{failed}</div>
            <div class="sec-stat-hint">Runs that blocked a push</div>
          </div>
          <div class={"sec-stat " + (repaired > 0 ? "is-green" : "")}>
            <div class="sec-stat-label">Auto-repaired</div>
            <div class="sec-stat-value">{repaired}</div>
            <div class="sec-stat-hint">Fixed automatically</div>
          </div>
        </div>

        <div class="sec-section-head">
          <h3 class="sec-section-title">Scanner status</h3>
          <span class="sec-section-sub">Most recent run per scanner</span>
        </div>
        {latestByName.size === 0 ? (
          <div class="sec-empty">
            <div class="sec-empty-inner">
              <strong>No scan runs yet</strong>
              <span>Push a commit to trigger the configured scanners.</span>
            </div>
          </div>
        ) : (
          <div class="sec-list">
            {Array.from(latestByName.entries()).map(([name, info]) => (
              <div class={"sec-card is-" + info.status}>
                <div class="sec-card-row">
                  <div class="sec-card-main">
                    <h4 class="sec-card-title">{name}</h4>
                    <p class="sec-card-summary">
                      {info.summary || "No summary recorded."}
                    </p>
                    <div class="sec-card-meta">
                      <code>{info.sha.slice(0, 7)}</code>
                      <span>·</span>
                      <span>{info.at.toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div class="sec-card-right">
                    <span class={"sec-pill is-" + info.status}>
                      <span class="dot" aria-hidden="true" />
                      {info.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div class="sec-section-head">
          <h3 class="sec-section-title">Recent runs</h3>
          <span class="sec-section-sub">Most recent {Math.min(runs.length, 50)} of {runs.length}</span>
        </div>
        {runs.length === 0 ? (
          <div class="sec-empty">
            <div class="sec-empty-inner">
              <strong>No runs yet</strong>
              <span>Push code to see scanner history here.</span>
            </div>
          </div>
        ) : (
          <div class="sec-list">
            {runs.slice(0, 50).map((r) => (
              <div class={"sec-card is-" + r.status}>
                <div class="sec-card-row">
                  <div class="sec-card-main">
                    <h4 class="sec-card-title">{r.gateName}</h4>
                    {r.summary && (
                      <p class="sec-card-summary">{r.summary}</p>
                    )}
                    <div class="sec-card-meta">
                      <code>{r.commitSha.slice(0, 7)}</code>
                      <span>·</span>
                      <span>{r.createdAt.toLocaleString()}</span>
                    </div>
                  </div>
                  <div class="sec-card-right">
                    <span class={"sec-pill is-" + r.status}>
                      <span class="dot" aria-hidden="true" />
                      {r.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

export default codeScanning;

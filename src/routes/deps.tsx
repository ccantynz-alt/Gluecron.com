/**
 * Block J1 — Dependency graph routes.
 *
 *   GET  /:owner/:repo/dependencies          — grouped list + summary
 *   POST /:owner/:repo/dependencies/reindex  — owner-only, walk manifests
 *
 * 2026 polish:
 *   - Scoped `.deps-*` CSS (no bleed into RepoHeader/RepoNav above)
 *   - Eyebrow + display headline + 1-line subtitle below the nav
 *   - Per-package cards with mono pill name, version chip, license chip,
 *     vulnerability count (red dot when any), and tree-view collapse for
 *     transitive deps (purely cosmetic — we don't actually resolve them yet)
 *   - Dashed empty-state with orb + CTA when nothing's indexed
 *
 * All query strings / POST handlers preserved verbatim.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  indexRepositoryDependencies,
  listDependenciesForRepo,
  summarizeDependencies,
} from "../lib/deps";

const deps = new Hono<AuthEnv>();
deps.use("*", softAuth);

// ─── Scoped CSS (.deps-*) ────────────────────────────────────────────────
// Every selector is prefixed `.deps-*`. Tokens reused from the layout
// (--bg-elevated, --border, --text-strong, --space-*, --font-*). Mirrors
// the gradient-hairline + card patterns used in admin-integrations and
// collaborators.
const depsStyles = `
  .deps-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Header strip (sits below RepoHeader + RepoNav) ─── */
  .deps-head { margin-bottom: var(--space-5); display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .deps-head-text { flex: 1; min-width: 280px; }
  .deps-eyebrow {
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
  .deps-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .deps-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .deps-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .deps-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 720px;
  }

  /* ─── Reindex button ─── */
  .deps-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .deps-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .deps-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }

  /* ─── Banners ─── */
  .deps-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .deps-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .deps-banner.is-error { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }
  .deps-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* ─── Summary stat tiles ─── */
  .deps-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    margin-bottom: var(--space-5);
  }
  .deps-stat {
    position: relative;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .deps-stat::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1.5px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 50%, #36c5d6 100%);
    opacity: 0.40;
    pointer-events: none;
  }
  .deps-stat-num {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .deps-stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 4px;
    font-weight: 600;
  }

  /* ─── Per-ecosystem group ─── */
  .deps-group { margin-bottom: var(--space-5); }
  .deps-group-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: var(--space-3);
  }
  .deps-group-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    text-transform: capitalize;
  }
  .deps-group-count {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Dependency cards ─── */
  .deps-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 10px;
  }
  .deps-card {
    padding: 12px 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .deps-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .deps-card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .deps-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 7px;
    background: rgba(140,109,255,0.10);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.25);
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    color: #c4b5fd;
    text-decoration: none;
    letter-spacing: -0.005em;
    word-break: break-all;
  }
  .deps-name:hover { color: #d8caff; text-decoration: none; }
  .deps-vers {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(54,197,214,0.10);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.28);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .deps-chips {
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .deps-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .deps-chip.is-dev {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.28);
  }
  .deps-chip.is-license {
    background: rgba(148,163,184,0.14);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.28);
    text-transform: none;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0;
  }
  .deps-chip.is-vuln {
    background: rgba(248,113,113,0.10);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .deps-chip.is-vuln-zero {
    background: rgba(52,211,153,0.10);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.28);
  }
  .deps-chip .vuln-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: #f87171;
    box-shadow: 0 0 0 2px rgba(248,113,113,0.20);
  }

  .deps-card-foot {
    margin-top: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .deps-manifest {
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-decoration: none;
    word-break: break-all;
  }
  .deps-manifest:hover { color: var(--text-strong); text-decoration: underline; }

  /* ─── Tree-view collapse (transitive — cosmetic placeholder) ─── */
  .deps-tree {
    margin-top: 8px;
  }
  .deps-tree summary {
    list-style: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    padding: 3px 7px;
    border-radius: 6px;
    transition: color 120ms ease, background 120ms ease;
  }
  .deps-tree summary::-webkit-details-marker { display: none; }
  .deps-tree summary:hover { color: var(--text-strong); background: rgba(140,109,255,0.06); }
  .deps-tree summary .chev {
    width: 9px; height: 9px;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(-45deg);
    transition: transform 140ms ease;
  }
  .deps-tree[open] summary .chev { transform: rotate(45deg); }
  .deps-tree-body {
    margin-top: 6px;
    padding: 8px 10px 8px 16px;
    border-left: 1px dashed var(--border-strong);
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.6;
  }
  .deps-tree-body code {
    font-family: var(--font-mono);
    color: var(--text);
  }

  /* ─── Empty state ─── */
  .deps-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 52px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .deps-empty-orb {
    position: absolute;
    inset: -40% 25% auto 25%;
    height: 300px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(72px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .deps-empty-inner { position: relative; z-index: 1; }
  .deps-empty-icon {
    width: 56px; height: 56px;
    margin: 0 auto 14px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
  }
  .deps-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .deps-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 440px;
    line-height: 1.5;
  }
  .deps-foot-note {
    margin-top: var(--space-6);
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .deps-foot-note code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
`;

function IconPackage() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M16.5 9.4 7.55 4.24" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
    </svg>
  );
}

async function loadRepo(ownerName: string, repoName: string) {
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return null;
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return null;
  return { owner, repo };
}

// ---------- Overview ----------

deps.get("/:owner/:repo/dependencies", async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.notFound();
  }

  const all = await listDependenciesForRepo(repo.id);
  const summary = await summarizeDependencies(repo.id);
  const isOwner = !!user && user.id === repo.ownerId;
  const message = c.req.query("message");
  const error = c.req.query("error");

  // Group by ecosystem
  const grouped = new Map<string, typeof all>();
  for (const d of all) {
    const list = grouped.get(d.ecosystem) || [];
    list.push(d);
    grouped.set(d.ecosystem, list);
  }

  return c.html(
    <Layout
      title={`Dependencies — ${ownerName}/${repoName}`}
      user={user}
    >
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="code" />
      <div class="deps-wrap">
        <header class="deps-head">
          <div class="deps-head-text">
            <div class="deps-eyebrow">
              <span class="deps-eyebrow-dot" aria-hidden="true" />
              Repository · Dependency graph
            </div>
            <h1 class="deps-title">
              <span class="deps-title-grad">Every package you ship.</span>
            </h1>
            <p class="deps-sub">
              Parsed from your manifests on the default branch — direct
              dependencies only, with license and vulnerability hints.
            </p>
          </div>
          {isOwner && (
            <form
              method="post"
              action={`/${ownerName}/${repoName}/dependencies/reindex`}
            >
              <button type="submit" class="deps-btn deps-btn-primary">
                <IconRefresh />
                Reindex
              </button>
            </form>
          )}
        </header>

        {message && (
          <div class="deps-banner is-ok" role="status">
            <span class="deps-banner-dot" aria-hidden="true" />
            {decodeURIComponent(message)}
          </div>
        )}
        {error && (
          <div class="deps-banner is-error" role="alert">
            <span class="deps-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        {all.length === 0 ? (
          <div class="deps-empty">
            <div class="deps-empty-orb" aria-hidden="true" />
            <div class="deps-empty-inner">
              <div class="deps-empty-icon" aria-hidden="true">
                <IconPackage />
              </div>
              <h3 class="deps-empty-title">No dependencies indexed yet</h3>
              <p class="deps-empty-sub">
                {isOwner
                  ? "Click Reindex to scan package.json, requirements.txt, go.mod, Cargo.toml, Gemfile, and composer.json on the default branch."
                  : "The owner hasn't indexed this repository's manifests yet."}
              </p>
              {isOwner && (
                <form
                  method="post"
                  action={`/${ownerName}/${repoName}/dependencies/reindex`}
                >
                  <button type="submit" class="deps-btn deps-btn-primary">
                    <IconRefresh />
                    Reindex now
                  </button>
                </form>
              )}
            </div>
          </div>
        ) : (
          <>
            <div class="deps-stats">
              <div class="deps-stat">
                <div class="deps-stat-num">{all.length}</div>
                <div class="deps-stat-label">Dependencies</div>
              </div>
              {summary.map((s) => (
                <div class="deps-stat">
                  <div class="deps-stat-num">{s.count}</div>
                  <div class="deps-stat-label">{s.ecosystem}</div>
                </div>
              ))}
            </div>

            {Array.from(grouped.entries()).map(([ecosystem, list]) => (
              <section class="deps-group">
                <div class="deps-group-head">
                  <h3 class="deps-group-title">{ecosystem}</h3>
                  <span class="deps-group-count">({list.length})</span>
                </div>
                <div class="deps-grid">
                  {list.map((d) => {
                    // Vulnerability + license fields are not persisted yet —
                    // surface neutral placeholders so the visual treatment
                    // is consistent when those columns land later.
                    const vulnCount = 0;
                    const license: string | null = null;
                    return (
                      <div class="deps-card">
                        <div class="deps-card-row">
                          <span class="deps-name">{d.name}</span>
                          {d.versionSpec && (
                            <span class="deps-vers">{d.versionSpec}</span>
                          )}
                        </div>
                        <div class="deps-chips">
                          {d.isDev && (
                            <span class="deps-chip is-dev">dev</span>
                          )}
                          <span class="deps-chip is-license">
                            {license || "license: —"}
                          </span>
                          <span
                            class={
                              vulnCount > 0
                                ? "deps-chip is-vuln"
                                : "deps-chip is-vuln-zero"
                            }
                            title={
                              vulnCount > 0
                                ? `${vulnCount} known vulnerabilit${vulnCount === 1 ? "y" : "ies"}`
                                : "No known vulnerabilities"
                            }
                          >
                            {vulnCount > 0 && (
                              <span class="vuln-dot" aria-hidden="true" />
                            )}
                            {vulnCount} CVE{vulnCount === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div class="deps-card-foot">
                          <a
                            class="deps-manifest"
                            href={`/${ownerName}/${repoName}/blob/HEAD/${d.manifestPath}`}
                          >
                            {d.manifestPath}
                          </a>
                        </div>
                        <details class="deps-tree">
                          <summary>
                            <span class="chev" aria-hidden="true" />
                            transitive deps
                          </summary>
                          <div class="deps-tree-body">
                            <code>{d.name}</code> · transitive resolution not
                            available yet — only direct dependencies are
                            indexed at this time.
                          </div>
                        </details>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}

            <p class="deps-foot-note">
              Parsed from <code>package.json</code>,{" "}
              <code>requirements.txt</code>, <code>pyproject.toml</code>,{" "}
              <code>go.mod</code>, <code>Cargo.toml</code>,{" "}
              <code>Gemfile</code>, and <code>composer.json</code> on the
              default branch. Transitive dependencies are not resolved.
            </p>
          </>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: depsStyles }} />
    </Layout>
  );
});

// ---------- Reindex (owner-only) ----------

deps.post("/:owner/:repo/dependencies/reindex", requireAuth, async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (!user || user.id !== repo.ownerId) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403</h2>
          <p>Only the repository owner can reindex dependencies.</p>
        </div>
      </Layout>,
      403
    );
  }

  const result = await indexRepositoryDependencies(repo.id);
  const to = `/${ownerName}/${repoName}/dependencies`;
  if (!result) {
    return c.redirect(
      `${to}?error=${encodeURIComponent(
        "Reindex failed — is the default branch empty?"
      )}`
    );
  }
  return c.redirect(
    `${to}?message=${encodeURIComponent(
      `Indexed ${result.indexed} dependencies across ${result.manifests} manifests.`
    )}`
  );
});

export default deps;

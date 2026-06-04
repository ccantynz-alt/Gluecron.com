/**
 * Packages UI — lists packages for a repo, per-package detail (Block C2).
 *
 *   GET /:owner/:repo/packages             — list of published packages
 *   GET /:owner/:repo/packages/:pkg{.+}    — detail + version list + install help
 *
 * Packages doesn't yet have a tab in RepoNav — we render with active="code"
 * so the page still lays out correctly.
 *
 * 2026 polish: scoped `.pkg-*` class system mirrors `admin-ops.tsx` and
 * `collaborators.tsx` — eyebrow + display headline, mono version pills,
 * tabular-nums for sizes/dates, dashed orb-lit empty state with publish
 * instructions, and a sidebar info card on detail.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  packages,
  packageVersions,
  packageTags,
  repositories,
  users,
} from "../db/schema";
import type { Package, PackageVersion, PackageTag } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getUnreadCount } from "../lib/unread";
import { parsePackageName } from "../lib/packages";

const ui = new Hono<AuthEnv>();
ui.use("*", softAuth);

async function loadRepo(owner: string, repo: string) {
  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerId: repositories.ownerId,
      defaultBranch: repositories.defaultBranch,
      starCount: repositories.starCount,
      forkCount: repositories.forkCount,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  return row || null;
}

function relTime(d: Date | string | null): string {
  if (!d) return "";
  const t = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - t.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return t.toLocaleDateString();
}

function fullPkgName(pkg: { scope: string | null; name: string }): string {
  return pkg.scope ? `${pkg.scope}/${pkg.name}` : pkg.name;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Scoped CSS (.pkg-*) ────────────────────────────────────────────────────
const pkgStyles = `
  .pkg-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .pkg-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .pkg-head-text { flex: 1; min-width: 280px; }
  .pkg-eyebrow {
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
  .pkg-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .pkg-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .pkg-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .pkg-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 640px;
  }

  /* Buttons */
  .pkg-btn {
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
    line-height: 1;
    white-space: nowrap;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .pkg-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .pkg-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .pkg-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
    padding: 6px 12px;
    font-size: 12px;
  }
  .pkg-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .pkg-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
    padding: 6px 12px;
    font-size: 12px;
  }
  .pkg-btn-danger:hover {
    border-style: dashed;
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
    text-decoration: none;
  }

  /* Crumbs */
  .pkg-crumbs {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
    font-size: 12.5px;
  }
  .pkg-crumbs a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 11px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 500;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .pkg-crumbs a:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }
  .pkg-crumbs span.cur {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
  }

  /* Package list */
  .pkg-list { display: flex; flex-direction: column; gap: 10px; }
  .pkg-card {
    display: block;
    text-decoration: none;
    color: inherit;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
  }
  .pkg-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
    text-decoration: none;
    color: inherit;
  }
  .pkg-card-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
  }
  .pkg-card-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 15.5px;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .pkg-card-desc {
    margin-top: 4px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .pkg-card-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .pkg-version {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(140,109,255,0.12);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    font-variant-numeric: tabular-nums;
  }
  .pkg-version.is-empty {
    background: rgba(148,163,184,0.12);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }
  .pkg-card-meta .sep { opacity: 0.4; }

  /* Detail grid */
  .pkg-detail-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 24px;
    align-items: start;
  }
  @media (max-width: 880px) {
    .pkg-detail-grid { grid-template-columns: 1fr; }
  }
  .pkg-section { margin-bottom: 20px; }
  .pkg-section-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-weight: 600;
    color: var(--text-muted);
    margin: 0 0 8px;
  }
  .pkg-code {
    display: block;
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    overflow-x: auto;
    white-space: pre;
  }
  .pkg-readme {
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    color: var(--text);
    max-height: 480px;
    overflow: auto;
  }

  /* Version list */
  .pkg-versions {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .pkg-version-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .pkg-version-row:last-child { border-bottom: 0; }
  .pkg-version-row:hover { background: rgba(255,255,255,0.02); }
  .pkg-version-main { flex: 1; min-width: 0; }
  .pkg-version-line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pkg-version-meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .pkg-version-meta code {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
  }
  .pkg-version-actions {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .pkg-version-actions form { margin: 0; }
  .pkg-yanked {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: rgba(248,113,113,0.12);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);
  }

  /* Sidebar */
  .pkg-side {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    position: relative;
    overflow: hidden;
  }
  .pkg-side::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
  }
  .pkg-side-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin: 0 0 4px;
    font-weight: 600;
  }
  .pkg-side-value {
    font-size: 13px;
    color: var(--text);
    margin: 0 0 14px;
    word-break: break-all;
  }
  .pkg-side-value:last-child { margin-bottom: 0; }
  .pkg-side-value code {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  /* Empty */
  .pkg-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(32px, 6vw, 56px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .pkg-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .pkg-empty-inner { position: relative; z-index: 1; }
  .pkg-empty-icon {
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
  .pkg-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .pkg-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 480px;
    line-height: 1.5;
  }
  .pkg-empty-howto {
    text-align: left;
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
    font-size: 13px;
    max-width: 640px;
    margin: 16px auto 0;
    line-height: 1.55;
  }
  .pkg-empty-howto ol { padding-left: 20px; margin: 8px 0 0; }
  .pkg-empty-howto li { margin-bottom: 6px; }
  .pkg-empty-howto code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 6px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
  }
  .pkg-empty-howto pre {
    background: rgba(0,0,0,0.25);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    margin: 6px 0;
    white-space: pre-wrap;
    color: var(--text);
  }
`;

function IconBox() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

ui.get("/:owner/:repo/packages", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  let rows: (Package & { latestVersion: string | null })[] = [];
  try {
    const pkgs = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.repositoryId, repoRow.id),
          eq(packages.ecosystem, "npm")
        )
      )
      .orderBy(desc(packages.updatedAt));

    // Fetch the "latest" tag for each package.
    const latest = await Promise.all(
      pkgs.map(async (p) => {
        try {
          const [tag] = await db
            .select({
              version: packageVersions.version,
            })
            .from(packageTags)
            .innerJoin(
              packageVersions,
              eq(packageTags.versionId, packageVersions.id)
            )
            .where(
              and(
                eq(packageTags.packageId, p.id),
                eq(packageTags.tag, "latest")
              )
            )
            .limit(1);
          return tag?.version || null;
        } catch {
          return null;
        }
      })
    );
    rows = pkgs.map((p, i) => ({ ...p, latestVersion: latest[i] }));
  } catch (err) {
    console.error("[packages] ui list:", err);
    return c.text("Service unavailable", 503);
  }

  const unread = user ? await getUnreadCount(user.id) : 0;
  const host = new URL(c.req.url).host;
  const registryUrl = `${new URL(c.req.url).protocol}//${host}/npm/`;

  return c.html(
    <Layout
      title={`Packages — ${owner}/${repo}`}
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
      <RepoNav owner={owner} repo={repo} active="code" />

      <div class="pkg-wrap">
        <header class="pkg-head">
          <div class="pkg-head-text">
            <div class="pkg-eyebrow">
              <span class="pkg-eyebrow-dot" aria-hidden="true" />
              Repository · Packages
            </div>
            <h1 class="pkg-title">
              <span class="pkg-title-grad">Published artifacts.</span>
            </h1>
            <p class="pkg-sub">
              Every npm package shipped from {owner}/{repo}, scoped to the
              repo's own registry namespace.
            </p>
          </div>
        </header>

        {rows.length === 0 ? (
          <div class="pkg-empty">
            <div class="pkg-empty-orb" aria-hidden="true" />
            <div class="pkg-empty-inner">
              <div class="pkg-empty-icon" aria-hidden="true">
                <IconBox />
              </div>
              <h3 class="pkg-empty-title">Publish your first package</h3>
              <p class="pkg-empty-sub">
                Wire your repo to the Gluecron npm registry and run{" "}
                <code>npm publish</code> — your tarball will appear here.
              </p>
              <div class="pkg-empty-howto">
                <strong>To publish:</strong>
                <ol>
                  <li>
                    Create a personal access token at{" "}
                    <a href="/settings/tokens">/settings/tokens</a>.
                  </li>
                  <li>
                    Add to your <code>.npmrc</code>:
                    <pre>
                      registry={registryUrl}
                      {"\n"}
                      //{host}/npm/:_authToken=YOUR_PAT
                    </pre>
                  </li>
                  <li>
                    In <code>package.json</code>, point{" "}
                    <code>repository.url</code> at this repo
                    (<code>{`http://${host}/${owner}/${repo}.git`}</code>).
                  </li>
                  <li>
                    Run <code>npm publish</code>.
                  </li>
                </ol>
              </div>
            </div>
          </div>
        ) : (
          <div class="pkg-list">
            {rows.map((p) => {
              const fullName = fullPkgName(p);
              return (
                <a
                  href={`/${owner}/${repo}/packages/${encodeURIComponent(fullName)}`}
                  class="pkg-card"
                >
                  <div class="pkg-card-row">
                    <div style="flex: 1; min-width: 0">
                      <div class="pkg-card-name">{fullName}</div>
                      {p.description && (
                        <div class="pkg-card-desc">{p.description}</div>
                      )}
                    </div>
                    <div class="pkg-card-meta">
                      {p.latestVersion ? (
                        <span class="pkg-version">{p.latestVersion}</span>
                      ) : (
                        <span class="pkg-version is-empty">no versions</span>
                      )}
                      <span class="sep">·</span>
                      <span>{relTime(p.updatedAt)}</span>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: pkgStyles }} />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

ui.get("/:owner/:repo/packages/:pkgName{.+}", async (c) => {
  const user = c.get("user");
  const { owner, repo, pkgName } = c.req.param();
  const parsed = parsePackageName(pkgName);
  if (!parsed) {
    return c.text("Invalid package name", 400);
  }

  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  let pkg: Package | null = null;
  let versions: PackageVersion[] = [];
  let tags: PackageTag[] = [];
  try {
    const candidates = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.repositoryId, repoRow.id),
          eq(packages.ecosystem, "npm"),
          eq(packages.name, parsed.name)
        )
      )
      .limit(10);
    pkg =
      candidates.find((p) => (p.scope ?? null) === (parsed.scope ?? null)) ||
      null;
    if (pkg) {
      versions = await db
        .select()
        .from(packageVersions)
        .where(eq(packageVersions.packageId, pkg.id))
        .orderBy(desc(packageVersions.publishedAt));
      tags = await db
        .select()
        .from(packageTags)
        .where(eq(packageTags.packageId, pkg.id));
    }
  } catch (err) {
    console.error("[packages] ui detail:", err);
    return c.text("Service unavailable", 503);
  }

  if (!pkg) return c.notFound();

  const unread = user ? await getUnreadCount(user.id) : 0;
  const fullName = fullPkgName(pkg);
  const latestTag = tags.find((t) => t.tag === "latest");
  const latestVersion =
    latestTag && versions.find((v) => v.id === latestTag.versionId);
  const isOwner = !!user && user.id === repoRow.ownerId;
  const host = new URL(c.req.url).host;

  return c.html(
    <Layout
      title={`${fullName} — ${owner}/${repo}`}
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
      <RepoNav owner={owner} repo={repo} active="code" />

      <div class="pkg-wrap">
        <div class="pkg-crumbs">
          <a href={`/${owner}/${repo}/packages`}>
            Packages
          </a>
          <span class="cur">{fullName}</span>
        </div>

        <header class="pkg-head">
          <div class="pkg-head-text">
            <div class="pkg-eyebrow">
              <span class="pkg-eyebrow-dot" aria-hidden="true" />
              Package · npm
            </div>
            <h1 class="pkg-title">
              <span class="pkg-title-grad">{fullName}</span>
            </h1>
            {pkg.description && (
              <p class="pkg-sub">{pkg.description}</p>
            )}
          </div>
          {latestVersion && (
            <span class="pkg-version">v{latestVersion.version}</span>
          )}
        </header>

        <div class="pkg-detail-grid">
          <div>
            <section class="pkg-section">
              <h3 class="pkg-section-label">Install</h3>
              <code class="pkg-code">
                npm install {fullName}
                {latestVersion ? `@${latestVersion.version}` : ""}
              </code>
            </section>

            {pkg.readme && (
              <section class="pkg-section">
                <h3 class="pkg-section-label">Readme</h3>
                <pre class="pkg-readme">{pkg.readme}</pre>
              </section>
            )}

            <section class="pkg-section">
              <h3 class="pkg-section-label">
                Versions
                <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);font-weight:500;font-variant-numeric:tabular-nums">
                  {" "}({versions.length})
                </span>
              </h3>
              {versions.length === 0 ? (
                <div class="pkg-empty" style="padding: 28px 20px">
                  <div class="pkg-empty-inner">
                    <p class="pkg-empty-sub" style="margin-bottom: 0">No versions yet.</p>
                  </div>
                </div>
              ) : (
                <div class="pkg-versions">
                  {versions.map((v) => (
                    <div class="pkg-version-row">
                      <div class="pkg-version-main">
                        <div class="pkg-version-line">
                          <span class="pkg-version">{v.version}</span>
                          {v.yanked && (
                            <span class="pkg-yanked">yanked</span>
                          )}
                        </div>
                        <div class="pkg-version-meta">
                          {humanSize(v.sizeBytes)} · published{" "}
                          {relTime(v.publishedAt)}
                          {v.shasum && (
                            <>
                              {" · sha1 "}
                              <code>{v.shasum.slice(0, 12)}</code>
                            </>
                          )}
                        </div>
                      </div>
                      <div class="pkg-version-actions">
                        <a
                          class="pkg-btn pkg-btn-ghost"
                          href={`/npm/${encodeURIComponent(fullName)}/-/${pkg.name}-${v.version}.tgz`}
                        >
                          Download
                        </a>
                        {isOwner && !v.yanked && (
                          <form
                            method="post"
                            action={`/api/packages/${owner}/${repo}/${encodeURIComponent(fullName)}/${v.version}/yank`}
                            onsubmit="return confirm('Yank this version? It will still download, but will be flagged as yanked.')"
                          >
                            <button
                              type="submit"
                              class="pkg-btn pkg-btn-danger"
                            >
                              Yank
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside class="pkg-side">
            <p class="pkg-side-label">Registry</p>
            <p class="pkg-side-value">
              <code>http://{host}/npm/</code>
            </p>
            {pkg.homepage && (
              <>
                <p class="pkg-side-label">Homepage</p>
                <p class="pkg-side-value">
                  <a href={pkg.homepage}>{pkg.homepage}</a>
                </p>
              </>
            )}
            {pkg.license && (
              <>
                <p class="pkg-side-label">License</p>
                <p class="pkg-side-value">{pkg.license}</p>
              </>
            )}
            <p class="pkg-side-label">Repository</p>
            <p class="pkg-side-value">
              <a href={`/${owner}/${repo}`}>
                {owner}/{repo}
              </a>
            </p>
          </aside>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: pkgStyles }} />
    </Layout>
  );
});

export default ui;

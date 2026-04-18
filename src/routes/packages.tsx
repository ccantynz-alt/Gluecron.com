/**
 * Packages UI — lists packages for a repo, per-package detail (Block C2).
 *
 *   GET /:owner/:repo/packages             — list of published packages
 *   GET /:owner/:repo/packages/:pkg{.+}    — detail + version list + install help
 *
 * Packages doesn't yet have a tab in RepoNav — we render with active="code"
 * so the page still lays out correctly.
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

      <div style="max-width: 900px">
        <h2 style="margin: 0 0 16px 0">Packages</h2>

        {rows.length === 0 ? (
          <div class="empty-state">
            <p style="margin-bottom: 12px">
              No npm packages published from this repository yet.
            </p>
            <div
              style="text-align: left; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; font-size: 13px; max-width: 640px; margin: 0 auto"
            >
              <strong>To publish:</strong>
              <ol style="padding-left: 20px; margin: 8px 0 0 0; line-height: 1.6">
                <li>
                  Create a personal access token at{" "}
                  <a href="/settings/tokens">/settings/tokens</a>.
                </li>
                <li>
                  Add to your <code>.npmrc</code>:
                  <pre style="background: #0b0d0f; color: #c7ccd1; padding: 8px 12px; border-radius: 4px; font-size: 12px; margin: 6px 0">
                    registry={registryUrl}
                    {"\n"}
                    //{host}/npm/:_authToken=YOUR_PAT
                  </pre>
                </li>
                <li>
                  In <code>package.json</code>, point{" "}
                  <code>repository.url</code> at this repo
                  (<code>
                    {`http://${host}/${owner}/${repo}.git`}
                  </code>
                  ).
                </li>
                <li>
                  Run <code>npm publish</code>.
                </li>
              </ol>
            </div>
          </div>
        ) : (
          <div class="panel" style="overflow: hidden">
            {rows.map((p) => {
              const fullName = fullPkgName(p);
              return (
                <a
                  href={`/${owner}/${repo}/packages/${encodeURIComponent(fullName)}`}
                  style="display: block; padding: 12px 16px; border-bottom: 1px solid var(--border); text-decoration: none; color: inherit"
                >
                  <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px">
                    <div style="flex: 1; min-width: 0">
                      <div style="font-weight: 600">{fullName}</div>
                      {p.description && (
                        <div style="font-size: 13px; color: var(--text-muted); margin-top: 2px">
                          {p.description}
                        </div>
                      )}
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); white-space: nowrap">
                      {p.latestVersion ? (
                        <span>
                          <code>{p.latestVersion}</code>
                        </span>
                      ) : (
                        <span>no versions</span>
                      )}
                      {" · "}
                      <span>{relTime(p.updatedAt)}</span>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>
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

      <div style="max-width: 900px">
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px">
          <a href={`/${owner}/${repo}/packages`}>Packages</a>
          {" / "}
          <span>{fullName}</span>
        </div>
        <h2 style="margin: 0 0 4px 0">{fullName}</h2>
        {pkg.description && (
          <p style="color: var(--text-muted); margin: 0 0 16px 0">
            {pkg.description}
          </p>
        )}

        <div style="display: grid; grid-template-columns: 1fr 280px; gap: 24px">
          <div>
            <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 0 0 8px 0">
              Install
            </h3>
            <pre style="background: #0b0d0f; color: #c7ccd1; padding: 10px 14px; border-radius: 6px; font-size: 13px; overflow-x: auto">
              npm install {fullName}
              {latestVersion ? `@${latestVersion.version}` : ""}
            </pre>

            {pkg.readme && (
              <>
                <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 20px 0 8px 0">
                  Readme
                </h3>
                <pre
                  style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; white-space: pre-wrap; font-size: 13px; line-height: 1.5"
                >
                  {pkg.readme}
                </pre>
              </>
            )}

            <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 20px 0 8px 0">
              Versions
            </h3>
            {versions.length === 0 ? (
              <div class="empty-state">
                <p>No versions yet.</p>
              </div>
            ) : (
              <div class="panel" style="overflow: hidden">
                {versions.map((v) => (
                  <div
                    style="padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 12px"
                  >
                    <div style="flex: 1; min-width: 0">
                      <div style="font-weight: 500">
                        <code>{v.version}</code>
                        {v.yanked && (
                          <span
                            style="margin-left: 8px; font-size: 11px; color: var(--red); text-transform: uppercase"
                          >
                            yanked
                          </span>
                        )}
                      </div>
                      <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
                        {humanSize(v.sizeBytes)} · published{" "}
                        {relTime(v.publishedAt)}
                        {v.shasum && (
                          <>
                            {" · sha1 "}
                            <code style="font-size: 11px">
                              {v.shasum.slice(0, 12)}
                            </code>
                          </>
                        )}
                      </div>
                    </div>
                    <a
                      class="btn btn-sm"
                      href={`/npm/${encodeURIComponent(fullName)}/-/${pkg.name}-${v.version}.tgz`}
                    >
                      Download
                    </a>
                    {isOwner && !v.yanked && (
                      <form
                        method="post"
                        action={`/api/packages/${owner}/${repo}/${encodeURIComponent(fullName)}/${v.version}/yank`}
                        onsubmit="return confirm('Yank this version? It will still download, but will be flagged as yanked.')"
                        style="margin: 0"
                      >
                        <button
                          type="submit"
                          class="btn btn-sm btn-danger"
                        >
                          Yank
                        </button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <aside>
            <div class="panel" style="padding: 12px 14px">
              <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px">
                Registry
              </div>
              <code style="font-size: 12px">http://{host}/npm/</code>

              {pkg.homepage && (
                <>
                  <div style="font-size: 12px; color: var(--text-muted); margin: 10px 0 4px 0">
                    Homepage
                  </div>
                  <a href={pkg.homepage} style="font-size: 13px; word-break: break-all">
                    {pkg.homepage}
                  </a>
                </>
              )}
              {pkg.license && (
                <>
                  <div style="font-size: 12px; color: var(--text-muted); margin: 10px 0 4px 0">
                    License
                  </div>
                  <div style="font-size: 13px">{pkg.license}</div>
                </>
              )}
              <div style="font-size: 12px; color: var(--text-muted); margin: 10px 0 4px 0">
                Repository
              </div>
              <a
                href={`/${owner}/${repo}`}
                style="font-size: 13px; word-break: break-all"
              >
                {owner}/{repo}
              </a>
            </div>
          </aside>
        </div>
      </div>
    </Layout>
  );
});

export default ui;

/**
 * Block J1 — Dependency graph routes.
 *
 *   GET  /:owner/:repo/dependencies          — grouped list + summary
 *   POST /:owner/:repo/dependencies/reindex  — owner-only, walk manifests
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
import { generateSpdx, generateCycloneDx } from "../lib/sbom";
import { scanLicenses, type LicenseReport, type LicenseRisk } from "../lib/license-scan";

const deps = new Hono<AuthEnv>();
deps.use("*", softAuth);

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
      <div class="settings-container">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">Dependencies</h2>
          <div style="display:flex;gap:8px;align-items:center">
            {all.length > 0 && (
              <>
                <a href={`/${ownerName}/${repoName}/dependencies/licenses`} class="btn btn-sm" style="text-decoration:none">
                  License Scan
                </a>
                <a href={`/${ownerName}/${repoName}/dependencies/sbom/spdx`} class="btn btn-sm" style="text-decoration:none">
                  SPDX
                </a>
                <a href={`/${ownerName}/${repoName}/dependencies/sbom/cyclonedx`} class="btn btn-sm" style="text-decoration:none">
                  CycloneDX
                </a>
              </>
            )}
            {isOwner && (
              <form
                method="POST"
                action={`/${ownerName}/${repoName}/dependencies/reindex`}
                style="margin:0"
              >
                <button type="submit" class="btn btn-primary btn-sm">
                  Reindex
                </button>
              </form>
            )}
          </div>
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
        <p style="color:var(--text-muted);margin-top:8px">
          Parsed from <code>package.json</code>, <code>requirements.txt</code>,{" "}
          <code>pyproject.toml</code>, <code>go.mod</code>,{" "}
          <code>Cargo.toml</code>, <code>Gemfile</code>, and{" "}
          <code>composer.json</code> on the default branch. Transitive
          dependencies are not resolved.
        </p>

        {all.length === 0 ? (
          <div class="panel-empty" style="padding:24px">
            No dependencies indexed yet.
            {isOwner && " Click Reindex to scan the repository."}
          </div>
        ) : (
          <>
            <div
              style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:16px 0"
            >
              <div class="panel" style="padding:12px;text-align:center">
                <div style="font-size:20px;font-weight:700">
                  {all.length}
                </div>
                <div
                  style="font-size:11px;color:var(--text-muted);text-transform:uppercase"
                >
                  Dependencies
                </div>
              </div>
              {summary.map((s) => (
                <div class="panel" style="padding:12px;text-align:center">
                  <div style="font-size:20px;font-weight:700">
                    {s.count}
                  </div>
                  <div
                    style="font-size:11px;color:var(--text-muted);text-transform:uppercase"
                  >
                    {s.ecosystem}
                  </div>
                </div>
              ))}
            </div>

            {Array.from(grouped.entries()).map(([ecosystem, list]) => (
              <>
                <h3 style="margin-top:20px">
                  {ecosystem}{" "}
                  <span
                    style="font-size:12px;color:var(--text-muted);font-weight:400"
                  >
                    ({list.length})
                  </span>
                </h3>
                <div class="panel" style="margin-bottom:12px">
                  {list.map((d) => (
                    <div
                      class="panel-item"
                      style="justify-content:space-between;flex-wrap:wrap;gap:6px"
                    >
                      <div>
                        <span
                          style="font-family:var(--font-mono);font-weight:600"
                        >
                          {d.name}
                        </span>
                        {d.versionSpec && (
                          <span
                            style="margin-left:8px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)"
                          >
                            {d.versionSpec}
                          </span>
                        )}
                        {d.isDev && (
                          <span
                            style="margin-left:8px;font-size:10px;padding:2px 6px;background:var(--bg-subtle);border-radius:3px;color:var(--text-muted);text-transform:uppercase"
                          >
                            dev
                          </span>
                        )}
                      </div>
                      <a
                        href={`/${ownerName}/${repoName}/blob/HEAD/${d.manifestPath}`}
                        style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono)"
                      >
                        {d.manifestPath}
                      </a>
                    </div>
                  ))}
                </div>
              </>
            ))}
          </>
        )}
      </div>
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

// ---------- License Compliance ----------

deps.get("/:owner/:repo/dependencies/licenses", async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) return c.notFound();

  const report = await scanLicenses(repo.id);

  const riskColor = (risk: LicenseRisk): string => {
    if (risk === "high") return "#f85149";
    if (risk === "medium") return "#d29922";
    if (risk === "low") return "#58a6ff";
    if (risk === "unknown") return "#8b949e";
    return "#3fb950";
  };

  const riskBadge = (risk: LicenseRisk) => (
    <span style={`font-size:11px;padding:2px 8px;border-radius:3px;background:${riskColor(risk)}22;color:${riskColor(risk)};font-weight:600;text-transform:uppercase`}>
      {risk}
    </span>
  );

  return c.html(
    <Layout title={`License Compliance — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="code" />
      <div class="settings-container">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">License Compliance</h2>
          <a href={`/${ownerName}/${repoName}/dependencies`} class="btn btn-sm" style="text-decoration:none">
            Back to Dependencies
          </a>
        </div>

        <div class={`panel ${report.compliant ? "" : "auth-error"}`} style="padding:16px;margin-top:16px">
          <div style="font-weight:600;font-size:16px;margin-bottom:4px">
            {report.compliant ? "Compliant" : "Action Required"}
          </div>
          <div style="color:var(--text-muted)">{report.summary}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:8px">
            {report.scanned} of {report.totalDeps} dependencies scanned
          </div>
        </div>

        {report.risks.high.length > 0 && (
          <>
            <h3 style="margin-top:24px;color:#f85149">High Risk ({report.risks.high.length})</h3>
            <div class="panel">
              {report.risks.high.map((d) => (
                <div class="panel-item" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
                  <div>
                    <span style="font-family:var(--font-mono);font-weight:600">{d.name}</span>
                    <span style="margin-left:8px;font-size:12px;color:var(--text-muted)">{d.version}</span>
                    {riskBadge(d.risk)}
                  </div>
                  <div style="font-size:12px;color:var(--text-muted)">{d.license} — {d.reason}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {report.risks.medium.length > 0 && (
          <>
            <h3 style="margin-top:24px;color:#d29922">Medium Risk ({report.risks.medium.length})</h3>
            <div class="panel">
              {report.risks.medium.map((d) => (
                <div class="panel-item" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
                  <div>
                    <span style="font-family:var(--font-mono);font-weight:600">{d.name}</span>
                    <span style="margin-left:8px;font-size:12px;color:var(--text-muted)">{d.version}</span>
                    {riskBadge(d.risk)}
                  </div>
                  <div style="font-size:12px;color:var(--text-muted)">{d.license} — {d.reason}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {report.risks.unknown.length > 0 && (
          <>
            <h3 style="margin-top:24px;color:#8b949e">Unknown License ({report.risks.unknown.length})</h3>
            <div class="panel">
              {report.risks.unknown.map((d) => (
                <div class="panel-item" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
                  <div>
                    <span style="font-family:var(--font-mono);font-weight:600">{d.name}</span>
                    <span style="margin-left:8px;font-size:12px;color:var(--text-muted)">{d.version}</span>
                    {riskBadge(d.risk)}
                  </div>
                  <div style="font-size:12px;color:var(--text-muted)">{d.ecosystem} — {d.reason}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {report.risks.low.length > 0 && (
          <>
            <h3 style="margin-top:24px">Other ({report.risks.low.length})</h3>
            <div class="panel">
              {report.risks.low.map((d) => (
                <div class="panel-item" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
                  <div>
                    <span style="font-family:var(--font-mono);font-weight:600">{d.name}</span>
                    <span style="margin-left:8px;font-size:12px;color:var(--text-muted)">{d.version}</span>
                    {riskBadge(d.risk)}
                  </div>
                  <div style="font-size:12px;color:var(--text-muted)">{d.license} — {d.reason}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
});

// ---------- License API ----------

deps.get("/api/repos/:owner/:repo/licenses", softAuth, async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.json({ error: "Not found" }, 404);
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(await scanLicenses(repo.id));
});

// ---------- SBOM Export (SPDX) ----------

deps.get("/:owner/:repo/dependencies/sbom/spdx", async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) return c.notFound();

  const spdx = await generateSpdx(repo.id, `${ownerName}/${repoName}`);
  return c.json(spdx, 200, {
    "Content-Disposition": `attachment; filename="${repoName}-sbom-spdx.json"`,
  });
});

// ---------- SBOM Export (CycloneDX) ----------

deps.get("/:owner/:repo/dependencies/sbom/cyclonedx", async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) return c.notFound();

  const bom = await generateCycloneDx(repo.id, `${ownerName}/${repoName}`);
  return c.json(bom, 200, {
    "Content-Disposition": `attachment; filename="${repoName}-sbom-cyclonedx.json"`,
  });
});

// ---------- SBOM API (JSON) ----------

deps.get("/api/repos/:owner/:repo/sbom", softAuth, async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const format = c.req.query("format") || "cyclonedx";
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.json({ error: "Not found" }, 404);
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.json({ error: "Not found" }, 404);
  }

  if (format === "spdx") {
    return c.json(await generateSpdx(repo.id, `${ownerName}/${repoName}`));
  }
  return c.json(await generateCycloneDx(repo.id, `${ownerName}/${repoName}`));
});

export default deps;

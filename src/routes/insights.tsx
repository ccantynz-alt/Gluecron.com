/**
 * Insight routes — time-travel, dependency analysis, rollback.
 *
 * These are the pages that don't exist on GitHub.
 * This is why developers will switch.
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
      <h2 style="margin-bottom: 4px">
        Time Travel: {filePath}
      </h2>
      <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px">
        {timeline.totalRevisions} revision{timeline.totalRevisions !== 1 ? "s" : ""} | First seen{" "}
        {new Date(timeline.firstSeen.date).toLocaleDateString()} by {timeline.firstSeen.author}
      </p>

      <div class="timeline">
        {timeline.revisions.map((rev, i) => (
          <div class="timeline-item">
            <div class="timeline-dot" />
            <div class="timeline-content">
              <div style="display: flex; justify-content: space-between; align-items: start">
                <div>
                  <a
                    href={`/${owner}/${repo}/commit/${rev.sha}`}
                    style="font-weight: 600; font-size: 14px"
                  >
                    {rev.message}
                  </a>
                  <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
                    {rev.author} — {new Date(rev.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </div>
                </div>
                <div style="text-align: right; font-size: 12px; white-space: nowrap">
                  <span class="stat-add">+{rev.linesAdded}</span>{" "}
                  <span class="stat-del">-{rev.linesRemoved}</span>
                  <div style="color: var(--text-muted)">{rev.sizeAfter} bytes</div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Layout>
  );
});

// Coupled files analysis
insights.get("/:owner/:repo/coupling", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();
  const ref = (await getDefaultBranch(owner, repo)) || "main";

  const coupled = await detectCoupledFiles(owner, repo, ref);
  const story = await getRepoStory(owner, repo, ref);
  const milestones = story.filter((s) => s.significance !== "normal").slice(0, 20);

  return c.html(
    <Layout title={`Insights — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <h2 style="margin-bottom: 20px">Code Insights</h2>

      <h3 style="margin-bottom: 12px">Coupled Files</h3>
      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px">
        Files that change together frequently — potential architectural coupling
      </p>
      {coupled.length === 0 ? (
        <p style="color: var(--text-muted)">No strong coupling detected.</p>
      ) : (
        <div class="issue-list" style="margin-bottom: 32px">
          {coupled.map((pair) => (
            <div class="issue-item">
              <div style="font-size: 13px; font-family: var(--font-mono)">
                <a href={`/${owner}/${repo}/blob/${ref}/${pair.files[0]}`}>
                  {pair.files[0]}
                </a>
                <span style="color: var(--text-muted); margin: 0 8px">+</span>
                <a href={`/${owner}/${repo}/blob/${ref}/${pair.files[1]}`}>
                  {pair.files[1]}
                </a>
              </div>
              <div style="font-size: 12px; color: var(--text-muted); white-space: nowrap">
                {pair.cochanges} co-changes ({pair.percentage}%)
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style="margin-bottom: 12px">Project Milestones</h3>
      {milestones.length === 0 ? (
        <p style="color: var(--text-muted)">No milestones detected yet.</p>
      ) : (
        <div class="timeline">
          {milestones.map((m) => (
            <div class="timeline-item">
              <div
                class="timeline-dot"
                style={m.significance === "milestone" ? "background: var(--green); width: 12px; height: 12px" : ""}
              />
              <div class="timeline-content">
                <a href={`/${owner}/${repo}/commit/${m.sha}`} style="font-weight: 600; font-size: 14px">
                  {m.message}
                </a>
                <div style="font-size: 12px; color: var(--text-muted)">
                  {m.author} — {new Date(m.date).toLocaleDateString()} |{" "}
                  <span class="stat-add">+{m.stats.additions}</span>{" "}
                  <span class="stat-del">-{m.stats.deletions}</span> in {m.stats.files} files
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
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
      <h2 style="margin-bottom: 4px">Dependency Intelligence</h2>
      <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px">
        {graph.externalDependencies} dependencies | {graph.internalModules} source files
        {graph.circularDeps.length > 0 && (
          <span style="color: var(--red)">
            {" "}| {graph.circularDeps.length} circular dependency chain{graph.circularDeps.length !== 1 ? "s" : ""}
          </span>
        )}
      </p>

      {unused.length > 0 && (
        <div style="background: rgba(248, 81, 73, 0.1); border: 1px solid var(--red); border-radius: var(--radius); padding: 12px 16px; margin-bottom: 20px">
          <strong style="color: var(--red)">Unused dependencies:</strong>{" "}
          <span style="font-family: var(--font-mono); font-size: 13px">
            {unused.join(", ")}
          </span>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px">
            These are installed but never imported. Removing them reduces install time and attack surface.
          </div>
        </div>
      )}

      <div class="issue-list">
        {graph.dependencies.map((dep) => (
          <div class="issue-item" style="flex-direction: column; align-items: stretch">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div>
                <strong style="font-size: 14px">{dep.name}</strong>
                <span style="margin-left: 8px; font-size: 12px; color: var(--text-muted)">
                  {dep.version}
                </span>
                {dep.isDevDep && (
                  <span class="badge" style="margin-left: 8px; font-size: 10px">
                    dev
                  </span>
                )}
              </div>
              <span style="font-size: 13px; color: var(--text-muted)">
                {dep.totalImports === 0 ? (
                  <span style="color: var(--red)">unused</span>
                ) : (
                  `${dep.totalImports} import${dep.totalImports !== 1 ? "s" : ""}`
                )}
              </span>
            </div>
            {dep.usedIn.length > 0 && (
              <div style="margin-top: 8px; font-size: 12px">
                {dep.usedIn.slice(0, 3).map((usage) => (
                  <div style="color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px">
                    <a href={`/${owner}/${repo}/blob/${ref}/${usage.file}`}>
                      {usage.file}:{usage.line}
                    </a>
                    <span style="margin-left: 8px">
                      {"{"}
                      {usage.importedSymbols.join(", ")}
                      {"}"}
                    </span>
                  </div>
                ))}
                {dep.usedIn.length > 3 && (
                  <div style="color: var(--text-muted); margin-top: 2px">
                    +{dep.usedIn.length - 3} more
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
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

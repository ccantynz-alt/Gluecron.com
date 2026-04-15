/**
 * Block J27 — Branch staleness / age report.
 *
 *   GET /:owner/:repo/branches/age[?threshold=0|30|60|90|180][&sort=…]
 *
 * softAuth, read-only. Walks every branch in the repo, fetches the tip commit
 * via `getCommit`, computes ahead/behind vs the default branch via
 * `aheadBehind`, and renders a per-branch table + buckets + summary KPIs.
 * Fail-soft: git errors degrade to empty report → page still renders 200.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  listBranches,
  getDefaultBranch,
  getCommit,
  aheadBehind,
} from "../git/repository";
import {
  buildBranchReport,
  parseThreshold,
  parseSort,
  thresholdLabel,
  sortLabel,
  categoryLabel,
  VALID_THRESHOLDS,
  VALID_SORTS,
  type BranchInputRow,
  type BranchAgeCategory,
} from "../lib/branch-age";

const branchAgeRoutes = new Hono<AuthEnv>();

branchAgeRoutes.use("*", softAuth);

async function resolveRepo(ownerName: string, repoName: string) {
  try {
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
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function ageColor(c: BranchAgeCategory): string {
  switch (c) {
    case "fresh":
      return "var(--green, #3fb950)";
    case "aging":
      return "var(--yellow, #d29922)";
    case "stale":
      return "var(--orange, #db6d28)";
    case "abandoned":
      return "var(--red, #f85149)";
  }
}

function formatDaysOld(days: number | null): string {
  if (days === null) return "\u2014";
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo`;
  const years = (days / 365).toFixed(1);
  return `${years} yr`;
}

branchAgeRoutes.get("/:owner/:repo/branches/age", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const threshold = parseThreshold(c.req.query("threshold"));
  const sort = parseSort(c.req.query("sort"));

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  // Private-repo visibility: only the owner can see the metric.
  if (resolved.repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  let branches: string[] = [];
  let defaultBranch: string | null = null;
  try {
    [branches, defaultBranch] = await Promise.all([
      listBranches(ownerName, repoName),
      getDefaultBranch(ownerName, repoName),
    ]);
  } catch {
    branches = [];
  }

  const inputs: BranchInputRow[] = [];
  for (const b of branches) {
    try {
      const commit = await getCommit(ownerName, repoName, b);
      let ahead = 0;
      let behind = 0;
      const isDefault = b === defaultBranch;
      if (!isDefault && defaultBranch) {
        const ab = await aheadBehind(ownerName, repoName, defaultBranch, b);
        if (ab) {
          ahead = ab.ahead;
          behind = ab.behind;
        }
      }
      inputs.push({
        name: b,
        tipSha: commit?.sha ?? "",
        tipDate: commit?.date ?? null,
        tipAuthor: commit?.author ?? null,
        tipMessage: commit?.message ?? null,
        ahead,
        behind,
        isDefault,
      });
    } catch {
      inputs.push({
        name: b,
        tipSha: "",
        tipDate: null,
        tipAuthor: null,
        tipMessage: null,
        ahead: 0,
        behind: 0,
        isDefault: b === defaultBranch,
      });
    }
  }

  const report = buildBranchReport({
    branches: inputs,
    defaultBranch,
    threshold,
    sort,
  });

  const kpi = (label: string, value: string) => (
    <div style="border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; background: var(--bg-secondary)">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 6px">
        {label}
      </div>
      <div style="font-size: 20px; font-weight: 600; font-family: var(--font-mono)">
        {value}
      </div>
    </div>
  );

  return c.html(
    <Layout title={`Branch age — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div style="max-width: 1000px">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
          <h2 style="margin: 0">Branch staleness</h2>
          <form
            method="GET"
            action={`/${ownerName}/${repoName}/branches/age`}
            style="display: flex; gap: 8px; align-items: center"
          >
            <label for="threshold" style="font-size: 12px; color: var(--text-muted)">
              Threshold:
            </label>
            <select
              id="threshold"
              name="threshold"
              onchange="this.form.submit()"
              style="padding: 4px 8px; font-size: 12px"
            >
              {VALID_THRESHOLDS.map((t) => (
                <option value={String(t)} selected={t === threshold}>
                  {thresholdLabel(t)}
                </option>
              ))}
            </select>
            <label for="sort" style="font-size: 12px; color: var(--text-muted)">
              Sort:
            </label>
            <select
              id="sort"
              name="sort"
              onchange="this.form.submit()"
              style="padding: 4px 8px; font-size: 12px"
            >
              {VALID_SORTS.map((s) => (
                <option value={s} selected={s === sort}>
                  {sortLabel(s)}
                </option>
              ))}
            </select>
          </form>
        </div>

        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px">
          Branch age = days since the tip commit. "Merged" means no commits ahead
          of <code>{report.defaultBranch ?? "the default branch"}</code>. Default
          branch is excluded from bucket counts.
        </p>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px">
          {kpi("Total branches", String(report.summary.total))}
          {kpi("Non-default", String(report.summary.nonDefault))}
          {kpi("Merged", String(report.summary.merged))}
          {kpi("Unmerged", String(report.summary.unmerged))}
          {kpi(
            "Median age",
            report.summary.medianAgeDays === null
              ? "\u2014"
              : formatDaysOld(report.summary.medianAgeDays)
          )}
          {kpi(
            "Oldest",
            report.summary.oldestDaysOld === null
              ? "\u2014"
              : formatDaysOld(report.summary.oldestDaysOld)
          )}
        </div>

        <h3 style="margin-bottom: 10px">Distribution</h3>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px">
          {(["fresh", "aging", "stale", "abandoned"] as BranchAgeCategory[]).map(
            (cat) => (
              <div
                style={`border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; text-align: center; border-left: 4px solid ${ageColor(cat)}`}
              >
                <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px">
                  {categoryLabel(cat)}
                </div>
                <div style="font-size: 18px; font-weight: 600">
                  {report.buckets[cat]}
                </div>
              </div>
            )
          )}
        </div>

        <h3 style="margin-bottom: 10px">
          Branches ({report.filtered.length}
          {report.filtered.length !== report.rows.length
            ? ` of ${report.rows.length}`
            : ""}
          )
        </h3>
        {report.filtered.length === 0 ? (
          <div class="empty-state">
            <p>No branches match this threshold.</p>
          </div>
        ) : (
          <table style="width: 100%; border-collapse: collapse">
            <thead>
              <tr>
                <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted)">
                  Branch
                </th>
                <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 100px">
                  Ahead
                </th>
                <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 100px">
                  Behind
                </th>
                <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 160px">
                  Last commit
                </th>
                <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 100px">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {report.filtered.map((r) => (
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border)">
                    <a
                      href={`/${ownerName}/${repoName}/tree/${encodeURIComponent(r.name)}`}
                      style={`font-family: var(--font-mono); font-weight: ${r.isDefault ? 600 : 400}`}
                    >
                      {r.name}
                    </a>
                    {r.isDefault && (
                      <span style="margin-left: 8px; font-size: 10px; padding: 2px 6px; background: var(--accent); color: white; border-radius: 10px">
                        default
                      </span>
                    )}
                    {r.tipAuthor && (
                      <span style="margin-left: 8px; font-size: 11px; color: var(--text-muted)">
                        by {r.tipAuthor}
                      </span>
                    )}
                  </td>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                    {r.ahead}
                  </td>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                    {r.behind}
                  </td>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px">
                    <span style={`color: ${ageColor(r.category)}`}>
                      {formatDaysOld(r.daysOld)}
                    </span>
                  </td>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-size: 11px">
                    {r.isDefault ? (
                      <span style="color: var(--text-muted)">default</span>
                    ) : r.merged ? (
                      <span style="color: var(--green, #3fb950)">merged</span>
                    ) : (
                      <span style="color: var(--text-muted)">open</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
});

export default branchAgeRoutes;

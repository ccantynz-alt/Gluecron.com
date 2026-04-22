/**
 * Block J32 — PR size distribution metric.
 *
 *   GET /:owner/:repo/insights/pr-size[?window=7|30|90|365|0&top=N]
 *
 * Renders five KPI cards (total / median / mean / p90 / small-PR ratio),
 * a five-class histogram (XS / S / M / L / XL), and the largest N PRs
 * in the window. Git numstat is computed per-PR against base..head via
 * `diffNumstat`, capped to 500 PRs per request so one repo can't pin a
 * whole server.
 *
 * softAuth; private repos 404 for non-owner viewers. Git failures on a
 * single PR yield zero lines changed for that PR (it still renders in
 * the XS bucket) rather than taking the whole page out.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { pullRequests, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { diffNumstat } from "../git/repository";
import {
  DEFAULT_TOP_N,
  VALID_WINDOWS,
  buildPrSizeReport,
  parseWindow,
  type PrSizeInput,
} from "../lib/pr-size";
import { formatPercent } from "../lib/language-stats";

const MAX_PRS = 500;
const MAX_TOP_N = 50;

const prSizeRoutes = new Hono<AuthEnv>();

prSizeRoutes.use("*", softAuth);

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

function parseTopN(raw: string | undefined): number {
  if (!raw) return DEFAULT_TOP_N;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N;
  return Math.min(Math.floor(n), MAX_TOP_N);
}

const SIZE_CLASS_COLORS: Record<string, string> = {
  xs: "#4caf50",
  s: "#8bc34a",
  m: "#ffc107",
  l: "#ff9800",
  xl: "#f44336",
};

prSizeRoutes.get("/:owner/:repo/insights/pr-size", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const windowDays = parseWindow(c.req.query("window"));
  const topN = parseTopN(c.req.query("top"));

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

  let prRows: {
    id: string;
    number: number;
    title: string;
    state: string;
    isDraft: boolean;
    baseBranch: string;
    headBranch: string;
    createdAt: Date;
    mergedAt: Date | null;
    closedAt: Date | null;
  }[] = [];
  try {
    prRows = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        state: pullRequests.state,
        isDraft: pullRequests.isDraft,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
        createdAt: pullRequests.createdAt,
        mergedAt: pullRequests.mergedAt,
        closedAt: pullRequests.closedAt,
      })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, resolved.repo.id))
      .orderBy(desc(pullRequests.createdAt))
      .limit(MAX_PRS);
  } catch {
    // empty → empty report
  }

  // Diff each PR's base..head in parallel but bounded.
  const diffs = await Promise.all(
    prRows.map(async (pr) => {
      try {
        const r = await diffNumstat(
          ownerName,
          repoName,
          pr.baseBranch,
          pr.headBranch
        );
        return r ?? { additions: 0, deletions: 0, files: 0 };
      } catch {
        return { additions: 0, deletions: 0, files: 0 };
      }
    })
  );

  const inputs: PrSizeInput[] = prRows.map((r, i) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    state: r.state,
    isDraft: r.isDraft,
    createdAt: r.createdAt,
    mergedAt: r.mergedAt,
    closedAt: r.closedAt,
    additions: diffs[i]!.additions,
    deletions: diffs[i]!.deletions,
    files: diffs[i]!.files,
  }));

  const report = buildPrSizeReport({
    prs: inputs,
    windowDays,
    topN,
  });

  const windowLabel = windowDays === 0 ? "All time" : `Last ${windowDays} days`;
  const empty = report.summary.total === 0;

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
    <Layout title={`PR size — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div style="max-width: 920px">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
          <h2 style="margin: 0">PR size distribution</h2>
          <form
            method="GET"
            action={`/${ownerName}/${repoName}/insights/pr-size`}
            style="display: flex; gap: 6px; align-items: center"
          >
            <label for="window" style="font-size: 12px; color: var(--text-muted)">
              Window:
            </label>
            <select
              id="window"
              name="window"
              onchange="this.form.submit()"
              style="padding: 4px 8px; font-size: 12px"
            >
              {VALID_WINDOWS.map((w) => (
                <option value={String(w)} selected={w === windowDays}>
                  {w === 0 ? "All time" : `Last ${w} days`}
                </option>
              ))}
            </select>
          </form>
        </div>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px">
          <strong>{windowLabel}</strong>. Size = additions + deletions
          (binaries counted as 0). Merged PRs are anchored on their merge
          date, unmerged PRs on creation date. Classes: XS ≤10, S ≤50, M
          ≤250, L ≤1000, XL &gt;1000.
        </p>

        {empty ? (
          <div class="empty-state">
            <h3>No PRs in window</h3>
            <p>Try widening the time range.</p>
          </div>
        ) : (
          <>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px">
              {kpi("Total", String(report.summary.total))}
              {kpi("Merged", String(report.summary.merged))}
              {kpi("Open", String(report.summary.open))}
              {kpi("Median", `${report.summary.medianLines} lines`)}
              {kpi("Mean", `${report.summary.meanLines} lines`)}
              {kpi("p90", `${report.summary.p90Lines} lines`)}
              {kpi("Largest", `${report.summary.largestLines} lines`)}
              {kpi("Small-PR ratio", formatPercent(report.summary.smallPrRatio))}
            </div>

            <h3 style="margin-bottom: 10px">Size distribution</h3>
            <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 24px">
              {report.buckets.map((b) => (
                <div
                  style={`border: 1px solid var(--border); border-left: 4px solid ${SIZE_CLASS_COLORS[b.key]}; border-radius: var(--radius); padding: 12px; text-align: center`}
                >
                  <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px">
                    {b.label}
                  </div>
                  <div style="font-size: 22px; font-weight: 600">
                    {b.count}
                  </div>
                  <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px">
                    {b.description}
                  </div>
                </div>
              ))}
            </div>

            <h3 style="margin-bottom: 10px">
              Largest PRs ({report.largest.length})
            </h3>
            {report.largest.length === 0 ? (
              <div class="empty-state">
                <p>No PRs matched the filter.</p>
              </div>
            ) : (
              <table style="width: 100%; border-collapse: collapse">
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted)">
                      PR
                    </th>
                    <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 90px">
                      Files
                    </th>
                    <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 90px">
                      +/-
                    </th>
                    <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 90px">
                      Size
                    </th>
                    <th style="text-align: center; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 60px">
                      Class
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.largest.map((p) => (
                    <tr>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border)">
                        <a href={`/${ownerName}/${repoName}/pulls/${p.number}`}>
                          <span style="color: var(--text-muted)">
                            #{p.number}
                          </span>{" "}
                          {p.title}
                        </a>
                      </td>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                        {p.files}
                      </td>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                        <span style="color: var(--green)">+{p.additions}</span>{" "}
                        <span style="color: var(--red)">-{p.deletions}</span>
                      </td>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                        {p.linesChanged}
                      </td>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: center">
                        <span
                          style={`display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: #fff; background: ${SIZE_CLASS_COLORS[p.sizeClass]}`}
                        >
                          {p.sizeClass.toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </Layout>
  );
});

export default prSizeRoutes;

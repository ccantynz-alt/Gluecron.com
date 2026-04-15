/**
 * Block J31 — Repository size audit.
 *
 *   GET /:owner/:repo/insights/size[?top=N&min=B&ref=<branch>]
 *
 * Renders "where are the bytes?" for the given ref (default branch by
 * default): summary stats, a size-class histogram, a top-level directory
 * breakdown, and the largest N files.
 *
 * softAuth, read-only. Reuses `listTreeRecursive` from J30. Git failures
 * degrade to an empty report — never 500.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getDefaultBranch, listTreeRecursive } from "../git/repository";
import {
  buildSizeReport,
  DEFAULT_TOP_N,
  type RepoSizeEntry,
} from "../lib/repo-size";
import { formatBytes, formatPercent } from "../lib/language-stats";

const MAX_TOP_N = 200;
const ABS_MAX_MIN_BYTES = 1024 * 1024 * 1024; // 1 GiB cap on user-supplied floor

const repoSizeRoutes = new Hono<AuthEnv>();

repoSizeRoutes.use("*", softAuth);

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

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  max: number
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function sanitiseRef(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (/\.\./.test(trimmed)) return null;
  if (/[\s~^:?*[\\]/.test(trimmed)) return null;
  return trimmed;
}

repoSizeRoutes.get("/:owner/:repo/insights/size", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");

  const topN = parsePositiveInt(c.req.query("top"), DEFAULT_TOP_N, MAX_TOP_N);
  const minBytes = parsePositiveInt(c.req.query("min"), 0, ABS_MAX_MIN_BYTES);
  const refParam = sanitiseRef(c.req.query("ref"));

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

  let ref: string | null = refParam;
  if (!ref) {
    try {
      ref = await getDefaultBranch(ownerName, repoName);
    } catch {
      ref = null;
    }
  }

  let entries: RepoSizeEntry[] = [];
  if (ref) {
    try {
      entries = await listTreeRecursive(ownerName, repoName, ref);
    } catch {
      entries = [];
    }
  }

  const report = buildSizeReport({
    entries,
    topN,
    minBytesForLargest: minBytes > 0 ? minBytes : undefined,
  });

  const empty = report.summary.countedFiles === 0;

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
    <Layout title={`Size audit — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div style="max-width: 920px">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
          <h2 style="margin: 0">Size audit</h2>
          <form
            method="GET"
            action={`/${ownerName}/${repoName}/insights/size`}
            style="display: flex; gap: 10px; align-items: center; font-size: 12px"
          >
            <label style="display: flex; align-items: center; gap: 4px">
              Top
              <select
                name="top"
                onchange="this.form.submit()"
                style="padding: 2px 6px; font-size: 12px"
              >
                {[10, 25, 50, 100].map((n) => (
                  <option value={String(n)} selected={n === topN}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {refParam ? (
              <input type="hidden" name="ref" value={refParam} />
            ) : null}
          </form>
        </div>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px">
          {ref ? (
            <>
              Analyzed <code>{ref}</code>. Includes everything in the working
              tree, vendored files and all — this is a raw disk-footprint view.
            </>
          ) : (
            <>No default branch detected — repository may be empty.</>
          )}
        </p>

        {empty ? (
          <div class="empty-state">
            <h3>No files to audit</h3>
            <p>The repository appears to be empty.</p>
          </div>
        ) : (
          <>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px">
              {kpi("Files", report.summary.countedFiles.toLocaleString())}
              {kpi("Total size", formatBytes(report.summary.totalBytes))}
              {kpi("Largest", formatBytes(report.summary.largestBytes))}
              {kpi("Median", formatBytes(report.summary.medianBytes))}
              {kpi("Mean", formatBytes(report.summary.averageBytes))}
            </div>

            <h3 style="margin-bottom: 10px">Size-class distribution</h3>
            <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 24px">
              {report.buckets.map((b) => (
                <div style="border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; text-align: center">
                  <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px">
                    {b.label}
                  </div>
                  <div style="font-size: 18px; font-weight: 600">
                    {b.fileCount}
                  </div>
                  <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; font-family: var(--font-mono)">
                    {formatBytes(b.bytes)}
                  </div>
                </div>
              ))}
            </div>

            <h3 style="margin-bottom: 10px">Top-level directories</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted)">
                    Path
                  </th>
                  <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 120px">
                    Files
                  </th>
                  <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 120px">
                    Size
                  </th>
                  <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 100px">
                    Share
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.directories.map((d) => (
                  <tr>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); font-family: var(--font-mono); font-size: 13px">
                      {d.name === "." ? "(root)" : `${d.name}/`}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                      {d.fileCount.toLocaleString()}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                      {formatBytes(d.bytes)}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                      {formatPercent(d.percent)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 style="margin-bottom: 10px">
              Largest files ({report.largest.length})
            </h3>
            {report.largest.length === 0 ? (
              <div class="empty-state">
                <p>No files match the filter.</p>
              </div>
            ) : (
              <table style="width: 100%; border-collapse: collapse">
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted)">
                      Path
                    </th>
                    <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 120px">
                      Size
                    </th>
                    <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 100px">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.largest.map((f) => (
                    <tr>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border); font-family: var(--font-mono); font-size: 12px; word-break: break-all">
                        {ref ? (
                          <a
                            href={`/${ownerName}/${repoName}/blob/${encodeURIComponent(
                              ref
                            )}/${f.path
                              .split("/")
                              .map((s) => encodeURIComponent(s))
                              .join("/")}`}
                          >
                            {f.path}
                          </a>
                        ) : (
                          f.path
                        )}
                      </td>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                        {formatBytes(f.size)}
                      </td>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                        {formatPercent(f.percent)}
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

export default repoSizeRoutes;

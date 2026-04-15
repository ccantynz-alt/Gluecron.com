/**
 * Block J30 — Repository language breakdown.
 *
 *   GET /:owner/:repo/languages[?vendored=1&fold=N&ref=<branch>]
 *
 * Renders a GitHub-parity language breakdown: a stacked percentage bar +
 * a per-language table (bytes, files, share). Uses `listTreeRecursive`
 * against the repo's default branch (or an explicit `ref`) to get file
 * sizes, then runs the pure `buildLanguageReport` helper.
 *
 * Defaults: vendored/generated files (node_modules, dist, lockfiles, etc.)
 * are excluded. Pass `?vendored=1` to include them.
 *
 * softAuth + try/catch-wrapped resolveRepo — never 500s.
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
  buildLanguageReport,
  formatBytes,
  formatPercent,
  type LanguageFileEntry,
  type LanguageReport,
} from "../lib/language-stats";

const languageRoutes = new Hono<AuthEnv>();

languageRoutes.use("*", softAuth);

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

function parseFold(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return 0;
  return n;
}

/** Minimal ref sanity check — branches/tags shouldn't contain whitespace or `..`. */
function sanitiseRef(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (/\.\./.test(trimmed)) return null;
  if (/[\s~^:?*[\\]/.test(trimmed)) return null;
  return trimmed;
}

languageRoutes.get("/:owner/:repo/languages", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");

  const includeVendored = c.req.query("vendored") === "1";
  const foldUnderPercent = parseFold(c.req.query("fold"));
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

  let entries: LanguageFileEntry[] = [];
  if (ref) {
    try {
      entries = await listTreeRecursive(ownerName, repoName, ref);
    } catch {
      entries = [];
    }
  }

  const report: LanguageReport = buildLanguageReport({
    entries,
    ignoreVendored: !includeVendored,
    foldUnderPercent,
  });

  const empty = report.buckets.length === 0;

  return c.html(
    <Layout title={`Languages — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div style="max-width: 920px">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
          <h2 style="margin: 0">Languages</h2>
          <form
            method="GET"
            action={`/${ownerName}/${repoName}/languages`}
            style="display: flex; gap: 10px; align-items: center; font-size: 12px"
          >
            <label style="display: flex; align-items: center; gap: 4px">
              <input
                type="checkbox"
                name="vendored"
                value="1"
                checked={includeVendored}
                onchange="this.form.submit()"
              />
              Include vendored
            </label>
            <label style="display: flex; align-items: center; gap: 4px">
              Fold &lt;
              <select
                name="fold"
                onchange="this.form.submit()"
                style="padding: 2px 6px; font-size: 12px"
              >
                {[0, 0.5, 1, 2, 5].map((n) => (
                  <option
                    value={String(n)}
                    selected={Math.abs(n - foldUnderPercent) < 0.001}
                  >
                    {n === 0 ? "Off" : `${n}%`}
                  </option>
                ))}
              </select>
            </label>
            {refParam ? (
              <input type="hidden" name="ref" value={refParam} />
            ) : null}
          </form>
        </div>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px">
          {ref ? (
            <>
              Analyzed <code>{ref}</code> —{" "}
              <strong>{report.countedFiles.toLocaleString()}</strong> of{" "}
              {report.totalFiles.toLocaleString()} files (
              {formatBytes(report.totalBytes)} total).{" "}
              {includeVendored
                ? "Including vendored + lock files."
                : "Vendored directories and lock files excluded."}
            </>
          ) : (
            <>No default branch detected — repository may be empty.</>
          )}
        </p>

        {empty ? (
          <div class="empty-state">
            <h3>No classifiable files</h3>
            <p>
              {ref
                ? "Either the repo is empty, only contains vendored files, or the file types aren't recognised."
                : "Push some code to see the language breakdown."}
            </p>
          </div>
        ) : (
          <>
            <div
              style="display: flex; width: 100%; height: 12px; border-radius: 6px; overflow: hidden; margin-bottom: 6px; background: var(--bg-secondary)"
              aria-label="Language breakdown"
              role="img"
            >
              {report.buckets.map((b) => (
                <div
                  title={`${b.language} — ${formatPercent(b.percent)}`}
                  style={`width: ${b.percent.toFixed(4)}%; background: ${b.color}; height: 100%`}
                />
              ))}
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 10px 16px; margin-bottom: 20px; font-size: 12px">
              {report.buckets.map((b) => (
                <span style="display: inline-flex; align-items: center; gap: 6px">
                  <span
                    style={`display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${b.color}`}
                  />
                  <strong>{b.language}</strong>
                  <span style="color: var(--text-muted)">
                    {formatPercent(b.percent)}
                  </span>
                </span>
              ))}
            </div>

            <table style="width: 100%; border-collapse: collapse">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted)">
                    Language
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
                {report.buckets.map((b) => (
                  <tr>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border)">
                      <span
                        style={`display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${b.color}; margin-right: 8px; vertical-align: middle`}
                      />
                      {b.language}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                      {b.fileCount.toLocaleString()}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                      {formatBytes(b.bytes)}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                      {formatPercent(b.percent)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Layout>
  );
});

export default languageRoutes;

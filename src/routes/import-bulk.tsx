/**
 * Bulk GitHub import — "paste my org + token → import everything".
 *
 * Owner flow for migrating many products at once. Reuses the single-repo
 * import logic from `src/lib/import-helper.ts` so the clone + DB insert
 * code path is identical to `/import`.
 *
 * Token never leaves this process: it's read from the form body, passed
 * to GitHub's API via `Authorization` header, and embedded in the git
 * clone URL only at the moment of spawning `git`. Results never contain
 * the token — `scrubSecrets()` in the helper redacts it before display.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  sanitizeRepoName,
  importOneRepo,
  type ImportOneRepoResult,
} from "../lib/import-helper";

const importBulkRoutes = new Hono<AuthEnv>();

importBulkRoutes.use("*", softAuth);

// Hard limits to keep a single request bounded.
const MAX_REPOS = 200;
const MAX_REPO_SIZE_KB = 500 * 1024; // 500 MB in KB (GitHub reports size in KB)
const GITHUB_PER_PAGE = 100;

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  clone_url: string;
  default_branch: string;
  fork: boolean;
  size: number; // KB
}

type Visibility = "public" | "private" | "both";

/**
 * Paginate the GitHub "list org repos" endpoint. Caps at MAX_REPOS so a
 * single request can't fan out indefinitely. Throws on non-2xx so the
 * caller can surface a friendly error.
 */
async function fetchOrgRepos(
  org: string,
  token: string
): Promise<GitHubRepo[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "gluecron/1.0",
    Authorization: `Bearer ${token}`,
  };

  const repos: GitHubRepo[] = [];
  let page = 1;
  while (repos.length < MAX_REPOS) {
    const url = `https://api.github.com/orgs/${encodeURIComponent(
      org
    )}/repos?per_page=${GITHUB_PER_PAGE}&page=${page}&type=all`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      // Never echo the token. Include only the status + first slice of body.
      const errBody = (await res.text()).slice(0, 200);
      throw new Error(`GitHub API error (${res.status}): ${errBody}`);
    }
    const batch = (await res.json()) as GitHubRepo[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < GITHUB_PER_PAGE) break;
    page++;
    if (page > 10) break; // hard page ceiling: 1000 entries, we cap earlier anyway
  }
  return repos.slice(0, MAX_REPOS);
}

function matchesVisibility(repo: GitHubRepo, v: Visibility): boolean {
  if (v === "both") return true;
  if (v === "public") return repo.private === false;
  if (v === "private") return repo.private === true;
  return true;
}

// ─── FORM PAGE ───────────────────────────────────────────────

importBulkRoutes.get("/import/bulk", requireAuth, async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");

  return c.html(
    <Layout title="Bulk import from GitHub" user={user}>
      <div style="max-width: 720px">
        <h2 style="margin-bottom: 4px">Bulk import from GitHub</h2>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px">
          Paste a GitHub org + personal access token. Gluecron will clone
          every repo into your namespace as a mirror.
        </p>

        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}

        <div style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 20px; font-size: 13px; color: var(--text-muted)">
          <strong style="color: var(--text)">What this does</strong>
          <ul style="margin: 8px 0 0 18px; line-height: 1.6">
            <li>
              Lists every repo in the org via the GitHub API
              (<code>/orgs/{"{org}"}/repos</code>, paginated).
            </li>
            <li>
              Clones each one as a bare mirror into your gluecron account
              (<code>{user.username}/{"{repo}"}</code>).
            </li>
            <li>
              Reports per-repo success / failure / skipped-if-exists at
              the end. One failure does not abort the batch.
            </li>
            <li>
              Hard caps: {MAX_REPOS} repos per run, 500MB per repo.
            </li>
          </ul>
        </div>

        <form method="POST" action="/import/bulk">
          <div class="form-group">
            <label style="display:block; margin-bottom:4px; font-size:13px">
              GitHub org
            </label>
            <input
              type="text"
              name="githubOrg"
              required
              placeholder="my-company"
              style="padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px; width: 100%"
            />
          </div>

          <div class="form-group">
            <label style="display:block; margin-bottom:4px; font-size:13px">
              GitHub personal access token (<code>repo:read</code> scope)
            </label>
            <input
              type="password"
              name="githubToken"
              required
              placeholder="ghp_xxxxxxxxxxxx"
              autocomplete="off"
              style="padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px; font-family: var(--font-mono); width: 100%"
            />
          </div>

          <div class="form-group">
            <label style="display:block; margin-bottom:4px; font-size:13px">
              Visibility filter
            </label>
            <select
              name="visibility"
              style="padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px; width: 100%"
            >
              <option value="both" selected>Both (public + private)</option>
              <option value="public">Public only</option>
              <option value="private">Private only</option>
            </select>
          </div>

          <div class="form-group" style="margin: 12px 0">
            <label style="display:flex; align-items:center; gap:8px; font-size:13px">
              <input type="checkbox" name="dryRun" value="1" checked />
              Dry run — preview the list without cloning
            </label>
          </div>

          <button type="submit" class="btn btn-primary">
            Run bulk import
          </button>
          <a href="/import" class="btn" style="margin-left: 8px">
            Back to /import
          </a>
        </form>
      </div>
    </Layout>
  );
});

// ─── POST HANDLER ────────────────────────────────────────────

importBulkRoutes.post("/import/bulk", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  const githubOrg = String(body.githubOrg || "").trim();
  const githubToken = String(body.githubToken || "").trim();
  const visibilityRaw = String(body.visibility || "both").trim();
  const visibility: Visibility =
    visibilityRaw === "public" || visibilityRaw === "private"
      ? (visibilityRaw as Visibility)
      : "both";
  const dryRun = Boolean(body.dryRun); // unchecked box = undefined = false

  if (!githubOrg) {
    return c.redirect("/import/bulk?error=GitHub+org+is+required");
  }
  if (!githubToken) {
    return c.redirect(
      "/import/bulk?error=GitHub+token+is+required+%28repo%3Aread+scope%29"
    );
  }

  // Validate the token has at least read access before we start cloning.
  // `GET /user` is the cheapest call that requires a valid token. We also
  // inspect the `X-OAuth-Scopes` header so we can warn early if the token
  // is missing `repo`/`repo:read`.
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "gluecron/1.0",
        Authorization: `Bearer ${githubToken}`,
      },
    });
    if (!userRes.ok) {
      return c.redirect(
        `/import/bulk?error=${encodeURIComponent(
          `Invalid GitHub token (${userRes.status}). Check scope repo:read.`
        )}`
      );
    }
    const scopes = (userRes.headers.get("x-oauth-scopes") || "").toLowerCase();
    if (
      scopes &&
      !scopes.includes("repo") &&
      !scopes.includes("public_repo")
    ) {
      return c.redirect(
        `/import/bulk?error=${encodeURIComponent(
          "Token is missing repo:read scope. Regenerate with repo (or public_repo) checked."
        )}`
      );
    }
  } catch (err) {
    // Network-level failure talking to GitHub. Don't leak err details.
    return c.redirect(
      "/import/bulk?error=Could+not+reach+GitHub+to+validate+the+token"
    );
  }

  // Pull the repo list.
  let allRepos: GitHubRepo[];
  try {
    allRepos = await fetchOrgRepos(githubOrg, githubToken);
  } catch (err) {
    const msg = (err as Error).message || "Unknown error";
    return c.redirect(
      `/import/bulk?error=${encodeURIComponent(msg).slice(0, 400)}`
    );
  }

  if (allRepos.length === 0) {
    return c.redirect(
      `/import/bulk?error=${encodeURIComponent(
        `No repos visible for org "${githubOrg}" with this token.`
      )}`
    );
  }

  // Apply visibility filter + size cap; track why things were skipped.
  const candidates: GitHubRepo[] = [];
  const oversized: { name: string; sizeKB: number }[] = [];
  for (const r of allRepos) {
    if (!matchesVisibility(r, visibility)) continue;
    if (typeof r.size === "number" && r.size > MAX_REPO_SIZE_KB) {
      oversized.push({ name: r.name, sizeKB: r.size });
      continue;
    }
    candidates.push(r);
  }

  // Dry run: render a preview + counts, never touch disk or DB.
  if (dryRun) {
    return c.html(
      <Layout title="Bulk import preview" user={user}>
        <div style="max-width: 820px">
          <h2 style="margin-bottom: 4px">Bulk import — dry-run preview</h2>
          <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px">
            Org <code>{githubOrg}</code> · visibility <code>{visibility}</code>
            {" · "}
            {candidates.length} repo(s) would be imported
            {oversized.length > 0 ? `, ${oversized.length} skipped (>500MB)` : ""}
            .
          </p>

          <ResultsTable
            rows={candidates.map((r) => ({
              name: sanitizeRepoName(r.name),
              status: "dry-run",
              notes: `${r.private ? "private" : "public"} · ${(
                r.size / 1024
              ).toFixed(1)} MB`,
            }))}
          />

          {oversized.length > 0 && (
            <>
              <h3 style="margin-top:24px">Skipped — over 500MB</h3>
              <ResultsTable
                rows={oversized.map((r) => ({
                  name: sanitizeRepoName(r.name),
                  status: "too-large",
                  notes: `${(r.sizeKB / 1024).toFixed(1)} MB`,
                }))}
              />
            </>
          )}

          <div style="margin-top:20px; padding:12px 14px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius); font-size:13px">
            Looks good? Go back and uncheck <em>Dry run</em> to actually
            import.
          </div>

          <div style="margin-top:16px">
            <a href="/import/bulk" class="btn btn-primary">
              Back to form
            </a>
          </div>
        </div>
      </Layout>
    );
  }

  // Real run: clone each candidate sequentially. Collect results.
  const results: ImportOneRepoResult[] = [];
  for (const r of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const res = await importOneRepo({
      cloneUrl: r.clone_url,
      targetName: r.name,
      ownerId: user.id,
      ownerUsername: user.username,
      token: githubToken,
      description: r.description,
      isPrivate: r.private,
      defaultBranch: r.default_branch,
    });
    results.push(res);
  }

  for (const o of oversized) {
    results.push({
      status: "failed",
      name: sanitizeRepoName(o.name),
      notes: `Skipped — over 500MB (${(o.sizeKB / 1024).toFixed(1)} MB)`,
    });
  }

  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return c.html(
    <Layout title="Bulk import results" user={user}>
      <div style="max-width: 820px">
        <h2 style="margin-bottom: 4px">Bulk import — results</h2>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px">
          Org <code>{githubOrg}</code>: {counts["success"] || 0} imported,
          {" "}
          {counts["skipped-exists"] || 0} skipped (exists),
          {" "}
          {counts["failed"] || 0} failed.
        </p>

        <ResultsTable rows={results} />

        <div style="margin-top:20px; display:flex; gap:8px">
          <a href={`/${user.username}`} class="btn btn-primary">
            View my repositories
          </a>
          <a href="/import/bulk" class="btn">
            Run another import
          </a>
        </div>
      </div>
    </Layout>
  );
});

// ─── COMPONENTS ──────────────────────────────────────────────

function ResultsTable({
  rows,
}: {
  rows: { name: string; status: string; notes: string }[];
}) {
  if (rows.length === 0) {
    return (
      <div style="padding:14px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius); font-size:13px; color:var(--text-muted)">
        No rows.
      </div>
    );
  }
  return (
    <table
      style="width:100%; border-collapse:collapse; font-size:13px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden"
    >
      <thead>
        <tr style="background:var(--bg); text-align:left">
          <th style="padding:8px 12px; border-bottom:1px solid var(--border)">
            Name
          </th>
          <th style="padding:8px 12px; border-bottom:1px solid var(--border)">
            Status
          </th>
          <th style="padding:8px 12px; border-bottom:1px solid var(--border)">
            Notes
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td style="padding:6px 12px; border-bottom:1px solid var(--border); font-family:var(--font-mono)">
              {r.name}
            </td>
            <td style="padding:6px 12px; border-bottom:1px solid var(--border)">
              <StatusBadge status={r.status} />
            </td>
            <td style="padding:6px 12px; border-bottom:1px solid var(--border); color:var(--text-muted)">
              {r.notes}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "success"
      ? "#3fb950"
      : status === "skipped-exists"
        ? "#f0b429"
        : status === "dry-run"
          ? "#58a6ff"
          : status === "too-large"
            ? "#f0b429"
            : "#f85149";
  return (
    <span
      style={`display:inline-block; padding:2px 8px; border-radius:10px; background:${color}22; color:${color}; font-size:12px; font-weight:600`}
    >
      {status}
    </span>
  );
}

export default importBulkRoutes;

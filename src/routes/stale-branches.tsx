/**
 * Stale Branch Cleanup UI — /:owner/:repo/branches/stale
 *
 * Lists merged branches that are safe to delete and lets the repo owner
 * bulk-delete them via a form POST.
 *
 * Filtering: protected/special branches (main, master, develop, staging,
 * production, HEAD, and the default branch itself) are never shown.
 *
 * For each stale branch we query pull_requests to find the most-recently
 * merged PR for that head branch — we display the PR number as a link
 * and the mergedAt date.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, pullRequests } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getDefaultBranch } from "../git/repository";
import { getUnreadCount } from "../lib/unread";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** These branches are never shown as stale candidates. */
const PROTECTED_NAMES = new Set([
  "main",
  "master",
  "develop",
  "staging",
  "production",
  "HEAD",
]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const staleBranchRoutes = new Hono<AuthEnv>();

// Path-scoped middleware (must NOT use `use("*", ...)` — see CLAUDE.md rule).
// softAuth for the GET (public repos visible to all), requireAuth for the POST.
staleBranchRoutes.use("/:owner/:repo/branches/stale*", softAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve owner user + repo record from URL params. */
async function resolveRepo(ownerName: string, repoName: string) {
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
}

/**
 * Run `git --git-dir <diskPath> branch --merged <defaultBranch>` and return
 * the list of branch names that are fully merged into defaultBranch, minus
 * any protected names and the default branch itself.
 */
async function getStaleBranches(
  diskPath: string,
  defaultBranch: string
): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "--git-dir", diskPath, "branch", "--merged", defaultBranch],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  return stdout
    .split("\n")
    .map((l) => l.replace(/^\*?\s+/, "").trim()) // strip leading "* " or spaces
    .filter(Boolean)
    .filter((b) => b !== defaultBranch && !PROTECTED_NAMES.has(b));
}

/** Age string from a Date — e.g. "3 days ago", "2 months ago". */
function ageFromNow(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays} days ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} month${diffMonths > 1 ? "s" : ""} ago`;
  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears} year${diffYears > 1 ? "s" : ""} ago`;
}

// ---------------------------------------------------------------------------
// Scoped CSS
// ---------------------------------------------------------------------------

const sbStyles = `
  .sb-container {
    max-width: 960px;
    margin: 0 auto;
    padding: 0 var(--space-3, 16px);
  }

  /* Hero */
  .sb-hero {
    position: relative;
    margin: 4px 0 24px;
    padding: 28px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .sb-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .sb-hero-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 6px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .sb-hero-title {
    font-size: clamp(22px, 3vw, 32px);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.1;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .sb-hero-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  /* Flash banner */
  .sb-flash {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 14px;
    margin-bottom: 18px;
    border: 1px solid;
  }
  .sb-flash.is-success {
    background: rgba(52,211,153,0.08);
    border-color: rgba(52,211,153,0.3);
    color: #34d399;
  }
  .sb-flash.is-error {
    background: rgba(248,113,113,0.08);
    border-color: rgba(248,113,113,0.3);
    color: #f87171;
  }

  /* Protected-branches hint */
  .sb-hint {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 18px;
    padding: 10px 14px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--border);
  }

  /* Toolbar */
  .sb-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .sb-count {
    font-size: 14px;
    color: var(--text-muted);
  }
  .sb-count strong { color: var(--text); }

  /* Table */
  .sb-table-wrap {
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .sb-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .sb-table thead {
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }
  .sb-table th {
    padding: 10px 14px;
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .sb-table th.sb-th-check {
    width: 36px;
    text-align: center;
  }
  .sb-table td {
    padding: 11px 14px;
    border-top: 1px solid var(--border);
    vertical-align: middle;
  }
  .sb-table tr:first-child td { border-top: none; }
  .sb-table tbody tr:hover { background: var(--bg-hover, rgba(255,255,255,0.03)); }

  .sb-td-check { text-align: center; }
  .sb-branch-name {
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    color: var(--text-strong);
    word-break: break-all;
  }
  .sb-pr-link {
    color: var(--text-link, #8c6dff);
    text-decoration: none;
    font-size: 13px;
  }
  .sb-pr-link:hover { text-decoration: underline; }
  .sb-dash { color: var(--text-muted); }
  .sb-date {
    font-size: 13px;
    color: var(--text);
    white-space: nowrap;
  }
  .sb-age {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Empty state */
  .sb-empty {
    text-align: center;
    padding: 60px 24px;
    color: var(--text-muted);
  }
  .sb-empty-icon {
    font-size: 40px;
    margin-bottom: 16px;
    line-height: 1;
  }
  .sb-empty-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .sb-empty-sub {
    font-size: 14px;
    margin: 0;
  }

  /* Actions */
  .sb-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 18px;
  }
  .sb-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 140ms ease, background 140ms ease;
    border: 1px solid transparent;
    text-decoration: none;
  }
  .sb-btn-danger {
    background: rgba(248,113,113,0.12);
    color: #f87171;
    border-color: rgba(248,113,113,0.35);
  }
  .sb-btn-danger:hover:not(:disabled) {
    background: rgba(248,113,113,0.22);
  }
  .sb-btn-danger:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;

// ---------------------------------------------------------------------------
// GET /:owner/:repo/branches/stale
// ---------------------------------------------------------------------------

staleBranchRoutes.get("/:owner/:repo/branches/stale", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  const { repo } = resolved;

  // Private repos require auth
  if (repo.isPrivate && !user) {
    return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`);
  }

  const isOwner = user?.id === repo.ownerId;

  // Get default branch
  const defaultBranch =
    (await getDefaultBranch(ownerName, repoName)) ?? repo.defaultBranch ?? "main";

  // Get stale branches
  let staleBranches: string[] = [];
  try {
    staleBranches = await getStaleBranches(repo.diskPath, defaultBranch);
  } catch {
    staleBranches = [];
  }

  // For each stale branch, find the last merged PR
  type BranchRow = {
    branch: string;
    prNumber: number | null;
    mergedAt: Date | null;
  };

  const rows: BranchRow[] = await Promise.all(
    staleBranches.map(async (branch) => {
      const [pr] = await db
        .select({
          number: pullRequests.number,
          mergedAt: pullRequests.mergedAt,
        })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.headBranch, branch),
            eq(pullRequests.state, "merged")
          )
        )
        .orderBy(desc(pullRequests.mergedAt))
        .limit(1);

      return {
        branch,
        prNumber: pr?.number ?? null,
        mergedAt: pr?.mergedAt ?? null,
      };
    })
  );

  // Sort by mergedAt desc (branches with no PR go last)
  rows.sort((a, b) => {
    if (a.mergedAt && b.mergedAt) {
      return b.mergedAt.getTime() - a.mergedAt.getTime();
    }
    if (a.mergedAt) return -1;
    if (b.mergedAt) return 1;
    return a.branch.localeCompare(b.branch);
  });

  // Unread count for nav badge
  const unreadCount = user ? await getUnreadCount(user.id) : 0;

  // Flash params
  const deleted = c.req.query("deleted");
  const failed = c.req.query("failed");

  return c.html(
    <Layout
      title={`Stale Branches — ${ownerName}/${repoName}`}
      user={user}
      notificationCount={unreadCount}
    >
      <style dangerouslySetInnerHTML={{ __html: sbStyles }} />
      <div class="sb-container">
        <RepoHeader
          owner={ownerName}
          repo={repoName}
          starCount={repo.starCount}
          forkCount={repo.forkCount}
          currentUser={user?.username ?? null}
        />
        <RepoNav owner={ownerName} repo={repoName} active="code" />

        {/* Flash message */}
        {(deleted !== undefined || failed !== undefined) && (
          <div
            class={`sb-flash ${Number(failed ?? 0) > 0 && Number(deleted ?? 0) === 0 ? "is-error" : "is-success"}`}
          >
            {Number(deleted ?? 0) > 0 && (
              <span>
                Deleted {deleted} branch{Number(deleted) !== 1 ? "es" : ""}
                {Number(failed ?? 0) > 0 && ` (${failed} failed)`}.
              </span>
            )}
            {Number(deleted ?? 0) === 0 && Number(failed ?? 0) > 0 && (
              <span>Failed to delete {failed} branch{Number(failed) !== 1 ? "es" : ""}.</span>
            )}
          </div>
        )}

        {/* Hero */}
        <div class="sb-hero">
          <p class="sb-hero-eyebrow">Repository maintenance</p>
          <h1 class="sb-hero-title">Stale Branches</h1>
          <p class="sb-hero-sub">
            Branches that have been fully merged into{" "}
            <code>{defaultBranch}</code> and are safe to remove.
            {!isOwner && " Only the repository owner can delete branches."}
          </p>
        </div>

        {/* Protected-branches hint */}
        <p class="sb-hint">
          Protected branches (<code>main</code>, <code>master</code>,{" "}
          <code>develop</code>, <code>staging</code>, <code>production</code>,{" "}
          <code>HEAD</code>, and <code>{defaultBranch}</code>) are never
          listed here.
        </p>

        {rows.length === 0 ? (
          /* Empty state */
          <div class="sb-empty">
            <div class="sb-empty-icon">&#10003;</div>
            <p class="sb-empty-title">
              No stale branches — great job keeping things tidy!
            </p>
            <p class="sb-empty-sub">
              All merged branches have already been cleaned up.
            </p>
          </div>
        ) : (
          <form method="post" action={`/${ownerName}/${repoName}/branches/stale/delete`}>
            {/* Toolbar */}
            <div class="sb-toolbar">
              <span class="sb-count">
                <strong>{rows.length}</strong> stale{" "}
                {rows.length === 1 ? "branch" : "branches"}
              </span>
            </div>

            {/* Table */}
            <div class="sb-table-wrap">
              <table class="sb-table">
                <thead>
                  <tr>
                    {isOwner && (
                      <th class="sb-th-check">
                        <input
                          type="checkbox"
                          id="sb-select-all"
                          title="Select all"
                          aria-label="Select all branches"
                        />
                      </th>
                    )}
                    <th>Branch</th>
                    <th>Merged PR</th>
                    <th>Merged date</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.branch}>
                      {isOwner && (
                        <td class="sb-td-check">
                          <input
                            type="checkbox"
                            name="branches[]"
                            value={row.branch}
                            class="sb-row-check"
                            aria-label={`Select ${row.branch}`}
                          />
                        </td>
                      )}
                      <td>
                        <span class="sb-branch-name">{row.branch}</span>
                      </td>
                      <td>
                        {row.prNumber != null ? (
                          <a
                            href={`/${ownerName}/${repoName}/pulls/${row.prNumber}`}
                            class="sb-pr-link"
                          >
                            #{row.prNumber}
                          </a>
                        ) : (
                          <span class="sb-dash">—</span>
                        )}
                      </td>
                      <td>
                        {row.mergedAt ? (
                          <span class="sb-date">
                            {row.mergedAt.toISOString().slice(0, 10)}
                          </span>
                        ) : (
                          <span class="sb-dash">—</span>
                        )}
                      </td>
                      <td>
                        {row.mergedAt ? (
                          <span class="sb-age">{ageFromNow(row.mergedAt)}</span>
                        ) : (
                          <span class="sb-dash">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Submit */}
            {isOwner && (
              <div class="sb-actions">
                <button
                  type="submit"
                  class="sb-btn sb-btn-danger"
                  id="sb-delete-btn"
                  disabled
                >
                  Delete selected
                </button>
              </div>
            )}
          </form>
        )}
      </div>

      {/* JS: select-all + disable/enable submit button */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var selectAll = document.getElementById('sb-select-all');
  var deleteBtn = document.getElementById('sb-delete-btn');
  var checks = [];

  function refresh() {
    checks = Array.from(document.querySelectorAll('.sb-row-check'));
    if (!deleteBtn) return;
    var anyChecked = checks.some(function (c) { return c.checked; });
    deleteBtn.disabled = !anyChecked;
  }

  if (selectAll) {
    selectAll.addEventListener('change', function () {
      checks.forEach(function (c) { c.checked = selectAll.checked; });
      refresh();
    });
  }

  document.addEventListener('change', function (e) {
    if (e.target && e.target.classList.contains('sb-row-check')) {
      refresh();
      if (selectAll) {
        selectAll.checked = checks.length > 0 && checks.every(function (c) { return c.checked; });
        selectAll.indeterminate = checks.some(function (c) { return c.checked; }) && !checks.every(function (c) { return c.checked; });
      }
    }
  });

  refresh();
})();
          `,
        }}
      />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/branches/stale/delete  (owner-only)
// ---------------------------------------------------------------------------

staleBranchRoutes.use("/:owner/:repo/branches/stale/delete", requireAuth);

staleBranchRoutes.post("/:owner/:repo/branches/stale/delete", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  const { repo } = resolved;

  // Owner-only
  if (user.id !== repo.ownerId) {
    return c.text("Forbidden", 403);
  }

  const defaultBranch =
    (await getDefaultBranch(ownerName, repoName)) ?? repo.defaultBranch ?? "main";

  // Re-derive the allowed stale set (re-run git to verify)
  let allowed: Set<string>;
  try {
    const stale = await getStaleBranches(repo.diskPath, defaultBranch);
    allowed = new Set(stale);
  } catch {
    allowed = new Set();
  }

  // Parse submitted branch names
  const body = await c.req.parseBody();
  const raw = body["branches[]"];
  const requested: string[] = (
    Array.isArray(raw) ? raw : raw ? [raw] : []
  ).map((v) => String(v).trim()).filter(Boolean);

  let deletedCount = 0;
  let failedCount = 0;

  for (const branch of requested) {
    // Must still be in the stale list (safety check)
    if (!allowed.has(branch)) {
      failedCount++;
      continue;
    }

    const proc = Bun.spawn(
      ["git", "--git-dir", repo.diskPath, "branch", "-d", branch],
      { stdout: "pipe", stderr: "pipe" }
    );
    await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      deletedCount++;
    } else {
      failedCount++;
    }
  }

  const params = new URLSearchParams();
  params.set("deleted", String(deletedCount));
  params.set("failed", String(failedCount));

  return c.redirect(
    `/${ownerName}/${repoName}/branches/stale?${params.toString()}`
  );
});

export { staleBranchRoutes };

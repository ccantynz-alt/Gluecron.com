/**
 * Cross-repo code search.
 *
 *   GET /search/code?q=&repos=&page=   — HTML page
 *   GET /api/search/code?q=&repos=&page= — JSON API
 *
 * Auth: softAuth — public repos are searchable by anonymous visitors;
 * private repos only appear when the authenticated user owns or collaborates
 * on them.
 *
 * Strategy (in priority order):
 *   1. `code_chunks` table — populated by the per-repo semantic-index path.
 *      Uses ILIKE for keyword matching against the stored `content` column.
 *   2. `git grep` fallback — when a repo has no indexed chunks we spawn a
 *      git grep subprocess against the bare repo on disk. Matches are
 *      capped at 5 lines per file and 20 files per repo so the fallback
 *      never bogs down a full page load.
 *
 * Scoped CSS: `.crs-*`
 */

import { Hono } from "hono";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { join } from "path";
import { db } from "../db";
import { codeChunks, repositories, repoCollaborators, users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getUnreadCount } from "../lib/unread";
import { config } from "../lib/config";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const crossRepoSearch = new Hono<AuthEnv>();
crossRepoSearch.use("/search/code*", softAuth);
crossRepoSearch.use("/api/search/code*", softAuth);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodeMatch {
  repoId: string;
  repoOwner: string;
  repoName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** Raw matched text (may span several lines). */
  snippet: string;
  /** Source of the match: "index" for code_chunks, "grep" for git-grep fallback. */
  source: "index" | "grep";
}

interface PagedResult {
  matches: CodeMatch[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

/** Highlight all occurrences of `q` in `text` using HTML <mark> tags. */
function highlight(text: string, q: string): string {
  if (!q) return escHtml(text);
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  return escHtml(text).replace(re, "<mark class=\"crs-mark\">$1</mark>");
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Run `git grep -n <pattern>` in a bare repo directory.
 * Returns at most `maxFiles` files with up to `linesPerFile` matching line
 * snippets each. Returns [] on any error.
 */
async function gitGrep(
  diskPath: string,
  pattern: string,
  maxFiles = 20,
  linesPerFile = 5
): Promise<Array<{ path: string; line: number; text: string }>> {
  try {
    const reposRoot = config.gitReposPath;
    const repoDir = join(reposRoot, diskPath);
    const proc = Bun.spawn(
      [
        "git",
        "--git-dir",
        repoDir,
        "grep",
        "-n",
        "-i",
        "--max-count",
        String(linesPerFile),
        "-e",
        pattern,
        "HEAD",
        "--",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    await proc.exited;

    const results: Array<{ path: string; line: number; text: string }> = [];
    const seen = new Set<string>();

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      // Format: HEAD:path:lineno:content  (git grep with --git-dir uses HEAD:)
      const m = line.match(/^HEAD:(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, filePath, lineStr, text] = m;
      if (!seen.has(filePath)) {
        if (seen.size >= maxFiles) break;
        seen.add(filePath);
      }
      results.push({ path: filePath, line: Number(lineStr), text });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Build a set of repository IDs the current user is allowed to see.
 * For anon: only public repos owned by any user.
 * For authed: also private repos they own OR are an accepted collaborator on.
 */
async function accessibleRepos(
  userId: string | null,
  repoFilter: string[]
): Promise<
  Array<{
    id: string;
    name: string;
    ownerName: string;
    diskPath: string;
    isPrivate: boolean;
  }>
> {
  // Build base query: always include public repos.
  const conditions = [eq(repositories.isPrivate, false)];

  if (userId) {
    // Also include private repos the user owns.
    conditions.push(eq(repositories.ownerId, userId));
  }

  let rows = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerName: users.username,
      diskPath: repositories.diskPath,
      isPrivate: repositories.isPrivate,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(or(...conditions))
    .orderBy(desc(repositories.pushedAt))
    .limit(500);

  // If auth'd, also pull private repos where they are an accepted collaborator.
  if (userId) {
    const collabRepoIds = await db
      .select({ repositoryId: repoCollaborators.repositoryId })
      .from(repoCollaborators)
      .where(
        and(
          eq(repoCollaborators.userId, userId),
          sql`${repoCollaborators.acceptedAt} IS NOT NULL`
        )
      );
    const collabIds = collabRepoIds.map((r) => r.repositoryId);
    if (collabIds.length > 0) {
      const privateCollabs = await db
        .select({
          id: repositories.id,
          name: repositories.name,
          ownerName: users.username,
          diskPath: repositories.diskPath,
          isPrivate: repositories.isPrivate,
        })
        .from(repositories)
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(
          and(eq(repositories.isPrivate, true), inArray(repositories.id, collabIds))
        );
      const existing = new Set(rows.map((r) => r.id));
      for (const r of privateCollabs) {
        if (!existing.has(r.id)) rows.push(r);
      }
    }
  }

  // Apply optional repo filter (owner/name slugs).
  if (repoFilter.length > 0) {
    rows = rows.filter((r) =>
      repoFilter.includes(`${r.ownerName}/${r.name}`)
    );
  }

  return rows;
}

/**
 * Search `code_chunks` for repos that have an index, then fall back to
 * `git grep` for repos without one.
 */
async function runSearch(
  q: string,
  repos: Array<{
    id: string;
    name: string;
    ownerName: string;
    diskPath: string;
    isPrivate: boolean;
  }>,
  page: number
): Promise<PagedResult> {
  if (!q || repos.length === 0) {
    return { matches: [], total: 0, page, pageSize: PAGE_SIZE, totalPages: 0 };
  }

  const pat = `%${q}%`;
  const repoIds = repos.map((r) => r.id);

  // 1. Find which repos have code_chunks.
  let indexedRepoIds: string[] = [];
  try {
    const indexed = await db
      .selectDistinct({ repositoryId: codeChunks.repositoryId })
      .from(codeChunks)
      .where(inArray(codeChunks.repositoryId, repoIds));
    indexedRepoIds = indexed.map((r) => r.repositoryId);
  } catch {
    indexedRepoIds = [];
  }

  const repoById = new Map(repos.map((r) => [r.id, r]));

  // 2. Keyword search on the code_chunks index.
  const indexMatches: CodeMatch[] = [];
  if (indexedRepoIds.length > 0) {
    try {
      const hits = await db
        .select({
          repositoryId: codeChunks.repositoryId,
          path: codeChunks.path,
          startLine: codeChunks.startLine,
          endLine: codeChunks.endLine,
          content: codeChunks.content,
        })
        .from(codeChunks)
        .where(
          and(
            inArray(codeChunks.repositoryId, indexedRepoIds),
            ilike(codeChunks.content, pat)
          )
        )
        .orderBy(desc(codeChunks.createdAt))
        .limit(200);

      for (const h of hits) {
        const repo = repoById.get(h.repositoryId);
        if (!repo) continue;
        indexMatches.push({
          repoId: h.repositoryId,
          repoOwner: repo.ownerName,
          repoName: repo.name,
          filePath: h.path,
          startLine: h.startLine,
          endLine: h.endLine,
          snippet: h.content,
          source: "index",
        });
      }
    } catch {
      // DB unavailable — skip index results.
    }
  }

  // 3. git grep fallback for un-indexed repos.
  const unindexedRepos = repos.filter((r) => !indexedRepoIds.includes(r.id));
  const grepMatches: CodeMatch[] = [];

  await Promise.all(
    unindexedRepos.slice(0, 10).map(async (repo) => {
      const lines = await gitGrep(repo.diskPath, q);
      for (const { path, line, text } of lines) {
        grepMatches.push({
          repoId: repo.id,
          repoOwner: repo.ownerName,
          repoName: repo.name,
          filePath: path,
          startLine: line,
          endLine: line,
          snippet: text,
          source: "grep",
        });
      }
    })
  );

  const allMatches = [...indexMatches, ...grepMatches];
  const total = allMatches.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const slice = allMatches.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return { matches: slice, total, page: safePage, pageSize: PAGE_SIZE, totalPages };
}

// ---------------------------------------------------------------------------
// JSON API  GET /api/search/code
// ---------------------------------------------------------------------------

crossRepoSearch.get("/api/search/code", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();
  const reposParam = (c.req.query("repos") || "").trim();
  const page = Math.max(1, Number(c.req.query("page") || "1"));
  const repoFilter = reposParam ? reposParam.split(",").map((s) => s.trim()).filter(Boolean) : [];

  if (!q) {
    return c.json({ matches: [], total: 0, page: 1, pageSize: PAGE_SIZE, totalPages: 0 });
  }

  const repos = await accessibleRepos(user?.id ?? null, repoFilter);
  const result = await runSearch(q, repos, page);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// HTML page  GET /search/code
// ---------------------------------------------------------------------------

crossRepoSearch.get("/search/code", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();
  const reposParam = (c.req.query("repos") || "").trim();
  const page = Math.max(1, Number(c.req.query("page") || "1"));
  const repoFilter = reposParam ? reposParam.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const unread = user ? await getUnreadCount(user.id) : 0;

  // Fetch accessible repos for filter dropdown.
  const accessibleRepoList = await accessibleRepos(user?.id ?? null, []);

  // Only run query when there is a search term.
  let result: PagedResult = {
    matches: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
    totalPages: 0,
  };
  if (q) {
    result = await runSearch(q, await accessibleRepos(user?.id ?? null, repoFilter), page);
  }

  const buildPageUrl = (p: number) => {
    const ps = new URLSearchParams({ q, page: String(p) });
    if (reposParam) ps.set("repos", reposParam);
    return `/search/code?${ps.toString()}`;
  };

  // Group matches by repo for the UI.
  const byRepo = new Map<
    string,
    { repoOwner: string; repoName: string; hits: CodeMatch[] }
  >();
  for (const m of result.matches) {
    const key = `${m.repoOwner}/${m.repoName}`;
    if (!byRepo.has(key)) {
      byRepo.set(key, { repoOwner: m.repoOwner, repoName: m.repoName, hits: [] });
    }
    byRepo.get(key)!.hits.push(m);
  }

  const repoGroups = [...byRepo.values()];

  return c.html(
    <Layout
      title={q ? `Code search — ${q}` : "Cross-repo code search"}
      user={user}
      notificationCount={unread}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
/* ─── Cross-repo search  .crs-* ─── */
.crs-hero {
  position: relative;
  margin: 4px 0 22px;
  padding: 32px 32px 28px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
}
.crs-hero::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg,transparent 0%,#8c6dff 30%,#36c5d6 70%,transparent 100%);
  opacity: 0.7;
  pointer-events: none;
}
.crs-hero-orb {
  position: absolute;
  inset: -30% -10% auto auto;
  width: 340px; height: 340px;
  background: radial-gradient(circle,rgba(140,109,255,0.18),rgba(54,197,214,0.09) 45%,transparent 70%);
  filter: blur(80px);
  opacity: 0.7;
  pointer-events: none;
  z-index: 0;
  animation: crsOrb 14s ease-in-out infinite;
}
@keyframes crsOrb {
  0%,100% { transform: scale(1) translate(0,0); opacity: 0.6; }
  50%      { transform: scale(1.1) translate(-12px,8px); opacity: 0.85; }
}
@media (prefers-reduced-motion: reduce) { .crs-hero-orb { animation: none; } }
.crs-hero-inner {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.crs-eyebrow {
  font-size: 11.5px;
  color: var(--text-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
}
.crs-title {
  font-family: var(--font-display);
  font-size: clamp(26px,4vw,38px);
  font-weight: 800;
  letter-spacing: -0.028em;
  line-height: 1.05;
  margin: 0;
  color: var(--text-strong);
}
.crs-sub {
  font-size: 14.5px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
  max-width: 600px;
}
/* ─── Search bar ─── */
.crs-form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: stretch;
}
.crs-input-wrap { position: relative; flex: 1; min-width: 220px; }
.crs-icon {
  position: absolute;
  top: 50%; left: 14px;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
  width: 16px; height: 16px;
}
.crs-input {
  width: 100%;
  box-sizing: border-box;
  padding: 12px 14px 12px 42px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  font: inherit;
  font-size: 14.5px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.crs-input::placeholder { color: var(--text-muted); }
.crs-input:focus {
  outline: none;
  border-color: rgba(140,109,255,0.55);
  box-shadow: 0 0 0 3px rgba(140,109,255,0.12);
}
.crs-select {
  padding: 12px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
  max-width: 220px;
}
.crs-select:focus {
  outline: none;
  border-color: rgba(140,109,255,0.55);
}
.crs-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 18px;
  height: 44px;
  border-radius: 12px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  background: linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);
  color: #fff;
  border: none;
  cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease;
  box-shadow: 0 6px 18px -6px rgba(140,109,255,0.5);
  white-space: nowrap;
}
.crs-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 24px -8px rgba(140,109,255,0.65);
}
/* ─── Tabs (back-link to global /search) ─── */
.crs-tabs {
  display: inline-flex;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 9999px;
  padding: 4px;
  gap: 2px;
  margin: 0 0 18px;
}
.crs-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border-radius: 9999px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
  transition: color 120ms ease, background 120ms ease;
}
.crs-tab:hover { color: var(--text-strong); text-decoration: none; }
.crs-tab.is-active {
  background: rgba(140,109,255,0.14);
  color: var(--text-strong);
}
/* ─── Stats bar ─── */
.crs-stats {
  font-size: 12.5px;
  color: var(--text-muted);
  margin: 0 0 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.crs-stats strong { color: var(--text); }
.crs-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(140,109,255,0.12);
  color: #c4b5fd;
  border: 1px solid rgba(140,109,255,0.28);
}
.crs-badge-grep {
  background: rgba(54,197,214,0.10);
  color: #67e8f9;
  border-color: rgba(54,197,214,0.28);
}
/* ─── Repo group ─── */
.crs-groups { display: flex; flex-direction: column; gap: 16px; }
.crs-group {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
}
.crs-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: rgba(255,255,255,0.02);
}
.crs-group-avatar {
  width: 28px; height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg,#8c6dff,#36c5d6);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 12px;
  color: #fff;
  flex-shrink: 0;
}
.crs-group-title {
  font-family: var(--font-mono);
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-strong);
  text-decoration: none;
}
.crs-group-title:hover { color: var(--accent); text-decoration: none; }
.crs-group-count {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-muted);
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  padding: 1px 8px;
  border-radius: 9999px;
}
/* ─── File match ─── */
.crs-file {
  border-bottom: 1px solid var(--border);
  padding: 10px 16px 12px;
}
.crs-file:last-child { border-bottom: none; }
.crs-file-path {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.crs-file-path:hover { color: var(--accent); text-decoration: none; }
.crs-file-lines {
  color: var(--text-muted);
  font-weight: 400;
}
.crs-snippet {
  margin: 0;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
.crs-mark {
  background: rgba(140,109,255,0.25);
  color: var(--text-strong);
  border-radius: 3px;
  padding: 0 2px;
}
/* ─── Empty state ─── */
.crs-empty {
  margin: 0;
  padding: 56px 32px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 16px;
  text-align: center;
  position: relative;
  overflow: hidden;
}
.crs-empty::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg,transparent 0%,#8c6dff 30%,#36c5d6 70%,transparent 100%);
  opacity: 0.55;
  pointer-events: none;
}
.crs-empty-title {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  color: var(--text-strong);
  margin: 0 0 8px;
}
.crs-empty-sub {
  font-size: 14px;
  color: var(--text-muted);
  line-height: 1.55;
  margin: 0 auto 20px;
  max-width: 460px;
}
/* ─── Pagination ─── */
.crs-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 24px;
  flex-wrap: wrap;
}
.crs-page-btn {
  display: inline-flex;
  align-items: center;
  padding: 6px 14px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  text-decoration: none;
  transition: border-color 120ms ease, background 120ms ease;
}
.crs-page-btn:hover { border-color: rgba(140,109,255,0.45); background: rgba(140,109,255,0.06); text-decoration: none; }
.crs-page-btn.is-active {
  background: rgba(140,109,255,0.14);
  border-color: rgba(140,109,255,0.45);
  color: var(--text-strong);
}
.crs-page-btn[aria-disabled="true"] {
  opacity: 0.4;
  pointer-events: none;
}
@media (max-width: 720px) {
  .crs-hero { padding: 20px 16px; }
  .crs-form { flex-direction: column; }
  .crs-select { max-width: 100%; }
  .crs-btn { width: 100%; justify-content: center; }
}
          `,
        }}
      />

      {/* ── Hero ── */}
      <section class="crs-hero">
        <div class="crs-hero-orb" aria-hidden="true" />
        <div class="crs-hero-inner">
          <div class="crs-eyebrow">Cross-repo · Code search</div>
          <h1 class="crs-title">
            <span class="gradient-text">Search code</span> across every repo.
          </h1>
          <p class="crs-sub">
            Keyword search inside file contents across all your accessible
            repositories. Results use the semantic index when available, or fall
            back to live{" "}
            <code style="font-size:13px">git grep</code>.
          </p>
          <form method="get" action="/search/code" class="crs-form" role="search">
            <div class="crs-input-wrap">
              <svg class="crs-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
                <path d="M20 20L17 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <input
                type="search"
                name="q"
                value={q}
                placeholder="Function name, error message, pattern…"
                aria-label="Search code"
                class="crs-input"
                autofocus
                autocomplete="off"
              />
            </div>
            <select name="repos" class="crs-select" aria-label="Filter by repository">
              <option value="" selected={!reposParam}>
                All repos
              </option>
              {accessibleRepoList.map((r) => {
                const slug = `${r.ownerName}/${r.name}`;
                return (
                  <option value={slug} selected={reposParam === slug}>
                    {slug}
                  </option>
                );
              })}
            </select>
            <button type="submit" class="crs-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
                <path d="M20 20L17 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              Search
            </button>
          </form>
        </div>
      </section>

      {/* ── Nav tabs ── */}
      <div class="crs-tabs" role="tablist" aria-label="Search categories">
        <a
          href={`/search?q=${encodeURIComponent(q)}&type=repos`}
          class="crs-tab"
          role="tab"
          aria-selected="false"
        >
          Global search
        </a>
        <a
          href={`/search/code?q=${encodeURIComponent(q)}`}
          class="crs-tab is-active"
          role="tab"
          aria-selected="true"
        >
          Code
        </a>
      </div>

      {/* ── No query yet ── */}
      {!q && (
        <div class="crs-empty">
          <svg
            style="width:72px;height:72px;margin:0 auto 16px;display:block;opacity:0.8"
            viewBox="0 0 96 96"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="crsIdleG" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop stop-color="#8c6dff" />
                <stop offset="1" stop-color="#36c5d6" />
              </linearGradient>
            </defs>
            <path d="M30 28L14 48L30 68" stroke="url(#crsIdleG)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M66 28L82 48L66 68" stroke="url(#crsIdleG)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M54 22L42 74" stroke="url(#crsIdleG)" stroke-width="4" stroke-linecap="round" opacity="0.55" />
          </svg>
          <h2 class="crs-empty-title">Search code across repos</h2>
          <p class="crs-empty-sub">
            Type a keyword above to search file contents across all
            {user ? " your" : " public"} repositories. Use the repo dropdown to
            narrow to a single repo.
          </p>
          {!user && (
            <p style="font-size:13px;color:var(--text-muted);margin:0">
              <a href="/login">Sign in</a> to also search your private
              repositories.
            </p>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {q && result.total === 0 && (
        <div class="crs-empty">
          <h2 class="crs-empty-title">No code matches for "{q}"</h2>
          <p class="crs-empty-sub">
            Try a different keyword, broaden the repo filter, or check that your
            repositories have been indexed for semantic search.
          </p>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <a href="/explore" class="btn btn-primary">
              Browse repos
            </a>
            <a
              href={`/search?q=${encodeURIComponent(q)}&type=repos`}
              class="btn"
            >
              Global search
            </a>
          </div>
        </div>
      )}

      {q && result.total > 0 && (
        <>
          {/* Stats */}
          <div class="crs-stats">
            <strong>{result.total}</strong>{" "}
            {result.total === 1 ? "match" : "matches"} across{" "}
            <strong>{repoGroups.length}</strong>{" "}
            {repoGroups.length === 1 ? "repo" : "repos"}
            {reposParam && (
              <>
                {" "}
                in{" "}
                <strong>
                  <code style="font-size:12px">{reposParam}</code>
                </strong>
              </>
            )}
            {" "}·{" "}
            page {result.page} of {result.totalPages}
          </div>

          {/* Grouped results */}
          <div class="crs-groups">
            {repoGroups.map(({ repoOwner, repoName, hits }) => {
              const initials =
                repoName.slice(0, 2).toUpperCase() || "??";
              return (
                <div class="crs-group">
                  <div class="crs-group-head">
                    <span class="crs-group-avatar" aria-hidden="true">
                      {initials}
                    </span>
                    <a
                      href={`/${repoOwner}/${repoName}`}
                      class="crs-group-title"
                    >
                      {repoOwner}/{repoName}
                    </a>
                    <span class="crs-group-count">
                      {hits.length}{" "}
                      {hits.length === 1 ? "match" : "matches"}
                    </span>
                  </div>
                  {hits.map((hit) => {
                    const blobHref = `/${repoOwner}/${repoName}/blob/HEAD/${hit.filePath}#L${hit.startLine}`;
                    const preview =
                      hit.snippet.length > 500
                        ? hit.snippet.slice(0, 500) + "\n…"
                        : hit.snippet;
                    const lineLabel =
                      hit.startLine === hit.endLine
                        ? `L${hit.startLine}`
                        : `L${hit.startLine}–${hit.endLine}`;
                    return (
                      <div class="crs-file">
                        <a href={blobHref} class="crs-file-path">
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          {hit.filePath}
                          <span class="crs-file-lines">
                            :{lineLabel}
                          </span>
                        </a>
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                          <span
                            class={
                              hit.source === "index"
                                ? "crs-badge"
                                : "crs-badge crs-badge-grep"
                            }
                          >
                            {hit.source === "index" ? "indexed" : "live grep"}
                          </span>
                        </div>
                        <pre
                          class="crs-snippet"
                          dangerouslySetInnerHTML={{
                            __html: highlight(preview, q),
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {result.totalPages > 1 && (
            <nav class="crs-pagination" aria-label="Result pages">
              <a
                href={buildPageUrl(result.page - 1)}
                class="crs-page-btn"
                aria-disabled={result.page <= 1 ? "true" : "false"}
                aria-label="Previous page"
              >
                ← Prev
              </a>
              {Array.from({ length: result.totalPages }, (_, i) => i + 1)
                .filter(
                  (p) =>
                    p === 1 ||
                    p === result.totalPages ||
                    Math.abs(p - result.page) <= 2
                )
                .reduce<Array<number | "…">>((acc, p, idx, arr) => {
                  if (idx > 0 && p - (arr[idx - 1] as number) > 1)
                    acc.push("…");
                  acc.push(p);
                  return acc;
                }, [])
                .map((p) =>
                  p === "…" ? (
                    <span style="color:var(--text-muted);padding:0 4px">…</span>
                  ) : (
                    <a
                      href={buildPageUrl(p as number)}
                      class={`crs-page-btn${p === result.page ? " is-active" : ""}`}
                      aria-current={p === result.page ? "page" : undefined}
                    >
                      {p}
                    </a>
                  )
                )}
              <a
                href={buildPageUrl(result.page + 1)}
                class="crs-page-btn"
                aria-disabled={result.page >= result.totalPages ? "true" : "false"}
                aria-label="Next page"
              >
                Next →
              </a>
            </nav>
          )}
        </>
      )}
    </Layout>
  );
});

export default crossRepoSearch;

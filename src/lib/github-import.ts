/**
 * Block L — GitHub importer.
 *
 * Pure helpers + orchestrator to copy a GitHub repo's metadata (labels,
 * issues, PRs, comments, releases, stargazers) into Gluecron's own tables.
 * The git content itself is handled separately via `git clone --mirror`.
 *
 * Contract:
 *   - Never throws. All helpers return `{ ok, data? } | { ok: false, error }`.
 *   - Paginated walkers honour a per-endpoint cap so a single sync request
 *     terminates in bounded time (no background worker needed for v1).
 *   - Auth is a GitHub PAT passed per call; we never log it.
 *   - Every insert uses the importing user as the authorId fallback so schema
 *     NOT NULL constraints are preserved even when we can't resolve the
 *     original GitHub author to a Gluecron user.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  issueComments,
  issueLabels,
  issues,
  labels as labelsTable,
  prComments,
  pullRequests,
  releases,
  repositories,
  stars,
  githubImports,
} from "../db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface GhRepo {
  default_branch?: string;
  private?: boolean;
  description?: string | null;
}

export interface GhLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: GhLabel[] | Array<{ name: string }>;
  pull_request?: { url: string } | null;
}

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  draft: boolean;
  base: { ref: string };
  head: { ref: string };
}

export interface GhComment {
  body: string;
  created_at: string;
  updated_at: string;
}

export interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  target_commitish: string;
  prerelease: boolean;
  draft: boolean;
  created_at: string;
  published_at: string | null;
}

export interface ImportCaps {
  labels: number;
  issues: number;
  pulls: number;
  issueComments: number;
  prComments: number;
  releases: number;
  stargazers: number;
}

export const DEFAULT_CAPS: ImportCaps = {
  labels: 200,
  issues: 200,
  pulls: 100,
  issueComments: 500,
  prComments: 500,
  releases: 50,
  stargazers: 200,
};

export interface ImportStats {
  labels: number;
  issues: number;
  pulls: number;
  issueComments: number;
  prComments: number;
  releases: number;
  stargazers: number;
}

export interface RunImportArgs {
  token: string;
  sourceOwner: string;
  sourceRepo: string;
  targetRepoId: string;
  importerUserId: string;
  caps?: Partial<ImportCaps>;
  fetchImpl?: typeof fetch; // injectable for tests
}

export interface RunImportResult {
  ok: boolean;
  stats: ImportStats;
  error?: string;
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/**
 * Build an authed clone URL. The token is URL-encoded and injected as
 * username. We reject CR/LF so a malicious token can't inject a header.
 */
export function buildAuthedCloneUrl(
  token: string,
  owner: string,
  repo: string
): Result<string> {
  if (!token || /[\r\n\s]/.test(token)) {
    return { ok: false, error: "invalid token" };
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, error: "invalid owner/repo" };
  }
  const encoded = encodeURIComponent(token);
  return {
    ok: true,
    data: `https://x-access-token:${encoded}@github.com/${owner}/${repo}.git`,
  };
}

/** Redact authed URL for logging. */
export function redactCloneUrl(url: string): string {
  return url.replace(/https:\/\/[^@]+@/, "https://***@");
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface GhFetchResponse {
  ok: boolean;
  status: number;
  body: unknown;
  linkNext?: string;
}

export async function ghFetch(
  token: string,
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<GhFetchResponse> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${token}`,
        "User-Agent": "gluecron-importer",
      },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const link = res.headers.get("link") || res.headers.get("Link");
    const linkNext = parseNextLink(link);
    return { ok: res.ok, status: res.status, body, linkNext };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      linkNext: undefined,
    };
  }
}

export function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Walk a paginated endpoint accumulating items up to `cap`. Stops on first
 * error response or when `linkNext` is absent.
 */
export async function paginate<T>(
  token: string,
  firstUrl: string,
  cap: number,
  fetchImpl: typeof fetch = fetch
): Promise<Result<T[]>> {
  const out: T[] = [];
  let url: string | undefined = firstUrl;
  let safety = 20; // hard ceiling on page walks
  while (url && out.length < cap && safety-- > 0) {
    const r = await ghFetch(token, url, fetchImpl);
    if (!r.ok) return { ok: false, error: `github ${r.status}` };
    if (!Array.isArray(r.body)) {
      return { ok: false, error: "expected array" };
    }
    for (const item of r.body as T[]) {
      out.push(item);
      if (out.length >= cap) break;
    }
    url = r.linkNext;
  }
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// Endpoint walkers
// ---------------------------------------------------------------------------

const API = "https://api.github.com";

export function fetchRepo(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<GhFetchResponse> {
  return ghFetch(token, `${API}/repos/${owner}/${repo}`, fetchImpl);
}

export function fetchLabels(
  token: string,
  owner: string,
  repo: string,
  cap: number,
  fetchImpl: typeof fetch = fetch
): Promise<Result<GhLabel[]>> {
  return paginate<GhLabel>(
    token,
    `${API}/repos/${owner}/${repo}/labels?per_page=100`,
    cap,
    fetchImpl
  );
}

export function fetchIssuesAndPulls(
  token: string,
  owner: string,
  repo: string,
  cap: number,
  fetchImpl: typeof fetch = fetch
): Promise<Result<GhIssue[]>> {
  return paginate<GhIssue>(
    token,
    `${API}/repos/${owner}/${repo}/issues?state=all&per_page=100`,
    cap,
    fetchImpl
  );
}

/** Filter a mixed issues+pulls list down to issues only. */
export function filterIssuesOnly(items: GhIssue[]): GhIssue[] {
  return items.filter((i) => !i.pull_request);
}

export function fetchPullRequests(
  token: string,
  owner: string,
  repo: string,
  cap: number,
  fetchImpl: typeof fetch = fetch
): Promise<Result<GhPull[]>> {
  return paginate<GhPull>(
    token,
    `${API}/repos/${owner}/${repo}/pulls?state=all&per_page=100`,
    cap,
    fetchImpl
  );
}

export function fetchIssueComments(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  cap: number,
  fetchImpl: typeof fetch = fetch
): Promise<Result<GhComment[]>> {
  return paginate<GhComment>(
    token,
    `${API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
    cap,
    fetchImpl
  );
}

export function fetchReleases(
  token: string,
  owner: string,
  repo: string,
  cap: number,
  fetchImpl: typeof fetch = fetch
): Promise<Result<GhRelease[]>> {
  return paginate<GhRelease>(
    token,
    `${API}/repos/${owner}/${repo}/releases?per_page=100`,
    cap,
    fetchImpl
  );
}

// ---------------------------------------------------------------------------
// Mappers — pure transforms from GitHub shapes to Gluecron insert rows
// ---------------------------------------------------------------------------

/** Normalise GitHub's 6-hex color (no #) into Gluecron's `#RRGGBB`. */
export function normaliseColor(hex: string | null | undefined): string {
  if (!hex) return "#8b949e";
  const s = hex.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(s)) return "#8b949e";
  return `#${s}`;
}

export function mapLabel(
  gh: GhLabel,
  repoId: string
): {
  repositoryId: string;
  name: string;
  color: string;
  description: string | null;
} {
  return {
    repositoryId: repoId,
    name: gh.name.slice(0, 50),
    color: normaliseColor(gh.color),
    description: gh.description ? gh.description.slice(0, 200) : null,
  };
}

export function mapIssue(
  gh: GhIssue,
  repoId: string,
  authorId: string
): {
  repositoryId: string;
  authorId: string;
  title: string;
  body: string | null;
  state: string;
  closedAt: Date | null;
} {
  return {
    repositoryId: repoId,
    authorId,
    title: gh.title.slice(0, 500),
    body: gh.body,
    state: gh.state === "closed" ? "closed" : "open",
    closedAt: gh.closed_at ? new Date(gh.closed_at) : null,
  };
}

export function mapPull(
  gh: GhPull,
  repoId: string,
  authorId: string
): {
  repositoryId: string;
  authorId: string;
  title: string;
  body: string | null;
  state: string;
  baseBranch: string;
  headBranch: string;
  isDraft: boolean;
  mergedAt: Date | null;
  closedAt: Date | null;
} {
  let state: "open" | "closed" | "merged" = "open";
  if (gh.merged_at) state = "merged";
  else if (gh.state === "closed") state = "closed";
  return {
    repositoryId: repoId,
    authorId,
    title: gh.title.slice(0, 500),
    body: gh.body,
    state,
    baseBranch: gh.base.ref.slice(0, 200),
    headBranch: gh.head.ref.slice(0, 200),
    isDraft: !!gh.draft,
    mergedAt: gh.merged_at ? new Date(gh.merged_at) : null,
    closedAt: gh.closed_at ? new Date(gh.closed_at) : null,
  };
}

export function mapRelease(
  gh: GhRelease,
  repoId: string,
  authorId: string
): {
  repositoryId: string;
  authorId: string;
  tag: string;
  name: string;
  body: string | null;
  targetCommit: string;
  isDraft: boolean;
  isPrerelease: boolean;
  publishedAt: Date | null;
} {
  return {
    repositoryId: repoId,
    authorId,
    tag: gh.tag_name.slice(0, 100),
    name: (gh.name ?? gh.tag_name).slice(0, 200),
    body: gh.body,
    targetCommit: gh.target_commitish.slice(0, 100),
    isDraft: !!gh.draft,
    isPrerelease: !!gh.prerelease,
    publishedAt: gh.published_at ? new Date(gh.published_at) : null,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function emptyStats(): ImportStats {
  return {
    labels: 0,
    issues: 0,
    pulls: 0,
    issueComments: 0,
    prComments: 0,
    releases: 0,
    stargazers: 0,
  };
}

/**
 * Walk GitHub endpoints for a single repo and mirror metadata into Gluecron.
 * Each endpoint is capped; failures are recorded on the run but do not halt
 * the overall import (best-effort, never throws).
 */
export async function runImport(args: RunImportArgs): Promise<RunImportResult> {
  const caps: ImportCaps = { ...DEFAULT_CAPS, ...(args.caps ?? {}) };
  const stats = emptyStats();
  const fetchImpl = args.fetchImpl ?? fetch;
  const errors: string[] = [];

  try {
    // Labels — build a name → id map so we can attach issueLabels.
    const labelMap = new Map<string, string>();
    const labelsRes = await fetchLabels(
      args.token,
      args.sourceOwner,
      args.sourceRepo,
      caps.labels,
      fetchImpl
    );
    if (labelsRes.ok) {
      for (const ghLabel of labelsRes.data) {
        try {
          const row = mapLabel(ghLabel, args.targetRepoId);
          const [inserted] = await db
            .insert(labelsTable)
            .values(row)
            .onConflictDoNothing()
            .returning();
          let labelId = inserted?.id;
          if (!labelId) {
            const [existing] = await db
              .select()
              .from(labelsTable)
              .where(
                and(
                  eq(labelsTable.repositoryId, args.targetRepoId),
                  eq(labelsTable.name, row.name)
                )
              )
              .limit(1);
            labelId = existing?.id;
          }
          if (labelId) {
            labelMap.set(row.name, labelId);
            stats.labels += 1;
          }
        } catch {
          // skip individual label on failure
        }
      }
    } else {
      errors.push(`labels: ${labelsRes.error}`);
    }

    // Issues + PRs come together from /issues?state=all; split them here.
    const mixedRes = await fetchIssuesAndPulls(
      args.token,
      args.sourceOwner,
      args.sourceRepo,
      caps.issues + caps.pulls,
      fetchImpl
    );
    const issuesOnly = mixedRes.ok ? filterIssuesOnly(mixedRes.data) : [];
    const issuesToInsert = issuesOnly.slice(0, caps.issues);
    if (!mixedRes.ok) errors.push(`issues: ${mixedRes.error}`);

    for (const ghIssue of issuesToInsert) {
      try {
        const [row] = await db
          .insert(issues)
          .values(mapIssue(ghIssue, args.targetRepoId, args.importerUserId))
          .returning();
        if (!row) continue;
        stats.issues += 1;

        // Attach labels
        for (const raw of ghIssue.labels ?? []) {
          const name =
            typeof raw === "string"
              ? raw
              : (raw as { name?: string } | null)?.name;
          if (!name) continue;
          const labelId = labelMap.get(name.slice(0, 50));
          if (!labelId) continue;
          try {
            await db
              .insert(issueLabels)
              .values({ issueId: row.id, labelId })
              .onConflictDoNothing();
          } catch {
            // ignore per-label
          }
        }

        // Walk comments for this issue (only while under the global cap)
        if (stats.issueComments < caps.issueComments) {
          const commentsRes = await fetchIssueComments(
            args.token,
            args.sourceOwner,
            args.sourceRepo,
            ghIssue.number,
            Math.min(50, caps.issueComments - stats.issueComments),
            fetchImpl
          );
          if (commentsRes.ok) {
            for (const ghComment of commentsRes.data) {
              try {
                await db.insert(issueComments).values({
                  issueId: row.id,
                  authorId: args.importerUserId,
                  body: ghComment.body,
                });
                stats.issueComments += 1;
                if (stats.issueComments >= caps.issueComments) break;
              } catch {
                // skip one comment
              }
            }
          }
        }
      } catch {
        // skip one issue
      }
    }

    // Pull requests — separate endpoint has base/head/merged_at we need.
    const pullsRes = await fetchPullRequests(
      args.token,
      args.sourceOwner,
      args.sourceRepo,
      caps.pulls,
      fetchImpl
    );
    if (!pullsRes.ok) errors.push(`pulls: ${pullsRes.error}`);
    if (pullsRes.ok) {
      for (const ghPull of pullsRes.data) {
        try {
          const [row] = await db
            .insert(pullRequests)
            .values(mapPull(ghPull, args.targetRepoId, args.importerUserId))
            .returning();
          if (!row) continue;
          stats.pulls += 1;

          if (stats.prComments < caps.prComments) {
            const commentsRes = await fetchIssueComments(
              args.token,
              args.sourceOwner,
              args.sourceRepo,
              ghPull.number,
              Math.min(50, caps.prComments - stats.prComments),
              fetchImpl
            );
            if (commentsRes.ok) {
              for (const ghComment of commentsRes.data) {
                try {
                  await db.insert(prComments).values({
                    pullRequestId: row.id,
                    authorId: args.importerUserId,
                    body: ghComment.body,
                    isAiReview: false,
                  });
                  stats.prComments += 1;
                  if (stats.prComments >= caps.prComments) break;
                } catch {
                  // skip one comment
                }
              }
            }
          }
        } catch {
          // skip one PR
        }
      }
    }

    // Releases
    const releasesRes = await fetchReleases(
      args.token,
      args.sourceOwner,
      args.sourceRepo,
      caps.releases,
      fetchImpl
    );
    if (!releasesRes.ok) errors.push(`releases: ${releasesRes.error}`);
    if (releasesRes.ok) {
      for (const ghRelease of releasesRes.data) {
        try {
          await db
            .insert(releases)
            .values(
              mapRelease(ghRelease, args.targetRepoId, args.importerUserId)
            )
            .onConflictDoNothing();
          stats.releases += 1;
        } catch {
          // skip
        }
      }
    }

    // Stargazers — just a count bump; we don't create fake user rows.
    const stargazersRes = await paginate<unknown>(
      args.token,
      `${API}/repos/${args.sourceOwner}/${args.sourceRepo}/stargazers?per_page=100`,
      caps.stargazers,
      fetchImpl
    );
    if (stargazersRes.ok) {
      stats.stargazers = stargazersRes.data.length;
      try {
        await db
          .update(repositories)
          .set({ starCount: stats.stargazers })
          .where(eq(repositories.id, args.targetRepoId));
        // Self-star from the importer so the "Stars" list isn't empty.
        await db
          .insert(stars)
          .values({
            userId: args.importerUserId,
            repositoryId: args.targetRepoId,
          })
          .onConflictDoNothing();
      } catch {
        // ignore
      }
    } else {
      errors.push(`stargazers: ${stargazersRes.error}`);
    }

    return {
      ok: errors.length === 0,
      stats,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      stats,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

export async function createImportRow(args: {
  userId: string;
  sourceOwner: string;
  sourceRepo: string;
}): Promise<string | null> {
  try {
    const [row] = await db
      .insert(githubImports)
      .values({
        userId: args.userId,
        sourceOwner: args.sourceOwner,
        sourceRepo: args.sourceRepo,
        status: "pending",
      })
      .returning();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export async function finaliseImportRow(
  importId: string,
  patch: {
    repositoryId?: string;
    status: "cloning" | "walking" | "ok" | "error";
    stats?: ImportStats;
    error?: string;
  }
): Promise<void> {
  try {
    await db
      .update(githubImports)
      .set({
        repositoryId: patch.repositoryId,
        status: patch.status,
        stats: patch.stats ? JSON.stringify(patch.stats) : undefined,
        error: patch.error,
        finishedAt:
          patch.status === "ok" || patch.status === "error"
            ? new Date()
            : undefined,
      })
      .where(eq(githubImports.id, importId));
  } catch {
    // best effort
  }
}

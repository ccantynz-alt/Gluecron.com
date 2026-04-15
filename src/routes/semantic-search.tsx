/**
 * Block D1 — Semantic code search UI + reindex trigger.
 *
 *   GET  /:owner/:repo/search/semantic?q=...      — results page (ILIKE parity)
 *   POST /:owner/:repo/search/semantic/reindex    — owner-only, fire-and-forget
 *
 * Intentionally tolerates a missing DB / missing repo / missing index so the
 * page is always navigable. When there's no index yet, the page shows a
 * "Build index" CTA pointing at the reindex endpoint.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, codeChunks } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  getDefaultBranch,
  resolveRef,
  repoExists,
} from "../git/repository";
import {
  indexRepository,
  searchRepository,
  isEmbeddingsProviderAvailable,
} from "../lib/semantic-search";

const semanticSearch = new Hono<AuthEnv>();
semanticSearch.use("*", softAuth);

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

function NotFound({ user }: { user: any }) {
  return (
    <Layout title="Not Found" user={user}>
      <div class="empty-state">
        <h2>Repository not found</h2>
        <p>No such repository, or you don't have access.</p>
      </div>
    </Layout>
  );
}

semanticSearch.get("/:owner/:repo/search/semantic", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();
  const flash = c.req.query("flash");

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return c.html(<NotFound user={user} />, 404);
  }
  const { repo } = resolved;

  // Figure out last-indexed state (chunk count + most recent createdAt).
  let indexedCount = 0;
  let lastIndexedAt: Date | null = null;
  let indexedCommitSha: string | null = null;
  try {
    // Grab the newest chunk row for metadata (sha + createdAt).
    const [newest] = await db
      .select({
        createdAt: codeChunks.createdAt,
        commitSha: codeChunks.commitSha,
      })
      .from(codeChunks)
      .where(eq(codeChunks.repositoryId, repo.id))
      .orderBy(desc(codeChunks.createdAt))
      .limit(1);
    if (newest) {
      lastIndexedAt = newest.createdAt as unknown as Date;
      indexedCommitSha = newest.commitSha || null;
      // Rough count for the UI blurb — order of magnitude is fine.
      const rows = await db
        .select({ id: codeChunks.id })
        .from(codeChunks)
        .where(eq(codeChunks.repositoryId, repo.id))
        .limit(5000);
      indexedCount = rows.length;
    }
  } catch {
    // DB unavailable — show the page anyway so the URL always resolves.
  }

  let hits: Awaited<ReturnType<typeof searchRepository>> = [];
  if (q && indexedCount > 0) {
    try {
      hits = await searchRepository({
        repositoryId: repo.id,
        query: q,
        limit: 20,
      });
    } catch {
      hits = [];
    }
  }

  const providers = isEmbeddingsProviderAvailable();
  const providerLabel = providers.voyage
    ? "Voyage voyage-code-3"
    : "lexical fallback (512-dim)";

  const isOwner = !!user && user.id === repo.ownerId;
  const refForLinks = indexedCommitSha || repo.defaultBranch || "HEAD";

  return c.html(
    <Layout title={`Semantic search — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <IssueNav owner={ownerName} repo={repoName} active="code" />

      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px">
        <h2 style="margin: 0">Semantic search</h2>
        <div class="meta" style="font-size: 12px">
          Provider: <strong>{providerLabel}</strong>
        </div>
      </div>

      {flash && (
        <div class="auth-success" style="margin-bottom: 16px">
          {decodeURIComponent(flash)}
        </div>
      )}

      <form
        method="GET"
        action={`/${ownerName}/${repoName}/search/semantic`}
        style="margin-bottom: 16px"
      >
        <input
          type="search"
          name="q"
          value={q}
          placeholder="Ask a question or describe what you're looking for…"
          style="width: 100%; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px"
          autofocus
        />
      </form>

      {indexedCount === 0 ? (
        <div class="empty-state">
          <h3>No index yet</h3>
          <p>
            This repository hasn't been indexed for semantic search. Build the
            index to enable AI-powered code lookup.
          </p>
          {isOwner ? (
            <form
              method="POST"
              action={`/${ownerName}/${repoName}/search/semantic/reindex`}
              style="margin-top: 12px"
            >
              <button type="submit" class="btn btn-primary">
                Build index
              </button>
            </form>
          ) : (
            <p class="meta" style="margin-top: 8px">
              Only the repository owner can trigger indexing.
            </p>
          )}
        </div>
      ) : (
        <>
          <div
            class="meta"
            style="font-size: 12px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center"
          >
            <span>
              {indexedCount} chunk{indexedCount === 1 ? "" : "s"} indexed
              {lastIndexedAt && (
                <>
                  {" · last indexed "}
                  {new Date(lastIndexedAt).toLocaleString()}
                </>
              )}
            </span>
            {isOwner && (
              <form
                method="POST"
                action={`/${ownerName}/${repoName}/search/semantic/reindex`}
                style="display: inline"
              >
                <button type="submit" class="btn btn-sm">
                  Reindex
                </button>
              </form>
            )}
          </div>

          {!q ? (
            <div class="empty-state">
              <p>Type a query to search across this repo's code.</p>
            </div>
          ) : hits.length === 0 ? (
            <div class="empty-state">
              <p>No results for "{q}"</p>
            </div>
          ) : (
            <div class="panel">
              {hits.map((h) => {
                const href = `/${ownerName}/${repoName}/blob/${refForLinks}/${h.path}#L${h.startLine}`;
                const preview =
                  h.content.length > 600
                    ? h.content.slice(0, 600) + "\n…"
                    : h.content;
                return (
                  <div class="panel-item" style="flex-direction: column; align-items: stretch">
                    <div
                      style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px"
                    >
                      <a href={href} style="font-weight: 600">
                        {h.path}
                      </a>
                      <span class="meta" style="font-size: 11px">
                        lines {h.startLine}–{h.endLine} · score{" "}
                        {h.score.toFixed(3)}
                      </span>
                    </div>
                    <pre
                      style="margin: 0; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; overflow-x: auto; white-space: pre-wrap"
                    >
                      {preview}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Layout>
  );
});

// Owner-only: rebuild the index. Fire-and-forget so the UI doesn't block on
// potentially multi-minute work. Always redirects.
semanticSearch.post(
  "/:owner/:repo/search/semantic/reindex",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const { repo } = resolved;

    if (repo.ownerId !== user.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/search/semantic?flash=${encodeURIComponent(
          "Only the repository owner can trigger indexing."
        )}`
      );
    }

    // Resolve the commit sha at the default branch. If the repo has no
    // commits yet we bail with a friendly flash.
    let sha: string | null = null;
    try {
      if (await repoExists(ownerName, repoName)) {
        const branch =
          (await getDefaultBranch(ownerName, repoName)) ||
          repo.defaultBranch ||
          "main";
        sha = await resolveRef(ownerName, repoName, branch);
      }
    } catch {
      sha = null;
    }

    if (!sha) {
      return c.redirect(
        `/${ownerName}/${repoName}/search/semantic?flash=${encodeURIComponent(
          "Repository has no commits yet — nothing to index."
        )}`
      );
    }

    // Fire-and-forget. Errors are swallowed inside indexRepository.
    void indexRepository({
      owner: ownerName,
      repo: repoName,
      repositoryId: repo.id,
      commitSha: sha,
    });

    return c.redirect(
      `/${ownerName}/${repoName}/search/semantic?flash=${encodeURIComponent(
        "Indexing started — results will appear shortly."
      )}`
    );
  }
);

export default semanticSearch;

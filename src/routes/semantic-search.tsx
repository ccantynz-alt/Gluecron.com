/**
 * Block D1 — Semantic code search UI + reindex trigger.
 *
 *   GET  /:owner/:repo/search/semantic?q=...      — results page (ILIKE parity)
 *   POST /:owner/:repo/search/semantic/reindex    — owner-only, fire-and-forget
 *
 * Intentionally tolerates a missing DB / missing repo / missing index so the
 * page is always navigable. When there's no index yet, the page shows a
 * "Build index" CTA pointing at the reindex endpoint.
 *
 * 2026 polish:
 *   - Scoped `.ss-*` CSS — sits below RepoHeader + IssueNav.
 *   - Eyebrow + display headline + 1-line subtitle.
 *   - Prominent search input w/ focus ring + gradient submit button.
 *   - Result cards show file:line in mono, snippet, and match score chip.
 *   - Dashed empty state w/ orb + Build/Reindex CTA when no index exists.
 *
 * All query strings + POST handlers preserved verbatim.
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
import { searchSemantic } from "../lib/semantic-index";

const semanticSearch = new Hono<AuthEnv>();
semanticSearch.use("*", softAuth);

// ─── Scoped CSS (.ss-*) ──────────────────────────────────────────────────
const ssStyles = `
  .ss-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .ss-head {
    margin-bottom: var(--space-5);
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .ss-head-text { flex: 1; min-width: 280px; }
  .ss-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .ss-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .ss-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .ss-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ss-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 720px;
  }

  .ss-provider {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
  }
  .ss-provider .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
  }

  .ss-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ss-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .ss-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* ─── Search bar ─── */
  .ss-search {
    display: flex;
    gap: 10px;
    align-items: stretch;
    margin-bottom: var(--space-4);
  }
  .ss-search-input-wrap { position: relative; flex: 1; }
  .ss-search-icon {
    position: absolute;
    top: 50%;
    left: 14px;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }
  .ss-search-input {
    width: 100%;
    box-sizing: border-box;
    padding: 12px 14px 12px 40px;
    font: inherit;
    font-size: 14.5px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    outline: none;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .ss-search-input:focus {
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.20);
  }
  .ss-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 18px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .ss-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .ss-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.65), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .ss-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
    padding: 7px 12px;
    font-size: 12.5px;
    border-radius: 9px;
  }
  .ss-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* ─── Index status bar ─── */
  .ss-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
    padding: 9px 14px;
    border-radius: 10px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .ss-status .num { color: var(--text-strong); font-weight: 600; }

  /* ─── Result cards ─── */
  .ss-results { display: flex; flex-direction: column; gap: 10px; }
  .ss-result {
    padding: 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .ss-result:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.025);
  }
  .ss-result-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .ss-result-path {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    text-decoration: none;
    word-break: break-all;
    letter-spacing: -0.005em;
  }
  .ss-result-path .lines { color: var(--text-muted); font-weight: 500; }
  .ss-result-path:hover { color: #c4b5fd; text-decoration: none; }
  .ss-score {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    background: rgba(54,197,214,0.12);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.30);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .ss-snippet {
    margin: 0;
    padding: 10px 12px;
    background: rgba(0,0,0,0.25);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ─── Empty state ─── */
  .ss-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 52px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .ss-empty-orb {
    position: absolute;
    inset: -40% 25% auto 25%;
    height: 300px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(72px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .ss-empty-inner { position: relative; z-index: 1; }
  .ss-empty-icon {
    width: 56px; height: 56px;
    margin: 0 auto 14px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
  }
  .ss-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .ss-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 480px;
    line-height: 1.5;
  }
`;

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function IconSparkles() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15l-1.7-4-4.3-1.7L10 7.6 12 3z" />
      <path d="M19 13l.9 2.4L22 16l-2.1.6L19 19l-.9-2.4L16 16l2.1-.6L19 13z" />
    </svg>
  );
}

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
      const rows = await db
        .select({ id: codeChunks.id })
        .from(codeChunks)
        .where(eq(codeChunks.repositoryId, repo.id))
        .limit(5000);
      indexedCount = rows.length;
    }
  } catch {
    // DB unavailable — show the page anyway.
  }

  let hits: Awaited<ReturnType<typeof searchRepository>> = [];
  if (q) {
    // Prefer the continuous per-push index (pgvector-backed). It's kept
    // fresh by `src/hooks/post-receive.ts` → `indexChangedFiles`, so it
    // typically beats the chunked full-repo index on staleness. Returns
    // `[]` when pgvector isn't available; fall back to the chunked index
    // in that case.
    try {
      const live = await searchSemantic({
        repositoryId: repo.id,
        query: q,
        limit: 20,
      });
      if (live.length > 0) {
        // Adapt to the chunked search-hit shape the UI expects. The
        // continuous index stores whole-file snippets (no line ranges),
        // so we surface line `1` and the snippet length as a best-effort
        // line span.
        hits = live.map((h) => {
          const lineCount = h.snippet
            ? Math.max(1, h.snippet.split("\n").length)
            : 1;
          return {
            path: h.filePath,
            startLine: 1,
            endLine: lineCount,
            content: h.snippet,
            score: h.score,
          };
        });
      }
    } catch {
      hits = [];
    }
    // Fall back to the chunked index if the continuous one had nothing.
    if (hits.length === 0 && indexedCount > 0) {
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

      <div class="ss-wrap">
        <header class="ss-head">
          <div class="ss-head-text">
            <div class="ss-eyebrow">
              <span class="ss-eyebrow-dot" aria-hidden="true" />
              Repository · Semantic search
            </div>
            <h1 class="ss-title">
              <span class="ss-title-grad">Ask the codebase anything.</span>
            </h1>
            <p class="ss-sub">
              Embeddings-powered code search across every indexed chunk —
              describe what you're looking for in natural language.
            </p>
          </div>
          <div class="ss-provider" title="Active embeddings provider">
            <span class="dot" aria-hidden="true" />
            {providerLabel}
          </div>
        </header>

        {flash && (
          <div class="ss-banner is-ok" role="status">
            <span class="ss-banner-dot" aria-hidden="true" />
            {decodeURIComponent(flash)}
          </div>
        )}

        <form
          method="get"
          action={`/${ownerName}/${repoName}/search/semantic`}
          class="ss-search"
        >
          <div class="ss-search-input-wrap">
            <span class="ss-search-icon" aria-hidden="true">
              <IconSearch />
            </span>
            <input
              type="search"
              name="q"
              value={q}
              placeholder="Ask a question or describe what you're looking for…"
              aria-label="Search"
              class="ss-search-input"
              autofocus
            />
          </div>
          <button type="submit" class="ss-btn ss-btn-primary">
            <IconSparkles />
            Search
          </button>
        </form>

        {indexedCount === 0 ? (
          <div class="ss-empty">
            <div class="ss-empty-orb" aria-hidden="true" />
            <div class="ss-empty-inner">
              <div class="ss-empty-icon" aria-hidden="true">
                <IconSparkles />
              </div>
              <h3 class="ss-empty-title">No index yet</h3>
              <p class="ss-empty-sub">
                This repository hasn't been indexed for semantic search. Build
                the index to enable AI-powered code lookup.
              </p>
              {isOwner ? (
                <form
                  method="post"
                  action={`/${ownerName}/${repoName}/search/semantic/reindex`}
                >
                  <button type="submit" class="ss-btn ss-btn-primary">
                    <IconSparkles />
                    Build index
                  </button>
                </form>
              ) : (
                <p
                  style="margin:0;color:var(--text-muted);font-size:13px"
                >
                  Only the repository owner can trigger indexing.
                </p>
              )}
            </div>
          </div>
        ) : (
          <>
            <div class="ss-status">
              <span>
                <span class="num">{indexedCount}</span> chunk
                {indexedCount === 1 ? "" : "s"} indexed
                {lastIndexedAt && (
                  <>
                    {" · last indexed "}
                    <span class="num">
                      {new Date(lastIndexedAt).toLocaleString()}
                    </span>
                  </>
                )}
              </span>
              {isOwner && (
                <form
                  method="post"
                  action={`/${ownerName}/${repoName}/search/semantic/reindex`}
                  style="display:inline"
                >
                  <button type="submit" class="ss-btn ss-btn-ghost">
                    Reindex
                  </button>
                </form>
              )}
            </div>

            {!q ? (
              <div class="ss-empty">
                <div class="ss-empty-orb" aria-hidden="true" />
                <div class="ss-empty-inner">
                  <div class="ss-empty-icon" aria-hidden="true">
                    <IconSearch />
                  </div>
                  <h3 class="ss-empty-title">Type a query to begin</h3>
                  <p class="ss-empty-sub">
                    Search across this repo's code — try a function name, a
                    file path, or a plain-English description of what you're
                    looking for.
                  </p>
                </div>
              </div>
            ) : hits.length === 0 ? (
              <div class="ss-empty">
                <div class="ss-empty-orb" aria-hidden="true" />
                <div class="ss-empty-inner">
                  <div class="ss-empty-icon" aria-hidden="true">
                    <IconSearch />
                  </div>
                  <h3 class="ss-empty-title">No results for "{q}"</h3>
                  <p class="ss-empty-sub">
                    Try a different phrasing or a related symbol name.
                  </p>
                </div>
              </div>
            ) : (
              <div class="ss-results">
                {hits.map((h) => {
                  const href = `/${ownerName}/${repoName}/blob/${refForLinks}/${h.path}#L${h.startLine}`;
                  const preview =
                    h.content.length > 600
                      ? h.content.slice(0, 600) + "\n…"
                      : h.content;
                  return (
                    <div class="ss-result">
                      <div class="ss-result-head">
                        <a href={href} class="ss-result-path">
                          {h.path}
                          <span class="lines">
                            :{h.startLine}–{h.endLine}
                          </span>
                        </a>
                        <span class="ss-score" title="Cosine similarity score">
                          score {h.score.toFixed(3)}
                        </span>
                      </div>
                      <pre class="ss-snippet">{preview}</pre>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: ssStyles }} />
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

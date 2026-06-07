/**
 * Natural Language Code Search UI
 *
 *   GET /:owner/:repo/search/nl?q=...  — search form + server-rendered results
 *
 * Uses Claude as the reasoner over actual file content (not embeddings).
 * Complements the embedding-based semantic search at /search/semantic.
 *
 * - softAuth: public repos searchable without login
 * - Server-side rendering: accept the wait (no client-side streaming needed)
 * - Results link to /:owner/:repo/blob/HEAD/<filePath>#L<lineStart>
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { nlSearch } from "../lib/nl-search";
import { isAiAvailable } from "../lib/ai-client";

const nlSearchRoutes = new Hono<AuthEnv>();
nlSearchRoutes.use("*", softAuth);

// ─── Scoped CSS (.nl-*) ──────────────────────────────────────────────────────
const nlStyles = `
  .nl-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .nl-head {
    margin-bottom: var(--space-5);
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .nl-head-text { flex: 1; min-width: 280px; }
  .nl-eyebrow {
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
  .nl-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    box-shadow: 0 0 0 3px rgba(245,158,11,0.18);
  }
  .nl-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .nl-title-grad {
    background-image: linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #ef4444 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .nl-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 720px;
  }

  .nl-provider {
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
  .nl-provider .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
  }

  /* ─── Search bar ─── */
  .nl-search {
    display: flex;
    gap: 10px;
    align-items: stretch;
    margin-bottom: var(--space-4);
  }
  .nl-search-input-wrap { position: relative; flex: 1; }
  .nl-search-icon {
    position: absolute;
    top: 50%;
    left: 14px;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }
  .nl-search-input {
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
  .nl-search-input:focus {
    border-color: rgba(245,158,11,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(245,158,11,0.20);
  }
  .nl-btn {
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
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .nl-btn-primary {
    background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(245,158,11,0.55), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .nl-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(245,158,11,0.65), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }

  /* ─── Examples ─── */
  .nl-examples {
    margin-bottom: var(--space-3);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .nl-examples-label {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .nl-example-chip {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 12px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    cursor: pointer;
    text-decoration: none;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .nl-example-chip:hover {
    border-color: rgba(245,158,11,0.45);
    color: var(--text-strong);
    background: rgba(245,158,11,0.06);
    text-decoration: none;
  }

  /* ─── Status bar ─── */
  .nl-status {
    margin-bottom: var(--space-3);
    padding: 9px 14px;
    border-radius: 10px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    font-variant-numeric: tabular-nums;
  }
  .nl-status .num { color: var(--text-strong); font-weight: 600; }

  /* ─── Result cards ─── */
  .nl-results { display: flex; flex-direction: column; gap: 10px; }
  .nl-result {
    padding: 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .nl-result:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.025);
  }
  .nl-result-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .nl-result-path {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    text-decoration: none;
    word-break: break-all;
    letter-spacing: -0.005em;
  }
  .nl-result-path .lines { color: var(--text-muted); font-weight: 500; }
  .nl-result-path:hover { color: #fcd34d; text-decoration: none; }
  .nl-confidence {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .nl-confidence-high {
    background: rgba(52,211,153,0.12);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .nl-confidence-medium {
    background: rgba(251,191,36,0.12);
    color: #fcd34d;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .nl-confidence-low {
    background: rgba(156,163,175,0.10);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px rgba(156,163,175,0.25);
  }
  .nl-explanation {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 8px;
    line-height: 1.5;
  }
  .nl-snippet {
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

  /* ─── Banner (no AI key) ─── */
  .nl-banner {
    margin-bottom: var(--space-4);
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid rgba(245,158,11,0.35);
    background: rgba(245,158,11,0.08);
    color: #fcd34d;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .nl-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* ─── Empty state ─── */
  .nl-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 52px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .nl-empty-orb {
    position: absolute;
    inset: -40% 25% auto 25%;
    height: 300px;
    background: radial-gradient(circle, rgba(245,158,11,0.15), rgba(239,68,68,0.08) 45%, transparent 70%);
    filter: blur(72px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .nl-empty-inner { position: relative; z-index: 1; }
  .nl-empty-icon {
    width: 56px; height: 56px;
    margin: 0 auto 14px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(245,158,11,0.25), rgba(239,68,68,0.20));
    box-shadow: inset 0 0 0 1px rgba(245,158,11,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fcd34d;
  }
  .nl-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .nl-empty-sub {
    margin: 0 auto;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 480px;
    line-height: 1.5;
  }

  /* ─── Footer ─── */
  .nl-footer {
    margin-top: var(--space-5);
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    font-family: var(--font-mono);
  }
  .nl-footer a { color: inherit; text-decoration: underline; }
  .nl-footer a:hover { color: var(--text); }
`;

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IconIntent() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
    </svg>
  );
}

// ─── Example queries ──────────────────────────────────────────────────────────

const EXAMPLE_QUERIES = [
  "find all places that write to the DB without error handling",
  "where do we check authentication?",
  "where do we validate user input?",
  "find all async functions that don't await their result",
  "where do we catch errors but ignore them?",
];

// ─── Resolve repo helper ──────────────────────────────────────────────────────

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

function NotFound({ user }: { user: typeof users.$inferSelect | null | undefined }) {
  return (
    <Layout title="Not Found" user={user}>
      <div class="empty-state">
        <h2>Repository not found</h2>
        <p>No such repository, or you don't have access.</p>
      </div>
    </Layout>
  );
}

// ─── Confidence pill ─────────────────────────────────────────────────────────

function ConfidencePill({ level }: { level: "high" | "medium" | "low" }) {
  const cls =
    level === "high"
      ? "nl-confidence nl-confidence-high"
      : level === "medium"
      ? "nl-confidence nl-confidence-medium"
      : "nl-confidence nl-confidence-low";
  return <span class={cls}>{level}</span>;
}

// ─── GET /:owner/:repo/search/nl ─────────────────────────────────────────────

nlSearchRoutes.get("/:owner/:repo/search/nl", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return c.html(<NotFound user={user} />, 404);
  }
  const { repo } = resolved;

  const aiAvailable = isAiAvailable();

  // Run NL search if a query was provided and AI is available
  let searchResult: Awaited<ReturnType<typeof nlSearch>> | null = null;
  if (q && aiAvailable) {
    searchResult = await nlSearch(ownerName, repoName, repo.id, q);
  }

  const results = searchResult?.results ?? [];
  const totalFilesScanned = searchResult?.totalFilesScanned ?? 0;
  const cached = searchResult?.cached ?? false;

  return c.html(
    <Layout title={`NL Search — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <IssueNav owner={ownerName} repo={repoName} active="code" />

      <div class="nl-wrap">
        {/* ─── Header ─── */}
        <header class="nl-head">
          <div class="nl-head-text">
            <div class="nl-eyebrow">
              <span class="nl-eyebrow-dot" aria-hidden="true" />
              Repository · Natural Language Search
            </div>
            <h1 class="nl-title">
              <span class="nl-title-grad">Search by intent, not keywords.</span>
            </h1>
            <p class="nl-sub">
              Describe what you're looking for in plain English — Claude reads
              the actual code and finds the matching places.
            </p>
          </div>
          <div class="nl-provider" title="Powered by Claude Sonnet">
            <span class="dot" aria-hidden="true" />
            Claude Sonnet
          </div>
        </header>

        {/* ─── No AI key warning ─── */}
        {!aiAvailable && (
          <div class="nl-banner" role="alert">
            <span class="nl-banner-dot" aria-hidden="true" />
            Natural language search requires an Anthropic API key (
            <code>ANTHROPIC_API_KEY</code>). Set the key and restart the server
            to enable this feature.
          </div>
        )}

        {/* ─── Search form ─── */}
        <form
          method="get"
          action={`/${ownerName}/${repoName}/search/nl`}
          class="nl-search"
        >
          <div class="nl-search-input-wrap">
            <span class="nl-search-icon" aria-hidden="true">
              <IconSearch />
            </span>
            <input
              type="search"
              name="q"
              value={q}
              placeholder='e.g. "find all places that write to the DB without error handling"'
              aria-label="Natural language search query"
              class="nl-search-input"
              autofocus
              disabled={!aiAvailable}
            />
          </div>
          <button type="submit" class="nl-btn nl-btn-primary" disabled={!aiAvailable}>
            <IconIntent />
            Search
          </button>
        </form>

        {/* ─── Example chips ─── */}
        {!q && aiAvailable && (
          <div class="nl-examples">
            <span class="nl-examples-label">Try:</span>
            {EXAMPLE_QUERIES.map((ex) => (
              <a
                href={`/${ownerName}/${repoName}/search/nl?q=${encodeURIComponent(ex)}`}
                class="nl-example-chip"
              >
                {ex}
              </a>
            ))}
          </div>
        )}

        {/* ─── Results area ─── */}
        {!q ? (
          /* Empty prompt state */
          <div class="nl-empty">
            <div class="nl-empty-orb" aria-hidden="true" />
            <div class="nl-empty-inner">
              <div class="nl-empty-icon" aria-hidden="true">
                <IconIntent />
              </div>
              <h3 class="nl-empty-title">Ask anything about the codebase</h3>
              <p class="nl-empty-sub">
                Type a natural language question above — Claude will scan the
                repository files and return the matching code locations with
                explanations.
              </p>
            </div>
          </div>
        ) : !aiAvailable ? (
          /* AI unavailable */
          <div class="nl-empty">
            <div class="nl-empty-orb" aria-hidden="true" />
            <div class="nl-empty-inner">
              <div class="nl-empty-icon" aria-hidden="true">
                <IconIntent />
              </div>
              <h3 class="nl-empty-title">AI not configured</h3>
              <p class="nl-empty-sub">
                Set <code>ANTHROPIC_API_KEY</code> to enable Claude-powered
                natural language search.
              </p>
            </div>
          </div>
        ) : results.length === 0 ? (
          /* No results */
          <div class="nl-empty">
            <div class="nl-empty-orb" aria-hidden="true" />
            <div class="nl-empty-inner">
              <div class="nl-empty-icon" aria-hidden="true">
                <IconSearch />
              </div>
              <h3 class="nl-empty-title">No results for "{q}"</h3>
              <p class="nl-empty-sub">
                Claude scanned {totalFilesScanned} file
                {totalFilesScanned === 1 ? "" : "s"} and found no matches.
                Try rephrasing your query or using different terminology.
              </p>
            </div>
          </div>
        ) : (
          /* Results */
          <>
            <div class="nl-status">
              <span>
                <span class="num">{results.length}</span> result
                {results.length === 1 ? "" : "s"}
                {" · scanned "}
                <span class="num">{totalFilesScanned}</span> file
                {totalFilesScanned === 1 ? "" : "s"}
                {cached && " · cached"}
              </span>
              <span>powered by Claude</span>
            </div>
            <div class="nl-results">
              {results.map((r) => {
                const href = `/${ownerName}/${repoName}/blob/HEAD/${r.filePath}#L${r.lineStart}`;
                const snippetPreview =
                  r.snippet.length > 800
                    ? r.snippet.slice(0, 800) + "\n…"
                    : r.snippet;
                return (
                  <div class="nl-result">
                    <div class="nl-result-head">
                      <a href={href} class="nl-result-path">
                        {r.filePath}
                        <span class="lines">
                          :{r.lineStart}–{r.lineEnd}
                        </span>
                      </a>
                      <ConfidencePill level={r.confidence} />
                    </div>
                    {r.explanation && (
                      <p class="nl-explanation">{r.explanation}</p>
                    )}
                    <pre class="nl-snippet">{snippetPreview}</pre>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ─── Footer ─── */}
        <div class="nl-footer">
          Natural language search powered by{" "}
          <a
            href={`/${ownerName}/${repoName}/search/semantic`}
            title="Switch to embedding-based semantic search"
          >
            semantic search
          </a>{" "}
          also available · Gluecron
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: nlStyles }} />
    </Layout>
  );
});

export { nlSearchRoutes };
export default nlSearchRoutes;

/**
 * Block I8 — Symbol / xref navigation.
 *
 *   GET  /:owner/:repo/symbols            — overview + "Reindex" button
 *   GET  /:owner/:repo/symbols/search     — search by name (prefix match)
 *   GET  /:owner/:repo/symbols/:name      — definitions list
 *   POST /:owner/:repo/symbols/reindex    — owner-only, runs indexer
 *
 * 2026 polish:
 *   - Scoped `.sym-*` CSS — no bleed into RepoHeader/RepoNav above.
 *   - Eyebrow + display headline + 1-line subtitle.
 *   - Each symbol is a card with a kind-specific icon (fn / class / var /
 *     interface / type / const), mono name pill, file:line, signature.
 *   - Search input gets a focus ring + gradient submit.
 *   - Dashed empty-state with orb + CTA when nothing's indexed.
 *
 * All query strings + POST handlers preserved verbatim.
 */

import { Hono } from "hono";
import { and, asc, eq, ilike, sql } from "drizzle-orm";
import { db } from "../db";
import { codeSymbols, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { indexRepositorySymbols, findDefinitions } from "../lib/symbols";

const symbols = new Hono<AuthEnv>();
symbols.use("*", softAuth);

// ─── Scoped CSS (.sym-*) ─────────────────────────────────────────────────
const symStyles = `
  .sym-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .sym-head {
    margin-bottom: var(--space-5);
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .sym-head-text { flex: 1; min-width: 280px; }
  .sym-eyebrow {
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
  .sym-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .sym-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .sym-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .sym-title-mono {
    font-family: var(--font-mono);
    letter-spacing: -0.018em;
  }
  .sym-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 720px;
  }

  .sym-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .sym-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .sym-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .sym-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .sym-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* ─── Banners ─── */
  .sym-banner {
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
  .sym-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .sym-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* ─── Search bar ─── */
  .sym-search {
    display: flex;
    gap: 10px;
    align-items: stretch;
    margin-bottom: var(--space-4);
  }
  .sym-search-input-wrap { position: relative; flex: 1; }
  .sym-search-icon {
    position: absolute;
    top: 50%;
    left: 14px;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }
  .sym-search-input {
    width: 100%;
    box-sizing: border-box;
    padding: 11px 14px 11px 40px;
    font: inherit;
    font-size: 14px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .sym-search-input:focus {
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.20);
  }

  /* ─── Summary tiles ─── */
  .sym-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    margin-bottom: var(--space-5);
  }
  .sym-stat {
    position: relative;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .sym-stat::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1.5px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 50%, #36c5d6 100%);
    opacity: 0.40;
    pointer-events: none;
  }
  .sym-stat-num {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .sym-stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 4px;
    font-weight: 600;
  }

  /* ─── Section header ─── */
  .sym-section-title {
    margin: 0 0 var(--space-3);
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }

  /* ─── Symbol cards ─── */
  .sym-list { display: flex; flex-direction: column; gap: 8px; }
  .sym-card {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .sym-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.025);
  }
  .sym-kind {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px; height: 30px;
    border-radius: 8px;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
  }
  .sym-kind.is-function {
    background: rgba(140,109,255,0.14);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .sym-kind.is-class {
    background: rgba(54,197,214,0.14);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
  }
  .sym-kind.is-interface {
    background: rgba(34,211,238,0.10);
    color: #a5f3fc;
    box-shadow: inset 0 0 0 1px rgba(34,211,238,0.32);
  }
  .sym-kind.is-type {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .sym-kind.is-const,
  .sym-kind.is-var {
    background: rgba(52,211,153,0.12);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .sym-kind.is-other {
    background: rgba(148,163,184,0.14);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }

  .sym-card-body { flex: 1; min-width: 0; }
  .sym-card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .sym-card-name {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sym-name {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 700;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
    word-break: break-all;
  }
  .sym-name:hover { color: #c4b5fd; text-decoration: none; }
  .sym-kind-label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .sym-card-loc {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    text-decoration: none;
    word-break: break-all;
    font-variant-numeric: tabular-nums;
  }
  .sym-card-loc:hover { color: var(--text-strong); text-decoration: underline; }
  .sym-sig {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: rgba(0,0,0,0.25);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text);
    overflow-x: auto;
    white-space: pre;
  }

  /* ─── Empty state ─── */
  .sym-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 52px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .sym-empty-orb {
    position: absolute;
    inset: -40% 25% auto 25%;
    height: 300px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(72px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .sym-empty-inner { position: relative; z-index: 1; }
  .sym-empty-icon {
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
  .sym-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .sym-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 460px;
    line-height: 1.5;
  }

  .sym-crumbs {
    margin-bottom: var(--space-4);
    font-size: 12.5px;
  }
  .sym-crumbs a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 11px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 500;
  }
  .sym-crumbs a:hover { border-color: var(--border-strong); color: var(--text-strong); text-decoration: none; }
`;

function IconRefresh() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function IconCode() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

/** Map a code-symbol kind to a short glyph + className suffix. */
function kindBadge(kind: string): { cls: string; glyph: string; label: string } {
  const k = (kind || "").toLowerCase();
  if (k === "function" || k === "fn" || k === "method")
    return { cls: "is-function", glyph: "fn", label: "function" };
  if (k === "class") return { cls: "is-class", glyph: "Cl", label: "class" };
  if (k === "interface") return { cls: "is-interface", glyph: "If", label: "interface" };
  if (k === "type") return { cls: "is-type", glyph: "T", label: "type" };
  if (k === "const") return { cls: "is-const", glyph: "K", label: "const" };
  if (k === "var" || k === "variable" || k === "let")
    return { cls: "is-var", glyph: "V", label: "var" };
  return { cls: "is-other", glyph: "·", label: kind || "symbol" };
}

async function loadRepo(ownerName: string, repoName: string) {
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
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return null;
  return { owner, repo };
}

function SymbolCard(props: {
  ownerName: string;
  repoName: string;
  name: string;
  kind: string;
  path: string;
  line: number;
  signature?: string | null;
}) {
  const { ownerName, repoName, name, kind, path, line, signature } = props;
  const badge = kindBadge(kind);
  return (
    <div class="sym-card">
      <span
        class={"sym-kind " + badge.cls}
        title={badge.label}
        aria-label={badge.label}
      >
        {badge.glyph}
      </span>
      <div class="sym-card-body">
        <div class="sym-card-row">
          <div class="sym-card-name">
            <a
              href={`/${ownerName}/${repoName}/symbols/${encodeURIComponent(name)}`}
              class="sym-name"
            >
              {name}
            </a>
            <span class="sym-kind-label">{badge.label}</span>
          </div>
          <a
            href={`/${ownerName}/${repoName}/blob/HEAD/${path}#L${line}`}
            class="sym-card-loc"
          >
            {path}:{line}
          </a>
        </div>
        {signature && <pre class="sym-sig">{signature}</pre>}
      </div>
    </div>
  );
}

// ---------- Overview ----------

symbols.get("/:owner/:repo/symbols", async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.notFound();
  }

  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(codeSymbols)
    .where(eq(codeSymbols.repositoryId, repo.id));
  const total = Number(countRow?.n || 0);

  const byKindRaw = await db
    .select({
      kind: codeSymbols.kind,
      n: sql<number>`count(*)::int`,
    })
    .from(codeSymbols)
    .where(eq(codeSymbols.repositoryId, repo.id))
    .groupBy(codeSymbols.kind);

  const latest = await db
    .select({
      name: codeSymbols.name,
      kind: codeSymbols.kind,
      path: codeSymbols.path,
      line: codeSymbols.line,
    })
    .from(codeSymbols)
    .where(eq(codeSymbols.repositoryId, repo.id))
    .orderBy(asc(codeSymbols.name))
    .limit(50);

  const isOwner = user && user.id === repo.ownerId;
  const message = c.req.query("message");

  return c.html(
    <Layout title={`Symbols — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="code" />
      <div class="sym-wrap">
        <header class="sym-head">
          <div class="sym-head-text">
            <div class="sym-eyebrow">
              <span class="sym-eyebrow-dot" aria-hidden="true" />
              Repository · Symbols
            </div>
            <h1 class="sym-title">
              <span class="sym-title-grad">Top-level definitions, indexed.</span>
            </h1>
            <p class="sym-sub">
              Jump straight to the file and line where each function, class,
              interface, type, or constant is defined on the default branch.
            </p>
          </div>
          {isOwner && (
            <form method="post" action={`/${ownerName}/${repoName}/symbols/reindex`}>
              <button type="submit" class="sym-btn sym-btn-primary">
                <IconRefresh />
                Reindex
              </button>
            </form>
          )}
        </header>

        {message && (
          <div class="sym-banner is-ok" role="status">
            <span class="sym-banner-dot" aria-hidden="true" />
            {decodeURIComponent(message)}
          </div>
        )}

        <form
          method="get"
          action={`/${ownerName}/${repoName}/symbols/search`}
          class="sym-search"
        >
          <div class="sym-search-input-wrap">
            <span class="sym-search-icon" aria-hidden="true">
              <IconSearch />
            </span>
            <input
              type="text"
              name="q"
              placeholder="Search symbol name…"
              required
              aria-label="Search symbol name"
              class="sym-search-input"
            />
          </div>
          <button type="submit" class="sym-btn sym-btn-primary">
            Search
          </button>
        </form>

        <div class="sym-stats">
          <div class="sym-stat">
            <div class="sym-stat-num">{total}</div>
            <div class="sym-stat-label">Symbols</div>
          </div>
          {byKindRaw.map((r) => (
            <div class="sym-stat">
              <div class="sym-stat-num">{Number(r.n)}</div>
              <div class="sym-stat-label">{r.kind}</div>
            </div>
          ))}
        </div>

        <h3 class="sym-section-title">A–Z</h3>
        {total === 0 ? (
          <div class="sym-empty">
            <div class="sym-empty-orb" aria-hidden="true" />
            <div class="sym-empty-inner">
              <div class="sym-empty-icon" aria-hidden="true">
                <IconCode />
              </div>
              <h3 class="sym-empty-title">No symbols indexed yet</h3>
              <p class="sym-empty-sub">
                {isOwner
                  ? "Click Reindex to scan the default branch for top-level functions, classes, interfaces, types, and constants."
                  : "The owner hasn't indexed this repository's symbols yet."}
              </p>
              {isOwner && (
                <form method="post" action={`/${ownerName}/${repoName}/symbols/reindex`}>
                  <button type="submit" class="sym-btn sym-btn-primary">
                    <IconRefresh />
                    Reindex now
                  </button>
                </form>
              )}
            </div>
          </div>
        ) : (
          <div class="sym-list">
            {latest.map((s) => (
              <SymbolCard
                ownerName={ownerName}
                repoName={repoName}
                name={s.name}
                kind={s.kind}
                path={s.path}
                line={s.line}
              />
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: symStyles }} />
    </Layout>
  );
});

// ---------- Search ----------

symbols.get("/:owner/:repo/symbols/search", async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.notFound();
  }

  const q = (c.req.query("q") || "").trim();
  const results = q
    ? await db
        .select({
          name: codeSymbols.name,
          kind: codeSymbols.kind,
          path: codeSymbols.path,
          line: codeSymbols.line,
        })
        .from(codeSymbols)
        .where(
          and(
            eq(codeSymbols.repositoryId, repo.id),
            ilike(codeSymbols.name, `${q}%`)
          )
        )
        .orderBy(asc(codeSymbols.name))
        .limit(200)
    : [];

  return c.html(
    <Layout title={`Symbol search — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="code" />
      <div class="sym-wrap">
        <div class="sym-crumbs">
          <a href={`/${ownerName}/${repoName}/symbols`}>← Back to symbols</a>
        </div>
        <header class="sym-head">
          <div class="sym-head-text">
            <div class="sym-eyebrow">
              <span class="sym-eyebrow-dot" aria-hidden="true" />
              Repository · Symbol search
            </div>
            <h1 class="sym-title">
              <span class="sym-title-grad">Find a symbol by name.</span>
            </h1>
            <p class="sym-sub">
              Prefix match across every indexed symbol — capped at 200
              results.
            </p>
          </div>
        </header>

        <form
          method="get"
          action={`/${ownerName}/${repoName}/symbols/search`}
          class="sym-search"
        >
          <div class="sym-search-input-wrap">
            <span class="sym-search-icon" aria-hidden="true">
              <IconSearch />
            </span>
            <input
              type="text"
              name="q"
              value={q}
              placeholder="Search symbol name…"
              required
              aria-label="Search symbol name"
              class="sym-search-input"
            />
          </div>
          <button type="submit" class="sym-btn sym-btn-primary">
            Search
          </button>
        </form>

        {q === "" ? (
          <div class="sym-empty">
            <div class="sym-empty-orb" aria-hidden="true" />
            <div class="sym-empty-inner">
              <div class="sym-empty-icon" aria-hidden="true">
                <IconSearch />
              </div>
              <h3 class="sym-empty-title">Type a prefix to search</h3>
              <p class="sym-empty-sub">
                Start typing a symbol name — matches appear as you submit.
              </p>
            </div>
          </div>
        ) : results.length === 0 ? (
          <div class="sym-empty">
            <div class="sym-empty-orb" aria-hidden="true" />
            <div class="sym-empty-inner">
              <div class="sym-empty-icon" aria-hidden="true">
                <IconSearch />
              </div>
              <h3 class="sym-empty-title">No symbols match "{q}"</h3>
              <p class="sym-empty-sub">
                Try a shorter prefix, or reindex if you've made changes.
              </p>
            </div>
          </div>
        ) : (
          <div class="sym-list">
            {results.map((s) => (
              <SymbolCard
                ownerName={ownerName}
                repoName={repoName}
                name={s.name}
                kind={s.kind}
                path={s.path}
                line={s.line}
              />
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: symStyles }} />
    </Layout>
  );
});

// ---------- Symbol detail ----------

symbols.get("/:owner/:repo/symbols/:name", async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName, name } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.notFound();
  }

  const decodedName = decodeURIComponent(name);
  const defs = await findDefinitions(repo.id, decodedName);

  return c.html(
    <Layout title={`${name} — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="code" />
      <div class="sym-wrap">
        <div class="sym-crumbs">
          <a href={`/${ownerName}/${repoName}/symbols`}>← Back to symbols</a>
        </div>
        <header class="sym-head">
          <div class="sym-head-text">
            <div class="sym-eyebrow">
              <span class="sym-eyebrow-dot" aria-hidden="true" />
              Repository · Symbol
            </div>
            <h1 class="sym-title sym-title-mono">
              <span class="sym-title-grad">{decodedName}</span>
            </h1>
            <p class="sym-sub">
              {defs.length} definition{defs.length === 1 ? "" : "s"} found
              across the indexed code.
            </p>
          </div>
        </header>

        {defs.length === 0 ? (
          <div class="sym-empty">
            <div class="sym-empty-orb" aria-hidden="true" />
            <div class="sym-empty-inner">
              <div class="sym-empty-icon" aria-hidden="true">
                <IconCode />
              </div>
              <h3 class="sym-empty-title">No definitions found</h3>
              <p class="sym-empty-sub">
                This symbol isn't currently indexed. It may have been removed,
                or you may need to reindex.
              </p>
              <a
                href={`/${ownerName}/${repoName}/symbols`}
                class="sym-btn sym-btn-ghost"
              >
                Back to symbols
              </a>
            </div>
          </div>
        ) : (
          <div class="sym-list">
            {defs.map((d) => (
              <SymbolCard
                ownerName={ownerName}
                repoName={repoName}
                name={decodedName}
                kind={d.kind}
                path={d.path}
                line={d.line}
                signature={d.signature}
              />
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: symStyles }} />
    </Layout>
  );
});

// ---------- Reindex ----------

symbols.post("/:owner/:repo/symbols/reindex", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  if (user.id !== repo.ownerId) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403</h2>
          <p>Only the repository owner can reindex symbols.</p>
        </div>
      </Layout>,
      403
    );
  }

  const result = await indexRepositorySymbols(repo.id);
  const msg = result
    ? `Indexed ${result.indexed} symbols across ${result.files} files.`
    : "Indexing failed — see server logs.";
  return c.redirect(
    `/${ownerName}/${repoName}/symbols?message=${encodeURIComponent(msg)}`
  );
});

export default symbols;

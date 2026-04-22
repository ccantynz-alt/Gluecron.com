/**
 * Block I8 — Symbol / xref navigation.
 *
 *   GET  /:owner/:repo/symbols            — overview + "Reindex" button
 *   GET  /:owner/:repo/symbols/search     — search by name (prefix match)
 *   GET  /:owner/:repo/symbols/:name      — definitions list
 *   POST /:owner/:repo/symbols/reindex    — owner-only, runs indexer
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

// ---------- Overview ----------

symbols.get("/:owner/:repo/symbols", async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { owner, repo } = ctx;
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
      <div class="settings-container">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">Symbols</h2>
          {isOwner && (
            <form method="post" action={`/${ownerName}/${repoName}/symbols/reindex`}>
              <button type="submit" class="btn btn-primary btn-sm">
                Reindex
              </button>
            </form>
          )}
        </div>
        {message && (
          <div class="auth-success" style="margin-top:12px">
            {decodeURIComponent(message)}
          </div>
        )}
        <p style="color:var(--text-muted);margin-top:8px">
          Top-level definitions from the default branch. Click a symbol to
          see all its definitions.
        </p>

        <form
          method="get"
          action={`/${ownerName}/${repoName}/symbols/search`}
          style="display:flex;gap:8px;margin:16px 0"
        >
          <input
            type="text"
            name="q"
            placeholder="Search symbol name..."
            required
            aria-label="Search symbol name"
            style="flex:1"
          />
          <button type="submit" class="btn">
            Search
          </button>
        </form>

        <div
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:16px"
        >
          <div class="panel" style="padding:12px;text-align:center">
            <div style="font-size:20px;font-weight:700">{total}</div>
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
              Symbols
            </div>
          </div>
          {byKindRaw.map((r) => (
            <div class="panel" style="padding:12px;text-align:center">
              <div style="font-size:20px;font-weight:700">{Number(r.n)}</div>
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
                {r.kind}
              </div>
            </div>
          ))}
        </div>

        <h3>A–Z</h3>
        {total === 0 ? (
          <div class="panel-empty" style="padding:24px">
            No symbols indexed yet.
            {isOwner && " Click Reindex to scan the repository."}
          </div>
        ) : (
          <div class="panel">
            {latest.map((s) => (
              <div class="panel-item" style="justify-content:space-between">
                <div>
                  <a
                    href={`/${ownerName}/${repoName}/symbols/${encodeURIComponent(s.name)}`}
                    style="font-weight:600;font-family:var(--font-mono)"
                  >
                    {s.name}
                  </a>{" "}
                  <span
                    style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-left:6px"
                  >
                    {s.kind}
                  </span>
                </div>
                <a
                  href={`/${ownerName}/${repoName}/blob/HEAD/${s.path}#L${s.line}`}
                  style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono)"
                >
                  {s.path}:{s.line}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
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
      <div class="settings-container">
        <h2>Symbol search</h2>
        <form
          method="get"
          action={`/${ownerName}/${repoName}/symbols/search`}
          style="display:flex;gap:8px;margin:12px 0"
        >
          <input
            type="text"
            name="q"
            value={q}
            placeholder="Search symbol name..."
            required
            aria-label="Search symbol name"
            style="flex:1"
          />
          <button type="submit" class="btn">
            Search
          </button>
          <a href={`/${ownerName}/${repoName}/symbols`} class="btn">
            Back
          </a>
        </form>
        {q === "" ? (
          <p style="color:var(--text-muted)">Enter a prefix to search.</p>
        ) : results.length === 0 ? (
          <p style="color:var(--text-muted)">No symbols match "{q}".</p>
        ) : (
          <div class="panel">
            {results.map((s) => (
              <div class="panel-item" style="justify-content:space-between">
                <div>
                  <a
                    href={`/${ownerName}/${repoName}/symbols/${encodeURIComponent(s.name)}`}
                    style="font-weight:600;font-family:var(--font-mono)"
                  >
                    {s.name}
                  </a>{" "}
                  <span
                    style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-left:6px"
                  >
                    {s.kind}
                  </span>
                </div>
                <a
                  href={`/${ownerName}/${repoName}/blob/HEAD/${s.path}#L${s.line}`}
                  style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono)"
                >
                  {s.path}:{s.line}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
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

  const defs = await findDefinitions(repo.id, decodeURIComponent(name));

  return c.html(
    <Layout title={`${name} — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="code" />
      <div class="settings-container">
        <h2 style="font-family:var(--font-mono)">{decodeURIComponent(name)}</h2>
        <p style="color:var(--text-muted)">
          {defs.length} definition{defs.length === 1 ? "" : "s"}
        </p>
        {defs.length === 0 ? (
          <div class="panel-empty" style="padding:24px">
            No definitions found.{" "}
            <a href={`/${ownerName}/${repoName}/symbols`}>Back to symbols</a>
          </div>
        ) : (
          <div class="panel">
            {defs.map((d) => (
              <div class="panel-item" style="flex-direction:column;align-items:stretch;gap:4px">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <span
                    style="font-size:11px;color:var(--text-muted);text-transform:uppercase"
                  >
                    {d.kind}
                  </span>
                  <a
                    href={`/${ownerName}/${repoName}/blob/HEAD/${d.path}#L${d.line}`}
                    style="font-size:12px;font-family:var(--font-mono)"
                  >
                    {d.path}:{d.line}
                  </a>
                </div>
                {d.signature && (
                  <pre
                    style="margin:0;padding:8px;background:var(--bg-subtle);border-radius:4px;font-size:12px;overflow-x:auto"
                  >
                    {d.signature}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
        <p style="margin-top:20px">
          <a href={`/${ownerName}/${repoName}/symbols`}>← Back to symbols</a>
        </p>
      </div>
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

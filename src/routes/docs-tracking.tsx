/**
 * AI-tracked documentation sections — staleness dashboard.
 *
 *   GET  /:owner/:repo/docs/tracking
 *
 * Lists every `<!-- gluecron:doc-track src=... -->` region we know about
 * in the repo, alongside its source hash, last-checked timestamp, and a
 * "Stale / Fresh / Unseen" pill. Empty state when nothing is tracked yet.
 *
 * All page-local CSS is scoped under `.doctrk-*` so it cannot bleed into
 * the shared layout (per CLAUDE.md: do NOT modify shared layout /
 * components / ui). Mirrors the gradient hairline + orb pattern used by
 * previews.tsx and environments.tsx.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { docTracking, pullRequests, repositories, users } from "../db/schema";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import { findTrackedDocs, type TrackedDoc } from "../lib/ai-doc-updater";

const r = new Hono<AuthEnv>();
r.use("*", softAuth);

interface RepoRow {
  id: string;
  name: string;
  defaultBranch: string;
  starCount: number;
  forkCount: number;
}

async function loadRepo(owner: string, repo: string): Promise<RepoRow | null> {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[docs-tracking] loadRepo failed:", err);
    return null;
  }
}

interface StoredRow {
  docPath: string;
  sectionMarker: string;
  lastCheckedAt: Date;
  lastPrId: string | null;
  prNumber: number | null;
  prState: string | null;
}

async function loadStored(repositoryId: string): Promise<StoredRow[]> {
  try {
    const rows = await db
      .select({
        docPath: docTracking.docPath,
        sectionMarker: docTracking.sectionMarker,
        lastCheckedAt: docTracking.lastCheckedAt,
        lastPrId: docTracking.lastPrId,
        prNumber: pullRequests.number,
        prState: pullRequests.state,
      })
      .from(docTracking)
      .leftJoin(pullRequests, eq(pullRequests.id, docTracking.lastPrId))
      .where(eq(docTracking.repositoryId, repositoryId));
    return rows.map((r) => ({
      docPath: r.docPath,
      sectionMarker: r.sectionMarker,
      lastCheckedAt: r.lastCheckedAt,
      lastPrId: r.lastPrId,
      prNumber: r.prNumber,
      prState: r.prState,
    }));
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — `.doctrk-*` only. Mirrors `.preview-*` styling so the
 * dashboard feels at home alongside the other repo sub-pages.
 * ───────────────────────────────────────────────────────────────────── */
const docTrackingStyles = `
  .doctrk-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .doctrk-head {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .doctrk-head::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #36c5d6 30%, #8c6dff 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .doctrk-head-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(54,197,214,0.18), rgba(140,109,255,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .doctrk-head-inner { position: relative; z-index: 1; }

  .doctrk-eyebrow {
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
  .doctrk-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #36c5d6, #8c6dff);
    box-shadow: 0 0 0 3px rgba(54,197,214,0.18);
  }
  .doctrk-title {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    letter-spacing: -0.02em;
  }
  .doctrk-sub {
    color: var(--text-muted);
    margin: 0;
    max-width: 70ch;
    line-height: 1.5;
  }

  .doctrk-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .doctrk-doc {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-elevated);
    padding: var(--space-3) var(--space-4);
  }
  .doctrk-doc-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }
  .doctrk-doc-path {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 700;
    color: var(--text-strong);
    word-break: break-all;
  }
  .doctrk-section {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: rgba(255,255,255,0.02);
    margin-top: 8px;
  }
  .doctrk-section-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .doctrk-section-src {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
  }
  .doctrk-section-claim {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.45;
    white-space: pre-wrap;
    max-height: 4.5em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .doctrk-section-meta {
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .doctrk-section-meta code {
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    padding: 1px 6px;
    border-radius: 6px;
  }
  .doctrk-section-meta a {
    color: #b69dff;
    text-decoration: none;
  }
  .doctrk-section-meta a:hover { text-decoration: underline; }

  /* ─── status pills ─── */
  .doctrk-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .doctrk-pill.is-stale {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .doctrk-pill.is-fresh {
    background: rgba(52,211,153,0.10);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .doctrk-pill.is-unseen {
    background: rgba(148,163,184,0.10);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }
  .doctrk-pill.is-missing {
    background: rgba(248,113,113,0.10);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.35);
  }
  .doctrk-pill-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }

  /* ─── empty state ─── */
  .doctrk-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    text-align: center;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .doctrk-empty-orb {
    position: absolute;
    inset: auto auto -40% 50%;
    transform: translateX(-50%);
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(54,197,214,0.18), rgba(140,109,255,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
  }
  .doctrk-empty-inner { position: relative; z-index: 1; max-width: 540px; margin: 0 auto; }
  .doctrk-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
  }
  .doctrk-empty-body {
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 var(--space-3);
  }
  .doctrk-empty code, .doctrk-codeblock {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    background: rgba(255,255,255,0.06);
    padding: 1px 6px;
    border-radius: 6px;
  }
  .doctrk-codeblock {
    display: block;
    padding: 10px 14px;
    white-space: pre;
    text-align: left;
    margin: var(--space-3) auto;
    max-width: 540px;
    overflow-x: auto;
  }
`;

function statusFor(
  stored: StoredRow | undefined,
  section: { stale: boolean; currentSrcHash: string }
): { label: string; cls: string } {
  if (section.currentSrcHash.startsWith("missing:")) {
    return { label: "missing source", cls: "is-missing" };
  }
  if (!stored) {
    return { label: "unseen", cls: "is-unseen" };
  }
  if (section.stale) {
    return { label: "stale", cls: "is-stale" };
  }
  return { label: "fresh", cls: "is-fresh" };
}

r.get("/:owner/:repo/docs/tracking", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const [docs, stored, unread] = await Promise.all([
    findTrackedDocs(repoRow.id).catch(() => [] as TrackedDoc[]),
    loadStored(repoRow.id),
    user ? getUnreadCount(user.id) : Promise.resolve(0),
  ]);

  const storedByKey = new Map<string, StoredRow>();
  for (const row of stored) {
    storedByKey.set(`${row.docPath}::${row.sectionMarker}`, row);
  }

  const totalSections = docs.reduce((a, d) => a + d.sections.length, 0);

  return c.html(
    <Layout
      title={`Tracked docs — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username}
      />
      <RepoNav owner={owner} repo={repo} active="code" />

      <div class="doctrk-wrap">
        <section class="doctrk-head">
          <div class="doctrk-head-orb" aria-hidden="true" />
          <div class="doctrk-head-inner">
            <div class="doctrk-eyebrow">
              <span class="doctrk-eyebrow-dot" aria-hidden="true" />
              AI-tracked docs · {owner}/{repo}
            </div>
            <h2 class="doctrk-title">Documentation drift</h2>
            <p class="doctrk-sub">
              Every markdown region wrapped in{" "}
              <code>&lt;!-- gluecron:doc-track src=... --&gt;</code> markers is
              hashed against the source it claims to describe. When the
              source changes, Claude opens a draft PR labelled{" "}
              <code>ai:doc-update</code> with the refreshed prose.
            </p>
          </div>
        </section>

        {docs.length === 0 ? (
          <div class="doctrk-empty">
            <div class="doctrk-empty-orb" aria-hidden="true" />
            <div class="doctrk-empty-inner">
              <h3 class="doctrk-empty-title">No tracked sections yet</h3>
              <p class="doctrk-empty-body">
                Wrap a paragraph in a markdown file with the marker below
                and Claude will keep it in sync with the source whenever
                you push.
              </p>
              <code class="doctrk-codeblock">{`<!-- gluecron:doc-track src=src/lib/auth.ts -->
This module exports \`signIn\` and \`signUp\` —
see the source for details.
<!-- /gluecron:doc-track -->`}</code>
            </div>
          </div>
        ) : (
          <>
            <p class="doctrk-sub" style="margin-bottom: var(--space-3);">
              {docs.length} doc{docs.length === 1 ? "" : "s"} · {totalSections}{" "}
              tracked section{totalSections === 1 ? "" : "s"}
            </p>
            <div class="doctrk-list">
              {docs.map((d) => (
                <div class="doctrk-doc">
                  <div class="doctrk-doc-head">
                    <div class="doctrk-doc-path">{d.path}</div>
                    <div>
                      <span class="doctrk-pill">
                        <span class="doctrk-pill-dot" aria-hidden="true" />
                        {d.sections.length} section
                        {d.sections.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  {d.sections.map((s) => {
                    const key = `${d.path}::${s.marker}`;
                    const storedRow = storedByKey.get(key);
                    const status = statusFor(storedRow, s);
                    const checkedLabel = storedRow
                      ? new Date(storedRow.lastCheckedAt).toISOString()
                      : "never";
                    return (
                      <div class="doctrk-section">
                        <div class="doctrk-section-head">
                          <div class="doctrk-section-src">
                            tracks <code>{s.claimedFor}</code>
                          </div>
                          <span class={`doctrk-pill ${status.cls}`}>
                            <span class="doctrk-pill-dot" aria-hidden="true" />
                            {status.label}
                          </span>
                        </div>
                        <div class="doctrk-section-claim">{s.claim}</div>
                        <div class="doctrk-section-meta">
                          <span>
                            marker <code>{s.marker}</code>
                          </span>
                          <span>
                            current{" "}
                            <code>{s.currentSrcHash.slice(0, 12)}</code>
                          </span>
                          <span>
                            stored{" "}
                            <code>
                              {(s.storedClaimedHash ?? "—").slice(0, 12)}
                            </code>
                          </span>
                          <span>last checked {checkedLabel}</span>
                          {storedRow?.prNumber ? (
                            <span>
                              PR{" "}
                              <a
                                href={`/${owner}/${repo}/pulls/${storedRow.prNumber}`}
                              >
                                #{storedRow.prNumber}
                              </a>{" "}
                              ({storedRow.prState ?? "?"})
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: docTrackingStyles }} />
    </Layout>
  );
});

export default r;

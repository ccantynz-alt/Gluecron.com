/**
 * Per-branch preview URLs — list view (migration 0062).
 *
 *   GET  /:owner/:repo/previews
 *
 * Lists every live preview row for the repo (one per branch). Status
 * pills, mono branch names, short SHAs, clickable URLs, expires-in
 * countdowns. Empty state when no pushes have been made to a
 * non-default branch yet.
 *
 * All page-local CSS is scoped under `.preview-*` so it can't bleed
 * into the shared layout (per CLAUDE.md: do NOT modify shared
 * layout/components/ui). Mirrors the gradient hairline + orb pattern
 * used by environments.tsx / admin-integrations.tsx.
 *
 * The corresponding JSON API + force-rebuild endpoints live in
 * src/routes/api-v2.ts.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import {
  formatExpiresIn,
  listPreviewsForRepo,
  previewStatusLabel,
} from "../lib/branch-previews";

const r = new Hono<AuthEnv>();
r.use("*", softAuth);

async function loadRepo(owner: string, repo: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        ownerId: repositories.ownerId,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
        previewBuildsEnabled: repositories.previewBuildsEnabled,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[previews] loadRepo failed:", err);
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.preview-*` so this page can't bleed
 * into the layout. Same gradient hairline + orb language as environments.
 * ───────────────────────────────────────────────────────────────────── */
const previewStyles = `
  .preview-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .preview-head {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .preview-head::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .preview-head-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .preview-head-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .preview-head-text { flex: 1; min-width: 240px; max-width: 720px; }
  .preview-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .preview-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .preview-title {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: clamp(22px, 2.6vw, 30px);
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1.1;
    color: var(--text-strong);
  }
  .preview-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .preview-sub {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .preview-col-title {
    margin: 0 0 var(--space-2);
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-weight: 600;
    color: var(--text-muted);
  }

  .preview-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }

  .preview-card {
    position: relative;
    padding: var(--space-4) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  .preview-card::before {
    content: '';
    position: absolute;
    top: 0; left: 14px; right: 14px;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 30%, rgba(54,197,214,0.45) 70%, transparent 100%);
    opacity: 0;
    transition: opacity 160ms ease;
  }
  .preview-card:hover {
    transform: translateY(-1px);
    border-color: rgba(140,109,255,0.32);
    box-shadow: 0 8px 22px -10px rgba(0,0,0,0.40);
  }
  .preview-card:hover::before { opacity: 1; }

  .preview-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-2);
  }
  .preview-card-titles { flex: 1; min-width: 200px; }
  .preview-card-branch {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    word-break: break-all;
  }
  .preview-card-url {
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preview-card-url a { color: var(--accent, #8c6dff); text-decoration: none; }
  .preview-card-url a:hover { color: var(--accent, #36c5d6); text-decoration: underline; }
  .preview-card-meta {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .preview-card-meta code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    padding: 1px 6px;
    border-radius: 6px;
  }

  /* ─── status pills ─── */
  .preview-pill {
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
  .preview-pill.is-building {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .preview-pill.is-ready {
    background: rgba(52,211,153,0.10);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .preview-pill.is-failed {
    background: rgba(248,113,113,0.10);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.35);
  }
  .preview-pill.is-expired {
    background: rgba(148,163,184,0.10);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }
  .preview-pill-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }
  .preview-pill.is-building .preview-pill-dot {
    animation: previewPulse 1.4s ease-in-out infinite;
  }
  @keyframes previewPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .preview-error {
    margin-top: var(--space-2);
    padding: 8px 12px;
    border-radius: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #fecaca;
    background: rgba(248,113,113,0.06);
    border: 1px solid rgba(248,113,113,0.30);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ─── empty state ─── */
  .preview-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    text-align: center;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .preview-empty-orb {
    position: absolute;
    inset: auto auto -40% 50%;
    transform: translateX(-50%);
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
  }
  .preview-empty-inner { position: relative; z-index: 1; max-width: 460px; margin: 0 auto; }
  .preview-empty-icon {
    width: 44px; height: 44px;
    margin: 0 auto var(--space-3);
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.14));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    display: flex; align-items: center; justify-content: center;
    color: #b69dff;
  }
  .preview-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    letter-spacing: -0.01em;
  }
  .preview-empty-body {
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 var(--space-3);
  }
  .preview-empty code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    background: rgba(255,255,255,0.06);
    padding: 1px 6px;
    border-radius: 6px;
  }

  /* ─── secondary tab strip — only used when RepoNav has no slot ─── */
  .preview-tabbar {
    display: flex;
    gap: 4px;
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .preview-tabbar a {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .preview-tabbar a.is-active {
    color: var(--text-strong);
    border-bottom-color: #8c6dff;
  }
  .preview-tabbar a:hover { color: var(--text); }
`;

r.get("/:owner/:repo/previews", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const previews = await listPreviewsForRepo(repoRow.id);
  const unread = user ? await getUnreadCount(user.id) : 0;
  const now = new Date();

  return c.html(
    <Layout
      title={`Previews — ${owner}/${repo}`}
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

      <div class="preview-wrap">
        <section class="preview-head">
          <div class="preview-head-orb" aria-hidden="true" />
          <div class="preview-head-inner">
            <div class="preview-head-text">
              <div class="preview-eyebrow">
                <span class="preview-eyebrow-dot" aria-hidden="true" />
                Branch previews · {owner}/{repo}
              </div>
              <h2 class="preview-title">
                <span class="preview-title-grad">Previews.</span>
              </h2>
              <p class="preview-sub">
                Every push to a non-default branch gets a unique preview
                URL. Open the URL to see the branch as if it were live —
                no merge required. Previews auto-expire 24 hours after
                the last push.
              </p>
            </div>
          </div>
        </section>

        <nav class="preview-tabbar" aria-label="Repository previews navigation">
          <a href={`/${owner}/${repo}`}>Code</a>
          <a class="is-active" href={`/${owner}/${repo}/previews`}>Previews</a>
          <a href={`/${owner}/${repo}/deployments`}>Deployments</a>
        </nav>

        <h4 class="preview-col-title">
          {previews.length === 0
            ? "No previews yet"
            : `${previews.length} preview${previews.length === 1 ? "" : "s"}`}
        </h4>

        {previews.length === 0 ? (
          <div class="preview-empty">
            <div class="preview-empty-orb" aria-hidden="true" />
            <div class="preview-empty-inner">
              <div class="preview-empty-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <h3 class="preview-empty-title">Push to a branch to get a preview URL</h3>
              <p class="preview-empty-body">
                Create a branch other than{" "}
                <code>{repoRow.defaultBranch}</code>, push some commits,
                and a unique preview URL will land here within seconds.
                Each preview lasts 24 hours after the last push.
              </p>
            </div>
          </div>
        ) : (
          <div class="preview-list">
            {previews.map((p) => {
              const shortSha = (p.commitSha || "").slice(0, 7);
              const expiresLabel = formatExpiresIn(p.expiresAt, now);
              const statusKey = p.status as
                | "building"
                | "ready"
                | "failed"
                | "expired";
              const pillClass = `preview-pill is-${statusKey}`;
              return (
                <div class="preview-card">
                  <div class="preview-card-head">
                    <div class="preview-card-titles">
                      <h3 class="preview-card-branch">{p.branchName}</h3>
                      <div class="preview-card-url">
                        {p.status === "ready" ? (
                          <a href={p.previewUrl} target="_blank" rel="noopener noreferrer">
                            {p.previewUrl}
                          </a>
                        ) : (
                          <span style="color: var(--text-muted)">
                            {p.previewUrl}
                          </span>
                        )}
                      </div>
                      <div class="preview-card-meta">
                        <span>
                          commit <code>{shortSha}</code>
                        </span>
                        <span>
                          {p.status === "expired"
                            ? "expired"
                            : `expires in ${expiresLabel}`}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span class={pillClass}>
                        <span class="preview-pill-dot" aria-hidden="true" />
                        {previewStatusLabel(p.status)}
                      </span>
                    </div>
                  </div>
                  {p.status === "failed" && p.errorMessage && (
                    <div class="preview-error">{p.errorMessage}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style dangerouslySetInnerHTML={{ __html: previewStyles }} />
    </Layout>
  );
});

export default r;

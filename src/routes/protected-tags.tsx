/**
 * Block E7 — Protected tags settings UI.
 *
 *   GET  /:owner/:repo/settings/protected-tags            — CRUD list
 *   POST /:owner/:repo/settings/protected-tags            — create
 *   POST /:owner/:repo/settings/protected-tags/:id/delete — remove
 *
 * 2026 polish: scoped under `.pt-`. Form actions, validation, and POST
 * handlers preserved verbatim — security-critical surface.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  addProtectedTag,
  listProtectedTags,
  removeProtectedTag,
} from "../lib/protected-tags";
import { audit } from "../lib/notify";

const protectedTagsRoutes = new Hono<AuthEnv>();
protectedTagsRoutes.use("*", softAuth);

async function loadRepo(ownerName: string, repoName: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every selector under `.pt-` so this surface can't leak.
 * ───────────────────────────────────────────────────────────────────── */
const ptStyles = `
  .pt-wrap { max-width: 980px; margin: 0 auto; padding: var(--space-4) 0; }

  .pt-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .pt-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .pt-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .pt-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .pt-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .pt-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .pt-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .pt-title {
    font-size: clamp(26px, 3.6vw, 36px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .pt-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .pt-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .pt-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }
  .pt-hero-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    font-size: 12.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 8px;
    text-decoration: none;
    font-weight: 500;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .pt-hero-link:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  .pt-banner {
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
  .pt-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .pt-banner.is-error { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }
  .pt-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* ─── Status card ─── */
  .pt-status {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .pt-status.is-on {
    border-color: rgba(52,211,153,0.32);
    background: linear-gradient(135deg, rgba(52,211,153,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .pt-status.is-empty {
    border-color: rgba(251,191,36,0.30);
    background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .pt-status-row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .pt-status-mark {
    flex-shrink: 0;
    width: 52px; height: 52px;
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 8px 20px -8px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .pt-status.is-on .pt-status-mark {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    box-shadow: 0 8px 20px -8px rgba(16,185,129,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .pt-status.is-empty .pt-status-mark {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    color: #1a1206;
    box-shadow: 0 8px 20px -8px rgba(251,191,36,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .pt-status-text { flex: 1; min-width: 220px; }
  .pt-status-headline {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .pt-status-desc { margin: 0; font-size: 13.5px; color: var(--text-muted); line-height: 1.5; }

  /* ─── Section card ─── */
  .pt-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .pt-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .pt-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .pt-section-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    flex-shrink: 0;
  }
  .pt-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .pt-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Tag cards ─── */
  .pt-list { display: flex; flex-direction: column; gap: 10px; }
  .pt-tag {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .pt-tag:hover { border-color: rgba(140,109,255,0.30); transform: translateY(-1px); }
  .pt-tag-body { flex: 1; min-width: 0; }
  .pt-tag-pattern {
    font-family: var(--font-mono);
    font-size: 13.5px;
    color: var(--text-strong);
    background: rgba(140,109,255,0.10);
    border: 1px solid rgba(140,109,255,0.30);
    padding: 3px 10px;
    border-radius: 8px;
    font-weight: 600;
    display: inline-block;
  }
  .pt-tag-meta {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .pt-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 9999px;
    background: rgba(52,211,153,0.10);
    color: #6ee7b7;
    border: 1px solid rgba(52,211,153,0.30);
  }
  .pt-chip .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }

  /* ─── Empty state ─── */
  .pt-empty {
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    position: relative;
    overflow: hidden;
  }
  .pt-empty-orb {
    position: absolute;
    inset: -30% auto auto -10%;
    width: 260px; height: 260px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    opacity: 0.8;
    pointer-events: none;
  }
  .pt-empty-mark {
    position: relative;
    z-index: 1;
    margin: 0 auto var(--space-3);
    width: 52px; height: 52px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.12));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
  }
  .pt-empty-title {
    position: relative;
    z-index: 1;
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .pt-empty-body {
    position: relative;
    z-index: 1;
    margin: 0 auto;
    max-width: 460px;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .pt-empty-body code { font-family: var(--font-mono); font-size: 11.5px; background: rgba(255,255,255,0.04); border: 1px solid var(--border); padding: 1px 6px; border-radius: 5px; color: var(--text); }

  /* ─── Form ─── */
  .pt-form { padding: var(--space-5); }
  .pt-form-group { margin-bottom: var(--space-4); }
  .pt-form-label {
    display: block;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .pt-input {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .pt-input:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .pt-form-hint { margin-top: 6px; font-size: 12px; color: var(--text-muted); }
  .pt-form-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }

  /* ─── Buttons ─── */
  .pt-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .pt-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .pt-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .pt-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .pt-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
    text-decoration: none;
  }
  .pt-btn-sm { padding: 6px 11px; font-size: 12px; }
`;

/* Icons */
const TagIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
);
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const ArrowLeft = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </svg>
);

protectedTagsRoutes.get(
  "/:owner/:repo/settings/protected-tags",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}`);

    const tags = await listProtectedTags(repoRow.id);
    const success = c.req.query("success");
    const error = c.req.query("error");

    const statusVariant: "is-on" | "is-empty" =
      tags.length === 0 ? "is-empty" : "is-on";
    const statusHead =
      tags.length === 0
        ? "No tag patterns protected"
        : `${tags.length} pattern${tags.length === 1 ? "" : "s"} protected`;
    const statusDesc =
      tags.length === 0
        ? "Anyone with write access can create, update, or delete any tag right now."
        : "Only repo owners can create, update, or delete tags matching one of the patterns below.";

    return c.html(
      <Layout title={`Protected tags — ${owner}/${repo}`} user={user}>
        <RepoHeader
          owner={owner}
          repo={repo}
          starCount={repoRow.starCount}
          forkCount={repoRow.forkCount}
          currentUser={user.username}
        />
        <RepoNav owner={owner} repo={repo} active="gates" />

        <div class="pt-wrap">
          <section class="pt-hero">
            <div class="pt-hero-orb" aria-hidden="true" />
            <div class="pt-hero-inner">
              <div class="pt-hero-text">
                <div class="pt-eyebrow">
                  <span class="pt-eyebrow-pill" aria-hidden="true">
                    <TagIcon />
                  </span>
                  Protected tags · {owner}/{repo}
                </div>
                <h1 class="pt-title">
                  <span class="pt-title-grad">Lock down releases.</span>
                </h1>
                <p class="pt-sub">
                  Mark tag patterns as protected. Only repo owners can create,
                  update, or delete tags matching one of these patterns. Globs
                  supported: <code>v*</code>, <code>release-*</code>,{" "}
                  <code>**</code>.
                </p>
              </div>
              <a href={`/${owner}/${repo}/settings`} class="pt-hero-link">
                <ArrowLeft /> Back to settings
              </a>
            </div>
          </section>

          {success && (
            <div class="pt-banner is-ok" role="status">
              <span class="pt-banner-dot" aria-hidden="true" />
              {decodeURIComponent(success)}
            </div>
          )}
          {error && (
            <div class="pt-banner is-error" role="alert">
              <span class="pt-banner-dot" aria-hidden="true" />
              {decodeURIComponent(error)}
            </div>
          )}

          <section class={`pt-status ${statusVariant}`}>
            <div class="pt-status-row">
              <span class="pt-status-mark" aria-hidden="true">
                <TagIcon />
              </span>
              <div class="pt-status-text">
                <h2 class="pt-status-headline">{statusHead}</h2>
                <p class="pt-status-desc">{statusDesc}</p>
              </div>
            </div>
          </section>

          <section class="pt-section">
            <header class="pt-section-head">
              <h3 class="pt-section-title">
                <span class="pt-section-icon" aria-hidden="true">
                  <TagIcon />
                </span>
                Protected patterns
              </h3>
              <p class="pt-section-sub">
                Each pattern is matched against the tag name (e.g.{" "}
                <code>v1.2.3</code> matches <code>v*</code>).
              </p>
            </header>
            <div class="pt-section-body">
              {tags.length === 0 ? (
                <div class="pt-empty">
                  <div class="pt-empty-orb" aria-hidden="true" />
                  <div class="pt-empty-mark" aria-hidden="true">
                    <TagIcon />
                  </div>
                  <h4 class="pt-empty-title">No protected tag patterns</h4>
                  <p class="pt-empty-body">
                    Common starting patterns: <code>v*</code> protects every
                    semver release tag; <code>release-*</code> protects named
                    release tags. Add one below to lock them down.
                  </p>
                </div>
              ) : (
                <div class="pt-list">
                  {tags.map((t) => (
                    <div class="pt-tag">
                      <div class="pt-tag-body">
                        <span class="pt-tag-pattern">{t.pattern}</span>
                        <div class="pt-tag-meta">
                          <span class="pt-chip">
                            <span class="dot" aria-hidden="true" />
                            owners only
                          </span>
                          <span>·</span>
                          <span>
                            Added{" "}
                            {t.createdAt
                              ? new Date(t.createdAt as unknown as string).toLocaleDateString()
                              : ""}
                          </span>
                        </div>
                      </div>
                      <form
                        method="post"
                        action={`/${owner}/${repo}/settings/protected-tags/${t.id}/delete`}
                        onsubmit="return confirm('Remove protection for this pattern?')"
                      >
                        <button type="submit" class="pt-btn pt-btn-danger pt-btn-sm">
                          Remove
                        </button>
                      </form>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section class="pt-section">
            <header class="pt-section-head">
              <h3 class="pt-section-title">
                <span class="pt-section-icon" aria-hidden="true">
                  <PlusIcon />
                </span>
                Protect new pattern
              </h3>
              <p class="pt-section-sub">
                Add a glob that should be reserved to repo owners.
              </p>
            </header>
            <form
              method="post"
              action={`/${owner}/${repo}/settings/protected-tags`}
              class="pt-form"
            >
              <div class="pt-form-group">
                <label class="pt-form-label" for="pt-pattern">Pattern</label>
                <input
                  type="text"
                  id="pt-pattern"
                  name="pattern"
                  required
                  placeholder="v* or release-*"
                  aria-label="Tag protection pattern"
                  class="pt-input"
                />
                <div class="pt-form-hint">
                  Globs: <code>v*</code>, <code>release-*</code>,{" "}
                  <code>**</code> matches everything.
                </div>
              </div>
              <button type="submit" class="pt-btn pt-btn-primary">
                <PlusIcon /> Protect pattern
              </button>
            </form>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: ptStyles }} />
      </Layout>
    );
  }
);

protectedTagsRoutes.post(
  "/:owner/:repo/settings/protected-tags",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}`);

    const body = await c.req.parseBody();
    const pattern = String(body.pattern || "").trim();
    if (!pattern) {
      return c.redirect(
        `/${owner}/${repo}/settings/protected-tags?error=${encodeURIComponent("Pattern required")}`
      );
    }

    const created = await addProtectedTag({
      repositoryId: repoRow.id,
      pattern,
      createdBy: user.id,
    });

    if (created) {
      await audit({
        userId: user.id,
        repositoryId: repoRow.id,
        action: "protected_tags.create",
        metadata: { pattern },
      });
    }

    return c.redirect(
      `/${owner}/${repo}/settings/protected-tags?success=${encodeURIComponent(
        created ? `Pattern '${pattern}' protected` : "Could not save pattern"
      )}`
    );
  }
);

protectedTagsRoutes.post(
  "/:owner/:repo/settings/protected-tags/:id/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}`);

    const ok = await removeProtectedTag(repoRow.id, id);
    if (ok) {
      await audit({
        userId: user.id,
        repositoryId: repoRow.id,
        action: "protected_tags.delete",
        targetId: id,
      });
    }

    return c.redirect(
      `/${owner}/${repo}/settings/protected-tags?success=${encodeURIComponent(
        ok ? "Pattern removed" : "Nothing removed"
      )}`
    );
  }
);

export default protectedTagsRoutes;

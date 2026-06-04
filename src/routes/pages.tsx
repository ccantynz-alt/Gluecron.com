/**
 * Block C3 — Pages / static hosting routes.
 *
 *   GET  /:owner/:repo/pages/*             — serve a static file from the
 *                                            latest successful gh-pages
 *                                            deployment
 *   GET  /:owner/:repo/settings/pages      — settings UI (owner-only)
 *   POST /:owner/:repo/settings/pages      — upsert settings
 *   POST /:owner/:repo/settings/pages/redeploy — manual redeploy trigger
 *
 * The serving endpoint reads blobs directly out of the bare git repo at the
 * commit sha of the most recent pages_deployments row for that repo. There is
 * no on-disk export — the git store IS the CDN.
 *
 * 2026 polish: settings UI uses a scoped `.pages-*` class system mirroring
 * `admin-ops.tsx` — eyebrow + display headline, polished settings card with
 * gradient hairline, deployment table with tabular-nums + status pills, and
 * an orb-lit dashed empty state for "no deployments yet".
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  pagesDeployments,
  pagesSettings,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getBlob, getRawBlob, resolveRef } from "../git/repository";
import { audit } from "../lib/notify";
import { getUnreadCount } from "../lib/unread";
import { config } from "../lib/config";
import {
  contentTypeFor,
  onPagesPush,
  resolvePagesPath,
} from "../lib/pages";

const pagesRoute = new Hono<AuthEnv>();
pagesRoute.use("*", softAuth);

interface LoadedRepo {
  id: string;
  name: string;
  ownerId: string;
  ownerUsername: string;
}

async function loadRepo(
  owner: string,
  repo: string
): Promise<LoadedRepo | null> {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        ownerUsername: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

async function getEffectiveSettings(repositoryId: string) {
  try {
    const [row] = await db
      .select()
      .from(pagesSettings)
      .where(eq(pagesSettings.repositoryId, repositoryId))
      .limit(1);
    if (row) return row;
  } catch {
    /* fall through to defaults */
  }
  // Synthesise defaults when the row doesn't exist.
  return {
    repositoryId,
    enabled: true,
    sourceBranch: "gh-pages",
    sourceDir: "/",
    customDomain: null as string | null,
    updatedAt: new Date(),
  };
}

// ─── Scoped CSS (.pages-*) ──────────────────────────────────────────────────
const pagesStyles = `
  .pages-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .pages-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .pages-head-text { flex: 1; min-width: 280px; }
  .pages-eyebrow {
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
  .pages-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .pages-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .pages-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .pages-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 640px;
  }

  /* Banners */
  .pages-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .pages-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .pages-banner.is-info {
    border-color: rgba(54,197,214,0.40);
    background: rgba(54,197,214,0.08);
    color: #a5f3fc;
  }
  .pages-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .pages-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* Section cards */
  .pages-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: var(--space-5);
    position: relative;
  }
  .pages-section::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .pages-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .pages-section-head-text { flex: 1; min-width: 240px; }
  .pages-section-title {
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
  .pages-section-title-icon {
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
  .pages-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .pages-section-body { padding: var(--space-4) var(--space-5); }

  /* Site URL card */
  .pages-url-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
    padding: 14px 16px;
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .pages-url-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin: 0 0 4px;
    font-weight: 600;
  }
  .pages-url-value {
    font-family: var(--font-mono);
    font-size: 13px;
    word-break: break-all;
  }
  .pages-url-value a {
    color: #c4b5fd;
    text-decoration: none;
  }
  .pages-url-value a:hover { color: #a48bff; text-decoration: underline; }

  /* Fields */
  .pages-field { margin-bottom: 16px; }
  .pages-field-label {
    display: block;
    font-size: 11.5px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .pages-input {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 12px;
    font: inherit;
    font-size: 13.5px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .pages-input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .pages-help {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    line-height: 1.45;
  }
  .pages-check { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; cursor: pointer; }

  /* Buttons */
  .pages-btn {
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
    line-height: 1;
    white-space: nowrap;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .pages-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .pages-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .pages-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .pages-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* Deploy list */
  .pages-deploys {
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .pages-deploy-row {
    display: grid;
    grid-template-columns: 1.4fr 1fr 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
  .pages-deploy-row:last-child { border-bottom: 0; }
  .pages-deploy-row.is-head {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    font-weight: 600;
    background: rgba(255,255,255,0.02);
  }
  .pages-deploy-row code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 6px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .pages-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: capitalize;
    justify-self: end;
  }
  .pages-status .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .pages-status.is-success {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .pages-status.is-failed {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .pages-status.is-pending {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }

  /* Empty */
  .pages-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 48px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .pages-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .pages-empty-inner { position: relative; z-index: 1; }
  .pages-empty-icon {
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
    margin-bottom: 14px;
  }
  .pages-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .pages-empty-sub {
    margin: 0 auto;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 420px;
    line-height: 1.5;
  }
`;

function IconGlobe() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
function IconRocket() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function statusPillClass(s: string): string {
  if (s === "success") return "pages-status is-success";
  if (s === "failed" || s === "error") return "pages-status is-failed";
  return "pages-status is-pending";
}

function shortDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 16).replace("T", " ");
}

// ---------------------------------------------------------------------------
// Serve: GET /:owner/:repo/pages/*
// ---------------------------------------------------------------------------

pagesRoute.get("/:owner/:repo/pages/*", async (c) => {
  const { owner, repo } = c.req.param();

  // Hono gives us the full path via c.req.path; extract whatever sits after
  // the "/pages/" segment. This is the only path component we treat as the
  // user-facing URL.
  const full = c.req.path;
  const marker = `/${owner}/${repo}/pages/`;
  const idx = full.indexOf(marker);
  const urlRest = idx >= 0 ? full.slice(idx + marker.length) : "";

  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) {
    return c.text("No Pages site published for this repository.", 404);
  }

  const settings = await getEffectiveSettings(repoRow.id);
  if (!settings.enabled) {
    return c.text("No Pages site published for this repository.", 404);
  }

  let deployment:
    | { commitSha: string; createdAt: Date; status: string }
    | null = null;
  try {
    const [row] = await db
      .select({
        commitSha: pagesDeployments.commitSha,
        createdAt: pagesDeployments.createdAt,
        status: pagesDeployments.status,
      })
      .from(pagesDeployments)
      .where(
        and(
          eq(pagesDeployments.repositoryId, repoRow.id),
          eq(pagesDeployments.status, "success")
        )
      )
      .orderBy(desc(pagesDeployments.createdAt))
      .limit(1);
    deployment = row || null;
  } catch {
    return c.text("Service unavailable", 503);
  }

  if (!deployment) {
    return c.text(
      "No Pages site published for this repository. Push to the configured source branch to publish.",
      404
    );
  }

  const candidates = resolvePagesPath(urlRest, settings.sourceDir);

  for (const candidate of candidates) {
    // Try as text first — getBlob fills in isBinary for us.
    const blob = await getBlob(owner, repo, deployment.commitSha, candidate);
    if (!blob) continue;

    const headers: Record<string, string> = {
      "Content-Type": contentTypeFor(candidate),
      "Cache-Control": "public, max-age=60",
      "X-Gluecron-Pages-Sha": deployment.commitSha.slice(0, 7),
    };

    if (blob.isBinary) {
      // getBlob blanks the content for binary — re-read the raw bytes.
      const raw = await getRawBlob(
        owner,
        repo,
        deployment.commitSha,
        candidate
      );
      if (!raw) continue;
      return new Response(raw as BodyInit, { status: 200, headers });
    }

    return new Response(blob.content, { status: 200, headers });
  }

  return c.text("Not found in Pages site.", 404);
});

// ---------------------------------------------------------------------------
// Settings UI: GET /:owner/:repo/settings/pages
// ---------------------------------------------------------------------------

pagesRoute.get(
  "/:owner/:repo/settings/pages",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const success = c.req.query("success");
    const error = c.req.query("error");
    const info = c.req.query("info");

    const repoRow = await loadRepo(ownerName, repoName);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.html(
        <Layout title="Unauthorized" user={user}>
          <div class="pages-wrap">
            <div class="pages-empty">
              <div class="pages-empty-orb" aria-hidden="true" />
              <div class="pages-empty-inner">
                <h2 class="pages-empty-title">Unauthorized</h2>
                <p class="pages-empty-sub">Only the repository owner can configure Pages.</p>
              </div>
            </div>
          </div>
          <style dangerouslySetInnerHTML={{ __html: pagesStyles }} />
        </Layout>,
        403
      );
    }

    const settings = await getEffectiveSettings(repoRow.id);

    let recent: Array<{
      id: string;
      ref: string;
      commitSha: string;
      status: string;
      createdAt: Date;
    }> = [];
    try {
      recent = await db
        .select({
          id: pagesDeployments.id,
          ref: pagesDeployments.ref,
          commitSha: pagesDeployments.commitSha,
          status: pagesDeployments.status,
          createdAt: pagesDeployments.createdAt,
        })
        .from(pagesDeployments)
        .where(eq(pagesDeployments.repositoryId, repoRow.id))
        .orderBy(desc(pagesDeployments.createdAt))
        .limit(10);
    } catch {
      /* fall through; render with empty list */
    }

    const unread = await getUnreadCount(user.id);
    const siteUrl = `${config.appBaseUrl}/${ownerName}/${repoName}/pages/`;

    return c.html(
      <Layout
        title={`Pages — ${ownerName}/${repoName}`}
        user={user}
        notificationCount={unread}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="code" />
        <div class="pages-wrap">
          <header class="pages-head">
            <div class="pages-head-text">
              <div class="pages-eyebrow">
                <span class="pages-eyebrow-dot" aria-hidden="true" />
                Repository · Pages
              </div>
              <h1 class="pages-title">
                <span class="pages-title-grad">Static hosting.</span>
              </h1>
              <p class="pages-sub">
                Publish a static site from {ownerName}/{repoName}. Every push
                to the source branch becomes a fresh deployment served straight
                from the git object store.
              </p>
            </div>
          </header>

          {success && (
            <div class="pages-banner is-ok" role="status">
              <span class="pages-banner-dot" aria-hidden="true" />
              {decodeURIComponent(success)}
            </div>
          )}
          {info && (
            <div class="pages-banner is-info" role="status">
              <span class="pages-banner-dot" aria-hidden="true" />
              {decodeURIComponent(info)}
            </div>
          )}
          {error && (
            <div class="pages-banner is-error" role="alert">
              <span class="pages-banner-dot" aria-hidden="true" />
              {decodeURIComponent(error)}
            </div>
          )}

          {/* Site URL */}
          <section class="pages-section">
            <header class="pages-section-head">
              <div class="pages-section-head-text">
                <h2 class="pages-section-title">
                  <span class="pages-section-title-icon" aria-hidden="true">
                    <IconGlobe />
                  </span>
                  Deployed URL
                </h2>
                <p class="pages-section-sub">
                  The public address of your site. Configure a custom domain
                  below to override this default.
                </p>
              </div>
            </header>
            <div class="pages-section-body">
              <div class="pages-url-card">
                <div>
                  <p class="pages-url-label">Site URL</p>
                  <div class="pages-url-value">
                    <a href={siteUrl}>{siteUrl}</a>
                  </div>
                </div>
                {settings.customDomain && (
                  <div>
                    <p class="pages-url-label">Custom domain</p>
                    <div class="pages-url-value">
                      <a href={`https://${settings.customDomain}/`}>
                        https://{settings.customDomain}/
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Settings form */}
          <section class="pages-section">
            <header class="pages-section-head">
              <div class="pages-section-head-text">
                <h2 class="pages-section-title">
                  <span class="pages-section-title-icon" aria-hidden="true">
                    <IconSettings />
                  </span>
                  Settings
                </h2>
                <p class="pages-section-sub">
                  Choose which branch and folder to publish from, and optionally
                  point a custom domain at this site.
                </p>
              </div>
            </header>
            <div class="pages-section-body">
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/pages`}
              >
                <div class="pages-field">
                  <label class="pages-check">
                    <input
                      type="checkbox"
                      name="enabled"
                      value="1"
                      checked={settings.enabled}
                      aria-label="Enable Pages"
                    />
                    Enable Pages
                  </label>
                </div>
                <div class="pages-field">
                  <label class="pages-field-label" for="source_branch">
                    Source branch
                  </label>
                  <input
                    class="pages-input"
                    type="text"
                    id="source_branch"
                    name="source_branch"
                    value={settings.sourceBranch}
                    placeholder="gh-pages"
                  />
                </div>
                <div class="pages-field">
                  <label class="pages-field-label" for="source_dir">
                    Source directory
                  </label>
                  <input
                    class="pages-input"
                    type="text"
                    id="source_dir"
                    name="source_dir"
                    value={settings.sourceDir}
                    placeholder="/"
                  />
                  <div class="pages-help">
                    Use <code>/</code> to serve from the repo root, or e.g.{" "}
                    <code>/docs</code>.
                  </div>
                </div>
                <div class="pages-field">
                  <label class="pages-field-label" for="custom_domain">
                    Custom domain (optional)
                  </label>
                  <input
                    class="pages-input"
                    type="text"
                    id="custom_domain"
                    name="custom_domain"
                    value={settings.customDomain || ""}
                    placeholder="example.com"
                  />
                  <div class="pages-help">
                    Point a CNAME at this repo's pages host to terminate at your
                    own domain.
                  </div>
                </div>
                <button type="submit" class="pages-btn pages-btn-primary">
                  Save settings
                </button>
              </form>
            </div>
          </section>

          {/* Deployments */}
          <section class="pages-section">
            <header class="pages-section-head">
              <div class="pages-section-head-text">
                <h2 class="pages-section-title">
                  <span class="pages-section-title-icon" aria-hidden="true">
                    <IconRocket />
                  </span>
                  Recent deployments
                  <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);font-weight:500;font-variant-numeric:tabular-nums">
                    {" "}({recent.length})
                  </span>
                </h2>
                <p class="pages-section-sub">
                  Latest 10 build attempts on this site. Trigger a manual
                  redeploy from <code>HEAD</code> of the source branch any time.
                </p>
              </div>
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/pages/redeploy`}
              >
                <button type="submit" class="pages-btn pages-btn-ghost">
                  Redeploy from HEAD
                </button>
              </form>
            </header>
            <div class="pages-section-body">
              {recent.length === 0 ? (
                <div class="pages-empty">
                  <div class="pages-empty-orb" aria-hidden="true" />
                  <div class="pages-empty-inner">
                    <div class="pages-empty-icon" aria-hidden="true">
                      <IconRocket />
                    </div>
                    <h3 class="pages-empty-title">Ship your first deploy</h3>
                    <p class="pages-empty-sub">
                      No deployments yet — push to{" "}
                      <code>{settings.sourceBranch}</code> or hit "Redeploy from
                      HEAD" to publish.
                    </p>
                  </div>
                </div>
              ) : (
                <div class="pages-deploys">
                  <div class="pages-deploy-row is-head">
                    <div>When</div>
                    <div>Ref</div>
                    <div>Commit</div>
                    <div style="text-align:right">Status</div>
                  </div>
                  {recent.map((d) => (
                    <div class="pages-deploy-row">
                      <div>{shortDate(d.createdAt)}</div>
                      <div>
                        <code>{d.ref}</code>
                      </div>
                      <div>
                        <code>{d.commitSha.slice(0, 7)}</code>
                      </div>
                      <span class={statusPillClass(d.status)}>
                        <span class="dot" aria-hidden="true" />
                        {d.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: pagesStyles }} />
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// Save settings: POST /:owner/:repo/settings/pages
// ---------------------------------------------------------------------------

pagesRoute.post(
  "/:owner/:repo/settings/pages",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();

    const repoRow = await loadRepo(ownerName, repoName);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const enabled = body.enabled === "1" || body.enabled === "on";
    const sourceBranch =
      String(body.source_branch || "gh-pages").trim() || "gh-pages";
    let sourceDir = String(body.source_dir || "/").trim() || "/";
    if (!sourceDir.startsWith("/")) sourceDir = `/${sourceDir}`;
    const customDomainRaw = String(body.custom_domain || "").trim();
    const customDomain = customDomainRaw === "" ? null : customDomainRaw;

    try {
      const [existing] = await db
        .select({ repositoryId: pagesSettings.repositoryId })
        .from(pagesSettings)
        .where(eq(pagesSettings.repositoryId, repoRow.id))
        .limit(1);
      if (existing) {
        await db
          .update(pagesSettings)
          .set({
            enabled,
            sourceBranch,
            sourceDir,
            customDomain,
            updatedAt: new Date(),
          })
          .where(eq(pagesSettings.repositoryId, repoRow.id));
      } else {
        await db.insert(pagesSettings).values({
          repositoryId: repoRow.id,
          enabled,
          sourceBranch,
          sourceDir,
          customDomain,
        });
      }
    } catch (err) {
      console.error("[pages] save settings:", err);
      return c.redirect(
        `/${ownerName}/${repoName}/settings/pages?error=${encodeURIComponent("Could not save settings")}`
      );
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "pages.settings.update",
      metadata: { enabled, sourceBranch, sourceDir, customDomain },
    });

    return c.redirect(
      `/${ownerName}/${repoName}/settings/pages?success=${encodeURIComponent("Pages settings saved")}`
    );
  }
);

// ---------------------------------------------------------------------------
// Manual redeploy: POST /:owner/:repo/settings/pages/redeploy
// ---------------------------------------------------------------------------

pagesRoute.post(
  "/:owner/:repo/settings/pages/redeploy",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;

    const repoRow = await loadRepo(ownerName, repoName);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const settings = await getEffectiveSettings(repoRow.id);
    const branch = settings.sourceBranch || "gh-pages";
    const ref = `refs/heads/${branch}`;

    // Try to resolve the current head of the source branch. If the branch
    // doesn't exist yet, tell the owner to push something to it instead of
    // recording a bogus deployment row.
    const sha = await resolveRef(ownerName, repoName, ref);
    if (!sha) {
      await audit({
        userId: user.id,
        repositoryId: repoRow.id,
        action: "pages.redeploy",
        metadata: { ref, result: "no-branch" },
      });
      return c.redirect(
        `/${ownerName}/${repoName}/settings/pages?info=${encodeURIComponent(`Branch ${branch} has no commits yet — push to it to deploy.`)}`
      );
    }

    await onPagesPush({
      ownerLogin: ownerName,
      repoName,
      repositoryId: repoRow.id,
      ref,
      newSha: sha,
      triggeredByUserId: user.id,
    });

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "pages.redeploy",
      metadata: { ref, sha },
    });

    return c.redirect(
      `/${ownerName}/${repoName}/settings/pages?success=${encodeURIComponent("Redeploy recorded")}`
    );
  }
);

export default pagesRoute;

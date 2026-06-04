/**
 * Block I9 — Repository mirroring.
 *
 *   GET  /:owner/:repo/settings/mirror             — config form + recent runs
 *   POST /:owner/:repo/settings/mirror             — save upstream URL + interval
 *   POST /:owner/:repo/settings/mirror/delete      — remove mirror config
 *   POST /:owner/:repo/settings/mirror/sync        — run one sync now (owner-only)
 *   POST /admin/mirrors/sync-all                   — site admin, run all due mirrors
 *
 * 2026 polish: scoped `.mirror-*` class system mirrors the gradient hero +
 * card patterns from admin-integrations.tsx and admin-ops.tsx. The hero
 * lives inside the page (below RepoHeader); the recent-run list is
 * card-per-row with status pill, tabular-nums timing, mono SHA/URL. All
 * form actions, query params, and POST handlers preserved verbatim.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { formatRelative } from "../views/ui";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";
import {
  deleteMirror,
  getMirrorForRepo,
  listRecentRuns,
  runMirrorSync,
  safeUrlForLog,
  syncAllDue,
  upsertMirror,
  validateUpstreamUrl,
} from "../lib/mirrors";

const mirrors = new Hono<AuthEnv>();
mirrors.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.mirror-*` so the surface can't bleed
 * into RepoHeader / nav above. Tokens reused from the layout
 * (--bg-elevated, --border, --text-strong, --space-*, --font-*).
 * ───────────────────────────────────────────────────────────────────── */
const mirrorStyles = `
  .mirror-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Hero ─── */
  .mirror-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .mirror-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .mirror-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .mirror-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .mirror-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .mirror-eyebrow {
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
  .mirror-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .mirror-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .mirror-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .mirror-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .mirror-sub code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .mirror-hero-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 18px;
    font-size: 13.5px;
    font-weight: 600;
    border-radius: 10px;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    white-space: nowrap;
    text-decoration: none;
    color: #ffffff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .mirror-hero-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }

  /* ─── Banners ─── */
  .mirror-banner {
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
  .mirror-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .mirror-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .mirror-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Section cards ─── */
  .mirror-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .mirror-section::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.45;
    pointer-events: none;
  }
  .mirror-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .mirror-section-title {
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
  .mirror-section-title-icon {
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
  .mirror-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .mirror-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Form ─── */
  .mirror-field { margin-bottom: var(--space-4); }
  .mirror-field:last-child { margin-bottom: 0; }
  .mirror-field-label {
    display: block;
    font-size: 11.5px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .mirror-input {
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
    font-family: var(--font-mono);
  }
  .mirror-input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .mirror-input.is-num { max-width: 180px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .mirror-checkbox-row {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    padding: 8px 12px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
  }
  .mirror-checkbox-row input { accent-color: #8c6dff; }

  /* ─── Buttons ─── */
  .mirror-btn {
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
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .mirror-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .mirror-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .mirror-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .mirror-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .mirror-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
  }
  .mirror-btn-danger:hover {
    border-style: dashed;
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
    text-decoration: none;
  }
  .mirror-action-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .mirror-action-row form { margin: 0; }

  /* ─── Status pills ─── */
  .mirror-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .mirror-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .mirror-pill.is-ok {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .mirror-pill.is-error {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .mirror-pill.is-pending {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .mirror-pill.is-neutral {
    background: rgba(148,163,184,0.16);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }

  /* ─── Run row cards ─── */
  .mirror-run-list { display: flex; flex-direction: column; gap: 8px; }
  .mirror-run-card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .mirror-run-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .mirror-run-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .mirror-run-meta .sep { opacity: 0.45; }
  .mirror-run-msg {
    font-size: 12.5px;
    color: var(--text-muted);
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  /* ─── Last-run summary ─── */
  .mirror-last {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    flex-wrap: wrap;
  }
  .mirror-last-left { flex: 1; min-width: 220px; }
  .mirror-last-stamp {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    margin-top: 4px;
  }
  .mirror-last-error {
    margin-top: 10px;
    padding: 10px 12px;
    background: rgba(248,113,113,0.06);
    border: 1px solid rgba(248,113,113,0.32);
    border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #fecaca;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
  }
  .mirror-upstream-foot {
    margin-top: var(--space-3);
    padding: 10px 12px;
    border-radius: 10px;
    background: rgba(255,255,255,0.02);
    border: 1px dashed var(--border);
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .mirror-upstream-foot code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }

  /* ─── Empty state ─── */
  .mirror-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 48px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .mirror-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .mirror-empty-inner { position: relative; z-index: 1; }
  .mirror-empty-icon {
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
  .mirror-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .mirror-empty-sub {
    margin: 0 auto 0;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 460px;
    line-height: 1.5;
  }

  .mirror-403 {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .mirror-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .mirror-403 p { color: var(--text-muted); margin: 0; font-size: 14px; }
`;

function IconMirror() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function renderForbidden(user: any) {
  return (
    <Layout title="Forbidden" user={user}>
      <div class="mirror-wrap">
        <div class="mirror-403">
          <h2>403 — Forbidden</h2>
          <p>Only the repository owner can configure mirroring.</p>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: mirrorStyles }} />
    </Layout>
  );
}

async function ownerGate(c: any): Promise<
  | Response
  | {
      user: any;
      ownerName: string;
      repoName: string;
      repo: typeof repositories.$inferSelect;
    }
> {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner || owner.id !== user.id) {
    return c.html(renderForbidden(user), 403);
  }
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return c.notFound();
  return { user, ownerName, repoName, repo };
}

function statusPill(status: string | null | undefined) {
  const s = (status || "").toLowerCase();
  if (s === "ok" || s === "success") {
    return (
      <span class="mirror-pill is-ok">
        <span class="dot" aria-hidden="true" />
        Success
      </span>
    );
  }
  if (s === "error" || s === "failed") {
    return (
      <span class="mirror-pill is-error">
        <span class="dot" aria-hidden="true" />
        Error
      </span>
    );
  }
  if (s === "pending" || s === "running") {
    return (
      <span class="mirror-pill is-pending">
        <span class="dot" aria-hidden="true" />
        {s === "running" ? "Running" : "Pending"}
      </span>
    );
  }
  return (
    <span class="mirror-pill is-neutral">
      <span class="dot" aria-hidden="true" />
      {s || "Unknown"}
    </span>
  );
}

// ---------- Config page ----------

mirrors.get("/:owner/:repo/settings/mirror", requireAuth, async (c) => {
  const g = await ownerGate(c);
  if (g instanceof Response) return g;
  const { user, ownerName, repoName, repo } = g;

  const mirror = await getMirrorForRepo(repo.id);
  const runs = mirror ? await listRecentRuns(mirror.id, 20) : [];

  const success = c.req.query("success");
  const error = c.req.query("error");

  return c.html(
    <Layout title={`Mirror — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div class="mirror-wrap">
        <section class="mirror-hero">
          <div class="mirror-hero-orb" aria-hidden="true" />
          <div class="mirror-hero-inner">
            <div class="mirror-hero-text">
              <div class="mirror-eyebrow">
                <span class="mirror-eyebrow-dot" aria-hidden="true" />
                Repository · Mirror
              </div>
              <h1 class="mirror-title">
                <span class="mirror-title-grad">Track an upstream.</span>
              </h1>
              <p class="mirror-sub">
                Periodically <code>git fetch --prune</code> from an upstream URL.
                Only <code>https://</code>, <code>http://</code>, and{" "}
                <code>git://</code> are accepted — SSH and local paths are not.
              </p>
            </div>
            {mirror && (
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/mirror/sync`}
              >
                <button type="submit" class="mirror-hero-cta">
                  <IconMirror />
                  Sync now
                </button>
              </form>
            )}
          </div>
        </section>

        {success && (
          <div class="mirror-banner is-ok" role="status">
            <span class="mirror-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="mirror-banner is-error" role="alert">
            <span class="mirror-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        <section class="mirror-section">
          <header class="mirror-section-head">
            <div>
              <h2 class="mirror-section-title">
                <span class="mirror-section-title-icon" aria-hidden="true">
                  <IconMirror />
                </span>
                Mirror configuration
              </h2>
              <p class="mirror-section-sub">
                Set the upstream URL and a sync cadence between 5 minutes and
                30 days. Disable to keep the config but pause auto-sync.
              </p>
            </div>
          </header>
          <div class="mirror-section-body">
            <form
              method="post"
              action={`/${ownerName}/${repoName}/settings/mirror`}
            >
              <div class="mirror-field">
                <label class="mirror-field-label" for="upstream_url">
                  Upstream URL
                </label>
                <input
                  type="text"
                  id="upstream_url"
                  name="upstream_url"
                  value={mirror?.upstreamUrl || ""}
                  placeholder="https://github.com/torvalds/linux.git"
                  required
                  class="mirror-input"
                  autocomplete="off"
                  spellcheck={false}
                />
              </div>
              <div class="mirror-field">
                <label class="mirror-field-label" for="interval_minutes">
                  Sync interval (minutes)
                </label>
                <input
                  type="number"
                  id="interval_minutes"
                  name="interval_minutes"
                  value={mirror?.intervalMinutes ?? 1440}
                  min="5"
                  max="43200"
                  class="mirror-input is-num"
                />
              </div>
              <div class="mirror-field">
                <label class="mirror-checkbox-row">
                  <input
                    type="checkbox"
                    name="is_enabled"
                    value="1"
                    checked={mirror ? mirror.isEnabled : true}
                    aria-label="Enabled"
                  />
                  <span>Enabled</span>
                </label>
              </div>
              <div class="mirror-action-row">
                <button type="submit" class="mirror-btn mirror-btn-primary">
                  {mirror ? "Update mirror" : "Enable mirror"}
                </button>
                {mirror && (
                  <form
                    method="post"
                    action={`/${ownerName}/${repoName}/settings/mirror/delete`}
                    onsubmit="return confirm('Remove mirror configuration?')"
                  >
                    <button type="submit" class="mirror-btn mirror-btn-danger">
                      Remove mirror
                    </button>
                  </form>
                )}
              </div>
            </form>
          </div>
        </section>

        {mirror && (
          <section class="mirror-section">
            <header class="mirror-section-head">
              <div>
                <h2 class="mirror-section-title">
                  <span class="mirror-section-title-icon" aria-hidden="true">
                    <IconClock />
                  </span>
                  Last run
                </h2>
                <p class="mirror-section-sub">
                  Most recent fetch outcome. Errors include the raw stderr.
                </p>
              </div>
            </header>
            <div class="mirror-section-body">
              {mirror.lastSyncedAt ? (
                <div class="mirror-last">
                  <div class="mirror-last-left">
                    {statusPill(mirror.lastStatus || "ok")}
                    <div class="mirror-last-stamp">
                      {formatRelative(mirror.lastSyncedAt as unknown as string)}
                    </div>
                    {mirror.lastError && (
                      <pre class="mirror-last-error">{mirror.lastError}</pre>
                    )}
                  </div>
                </div>
              ) : (
                <div style="color:var(--text-muted);font-size:13.5px">
                  Never synced. Hit <em>Sync now</em> above to run the first fetch.
                </div>
              )}
            </div>
          </section>
        )}

        {mirror && (
          <section class="mirror-section">
            <header class="mirror-section-head">
              <div>
                <h2 class="mirror-section-title">
                  <span class="mirror-section-title-icon" aria-hidden="true">
                    <IconClock />
                  </span>
                  Recent runs
                  <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);font-weight:500;font-variant-numeric:tabular-nums">
                    {" "}({runs.length})
                  </span>
                </h2>
                <p class="mirror-section-sub">
                  Latest 20 fetches, newest first.
                </p>
              </div>
            </header>
            <div class="mirror-section-body">
              {runs.length === 0 ? (
                <div class="mirror-empty">
                  <div class="mirror-empty-orb" aria-hidden="true" />
                  <div class="mirror-empty-inner">
                    <div class="mirror-empty-icon" aria-hidden="true">
                      <IconClock />
                    </div>
                    <h3 class="mirror-empty-title">No runs yet</h3>
                    <p class="mirror-empty-sub">
                      Once a sync fires (manually or on schedule) it will land
                      here with its status and timing.
                    </p>
                  </div>
                </div>
              ) : (
                <div class="mirror-run-list">
                  {runs.map((r) => (
                    <div class="mirror-run-card">
                      {statusPill(r.status)}
                      <div class="mirror-run-meta">
                        <span>{formatRelative(r.startedAt as unknown as string)}</span>
                      </div>
                      {r.message && (
                        <span class="mirror-run-msg" title={r.message}>
                          {r.message.split("\n")[0]}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div class="mirror-upstream-foot">
                Upstream (logged, credentials redacted):{" "}
                <code>{safeUrlForLog(mirror.upstreamUrl)}</code>
              </div>
            </div>
          </section>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: mirrorStyles }} />
    </Layout>
  );
});

// ---------- Save config ----------

mirrors.post("/:owner/:repo/settings/mirror", requireAuth, async (c) => {
  const g = await ownerGate(c);
  if (g instanceof Response) return g;
  const { user, ownerName, repoName, repo } = g;
  const body = await c.req.parseBody();
  const upstreamUrl = String(body.upstream_url || "").trim();
  const intervalRaw = Number(body.interval_minutes || 1440);
  const interval = Math.max(5, Math.min(43200, Math.floor(intervalRaw || 1440)));
  const isEnabled = String(body.is_enabled || "") === "1";

  const v = validateUpstreamUrl(upstreamUrl);
  if (!v.ok) {
    return c.redirect(
      `/${ownerName}/${repoName}/settings/mirror?error=${encodeURIComponent(
        v.error || "Invalid URL"
      )}`
    );
  }

  const result = await upsertMirror({
    repositoryId: repo.id,
    upstreamUrl,
    intervalMinutes: interval,
    isEnabled,
  });
  if (!result.ok) {
    return c.redirect(
      `/${ownerName}/${repoName}/settings/mirror?error=${encodeURIComponent(
        result.error
      )}`
    );
  }

  await audit({
    userId: user.id,
    repositoryId: repo.id,
    action: "mirror.configure",
    metadata: {
      upstream: safeUrlForLog(upstreamUrl),
      intervalMinutes: interval,
      isEnabled,
    },
  });

  return c.redirect(
    `/${ownerName}/${repoName}/settings/mirror?success=${encodeURIComponent(
      "Mirror configuration saved."
    )}`
  );
});

// ---------- Delete ----------

mirrors.post("/:owner/:repo/settings/mirror/delete", requireAuth, async (c) => {
  const g = await ownerGate(c);
  if (g instanceof Response) return g;
  const { user, ownerName, repoName, repo } = g;

  await deleteMirror(repo.id);
  await audit({
    userId: user.id,
    repositoryId: repo.id,
    action: "mirror.delete",
  });

  return c.redirect(
    `/${ownerName}/${repoName}/settings/mirror?success=${encodeURIComponent(
      "Mirror removed."
    )}`
  );
});

// ---------- Sync now ----------

mirrors.post("/:owner/:repo/settings/mirror/sync", requireAuth, async (c) => {
  const g = await ownerGate(c);
  if (g instanceof Response) return g;
  const { user, ownerName, repoName, repo } = g;
  const mirror = await getMirrorForRepo(repo.id);
  if (!mirror) {
    return c.redirect(
      `/${ownerName}/${repoName}/settings/mirror?error=${encodeURIComponent(
        "No mirror configured"
      )}`
    );
  }

  const result = await runMirrorSync(mirror.id);
  await audit({
    userId: user.id,
    repositoryId: repo.id,
    action: "mirror.sync",
    metadata: { ok: result.ok, exitCode: result.exitCode },
  });
  const msg = result.ok
    ? "Mirror sync completed."
    : `Sync failed: ${result.message.split("\n")[0]}`;
  return c.redirect(
    `/${ownerName}/${repoName}/settings/mirror?${
      result.ok ? "success" : "error"
    }=${encodeURIComponent(msg)}`
  );
});

// ---------- Admin: sync all due ----------

mirrors.post("/admin/mirrors/sync-all", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="mirror-wrap">
          <div class="mirror-403">
            <h2>403 — Forbidden</h2>
            <p>Site admin only.</p>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: mirrorStyles }} />
      </Layout>,
      403
    );
  }
  const summary = await syncAllDue();
  await audit({
    userId: user.id,
    action: "admin.mirrors.sync-all",
    metadata: summary,
  });
  return c.redirect(
    `/admin?message=${encodeURIComponent(
      `Mirror sync: ${summary.total} due, ${summary.ok} ok, ${summary.failed} failed.`
    )}`
  );
});

export default mirrors;

/**
 * Block H — Marketplace UI + developer-side app management.
 *
 *   GET  /marketplace                       — public app directory (search)
 *   GET  /marketplace/:slug                 — app detail + install CTA
 *   POST /marketplace/:slug/install         — install to user (v1 only)
 *   POST /marketplace/installations/:id/uninstall
 *                                           — revoke access
 *   GET  /settings/apps                     — list installed apps
 *   GET  /developer/apps-new                — register a new app
 *   POST /developer/apps-new                — create app + bot
 *   GET  /developer/apps/:slug/manage       — event log + install count
 *   POST /developer/apps/:slug/tokens/new   — issue install token (for testing)
 *
 * 2026 polish — gradient hairline hero, orb, eyebrow, gradient verb,
 * featured app grid with logos, category filter pills, install CTA.
 * All CSS scoped under `.mkt-*`.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { appInstallations } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  KNOWN_PERMISSIONS,
  KNOWN_EVENTS,
  countInstalls,
  createApp,
  getAppBySlug,
  installApp,
  issueInstallToken,
  listEventsForApp,
  listInstallationsForApp,
  listInstallationsForTarget,
  listPublicApps,
  normalisePermissions,
  parsePermissions,
  uninstallApp,
} from "../lib/marketplace";
import { audit } from "../lib/notify";

const marketplace = new Hono<AuthEnv>();
marketplace.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.mkt-` so this surface can't bleed
 * into other pages. Mirrors the gradient hero + section card patterns
 * from admin-integrations.tsx, admin-ops.tsx, error-page.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .mkt-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-6, 32px) var(--space-4, 24px); }

  /* ─── Hero ─── */
  .mkt-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .mkt-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .mkt-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .mkt-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .mkt-hero-text { max-width: 680px; flex: 1; min-width: 240px; }
  .mkt-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 16px;
  }
  .mkt-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .mkt-title {
    font-family: var(--font-display);
    font-size: clamp(32px, 5vw, 48px);
    font-weight: 800;
    letter-spacing: -0.030em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .mkt-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .mkt-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 580px;
  }
  .mkt-hero-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    text-decoration: none;
    border: 1px solid transparent;
    box-shadow: 0 6px 16px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .mkt-hero-cta:hover {
    transform: translateY(-1px);
    color: #fff;
    text-decoration: none;
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60);
  }

  /* ─── Search + filter row ─── */
  .mkt-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .mkt-search {
    display: flex;
    gap: 8px;
    flex: 1;
    min-width: 240px;
  }
  .mkt-search input {
    flex: 1;
    padding: 9px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 14px;
    color: var(--text);
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .mkt-search input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .mkt-search button {
    padding: 9px 16px;
    border-radius: 10px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .mkt-search button:hover {
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.06);
  }

  /* ─── Category filter pills ─── */
  .mkt-pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .mkt-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    text-decoration: none;
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
  }
  .mkt-pill:hover {
    color: var(--text-strong);
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.06);
    text-decoration: none;
  }
  .mkt-pill.is-active {
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: #c5b3ff;
    border-color: rgba(140,109,255,0.45);
  }

  /* ─── App grid ─── */
  .mkt-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3);
  }
  .mkt-card {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    color: inherit;
    text-decoration: none;
    transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
  }
  .mkt-card:hover {
    border-color: rgba(140,109,255,0.45);
    transform: translateY(-2px);
    box-shadow: 0 10px 28px -10px rgba(140,109,255,0.30);
    text-decoration: none;
    color: inherit;
  }
  .mkt-card-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .mkt-logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px; height: 44px;
    border-radius: 11px;
    flex-shrink: 0;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 18px;
    color: #fff;
    letter-spacing: -0.02em;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 12px -6px rgba(0,0,0,0.45);
  }
  .mkt-card-name {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
    letter-spacing: -0.012em;
  }
  .mkt-card-bot {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 1px;
  }
  .mkt-card-desc {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    flex: 1;
  }
  .mkt-card-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .mkt-card-meta .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .mkt-card-meta .meta-item svg { color: var(--accent); opacity: 0.85; }
  .mkt-card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 4px;
  }
  .mkt-card-perm {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-family: var(--font-mono);
  }
  .mkt-install-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    text-decoration: none;
    box-shadow: 0 4px 12px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease;
  }
  .mkt-install-btn:hover {
    transform: translateY(-1px);
    color: #fff;
    text-decoration: none;
  }

  /* ─── Empty / zero state ─── */
  .mkt-empty {
    position: relative;
    padding: clamp(28px, 4vw, 44px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed rgba(140,109,255,0.40);
    border-radius: 16px;
    overflow: hidden;
  }
  .mkt-empty-orb {
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(60px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .mkt-empty-inner { position: relative; z-index: 1; }
  .mkt-empty-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.12));
    color: #c5b3ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
    margin-bottom: 14px;
  }
  .mkt-empty-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 8px;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .mkt-empty-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0 auto 18px;
    max-width: 480px;
    line-height: 1.55;
  }
  .mkt-empty-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
  }

  /* ─── Section card (shared) ─── */
  .mkt-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .mkt-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .mkt-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.014em;
  }
  .mkt-section-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .mkt-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Buttons ─── */
  .mkt-btn {
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
  }
  .mkt-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .mkt-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .mkt-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong, var(--border));
  }
  .mkt-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .mkt-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
    padding: 6px 12px;
    font-size: 12px;
  }
  .mkt-btn-danger:hover {
    border-style: dashed;
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
  }

  /* ─── Detail page ─── */
  .mkt-detail-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .mkt-detail-logo {
    width: 64px; height: 64px;
    border-radius: 14px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 26px;
    color: #fff;
    letter-spacing: -0.02em;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 6px 18px -6px rgba(0,0,0,0.45);
  }
  .mkt-detail-name {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 800;
    color: var(--text-strong);
    margin: 0;
    letter-spacing: -0.022em;
  }
  .mkt-detail-meta {
    margin-top: 4px;
    font-size: 12.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  /* ─── Perm list ─── */
  .mkt-perm-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .mkt-perm-list li code {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
  }

  /* ─── Install form labels ─── */
  .mkt-perm-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    font-size: 13px;
    color: var(--text);
    margin: var(--space-3) 0;
  }
  .mkt-perm-labels label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  /* ─── Developer form ─── */
  .mkt-form-group { margin-bottom: var(--space-3); }
  .mkt-form-group label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .mkt-form-group input[type="text"],
  .mkt-form-group input[type="url"],
  .mkt-form-group textarea,
  .mkt-form-group select {
    width: 100%;
    padding: 9px 12px;
    background: var(--bg-secondary, rgba(0,0,0,0.15));
    border: 1px solid var(--border);
    border-radius: 9px;
    font: inherit;
    font-size: 13.5px;
    color: var(--text);
    box-sizing: border-box;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .mkt-form-group input[type="text"]:focus,
  .mkt-form-group input[type="url"]:focus,
  .mkt-form-group textarea:focus {
    outline: none;
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .mkt-checkbox-grid {
    display: grid;
    gap: 6px 14px;
    font-size: 13px;
  }
  .mkt-checkbox-grid.cols-2 { grid-template-columns: repeat(2, 1fr); }
  .mkt-checkbox-grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 600px) {
    .mkt-checkbox-grid.cols-2,
    .mkt-checkbox-grid.cols-3 { grid-template-columns: 1fr; }
  }

  /* ─── Installs list (settings/apps + developer/manage) ─── */
  .mkt-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .mkt-list-item:last-child { border-bottom: none; }
  .mkt-list-item-main { flex: 1; min-width: 0; }
  .mkt-list-item-title {
    font-weight: 600;
    color: var(--text-strong);
    text-decoration: none;
  }
  .mkt-list-item-title:hover { color: var(--accent); }
  .mkt-list-item-meta {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Token-issued reveal ─── */
  .mkt-token-block {
    padding: 14px 16px;
    margin-top: 12px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    word-break: break-all;
  }
`;

/* Inline SVG icons. */
function IconDownload() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
function IconStar() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round" aria-hidden="true">
      <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2" />
    </svg>
  );
}
function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}
function IconGrid() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

/* Map a slug to a stable gradient so each app gets a unique-feeling logo.
 * The same input always renders the same gradient — keeps it consistent
 * across views and avoids the "rebuild → palette shuffled" effect. */
const LOGO_GRADIENTS = [
  "linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%)",
  "linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)",
  "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)",
  "linear-gradient(135deg, #10b981 0%, #14b8a6 100%)",
  "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
  "linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)",
  "linear-gradient(135deg, #84cc16 0%, #22c55e 100%)",
  "linear-gradient(135deg, #f97316 0%, #fb7185 100%)",
];

function gradientFor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const idx = ((h % LOGO_GRADIENTS.length) + LOGO_GRADIENTS.length) % LOGO_GRADIENTS.length;
  return LOGO_GRADIENTS[idx]!;
}

function appInitials(name: string): string {
  const parts = name.trim().split(/[\s\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ---------- Public directory ----------

marketplace.get("/marketplace", async (c) => {
  const user = c.get("user");
  const q = c.req.query("q") || "";
  const list = await listPublicApps(q);
  return c.html(
    <Layout title="Marketplace — Gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="mkt-wrap">
        {/* ─── Hero ─── */}
        <section class="mkt-hero">
          <div class="mkt-hero-orb" aria-hidden="true" />
          <div class="mkt-hero-inner">
            <div class="mkt-hero-text">
              <div class="mkt-eyebrow">
                <span class="mkt-eyebrow-dot" aria-hidden="true" />
                Marketplace
              </div>
              <h1 class="mkt-title">
                <span class="mkt-title-grad">Extend.</span>
              </h1>
              <p class="mkt-sub">
                Apps, bots, and integrations that plug into your repos. Install
                in one click — every app runs with its own scoped bot identity.
              </p>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <a href="/marketplace/agents" class="mkt-hero-cta">
                Agents &rarr;
              </a>
              {user && (
                <a
                  href="/developer/apps-new"
                  class="mkt-hero-cta"
                  style="background:transparent;border:1px solid var(--border);color:var(--text);box-shadow:none"
                >
                  + Register app
                </a>
              )}
            </div>
          </div>
        </section>

        {/* ─── Search + category pills ─── */}
        <form method="get" action="/marketplace" class="mkt-toolbar">
          <div class="mkt-search">
            <input
              type="text"
              name="q"
              value={q}
              placeholder="Search apps by name, description, or permission"
              aria-label="Search apps"
            />
            <button type="submit">Search</button>
          </div>
        </form>

        <div class="mkt-pills" role="tablist" aria-label="Filter by category">
          <a href="/marketplace" class={"mkt-pill" + (!q ? " is-active" : "")}>
            All apps
          </a>
          <a href="/marketplace?q=ci" class={"mkt-pill" + (q === "ci" ? " is-active" : "")}>
            CI / CD
          </a>
          <a href="/marketplace?q=ai" class={"mkt-pill" + (q === "ai" ? " is-active" : "")}>
            AI
          </a>
          <a href="/marketplace?q=security" class={"mkt-pill" + (q === "security" ? " is-active" : "")}>
            Security
          </a>
          <a href="/marketplace?q=chat" class={"mkt-pill" + (q === "chat" ? " is-active" : "")}>
            Chat
          </a>
          <a href="/marketplace?q=monitoring" class={"mkt-pill" + (q === "monitoring" ? " is-active" : "")}>
            Monitoring
          </a>
        </div>

        {/* ─── App grid ─── */}
        {list.length === 0 ? (
          <div class="mkt-empty">
            <div class="mkt-empty-orb" aria-hidden="true" />
            <div class="mkt-empty-inner">
              <span class="mkt-empty-glyph" aria-hidden="true"><IconGrid /></span>
              <h2 class="mkt-empty-title">
                {q ? "No matching apps." : "No apps yet."}
              </h2>
              <p class="mkt-empty-sub">
                {q
                  ? <>Nothing matches <code style="font-family:var(--font-mono);background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:4px">{q}</code>. Try a different search or clear the filter.</>
                  : <>The marketplace is empty. Build the first app and list it for everyone.</>}
              </p>
              <div class="mkt-empty-actions">
                {q && <a href="/marketplace" class="mkt-btn mkt-btn-ghost">Clear search</a>}
                {user && <a href="/developer/apps-new" class="mkt-btn mkt-btn-primary">+ Register an app</a>}
                {!user && <a href="/login?next=/developer/apps-new" class="mkt-btn mkt-btn-primary">Sign in to register</a>}
              </div>
            </div>
          </div>
        ) : (
          <div class="mkt-grid">
            {list.map((a) => {
              const perms = parsePermissions(a.permissions).length;
              return (
                <a href={`/marketplace/${a.slug}`} class="mkt-card">
                  <div class="mkt-card-head">
                    <span class="mkt-logo" aria-hidden="true" style={`background:${gradientFor(a.slug)}`}>
                      {appInitials(a.name)}
                    </span>
                    <div style="min-width:0">
                      <h3 class="mkt-card-name">{a.name}</h3>
                      <div class="mkt-card-bot">{a.slug}[bot]</div>
                    </div>
                  </div>
                  <p class="mkt-card-desc">
                    {(a.description || "No description.").slice(0, 140)}
                  </p>
                  <div class="mkt-card-meta">
                    <span class="meta-item" title="Permissions requested">
                      <IconDownload />
                      {perms} perm{perms === 1 ? "" : "s"}
                    </span>
                    <span class="meta-item" title="Verified">
                      <IconStar />
                      Verified
                    </span>
                  </div>
                  <div class="mkt-card-foot">
                    <span class="mkt-card-perm">Public app</span>
                    <span class="mkt-install-btn">Install &rarr;</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
});

marketplace.get("/marketplace/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const app = await getAppBySlug(slug);
  if (!app || !app.isPublic) return c.notFound();
  const [installs, perms] = await Promise.all([
    countInstalls(app.id),
    Promise.resolve(parsePermissions(app.permissions)),
  ]);
  return c.html(
    <Layout title={`${app.name} — Marketplace`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="mkt-wrap">
        <section class="mkt-hero">
          <div class="mkt-hero-orb" aria-hidden="true" />
          <div class="mkt-hero-inner">
            <div class="mkt-hero-text" style="flex:1">
              <div class="mkt-detail-head">
                <span class="mkt-detail-logo" aria-hidden="true" style={`background:${gradientFor(app.slug)}`}>
                  {appInitials(app.name)}
                </span>
                <div style="min-width:0">
                  <h1 class="mkt-detail-name">{app.name}</h1>
                  <div class="mkt-detail-meta">
                    {app.slug}[bot] · {installs} install{installs === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
              <p class="mkt-sub">{app.description || "No description."}</p>
              {app.homepageUrl && (
                <p class="mkt-sub" style="font-size:13px;margin-top:8px">
                  Homepage: <a href={app.homepageUrl} style="color:var(--accent);text-decoration:none">{app.homepageUrl}</a>
                </p>
              )}
            </div>
            <a href="/marketplace" class="mkt-hero-cta" style="background:transparent;border-color:var(--border);color:var(--text-muted);box-shadow:none">
              <IconArrowLeft /> Back
            </a>
          </div>
        </section>

        <section class="mkt-section">
          <header class="mkt-section-head">
            <div>
              <h3 class="mkt-section-title">Permissions</h3>
              <p class="mkt-section-sub">
                Granted to <strong style="color:var(--text)">{app.name}</strong> on install.
                Revoke any time from <a href="/settings/apps" style="color:var(--accent);text-decoration:none">/settings/apps</a>.
              </p>
            </div>
          </header>
          <div class="mkt-section-body">
            {perms.length === 0 ? (
              <div class="mkt-empty" style="padding:20px;border-style:dashed">
                <div class="mkt-empty-inner">No permissions requested.</div>
              </div>
            ) : (
              <ul class="mkt-perm-list">
                {perms.map((p) => (
                  <li><code>{p}</code></li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {user ? (
          <section class="mkt-section">
            <header class="mkt-section-head">
              <div>
                <h3 class="mkt-section-title">Install on your account</h3>
                <p class="mkt-section-sub">
                  Installing grants {perms.length} permission{perms.length === 1 ? "" : "s"}{" "}
                  to <strong style="color:var(--text)">{app.name}</strong> on your personal account.
                </p>
              </div>
            </header>
            <div class="mkt-section-body">
              <form method="post" action={`/marketplace/${slug}/install`}>
                <div class="mkt-perm-labels">
                  {perms.map((p) => (
                    <label>
                      <input type="checkbox" name="permissions" value={p} checked />
                      <code style="font-family:var(--font-mono);font-size:12px">{p}</code>
                    </label>
                  ))}
                </div>
                <button type="submit" class="mkt-btn mkt-btn-primary">
                  Install {app.name}
                </button>
              </form>
            </div>
          </section>
        ) : (
          <div class="mkt-empty">
            <div class="mkt-empty-inner">
              <span class="mkt-empty-glyph" aria-hidden="true"><IconDownload /></span>
              <h2 class="mkt-empty-title">Sign in to install</h2>
              <p class="mkt-empty-sub">Apps are installed against your account so they can act on your repos.</p>
              <div class="mkt-empty-actions">
                <a href={`/login?next=/marketplace/${slug}`} class="mkt-btn mkt-btn-primary">Sign in</a>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
});

marketplace.post("/marketplace/:slug/install", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const app = await getAppBySlug(slug);
  if (!app) return c.notFound();
  const body = await c.req.parseBody({ all: true });
  const rawPerms = body.permissions;
  const perms = Array.isArray(rawPerms)
    ? rawPerms.map(String)
    : rawPerms
    ? [String(rawPerms)]
    : [];
  const inst = await installApp({
    appId: app.id,
    installedBy: user.id,
    targetType: "user",
    targetId: user.id,
    grantedPermissions: perms,
  });
  if (inst) {
    await audit({
      userId: user.id,
      action: "marketplace.install",
      targetType: "app",
      targetId: app.id,
      metadata: { grantedPermissions: normalisePermissions(perms) },
    });
  }
  return c.redirect("/settings/apps");
});

marketplace.post(
  "/marketplace/installations/:id/uninstall",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    // Only the installer can uninstall
    const [inst] = await db
      .select()
      .from(appInstallations)
      .where(eq(appInstallations.id, id))
      .limit(1);
    if (!inst || inst.installedBy !== user.id) {
      return c.text("forbidden", 403);
    }
    const ok = await uninstallApp(id);
    if (ok) {
      await audit({
        userId: user.id,
        action: "marketplace.uninstall",
        targetType: "app_installation",
        targetId: id,
      });
    }
    return c.redirect("/settings/apps");
  }
);

// ---------- Personal installs ----------

marketplace.get("/settings/apps", requireAuth, async (c) => {
  const user = c.get("user")!;
  const installs = await listInstallationsForTarget("user", user.id);
  return c.html(
    <Layout title="Installed apps — Gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="mkt-wrap">
        <section class="mkt-hero">
          <div class="mkt-hero-orb" aria-hidden="true" />
          <div class="mkt-hero-inner">
            <div class="mkt-hero-text">
              <div class="mkt-eyebrow">
                <span class="mkt-eyebrow-dot" aria-hidden="true" />
                Installed apps · <strong>@{user.username}</strong>
              </div>
              <h1 class="mkt-title">
                <span class="mkt-title-grad">Your apps.</span>
              </h1>
              <p class="mkt-sub">
                Every app you've installed, plus the permissions you granted. Uninstall any time.
              </p>
            </div>
            <a href="/marketplace" class="mkt-hero-cta">
              Browse marketplace
            </a>
          </div>
        </section>

        {installs.length === 0 ? (
          <div class="mkt-empty">
            <div class="mkt-empty-orb" aria-hidden="true" />
            <div class="mkt-empty-inner">
              <span class="mkt-empty-glyph" aria-hidden="true"><IconGrid /></span>
              <h2 class="mkt-empty-title">No apps installed.</h2>
              <p class="mkt-empty-sub">
                Browse the marketplace and install your first integration —
                CI bots, AI reviewers, notification bridges, and more.
              </p>
              <div class="mkt-empty-actions">
                <a href="/marketplace" class="mkt-btn mkt-btn-primary">Browse the marketplace</a>
              </div>
            </div>
          </div>
        ) : (
          <div class="mkt-section">
            {installs.map((i) => (
              <div class="mkt-list-item">
                <div class="mkt-list-item-main">
                  <a
                    href={i.app ? `/marketplace/${i.app.slug}` : "#"}
                    class="mkt-list-item-title"
                  >
                    {i.app?.name || "(unknown app)"}
                  </a>
                  <div class="mkt-list-item-meta">
                    {parsePermissions(i.grantedPermissions).length} permissions ·
                    installed{" "}
                    {i.createdAt
                      ? new Date(i.createdAt).toLocaleDateString()
                      : ""}
                  </div>
                </div>
                <form
                  method="post"
                  action={`/marketplace/installations/${i.id}/uninstall`}
                  onsubmit="return confirm('Uninstall this app?')"
                  style="margin:0"
                >
                  <button type="submit" class="mkt-btn mkt-btn-danger">
                    Uninstall
                  </button>
                </form>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
});

// ---------- Developer UX ----------

marketplace.get("/developer/apps-new", requireAuth, async (c) => {
  const user = c.get("user")!;
  return c.html(
    <Layout title="New app — Marketplace" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="mkt-wrap">
        <section class="mkt-hero">
          <div class="mkt-hero-orb" aria-hidden="true" />
          <div class="mkt-hero-inner">
            <div class="mkt-hero-text">
              <div class="mkt-eyebrow">
                <span class="mkt-eyebrow-dot" aria-hidden="true" />
                Developer · New app
              </div>
              <h1 class="mkt-title">
                <span class="mkt-title-grad">Build.</span>
              </h1>
              <p class="mkt-sub">
                Register a new app, declare the permissions it needs, and pick the events it listens for.
                Your app gets a scoped bot identity and a webhook secret on submit.
              </p>
            </div>
            <a href="/marketplace" class="mkt-hero-cta" style="background:transparent;border:1px solid var(--border);color:var(--text-muted);box-shadow:none">
              <IconArrowLeft /> Back
            </a>
          </div>
        </section>

        <form method="post" action="/developer/apps-new" class="mkt-section">
          <div class="mkt-section-body">
            <div class="mkt-form-group">
              <label>Name</label>
              <input type="text" name="name" required aria-label="App name" />
            </div>
            <div class="mkt-form-group">
              <label>Description</label>
              <textarea name="description" rows={3} />
            </div>
            <div class="mkt-form-group">
              <label>Homepage URL</label>
              <input type="url" name="homepageUrl" aria-label="Homepage URL" />
            </div>
            <div class="mkt-form-group">
              <label>Webhook URL (optional)</label>
              <input type="url" name="webhookUrl" aria-label="Webhook URL" />
            </div>
            <div class="mkt-form-group">
              <label>Permissions</label>
              <div class="mkt-checkbox-grid cols-2">
                {KNOWN_PERMISSIONS.map((p) => (
                  <label>
                    <input type="checkbox" name="permissions" value={p} /> {p}
                  </label>
                ))}
              </div>
            </div>
            <div class="mkt-form-group">
              <label>Events</label>
              <div class="mkt-checkbox-grid cols-3">
                {KNOWN_EVENTS.map((e) => (
                  <label>
                    <input type="checkbox" name="events" value={e} /> {e}
                  </label>
                ))}
              </div>
            </div>
            <div class="mkt-form-group">
              <label>
                <input type="checkbox" name="isPublic" value="1" checked /> List in public marketplace
              </label>
            </div>
            <button type="submit" class="mkt-btn mkt-btn-primary">
              Create app
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
});

marketplace.post("/developer/apps-new", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody({ all: true });
  const name = String(body.name || "").trim();
  if (!name) return c.redirect("/developer/apps-new");
  const rawPerms = body.permissions;
  const perms = Array.isArray(rawPerms)
    ? rawPerms.map(String)
    : rawPerms
    ? [String(rawPerms)]
    : [];
  const rawEvents = body.events;
  const events = Array.isArray(rawEvents)
    ? rawEvents.map(String)
    : rawEvents
    ? [String(rawEvents)]
    : [];
  const app = await createApp({
    name,
    description: String(body.description || ""),
    homepageUrl: String(body.homepageUrl || "") || undefined,
    webhookUrl: String(body.webhookUrl || "") || undefined,
    creatorId: user.id,
    permissions: perms,
    defaultEvents: events,
    isPublic: !!body.isPublic,
  });
  if (!app) return c.text("failed to create", 500);
  await audit({
    userId: user.id,
    action: "marketplace.app.create",
    targetType: "app",
    targetId: app.id,
  });
  return c.redirect(`/developer/apps/${app.slug}/manage`);
});

marketplace.get("/developer/apps/:slug/manage", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const app = await getAppBySlug(slug);
  if (!app) return c.notFound();
  if (app.creatorId !== user.id) return c.text("forbidden", 403);
  const [installs, events] = await Promise.all([
    listInstallationsForApp(app.id),
    listEventsForApp(app.id, 20),
  ]);
  return c.html(
    <Layout title={`Manage ${app.name}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="mkt-wrap">
        <section class="mkt-hero">
          <div class="mkt-hero-orb" aria-hidden="true" />
          <div class="mkt-hero-inner">
            <div class="mkt-hero-text">
              <div class="mkt-detail-head">
                <span class="mkt-detail-logo" aria-hidden="true" style={`background:${gradientFor(app.slug)}`}>
                  {appInitials(app.name)}
                </span>
                <div style="min-width:0">
                  <h1 class="mkt-detail-name">{app.name}</h1>
                  <div class="mkt-detail-meta">Developer · {installs.length} install{installs.length === 1 ? "" : "s"}</div>
                </div>
              </div>
            </div>
            <a href={`/marketplace/${app.slug}`} class="mkt-hero-cta" style="background:transparent;border:1px solid var(--border);color:var(--text-muted);box-shadow:none">
              Public page
            </a>
          </div>
        </section>

        <section class="mkt-section">
          <header class="mkt-section-head">
            <div>
              <h3 class="mkt-section-title">Bot identity</h3>
              <p class="mkt-section-sub">
                The bot account that authors comments, opens PRs, and signs webhook payloads on this app's behalf.
              </p>
            </div>
          </header>
          <div class="mkt-section-body">
            <div style="font-family:var(--font-mono);font-size:14px;color:var(--text-strong)">{app.slug}[bot]</div>
            {app.webhookSecret && (
              <div style="margin-top:10px;font-size:12.5px;color:var(--text-muted)">
                Webhook secret:{" "}
                <code style="font-family:var(--font-mono);background:rgba(255,255,255,0.04);padding:3px 8px;border-radius:6px;color:var(--text)">{app.webhookSecret}</code>
              </div>
            )}
          </div>
        </section>

        <section class="mkt-section">
          <header class="mkt-section-head">
            <div>
              <h3 class="mkt-section-title">Installations ({installs.length})</h3>
              <p class="mkt-section-sub">Every user or org that has granted this app access.</p>
            </div>
          </header>
          {installs.length === 0 ? (
            <div class="mkt-section-body">
              <div class="mkt-empty" style="padding:20px;border-style:dashed">
                <div class="mkt-empty-inner">No installs yet.</div>
              </div>
            </div>
          ) : (
            installs.map((i) => (
              <div class="mkt-list-item">
                <div class="mkt-list-item-main">
                  {i.targetType}: <code style="font-family:var(--font-mono);font-size:12px">{i.targetId}</code>
                </div>
                <div style="font-size:12px;color:var(--text-muted);font-variant-numeric:tabular-nums">
                  {parsePermissions(i.grantedPermissions).length} perms ·{" "}
                  {i.createdAt
                    ? new Date(i.createdAt).toLocaleDateString()
                    : ""}
                </div>
              </div>
            ))
          )}
        </section>

        <section class="mkt-section">
          <header class="mkt-section-head">
            <div>
              <h3 class="mkt-section-title">Recent events</h3>
              <p class="mkt-section-sub">Last 20 events delivered to this app.</p>
            </div>
          </header>
          {events.length === 0 ? (
            <div class="mkt-section-body">
              <div class="mkt-empty" style="padding:20px;border-style:dashed">
                <div class="mkt-empty-inner">No events yet.</div>
              </div>
            </div>
          ) : (
            events.map((e) => (
              <div class="mkt-list-item">
                <span style="font-family:var(--font-mono);font-size:13px;color:var(--text-strong)">{e.kind}</span>
                <span style="font-size:12px;color:var(--text-muted);font-variant-numeric:tabular-nums">
                  {e.createdAt
                    ? new Date(e.createdAt).toLocaleString()
                    : ""}
                </span>
              </div>
            ))
          )}
        </section>

        <section class="mkt-section">
          <header class="mkt-section-head">
            <div>
              <h3 class="mkt-section-title">Installation tokens</h3>
              <p class="mkt-section-sub">
                Issue a bearer token for an existing installation. Use this to test bot API calls. Tokens are shown once and expire after 1 hour.
              </p>
            </div>
          </header>
          <div class="mkt-section-body">
            <form
              method="post"
              action={`/developer/apps/${app.slug}/tokens/new`}
              style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"
            >
              <select name="installationId" class="mkt-form-group" style="margin:0;padding:9px 12px;background:var(--bg-secondary,rgba(0,0,0,0.15));border:1px solid var(--border);border-radius:9px;color:var(--text);font:inherit;font-size:13.5px">
                {installs.map((i) => (
                  <option value={i.id}>
                    {i.targetType}:{i.targetId.slice(0, 8)}
                  </option>
                ))}
              </select>
              <button type="submit" class="mkt-btn mkt-btn-primary" disabled={installs.length === 0}>
                Issue token
              </button>
            </form>
          </div>
        </section>
      </div>
    </Layout>
  );
});

marketplace.post(
  "/developer/apps/:slug/tokens/new",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const app = await getAppBySlug(slug);
    if (!app) return c.notFound();
    if (app.creatorId !== user.id) return c.text("forbidden", 403);
    const body = await c.req.parseBody();
    const installationId = String(body.installationId || "");
    if (!installationId) return c.redirect(`/developer/apps/${slug}/manage`);
    // Validate the installation belongs to this app
    const [inst] = await db
      .select()
      .from(appInstallations)
      .where(eq(appInstallations.id, installationId))
      .limit(1);
    if (!inst || inst.appId !== app.id) return c.text("forbidden", 403);
    const t = await issueInstallToken(installationId);
    if (!t) return c.text("failed", 500);
    await audit({
      userId: user.id,
      action: "marketplace.token.issue",
      targetType: "app_installation",
      targetId: installationId,
    });
    return c.html(
      <Layout title="Token issued" user={user}>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="mkt-wrap">
          <section class="mkt-hero">
            <div class="mkt-hero-orb" aria-hidden="true" />
            <div class="mkt-hero-inner">
              <div class="mkt-hero-text">
                <div class="mkt-eyebrow">
                  <span class="mkt-eyebrow-dot" aria-hidden="true" />
                  Token issued
                </div>
                <h1 class="mkt-title">
                  <span class="mkt-title-grad">Copy now.</span>
                </h1>
                <p class="mkt-sub">
                  This token is shown once — store it somewhere safe. Expires{" "}
                  {t.expiresAt.toISOString()}.
                </p>
              </div>
            </div>
          </section>

          <section class="mkt-section">
            <div class="mkt-section-body">
              <div class="mkt-token-block">{t.token}</div>
              <a href={`/developer/apps/${slug}/manage`} class="mkt-btn mkt-btn-ghost" style="margin-top:14px">
                <IconArrowLeft /> Back
              </a>
            </div>
          </section>
        </div>
      </Layout>
    );
  }
);

export default marketplace;

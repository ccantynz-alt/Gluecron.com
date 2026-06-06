/**
 * Block F3 — Site admin panel.
 *
 *   GET  /admin                           — dashboard (counts + recent users)
 *   GET  /admin/users                     — user list + search
 *   POST /admin/users/:id/admin           — toggle site-admin flag
 *   GET  /admin/repos                     — repo list (including private)
 *   POST /admin/repos/:id/delete          — nuclear delete (audit-logged)
 *   GET  /admin/flags                     — site flags CRUD
 *   POST /admin/flags                     — set flag
 *
 * All routes gated by `isSiteAdmin`. First registered user is the bootstrap
 * admin. Site banner + registration lock are surfaced to the rest of the app
 * via `getFlag`.
 *
 * Visual polish (parallel session 3.I): adopts the 2026 design language —
 * gradient-hairline hero, animated orb, stat cards with display font, and a
 * polished action grid with inline-SVG glyphs. Logic, auth gates, redirects,
 * and audit emissions are unchanged from the pre-polish version. All scoped
 * CSS classes are prefixed `.admin-`.
 */

import { Hono } from "hono";
import { and, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import { db } from "../db";
import { aiCostEvents, auditLog, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  grantSiteAdmin,
  isSiteAdmin,
  KNOWN_FLAGS,
  listFlags,
  listSiteAdmins,
  revokeSiteAdmin,
  setFlag,
} from "../lib/admin";
import { audit } from "../lib/notify";
import { sendDigestsToAll, sendDigestForUser } from "../lib/email-digest";
import {
  getLastTick,
  getTickCount,
  runAutopilotTick,
} from "../lib/autopilot";
import { ensureDemoContent, DEMO_USERNAME } from "../lib/demo-seed";

const admin = new Hono<AuthEnv>();
admin.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.admin-` so the block cannot bleed
 * into other surfaces. Pattern mirrors dashboard-hero (commit a004c46),
 * repo-home (commit 544d842), and settings polish (commit 98eb360).
 * ───────────────────────────────────────────────────────────────────── */
const adminStyles = `
  .admin-wrap { max-width: 1680px; margin: 0 auto; }

  /* ─── Hero (main dashboard) ─── */
  .admin-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .admin-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .admin-hero-bg {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    pointer-events: none;
    z-index: 0;
  }
  .admin-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: adminHeroOrb 14s ease-in-out infinite;
  }
  @keyframes adminHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .admin-hero-orb { animation: none; }
  }
  .admin-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 720px;
  }
  .admin-hero-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    text-transform: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .admin-hero-eyebrow .admin-shield {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .admin-hero-eyebrow .admin-who {
    color: var(--accent);
    font-weight: 600;
  }
  .admin-hero-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .admin-hero-title .gradient-text,
  .admin-hero-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .admin-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }

  /* ─── Section hero (sub-pages) ─── */
  .admin-sec-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .admin-sec-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.6;
    pointer-events: none;
  }
  .admin-sec-hero-text { flex: 1; min-width: 240px; }
  .admin-sec-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .admin-sec-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 2.8vw, 28px);
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1.1;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .admin-sec-sub {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .admin-sec-hero-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* ─── Banners ─── */
  .admin-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .admin-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .admin-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }

  /* ─── Stat grid ─── */
  .admin-stat-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  @media (max-width: 720px) {
    .admin-stat-grid { grid-template-columns: 1fr; }
    .admin-hero { padding: var(--space-4); }
    .admin-actions { grid-template-columns: 1fr; }
    .admin-action { min-height: 44px; padding: 14px; }
    .admin-list-row { flex-direction: column; align-items: stretch; padding: 14px; }
    .admin-search { flex-direction: column; align-items: stretch; }
    .admin-search .admin-input { width: 100%; }
    .admin-card-body { padding: var(--space-4); }
    .admin-card-foot { padding: var(--space-3) var(--space-4); justify-content: flex-start; }
    .admin-ap-table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  }
  .admin-stat {
    position: relative;
    padding: var(--space-4) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  .admin-stat::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(135deg, rgba(140,109,255,0.05), rgba(54,197,214,0.04));
    opacity: 0;
    pointer-events: none;
    transition: opacity 200ms ease;
  }
  .admin-stat:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    box-shadow: 0 10px 28px -16px rgba(0,0,0,0.55);
  }
  .admin-stat:hover::after { opacity: 1; }
  .admin-stat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
    position: relative;
    z-index: 1;
  }
  .admin-stat-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .admin-stat-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .admin-stat-value {
    position: relative;
    z-index: 1;
    font-family: var(--font-display);
    font-size: 36px;
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1;
    color: var(--text-strong);
  }
  .admin-stat-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-faint);
    position: relative;
    z-index: 1;
  }

  /* ─── Action grid ─── */
  .admin-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: var(--space-2);
    margin-bottom: var(--space-6);
  }
  .admin-action {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text);
    text-decoration: none;
    font-size: 13.5px;
    font-weight: 500;
    line-height: 1.25;
    transition: border-color 150ms ease, background 150ms ease, transform 150ms ease;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
  }
  .admin-action:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.025);
    transform: translateY(-1px);
  }
  .admin-action:focus-visible {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .admin-action .admin-action-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px; height: 30px;
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    color: var(--text-muted);
    flex-shrink: 0;
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .admin-action.is-primary {
    border-color: rgba(140,109,255,0.35);
    background: linear-gradient(135deg, rgba(140,109,255,0.14), rgba(54,197,214,0.10));
    color: var(--text-strong);
  }
  .admin-action.is-primary:hover {
    border-color: rgba(140,109,255,0.55);
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
  }
  .admin-action.is-primary .admin-action-icon {
    background: rgba(140,109,255,0.18);
    color: #c5b3ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
  }
  .admin-action-form { display: contents; }

  /* ─── Section header (h3 replacement) ─── */
  .admin-h3 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin: var(--space-5) 0 var(--space-3);
  }
  .admin-h3 h3 {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.014em;
    margin: 0;
    color: var(--text-strong);
  }
  .admin-h3-meta {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* ─── Lists / cards ─── */
  .admin-list {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .admin-list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background 120ms ease;
  }
  .admin-list-row:last-child { border-bottom: none; }
  .admin-list-row:hover { background: rgba(255,255,255,0.018); }
  .admin-list-empty {
    padding: var(--space-5);
    text-align: center;
    color: var(--text-muted);
    font-size: 13.5px;
  }
  .admin-list-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
  .admin-avatar {
    width: 30px; height: 30px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.30), rgba(54,197,214,0.22));
    color: var(--text-strong);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    flex-shrink: 0;
    text-transform: uppercase;
  }
  .admin-avatar.is-admin {
    background: linear-gradient(135deg, rgba(140,109,255,0.50), rgba(54,197,214,0.35));
    color: #fff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.55), 0 0 12px rgba(140,109,255,0.25);
  }
  .admin-row-text { min-width: 0; }
  .admin-row-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    text-decoration: none;
  }
  .admin-row-title:hover { color: var(--accent-hover); }
  .admin-row-sub {
    margin-top: 2px;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .admin-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .admin-pill.is-admin {
    background: rgba(140,109,255,0.16);
    color: #c5b3ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .admin-pill.is-private {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .admin-pill.is-public {
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .admin-pill.is-on {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .admin-pill.is-off {
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .admin-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }

  /* ─── Inline forms / search ─── */
  .admin-search {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    margin-bottom: var(--space-4);
  }
  .admin-input {
    width: 320px;
    max-width: 100%;
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-sans);
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .admin-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* ─── Flags form ─── */
  .admin-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .admin-card-body { padding: var(--space-5); }
  .admin-card-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .admin-card-foot .admin-foot-hint {
    margin-right: auto;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .admin-field { margin-bottom: var(--space-4); }
  .admin-field:last-child { margin-bottom: 0; }
  .admin-field label {
    display: block;
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.005em;
  }
  .admin-field .admin-input-mono {
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
  }
  .admin-field .admin-input-mono:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .admin-field-hint {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .admin-field-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }

  /* ─── Digest forms ─── */
  .admin-digest-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  /* ─── Autopilot specific ─── */
  .admin-ap-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .admin-ap-table thead th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 10px 14px;
    background: rgba(255,255,255,0.015);
    border-bottom: 1px solid var(--border);
  }
  .admin-ap-table tbody td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 13px;
    color: var(--text);
    vertical-align: top;
  }
  .admin-ap-table tbody tr:last-child td { border-bottom: none; }
  .admin-ap-table code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
  }
  .admin-ap-status-ok { color: var(--green); font-weight: 600; }
  .admin-ap-status-fail { color: var(--red); font-weight: 600; }
  .admin-ap-empty {
    padding: var(--space-5);
    text-align: center;
    color: var(--text-muted);
    font-size: 13.5px;
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
    border-radius: 14px;
  }
  .admin-ap-foot {
    margin-top: var(--space-5);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border-subtle);
    background: rgba(255,255,255,0.015);
    border-radius: 10px;
    color: var(--text-muted);
    font-size: 12.5px;
  }
  .admin-ap-foot code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text);
  }

  /* ─── Misc ─── */
  .admin-403 {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .admin-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .admin-403 p { color: var(--text-muted); margin: 0; font-size: 14px; }
`;

/* ─────────────────────────────────────────────────────────────────────────
 * Per-sub-page scoped CSS — each handler gets its own namespace so they
 * cannot bleed into each other or back into the shared `.admin-*` panel.
 *
 *   .adm-users-*      /admin/users
 *   .adm-repos-*      /admin/repos
 *   .adm-flags-*      /admin/flags
 *   .adm-digests-*    /admin/digests
 *   .adm-autopilot-*  /admin/autopilot
 *
 * All five mirror the 2026 design language from /admin and /admin/ops:
 *   - gradient hairline (::before)
 *   - animated radial-gradient orb
 *   - clamp() display headline + gradient-text span
 *   - eyebrow + subtitle
 *   - cards with avatar/icon + mono IDs + action buttons
 *   - filter pills / search bar
 *   - empty state with orb
 * ───────────────────────────────────────────────────────────────────── */
const admUsersStyles = `
  .adm-users-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* Hero */
  .adm-users-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adm-users-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .adm-users-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
    animation: admUsersOrb 14s ease-in-out infinite;
  }
  @keyframes admUsersOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .adm-users-hero-orb { animation: none; }
  }
  .adm-users-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .adm-users-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .adm-users-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .adm-users-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px; height: 22px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .adm-users-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .adm-users-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .adm-users-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .adm-users-back {
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
  .adm-users-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
  }

  /* Filter bar */
  .adm-users-filterbar {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .adm-users-search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 280px;
  }
  .adm-users-search-ico {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
    display: inline-flex;
  }
  .adm-users-input {
    flex: 1;
    width: 100%;
    padding: 10px 12px 10px 36px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    outline: none;
    font-family: var(--font-sans);
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .adm-users-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .adm-users-pills {
    display: inline-flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .adm-users-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .adm-users-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }
  .adm-users-pill.is-admin {
    background: rgba(140,109,255,0.16);
    color: #c5b3ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }

  /* Buttons */
  .adm-users-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid var(--border-strong);
    background: rgba(255,255,255,0.02);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    line-height: 1;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }
  .adm-users-btn:hover { border-color: rgba(140,109,255,0.45); background: rgba(140,109,255,0.06); color: var(--text-strong); }
  .adm-users-btn-ghost { background: transparent; color: var(--text-muted); border-color: var(--border); }
  .adm-users-btn-ghost:hover { color: var(--text); background: rgba(255,255,255,0.03); border-color: var(--border-strong); }
  .adm-users-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .adm-users-btn-primary:hover { color: #fff; transform: translateY(-1px); box-shadow: 0 10px 24px -8px rgba(140,109,255,0.55); }
  .adm-users-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.40);
  }
  .adm-users-btn-danger:hover {
    background: rgba(248,113,113,0.08);
    border-color: rgba(248,113,113,0.70);
    color: #fecaca;
  }

  /* Card grid */
  .adm-users-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--space-3);
  }
  .adm-users-card {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  .adm-users-card:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    box-shadow: 0 10px 28px -16px rgba(0,0,0,0.55);
  }
  .adm-users-card.is-admin {
    border-color: rgba(140,109,255,0.35);
    background:
      linear-gradient(180deg, rgba(140,109,255,0.04), transparent 60%),
      var(--bg-elevated);
  }
  .adm-users-card-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .adm-users-avatar {
    width: 38px; height: 38px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.30), rgba(54,197,214,0.22));
    color: var(--text-strong);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    flex-shrink: 0;
    text-transform: uppercase;
  }
  .adm-users-avatar.is-admin {
    background: linear-gradient(135deg, rgba(140,109,255,0.50), rgba(54,197,214,0.35));
    color: #fff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.55), 0 0 12px rgba(140,109,255,0.25);
  }
  .adm-users-card-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .adm-users-card-name {
    font-size: 14.5px;
    font-weight: 700;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
  }
  .adm-users-card-name:hover { color: var(--accent-hover, var(--accent)); }
  .adm-users-card-mono {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.03);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    width: fit-content;
  }
  .adm-users-card-meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12.5px;
  }
  .adm-users-meta-item { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
  .adm-users-meta-key {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    flex-shrink: 0;
    width: 50px;
  }
  .adm-users-meta-val { color: var(--text); word-break: break-all; min-width: 0; }
  .adm-users-card-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: auto;
  }
  .adm-users-card-actions form { margin: 0; }

  /* Empty state */
  .adm-users-empty {
    position: relative;
    padding: var(--space-12) var(--space-6);
    border: 1px dashed var(--border);
    border-radius: 16px;
    background: var(--bg-elevated);
    text-align: center;
    overflow: hidden;
  }
  .adm-users-empty-orb {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
    z-index: 0;
  }
  .adm-users-empty-inner { position: relative; z-index: 1; }
  .adm-users-empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px; height: 56px;
    border-radius: 16px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    margin-bottom: var(--space-3);
  }
  .adm-users-empty-icon svg { width: 24px; height: 24px; }
  .adm-users-empty-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .adm-users-empty-sub {
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.5;
  }
  .adm-users-empty-sub code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text);
  }

  @media (max-width: 720px) {
    .adm-users-wrap { padding: var(--space-4) var(--space-3); }
    .adm-users-hero { padding: var(--space-4); }
    .adm-users-grid { grid-template-columns: 1fr; }
  }
`;

const admReposStyles = `
  .adm-repos-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .adm-repos-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adm-repos-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .adm-repos-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
    animation: admReposOrb 14s ease-in-out infinite;
  }
  @keyframes admReposOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .adm-repos-hero-orb { animation: none; }
  }
  .adm-repos-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .adm-repos-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .adm-repos-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .adm-repos-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px; height: 22px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .adm-repos-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .adm-repos-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .adm-repos-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .adm-repos-back {
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
  .adm-repos-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
  }

  .adm-repos-pills {
    display: inline-flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .adm-repos-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .adm-repos-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .adm-repos-pill.is-private {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .adm-repos-pill.is-public {
    background: rgba(52,211,153,0.10);
    color: #86efac;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.28);
  }

  .adm-repos-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid var(--border-strong);
    background: rgba(255,255,255,0.02);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    line-height: 1;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }
  .adm-repos-btn:hover { border-color: rgba(140,109,255,0.45); background: rgba(140,109,255,0.06); color: var(--text-strong); }
  .adm-repos-btn-ghost { background: transparent; color: var(--text-muted); border-color: var(--border); }
  .adm-repos-btn-ghost:hover { color: var(--text); background: rgba(255,255,255,0.03); border-color: var(--border-strong); }
  .adm-repos-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.40);
  }
  .adm-repos-btn-danger:hover {
    background: rgba(248,113,113,0.08);
    border-color: rgba(248,113,113,0.70);
    color: #fecaca;
  }

  .adm-repos-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: var(--space-3);
  }
  .adm-repos-card {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  .adm-repos-card:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    box-shadow: 0 10px 28px -16px rgba(0,0,0,0.55);
  }
  .adm-repos-card-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .adm-repos-icon {
    width: 38px; height: 38px;
    border-radius: 10px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.12));
    color: #b69dff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    flex-shrink: 0;
  }
  .adm-repos-icon svg { width: 18px; height: 18px; }
  .adm-repos-card-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .adm-repos-card-name {
    font-size: 14.5px;
    font-weight: 700;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
    word-break: break-all;
  }
  .adm-repos-card-name:hover { color: var(--accent-hover, var(--accent)); }
  .adm-repos-card-mono {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.03);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    width: fit-content;
  }
  .adm-repos-card-meta {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .adm-repos-meta-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .adm-repos-meta-item svg { width: 13px; height: 13px; color: var(--text-muted); }
  .adm-repos-card-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: auto;
  }
  .adm-repos-card-actions form { margin: 0; }

  .adm-repos-empty {
    position: relative;
    padding: var(--space-12) var(--space-6);
    border: 1px dashed var(--border);
    border-radius: 16px;
    background: var(--bg-elevated);
    text-align: center;
    overflow: hidden;
  }
  .adm-repos-empty-orb {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
    z-index: 0;
  }
  .adm-repos-empty-inner { position: relative; z-index: 1; }
  .adm-repos-empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px; height: 56px;
    border-radius: 16px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    margin-bottom: var(--space-3);
  }
  .adm-repos-empty-icon svg { width: 24px; height: 24px; }
  .adm-repos-empty-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .adm-repos-empty-sub {
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.5;
  }

  @media (max-width: 720px) {
    .adm-repos-wrap { padding: var(--space-4) var(--space-3); }
    .adm-repos-hero { padding: var(--space-4); }
    .adm-repos-grid { grid-template-columns: 1fr; }
  }
`;

const admFlagsStyles = `
  .adm-flags-wrap { max-width: 1200px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .adm-flags-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adm-flags-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .adm-flags-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
    animation: admFlagsOrb 14s ease-in-out infinite;
  }
  @keyframes admFlagsOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .adm-flags-hero-orb { animation: none; }
  }
  .adm-flags-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .adm-flags-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .adm-flags-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .adm-flags-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px; height: 22px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .adm-flags-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .adm-flags-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .adm-flags-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .adm-flags-sub code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text);
  }
  .adm-flags-back {
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
  .adm-flags-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
  }

  .adm-flags-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .adm-flags-card-body { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
  .adm-flags-card-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .adm-flags-foot-hint {
    margin-right: auto;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  .adm-flags-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    background: rgba(255,255,255,0.015);
    transition: border-color 120ms ease, background 120ms ease;
  }
  .adm-flags-field:hover { border-color: var(--border); background: rgba(255,255,255,0.025); }
  .adm-flags-field-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .adm-flags-key {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .adm-flags-mono {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
  }
  .adm-flags-input {
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
  .adm-flags-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .adm-flags-hint {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 2px;
    line-height: 1.45;
  }
  .adm-flags-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text);
  }

  .adm-flags-btn {
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
    font: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .adm-flags-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .adm-flags-btn-primary:hover { transform: translateY(-1px); box-shadow: 0 10px 24px -8px rgba(140,109,255,0.55); }

  @media (max-width: 720px) {
    .adm-flags-wrap { padding: var(--space-4) var(--space-3); }
    .adm-flags-hero { padding: var(--space-4); }
  }
`;

const admDigestsStyles = `
  .adm-digests-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .adm-digests-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adm-digests-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .adm-digests-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
    animation: admDigestsOrb 14s ease-in-out infinite;
  }
  @keyframes admDigestsOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .adm-digests-hero-orb { animation: none; }
  }
  .adm-digests-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .adm-digests-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .adm-digests-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .adm-digests-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px; height: 22px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .adm-digests-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .adm-digests-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .adm-digests-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .adm-digests-back {
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
  .adm-digests-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
  }

  .adm-digests-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .adm-digests-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .adm-digests-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  .adm-digests-pills {
    display: inline-flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .adm-digests-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .adm-digests-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .adm-digests-pill.is-on {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }

  .adm-digests-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .adm-digests-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .adm-digests-section-icon {
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
  .adm-digests-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .adm-digests-section-sub { margin: 4px 0 0; font-size: 12.5px; color: var(--text-muted); }
  .adm-digests-section-body { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }

  .adm-digests-input {
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
    max-width: 280px;
  }
  .adm-digests-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .adm-digests-form-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .adm-digests-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid var(--border-strong);
    background: rgba(255,255,255,0.02);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .adm-digests-btn:hover { border-color: rgba(140,109,255,0.45); background: rgba(140,109,255,0.06); color: var(--text-strong); }
  .adm-digests-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .adm-digests-btn-primary:hover { color: #fff; transform: translateY(-1px); box-shadow: 0 10px 24px -8px rgba(140,109,255,0.55); }

  .adm-digests-section-divider {
    border-top: 1px solid var(--border-subtle);
    padding-top: var(--space-3);
    margin-top: var(--space-2);
  }
  .adm-digests-divider-hint {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
  }

  .adm-digests-h3 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin: var(--space-5) 0 var(--space-3);
  }
  .adm-digests-h3 h3 {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.014em;
    margin: 0;
    color: var(--text-strong);
  }
  .adm-digests-h3-meta { font-size: 12px; color: var(--text-muted); }

  .adm-digests-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3);
  }
  .adm-digests-card {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    display: flex;
    align-items: center;
    gap: 12px;
    transition: transform 160ms ease, border-color 160ms ease;
  }
  .adm-digests-card:hover { transform: translateY(-1px); border-color: var(--border-strong); }
  .adm-digests-avatar {
    width: 36px; height: 36px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.30), rgba(54,197,214,0.22));
    color: var(--text-strong);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    flex-shrink: 0;
    text-transform: uppercase;
  }
  .adm-digests-card-text { min-width: 0; flex: 1; }
  .adm-digests-card-name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-strong);
    text-decoration: none;
  }
  .adm-digests-card-name:hover { color: var(--accent-hover, var(--accent)); }
  .adm-digests-card-sent {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .adm-digests-empty {
    position: relative;
    padding: var(--space-12) var(--space-6);
    border: 1px dashed var(--border);
    border-radius: 16px;
    background: var(--bg-elevated);
    text-align: center;
    overflow: hidden;
  }
  .adm-digests-empty-orb {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
    z-index: 0;
  }
  .adm-digests-empty-inner { position: relative; z-index: 1; }
  .adm-digests-empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px; height: 56px;
    border-radius: 16px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    margin-bottom: var(--space-3);
  }
  .adm-digests-empty-icon svg { width: 24px; height: 24px; }
  .adm-digests-empty-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .adm-digests-empty-sub {
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.5;
  }

  @media (max-width: 720px) {
    .adm-digests-wrap { padding: var(--space-4) var(--space-3); }
    .adm-digests-hero { padding: var(--space-4); }
    .adm-digests-grid { grid-template-columns: 1fr; }
  }
`;

const admAutopilotStyles = `
  .adm-autopilot-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .adm-autopilot-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adm-autopilot-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .adm-autopilot-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
    animation: admAutopilotOrb 14s ease-in-out infinite;
  }
  @keyframes admAutopilotOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .adm-autopilot-hero-orb { animation: none; }
  }
  .adm-autopilot-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .adm-autopilot-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .adm-autopilot-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .adm-autopilot-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px; height: 22px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .adm-autopilot-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .adm-autopilot-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .adm-autopilot-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .adm-autopilot-back {
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
  .adm-autopilot-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
  }

  .adm-autopilot-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .adm-autopilot-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .adm-autopilot-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  .adm-autopilot-statgrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .adm-autopilot-stat {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  .adm-autopilot-stat:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    box-shadow: 0 10px 28px -16px rgba(0,0,0,0.55);
  }
  .adm-autopilot-stat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }
  .adm-autopilot-stat-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .adm-autopilot-stat-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .adm-autopilot-stat-value {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1;
    color: var(--text-strong);
  }
  .adm-autopilot-stat-value.is-mono {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.3;
    word-break: break-all;
  }
  .adm-autopilot-stat-hint { margin-top: 6px; font-size: 12px; color: var(--text-muted); }
  .adm-autopilot-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .adm-autopilot-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .adm-autopilot-pill.is-on {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .adm-autopilot-pill.is-off {
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .adm-autopilot-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .adm-autopilot-actions form { margin: 0; }
  .adm-autopilot-action-hint {
    color: var(--text-muted);
    font-size: 13px;
  }

  .adm-autopilot-btn {
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
    font: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .adm-autopilot-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .adm-autopilot-btn-primary:hover { transform: translateY(-1px); box-shadow: 0 10px 24px -8px rgba(140,109,255,0.55); }

  .adm-autopilot-h3 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0 0 var(--space-3);
  }
  .adm-autopilot-h3 h3 {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.014em;
    margin: 0;
    color: var(--text-strong);
  }
  .adm-autopilot-h3-meta { font-size: 12px; color: var(--text-muted); }

  .adm-autopilot-tasks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3);
  }
  .adm-autopilot-task {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: transform 160ms ease, border-color 160ms ease;
  }
  .adm-autopilot-task:hover { transform: translateY(-1px); border-color: var(--border-strong); }
  .adm-autopilot-task.is-ok { border-color: rgba(52,211,153,0.28); }
  .adm-autopilot-task.is-fail { border-color: rgba(248,113,113,0.32); }
  .adm-autopilot-task-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .adm-autopilot-task-light {
    flex-shrink: 0;
    width: 10px; height: 10px;
    border-radius: 9999px;
    background: #6b7280;
    box-shadow: 0 0 0 3px rgba(107,114,128,0.16);
  }
  .adm-autopilot-task-light.is-ok {
    background: #34d399;
    box-shadow: 0 0 0 3px rgba(52,211,153,0.22), 0 0 8px rgba(52,211,153,0.45);
  }
  .adm-autopilot-task-light.is-fail {
    background: #f87171;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.22), 0 0 10px rgba(248,113,113,0.50);
    animation: admApPulse 1.8s ease-in-out infinite;
  }
  @keyframes admApPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.7; transform: scale(0.92); }
  }
  @media (prefers-reduced-motion: reduce) {
    .adm-autopilot-task-light.is-fail { animation: none; }
  }
  .adm-autopilot-task-name {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    word-break: break-word;
    flex: 1;
    min-width: 0;
  }
  .adm-autopilot-task-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .adm-autopilot-task-status.is-ok {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .adm-autopilot-task-status.is-fail {
    background: rgba(248,113,113,0.12);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .adm-autopilot-task-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .adm-autopilot-task-err {
    font-size: 11.5px;
    color: #fecaca;
    line-height: 1.5;
    background: rgba(248,113,113,0.06);
    border: 1px solid rgba(248,113,113,0.20);
    padding: 6px 8px;
    border-radius: 6px;
    word-break: break-word;
  }

  .adm-autopilot-empty {
    position: relative;
    padding: var(--space-12) var(--space-6);
    border: 1px dashed var(--border);
    border-radius: 16px;
    background: var(--bg-elevated);
    text-align: center;
    overflow: hidden;
  }
  .adm-autopilot-empty-orb {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
    z-index: 0;
  }
  .adm-autopilot-empty-inner { position: relative; z-index: 1; }
  .adm-autopilot-empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px; height: 56px;
    border-radius: 16px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    margin-bottom: var(--space-3);
  }
  .adm-autopilot-empty-icon svg { width: 24px; height: 24px; }
  .adm-autopilot-empty-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .adm-autopilot-empty-sub {
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.5;
  }

  .adm-autopilot-foot {
    margin-top: var(--space-5);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border-subtle);
    background: rgba(255,255,255,0.015);
    border-radius: 10px;
    color: var(--text-muted);
    font-size: 12.5px;
  }
  .adm-autopilot-foot code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text);
  }

  @media (max-width: 720px) {
    .adm-autopilot-wrap { padding: var(--space-4) var(--space-3); }
    .adm-autopilot-hero { padding: var(--space-4); }
    .adm-autopilot-statgrid { grid-template-columns: 1fr 1fr; }
    .adm-autopilot-tasks { grid-template-columns: 1fr; }
  }
`;

const admAnalyticsStyles = `
  .adm-analytics-wrap { max-width: 1400px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .adm-analytics-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adm-analytics-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .adm-analytics-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
    animation: admAnalyticsOrb 14s ease-in-out infinite;
  }
  @keyframes admAnalyticsOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) { .adm-analytics-hero-orb { animation: none; } }
  .adm-analytics-hero-inner {
    position: relative; z-index: 1;
    display: flex; align-items: flex-end; justify-content: space-between;
    gap: var(--space-4); flex-wrap: wrap;
  }
  .adm-analytics-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .adm-analytics-eyebrow {
    font-size: 12px; color: var(--text-muted); margin-bottom: var(--space-2);
    letter-spacing: 0.02em; display: inline-flex; align-items: center; gap: 8px;
  }
  .adm-analytics-eyebrow-pill {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 6px;
    background: rgba(140,109,255,0.14); color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .adm-analytics-title {
    font-size: clamp(28px, 4vw, 36px); font-family: var(--font-display);
    font-weight: 800; letter-spacing: -0.028em; line-height: 1.05;
    margin: 0 0 var(--space-2); color: var(--text-strong);
  }
  .adm-analytics-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; color: transparent;
  }
  .adm-analytics-sub { font-size: 14px; color: var(--text-muted); margin: 0; line-height: 1.5; }
  .adm-analytics-back {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 12px; font-size: 12.5px; color: var(--text-muted);
    background: rgba(255,255,255,0.02); border: 1px solid var(--border);
    border-radius: 8px; text-decoration: none; font-weight: 500;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .adm-analytics-back:hover { border-color: var(--border-strong); color: var(--text-strong); background: rgba(255,255,255,0.04); }

  .adm-analytics-statgrid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3); margin-bottom: var(--space-5);
  }
  .adm-analytics-stat {
    padding: var(--space-4); background: var(--bg-elevated);
    border: 1px solid var(--border); border-radius: 14px; overflow: hidden;
  }
  .adm-analytics-stat-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;
  }
  .adm-analytics-stat-value {
    font-family: var(--font-display); font-size: 28px; font-weight: 800;
    letter-spacing: -0.024em; line-height: 1; color: var(--text-strong);
  }
  .adm-analytics-stat-hint { margin-top: 6px; font-size: 12px; color: var(--text-faint); }

  .adm-analytics-h3 {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: var(--space-3); margin: var(--space-5) 0 var(--space-3);
  }
  .adm-analytics-h3 h3 {
    font-family: var(--font-display); font-size: 16px; font-weight: 700;
    letter-spacing: -0.014em; margin: 0; color: var(--text-strong);
  }
  .adm-analytics-h3-meta { font-size: 12px; color: var(--text-muted); }

  .adm-analytics-table {
    width: 100%; border-collapse: collapse;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 14px; overflow: hidden;
  }
  .adm-analytics-table thead th {
    text-align: left; font-size: 11px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted);
    padding: 10px 16px; background: rgba(255,255,255,0.015);
    border-bottom: 1px solid var(--border);
  }
  .adm-analytics-table thead th:not(:first-child) { text-align: right; }
  .adm-analytics-table tbody td {
    padding: 10px 16px; border-bottom: 1px solid var(--border-subtle);
    font-size: 13px; color: var(--text); vertical-align: middle;
  }
  .adm-analytics-table tbody td:not(:first-child) { text-align: right; font-family: var(--font-mono); font-size: 12px; }
  .adm-analytics-table tbody tr:last-child td { border-bottom: none; }
  .adm-analytics-table tbody tr:hover td { background: rgba(255,255,255,0.018); }
  .adm-analytics-table code { font-family: var(--font-mono); font-size: 12px; color: var(--text-strong); }
  .adm-analytics-empty {
    padding: var(--space-6); text-align: center; color: var(--text-muted);
    font-size: 13.5px; background: var(--bg-elevated);
    border: 1px dashed var(--border); border-radius: 14px;
  }

  /* bar chart cells */
  .adm-analytics-bar-cell { display: flex; align-items: center; gap: 8px; }
  .adm-analytics-bar-track {
    flex: 1; height: 6px; background: var(--bg-tertiary);
    border-radius: 9999px; overflow: hidden; min-width: 60px;
  }
  .adm-analytics-bar-fill {
    height: 100%; border-radius: 9999px;
    background: linear-gradient(90deg, #8c6dff, #36c5d6);
  }
  .adm-analytics-bar-label { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); flex-shrink: 0; }

  .adm-analytics-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 9999px; font-size: 10.5px;
    font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    background: rgba(140,109,255,0.12); color: #c5b3ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .adm-analytics-pill.is-ok { background: rgba(52,211,153,0.12); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.28); }
  .adm-analytics-pill.is-err { background: rgba(248,113,113,0.12); color: #fecaca; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.28); }

  @media (max-width: 720px) {
    .adm-analytics-wrap { padding: var(--space-4) var(--space-3); }
    .adm-analytics-hero { padding: var(--space-4); }
    .adm-analytics-statgrid { grid-template-columns: 1fr 1fr; }
    .adm-analytics-table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  }
`;

/** Inline-SVG icons (no external deps). Stroke-based, currentColor. */
const Icons = {
  shield: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  users: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  repo: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  starShield: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  ops: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  pulse: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  flag: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  ),
  mail: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
  google: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v8" /><path d="M8 12h8" />
    </svg>
  ),
  github: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.74.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.35.78 1.04.78 2.1 0 1.52-.01 2.74-.01 3.11 0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  ),
  sso: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  bot: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <circle cx="9" cy="13" r="1" />
      <circle cx="15" cy="13" r="1" />
      <path d="M12 3v4" />
    </svg>
  ),
  refresh: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
    </svg>
  ),
  arrowLeft: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  ),
  dollarSign: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  trendingUp: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  ),
  key: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  ),
};

/** First-letter avatar helper. */
function initials(s: string): string {
  return (s || "?").trim().charAt(0).toUpperCase() || "?";
}

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="admin-403">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
        <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      </Layout>,
      403
    );
  }
  return { user };
}

admin.get("/admin", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const [uc] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [rc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(repositories);

  const recent = await db
    .select({
      id: users.id,
      username: users.username,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(10);

  const admins = await listSiteAdmins();

  const msg = c.req.query("result") || c.req.query("error");
  const isErr = !!c.req.query("error");

  const userCount = Number(uc?.n || 0);
  const repoCount = Number(rc?.n || 0);
  const adminCount = admins.length;

  return c.html(
    <Layout title="Admin — Gluecron" user={user}>
      <div class="admin-wrap">
        <section class="admin-hero">
          <div class="admin-hero-bg" aria-hidden="true">
            <div class="admin-hero-orb" />
          </div>
          <div class="admin-hero-inner">
            <div class="admin-hero-eyebrow">
              <span class="admin-shield" aria-hidden="true">{Icons.shield}</span>
              Site administration ·{" "}
              <span class="admin-who">{user.username}</span>
            </div>
            <h2 class="admin-hero-title">
              <span class="admin-hero-title-grad">Site admin</span>.
            </h2>
            <p class="admin-hero-sub">
              {userCount} user{userCount === 1 ? "" : "s"} ·{" "}
              {repoCount} repo{repoCount === 1 ? "" : "s"} ·{" "}
              {adminCount} site admin{adminCount === 1 ? "" : "s"}.{" "}
              Operations, flags, digests, and autopilot — all in one place.
            </p>
          </div>
        </section>

        {msg && (
          <div class={"admin-banner " + (isErr ? "is-error" : "is-ok")}>
            {decodeURIComponent(msg)}
          </div>
        )}

        <div class="admin-stat-grid">
          <div class="admin-stat">
            <div class="admin-stat-head">
              <span class="admin-stat-label">Users</span>
              <span class="admin-stat-icon">{Icons.users}</span>
            </div>
            <div class="admin-stat-value">{userCount}</div>
            <div class="admin-stat-hint">Registered accounts</div>
          </div>
          <div class="admin-stat">
            <div class="admin-stat-head">
              <span class="admin-stat-label">Repos</span>
              <span class="admin-stat-icon">{Icons.repo}</span>
            </div>
            <div class="admin-stat-value">{repoCount}</div>
            <div class="admin-stat-hint">Public + private</div>
          </div>
          <div class="admin-stat">
            <div class="admin-stat-head">
              <span class="admin-stat-label">Admins</span>
              <span class="admin-stat-icon">{Icons.starShield}</span>
            </div>
            <div class="admin-stat-value">{adminCount}</div>
            <div class="admin-stat-hint">Site admins</div>
          </div>
        </div>

        <div class="admin-actions">
          <a href="/admin/ops" class="admin-action is-primary">
            <span class="admin-action-icon">{Icons.ops}</span>
            Operations
          </a>
          <a href="/admin/integrations" class="admin-action is-primary">
            <span class="admin-action-icon">{Icons.key}</span>
            Integrations
          </a>
          <a href="/admin/health" class="admin-action is-primary">
            <span class="admin-action-icon">{Icons.pulse}</span>
            Health (traffic lights)
          </a>
          <a href="/admin/deploys" class="admin-action is-primary">
            <span class="admin-action-icon">{Icons.ops}</span>
            Deploys
          </a>
          <a href="/admin/diagnose" class="admin-action">
            <span class="admin-action-icon">{Icons.pulse}</span>
            Diagnose
          </a>
          <a href="/admin/self-host" class="admin-action">
            <span class="admin-action-icon">{Icons.ops}</span>
            Self-host status
          </a>
          <a href="/admin/status" class="admin-action">
            <span class="admin-action-icon">{Icons.pulse}</span>
            Live activity stream
          </a>
          <a href="/admin/users" class="admin-action">
            <span class="admin-action-icon">{Icons.users}</span>
            Manage users
          </a>
          <a href="/admin/repos" class="admin-action">
            <span class="admin-action-icon">{Icons.repo}</span>
            Manage repos
          </a>
          <a href="/admin/flags" class="admin-action">
            <span class="admin-action-icon">{Icons.flag}</span>
            Site flags
          </a>
          <a href="/admin/digests" class="admin-action">
            <span class="admin-action-icon">{Icons.mail}</span>
            Email digests
          </a>
          <a href="/admin/google-oauth" class="admin-action">
            <span class="admin-action-icon">{Icons.google}</span>
            Sign in with Google
          </a>
          <a href="/admin/github-oauth" class="admin-action">
            <span class="admin-action-icon">{Icons.github}</span>
            Sign in with GitHub
          </a>
          <a href="/admin/sso" class="admin-action">
            <span class="admin-action-icon">{Icons.sso}</span>
            Enterprise SSO
          </a>
          <a href="/admin/ai-costs" class="admin-action is-primary">
            <span class="admin-action-icon">{Icons.dollarSign}</span>
            AI cost breakdown
          </a>
          <a href="/admin/growth" class="admin-action is-primary">
            <span class="admin-action-icon">{Icons.trendingUp}</span>
            User growth
          </a>
          <a href="/admin/autopilot" class="admin-action" title="CI healer, patch generator, proactive monitor, AI build tasks">
            <span class="admin-action-icon">{Icons.bot}</span>
            Autopilot
          </a>
          <a href="/admin/diagnose" class="admin-action" title="Live status of the AI CI healer, patch generator, and proactive monitor">
            <span class="admin-action-icon">{Icons.bot}</span>
            AI background tasks
          </a>
          <a href="/connect/claude" class="admin-action is-primary">
            <span class="admin-action-icon">{Icons.bot}</span>
            Connect Claude
          </a>
          <form
            method="post"
            action="/admin/demo/reseed"
            class="admin-action-form"
          >
            <button
              class="admin-action"
              type="submit"
              title="Idempotently (re)create demo user + 3 sample repos"
            >
              <span class="admin-action-icon">{Icons.refresh}</span>
              Reseed demo
            </button>
          </form>
        </div>

        <div class="admin-h3">
          <h3>Recent signups</h3>
          <span class="admin-h3-meta">
            {recent.length} most-recent
          </span>
        </div>
        <div class="admin-list" style="margin-bottom:20px">
          {recent.length === 0 ? (
            <div class="admin-list-empty">No users yet.</div>
          ) : (
            recent.map((u) => (
              <div class="admin-list-row">
                <div class="admin-list-main">
                  <span class="admin-avatar" aria-hidden="true">{initials(u.username)}</span>
                  <div class="admin-row-text">
                    <a href={`/${u.username}`} class="admin-row-title">
                      {u.username}
                    </a>
                    <div class="admin-row-sub">
                      <span>Joined</span>
                      <span>
                        {u.createdAt
                          ? new Date(u.createdAt as unknown as string).toLocaleString()
                          : ""}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div class="admin-h3">
          <h3>Site admins</h3>
          <span class="admin-h3-meta">
            {adminCount} active
          </span>
        </div>
        <div class="admin-list">
          {admins.length === 0 ? (
            <div class="admin-list-empty">
              No admins (bootstrap mode — oldest user is admin).
            </div>
          ) : (
            admins.map((a) => (
              <div class="admin-list-row">
                <div class="admin-list-main">
                  <span class="admin-avatar is-admin" aria-hidden="true">{initials(a.username)}</span>
                  <div class="admin-row-text">
                    <a href={`/${a.username}`} class="admin-row-title">
                      {a.username}
                    </a>
                    <div class="admin-row-sub">
                      <span class="admin-pill is-admin">
                        <span class="dot" aria-hidden="true" /> Site admin
                      </span>
                      <span>
                        Granted{" "}
                        {a.grantedAt
                          ? new Date(a.grantedAt as unknown as string).toLocaleDateString()
                          : "—"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
    </Layout>
  );
});

// ----- Users -----

admin.get("/admin/users", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const q = c.req.query("q") || "";
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      q
        ? or(ilike(users.username, `%${q}%`), ilike(users.email, `%${q}%`))!
        : sql`1=1`
    )
    .orderBy(desc(users.createdAt))
    .limit(200);

  const adminIds = new Set((await listSiteAdmins()).map((a) => a.userId));
  const adminCount = rows.filter((u) => adminIds.has(u.id)).length;

  return c.html(
    <Layout title="Admin — Users" user={user}>
      <div class="adm-users-wrap">
        <section class="adm-users-hero">
          <div class="adm-users-hero-orb" aria-hidden="true" />
          <div class="adm-users-hero-inner">
            <div class="adm-users-hero-text">
              <div class="adm-users-eyebrow">
                <span class="adm-users-eyebrow-pill" aria-hidden="true">{Icons.users}</span>
                Site admin · Users
              </div>
              <h1 class="adm-users-title">
                <span class="adm-users-title-grad">Users</span>.
              </h1>
              <p class="adm-users-sub">
                Search, audit, and grant or revoke the site-admin flag.
                Showing up to 200 accounts ordered by signup recency.
              </p>
            </div>
            <a href="/admin" class="adm-users-back">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        <div class="adm-users-filterbar">
          <form method="get" action="/admin/users" class="adm-users-search">
            <span class="adm-users-search-ico" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              name="q"
              value={q}
              placeholder="Search username or email"
              aria-label="Search username or email"
              class="adm-users-input"
            />
            <button type="submit" class="adm-users-btn">Search</button>
            {q && (
              <a href="/admin/users" class="adm-users-btn adm-users-btn-ghost">Clear</a>
            )}
          </form>
          <div class="adm-users-pills">
            <span class="adm-users-pill"><span class="dot" aria-hidden="true" />{rows.length} shown</span>
            <span class="adm-users-pill is-admin"><span class="dot" aria-hidden="true" />{adminCount} admin{adminCount === 1 ? "" : "s"}</span>
          </div>
        </div>

        {rows.length === 0 ? (
          <div class="adm-users-empty">
            <div class="adm-users-empty-orb" aria-hidden="true" />
            <div class="adm-users-empty-inner">
              <div class="adm-users-empty-icon" aria-hidden="true">{Icons.users}</div>
              <div class="adm-users-empty-title">No users found</div>
              <div class="adm-users-empty-sub">
                {q ? <>No accounts match <code>{q}</code>. Try a different query.</> : "There are no registered accounts yet."}
              </div>
            </div>
          </div>
        ) : (
          <div class="adm-users-grid">
            {rows.map((u) => {
              const isAdmin = adminIds.has(u.id);
              return (
                <div class={"adm-users-card" + (isAdmin ? " is-admin" : "")}>
                  <div class="adm-users-card-head">
                    <span class={"adm-users-avatar" + (isAdmin ? " is-admin" : "")} aria-hidden="true">
                      {initials(u.username)}
                    </span>
                    <div class="adm-users-card-id">
                      <a href={`/${u.username}`} class="adm-users-card-name">{u.username}</a>
                      <code class="adm-users-card-mono" title={u.id}>{u.id.slice(0, 8)}</code>
                    </div>
                    {isAdmin && (
                      <span class="adm-users-pill is-admin" style="margin-left:auto"><span class="dot" aria-hidden="true" />Admin</span>
                    )}
                  </div>
                  <div class="adm-users-card-meta">
                    <span class="adm-users-meta-item">
                      <span class="adm-users-meta-key">Email</span>
                      <span class="adm-users-meta-val">{u.email}</span>
                    </span>
                    {u.createdAt && (
                      <span class="adm-users-meta-item">
                        <span class="adm-users-meta-key">Joined</span>
                        <span class="adm-users-meta-val">
                          {new Date(u.createdAt as unknown as string).toLocaleDateString()}
                        </span>
                      </span>
                    )}
                  </div>
                  <div class="adm-users-card-actions">
                    <form
                      method="post"
                      action={`/admin/users/${u.id}/admin`}
                      onsubmit={
                        isAdmin
                          ? "return confirm('Revoke site admin?')"
                          : "return confirm('Grant site admin?')"
                      }
                    >
                      <button
                        type="submit"
                        class={"adm-users-btn " + (isAdmin ? "adm-users-btn-danger" : "adm-users-btn-primary")}
                      >
                        {isAdmin ? "Revoke admin" : "Grant admin"}
                      </button>
                    </form>
                    <a href={`/${u.username}`} class="adm-users-btn adm-users-btn-ghost">
                      View profile
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      <style dangerouslySetInnerHTML={{ __html: admUsersStyles }} />
    </Layout>
  );
});

admin.post("/admin/users/:id/admin", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const id = c.req.param("id");
  const admins = await listSiteAdmins();
  const isAlready = admins.some((a) => a.userId === id);
  if (isAlready) {
    await revokeSiteAdmin(id);
    await audit({
      userId: user.id,
      action: "site_admin.revoke",
      targetType: "user",
      targetId: id,
    });
  } else {
    await grantSiteAdmin(id, user.id);
    await audit({
      userId: user.id,
      action: "site_admin.grant",
      targetType: "user",
      targetId: id,
    });
  }
  return c.redirect("/admin/users");
});

// ----- Repos -----

admin.get("/admin/repos", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const rows = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerUsername: users.username,
      isPrivate: repositories.isPrivate,
      createdAt: repositories.createdAt,
      starCount: repositories.starCount,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .orderBy(desc(repositories.createdAt))
    .limit(200);

  const privateCount = rows.filter((r) => r.isPrivate).length;
  const publicCount = rows.length - privateCount;

  return c.html(
    <Layout title="Admin — Repos" user={user}>
      <div class="adm-repos-wrap">
        <section class="adm-repos-hero">
          <div class="adm-repos-hero-orb" aria-hidden="true" />
          <div class="adm-repos-hero-inner">
            <div class="adm-repos-hero-text">
              <div class="adm-repos-eyebrow">
                <span class="adm-repos-eyebrow-pill" aria-hidden="true">{Icons.repo}</span>
                Site admin · Repositories
              </div>
              <h1 class="adm-repos-title">
                <span class="adm-repos-title-grad">Repositories</span>.
              </h1>
              <p class="adm-repos-sub">
                Every repository on the platform — public and private.
                Delete is irreversible and audit-logged.
              </p>
            </div>
            <a href="/admin" class="adm-repos-back">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        <div class="adm-repos-pills">
          <span class="adm-repos-pill"><span class="dot" aria-hidden="true" />{rows.length} shown</span>
          <span class="adm-repos-pill is-public"><span class="dot" aria-hidden="true" />{publicCount} public</span>
          <span class="adm-repos-pill is-private"><span class="dot" aria-hidden="true" />{privateCount} private</span>
        </div>

        {rows.length === 0 ? (
          <div class="adm-repos-empty">
            <div class="adm-repos-empty-orb" aria-hidden="true" />
            <div class="adm-repos-empty-inner">
              <div class="adm-repos-empty-icon" aria-hidden="true">{Icons.repo}</div>
              <div class="adm-repos-empty-title">No repositories yet</div>
              <div class="adm-repos-empty-sub">
                When users create their first repos, they'll appear here.
              </div>
            </div>
          </div>
        ) : (
          <div class="adm-repos-grid">
            {rows.map((r) => (
              <div class="adm-repos-card">
                <div class="adm-repos-card-head">
                  <span class="adm-repos-icon" aria-hidden="true">{Icons.repo}</span>
                  <div class="adm-repos-card-title">
                    <a
                      href={`/${r.ownerUsername}/${r.name}`}
                      class="adm-repos-card-name"
                    >
                      {r.ownerUsername}/{r.name}
                    </a>
                    <code class="adm-repos-card-mono" title={r.id}>{r.id.slice(0, 8)}</code>
                  </div>
                  <span
                    class={
                      "adm-repos-pill " +
                      (r.isPrivate ? "is-private" : "is-public")
                    }
                    style="margin-left:auto"
                  >
                    <span class="dot" aria-hidden="true" />
                    {r.isPrivate ? "private" : "public"}
                  </span>
                </div>
                <div class="adm-repos-card-meta">
                  <span class="adm-repos-meta-item">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                    {r.starCount} star{r.starCount === 1 ? "" : "s"}
                  </span>
                  {r.createdAt && (
                    <span class="adm-repos-meta-item">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                      {new Date(r.createdAt as unknown as string).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <div class="adm-repos-card-actions">
                  <a href={`/${r.ownerUsername}/${r.name}`} class="adm-repos-btn adm-repos-btn-ghost">
                    Open repo
                  </a>
                  <form
                    method="post"
                    action={`/admin/repos/${r.id}/delete`}
                    onsubmit="return confirm('Delete repository permanently? This cannot be undone.')"
                  >
                    <button type="submit" class="adm-repos-btn adm-repos-btn-danger">
                      Delete
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      <style dangerouslySetInnerHTML={{ __html: admReposStyles }} />
    </Layout>
  );
});

admin.post("/admin/repos/:id/delete", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const id = c.req.param("id");
  try {
    await db.delete(repositories).where(eq(repositories.id, id));
  } catch (err) {
    console.error("[admin] repo delete:", err);
  }
  await audit({
    userId: user.id,
    action: "admin.repo.delete",
    targetType: "repository",
    targetId: id,
  });
  return c.redirect("/admin/repos");
});

// ----- Flags -----

admin.get("/admin/flags", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const existing = await listFlags();
  const existingMap = new Map(existing.map((f) => [f.key, f.value]));
  const keys = Object.keys(KNOWN_FLAGS) as Array<keyof typeof KNOWN_FLAGS>;

  return c.html(
    <Layout title="Admin — Flags" user={user}>
      <div class="adm-flags-wrap">
        <section class="adm-flags-hero">
          <div class="adm-flags-hero-orb" aria-hidden="true" />
          <div class="adm-flags-hero-inner">
            <div class="adm-flags-hero-text">
              <div class="adm-flags-eyebrow">
                <span class="adm-flags-eyebrow-pill" aria-hidden="true">{Icons.flag}</span>
                Site admin · Feature flags
              </div>
              <h1 class="adm-flags-title">
                <span class="adm-flags-title-grad">Site flags</span>.
              </h1>
              <p class="adm-flags-sub">
                Runtime feature flags surfaced to the rest of the app via{" "}
                <code>getFlag()</code> — registration lock, site banner, read-only mode, and more.
              </p>
            </div>
            <a href="/admin" class="adm-flags-back">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        <form method="post" action="/admin/flags" class="adm-flags-card">
          <div class="adm-flags-card-body">
            {keys.map((k) => {
              const current = existingMap.get(k) ?? (KNOWN_FLAGS as any)[k];
              const isOverridden =
                existingMap.has(k) && existingMap.get(k) !== (KNOWN_FLAGS as any)[k];
              return (
                <div class="adm-flags-field">
                  <div class="adm-flags-field-head">
                    <label for={`flag-${k}`} class="adm-flags-key">{k}</label>
                    {isOverridden && (
                      <span class="adm-flags-mono">overridden</span>
                    )}
                  </div>
                  <input
                    id={`flag-${k}`}
                    type="text"
                    name={k}
                    value={current}
                    aria-label={k}
                    class="adm-flags-input"
                  />
                  <div class="adm-flags-hint">
                    default: <code>{(KNOWN_FLAGS as any)[k] || "(empty)"}</code>
                  </div>
                </div>
              );
            })}
          </div>
          <div class="adm-flags-card-foot">
            <span class="adm-flags-foot-hint">
              Saved values overwrite the defaults at runtime.
            </span>
            <button type="submit" class="adm-flags-btn adm-flags-btn-primary">
              Save changes
            </button>
          </div>
        </form>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      <style dangerouslySetInnerHTML={{ __html: admFlagsStyles }} />
    </Layout>
  );
});

admin.post("/admin/flags", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const body = await c.req.parseBody();
  const keys = Object.keys(KNOWN_FLAGS) as Array<keyof typeof KNOWN_FLAGS>;
  for (const k of keys) {
    const v = String(body[k] ?? "");
    await setFlag(k, v, user.id);
  }
  await audit({ userId: user.id, action: "admin.flags.save" });
  return c.redirect("/admin/flags");
});

// ----- Email digests (Block I7) -----

admin.get("/admin/digests", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const [optedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.notifyEmailDigestWeekly, true));
  const opted = Number(optedRow?.n || 0);

  const recentlySent = await db
    .select({
      id: users.id,
      username: users.username,
      lastDigestSentAt: users.lastDigestSentAt,
    })
    .from(users)
    .where(sql`${users.lastDigestSentAt} is not null`)
    .orderBy(desc(users.lastDigestSentAt))
    .limit(20);

  const result = c.req.query("result");
  const error = c.req.query("error");

  return c.html(
    <Layout title="Admin — Digests" user={user}>
      <div class="adm-digests-wrap">
        <section class="adm-digests-hero">
          <div class="adm-digests-hero-orb" aria-hidden="true" />
          <div class="adm-digests-hero-inner">
            <div class="adm-digests-hero-text">
              <div class="adm-digests-eyebrow">
                <span class="adm-digests-eyebrow-pill" aria-hidden="true">{Icons.mail}</span>
                Site admin · Email
              </div>
              <h1 class="adm-digests-title">
                <span class="adm-digests-title-grad">Email digests</span>.
              </h1>
              <p class="adm-digests-sub">
                Manually trigger the weekly digest for every opted-in user
                or preview the email for a single account.
              </p>
            </div>
            <a href="/admin" class="adm-digests-back">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        {result && (
          <div class="adm-digests-banner is-ok">{decodeURIComponent(result)}</div>
        )}
        {error && (
          <div class="adm-digests-banner is-error">{decodeURIComponent(error)}</div>
        )}

        <div class="adm-digests-pills">
          <span class="adm-digests-pill is-on"><span class="dot" aria-hidden="true" />{opted} opted-in</span>
          <span class="adm-digests-pill"><span class="dot" aria-hidden="true" />{recentlySent.length} recent</span>
        </div>

        <section class="adm-digests-section">
          <header class="adm-digests-section-head">
            <span class="adm-digests-section-icon" aria-hidden="true">{Icons.mail}</span>
            <div>
              <h3 class="adm-digests-section-title">Send digests</h3>
              <p class="adm-digests-section-sub">
                {opted} user{opted === 1 ? "" : "s"} subscribed to the weekly digest.
              </p>
            </div>
          </header>
          <div class="adm-digests-section-body">
            <form method="post" action="/admin/digests/run">
              <button
                type="submit"
                class="adm-digests-btn adm-digests-btn-primary"
                onclick="return confirm('Send weekly digest to all opted-in users now?')"
              >
                {Icons.mail}
                Send digests now
              </button>
            </form>
            <div class="adm-digests-section-divider">
              <div class="adm-digests-divider-hint">
                Preview / one-off — send the digest to a single user.
              </div>
              <form
                method="post"
                action="/admin/digests/preview"
                class="adm-digests-form-row"
              >
                <input
                  type="text"
                  name="username"
                  placeholder="username"
                  required
                  aria-label="Username"
                  class="adm-digests-input"
                />
                <button type="submit" class="adm-digests-btn">
                  Send to one user
                </button>
              </form>
            </div>
          </div>
        </section>

        <div class="adm-digests-h3">
          <h3>Recently sent</h3>
          <span class="adm-digests-h3-meta">last {recentlySent.length}</span>
        </div>
        {recentlySent.length === 0 ? (
          <div class="adm-digests-empty">
            <div class="adm-digests-empty-orb" aria-hidden="true" />
            <div class="adm-digests-empty-inner">
              <div class="adm-digests-empty-icon" aria-hidden="true">{Icons.mail}</div>
              <div class="adm-digests-empty-title">No digests sent yet</div>
              <div class="adm-digests-empty-sub">
                When the weekly digest fires, sent recipients will appear here.
              </div>
            </div>
          </div>
        ) : (
          <div class="adm-digests-grid">
            {recentlySent.map((u) => (
              <div class="adm-digests-card">
                <span class="adm-digests-avatar" aria-hidden="true">{initials(u.username)}</span>
                <div class="adm-digests-card-text">
                  <a href={`/${u.username}`} class="adm-digests-card-name">{u.username}</a>
                  <div class="adm-digests-card-sent">
                    sent {u.lastDigestSentAt
                      ? new Date(u.lastDigestSentAt as unknown as string).toLocaleString()
                      : "—"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      <style dangerouslySetInnerHTML={{ __html: admDigestsStyles }} />
    </Layout>
  );
});

admin.post("/admin/digests/run", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const results = await sendDigestsToAll();
  const sent = results.filter((r) => r.ok).length;
  const skipped = results.length - sent;
  await audit({
    userId: user.id,
    action: "admin.digests.run",
    metadata: { sent, skipped, total: results.length },
  });
  return c.redirect(
    `/admin/digests?result=${encodeURIComponent(
      `Processed ${results.length} opted-in users: ${sent} sent, ${skipped} skipped.`
    )}`
  );
});

admin.post("/admin/digests/preview", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const body = await c.req.parseBody();
  const username = String(body.username || "").trim();
  if (!username) {
    return c.redirect("/admin/digests?error=Username+required");
  }
  const [target] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!target) {
    return c.redirect("/admin/digests?error=User+not+found");
  }
  const result = await sendDigestForUser(target.id);
  await audit({
    userId: user.id,
    action: "admin.digests.preview",
    targetType: "user",
    targetId: target.id,
    metadata: {
      ok: result.ok,
      skipped: "skipped" in result ? result.skipped : null,
    },
  });
  if (result.ok) {
    return c.redirect(
      `/admin/digests?result=${encodeURIComponent(
        `Digest sent to ${target.username}.`
      )}`
    );
  }
  return c.redirect(
    `/admin/digests?error=${encodeURIComponent(
      `Not sent: ${"skipped" in result ? result.skipped : "unknown reason"}`
    )}`
  );
});

const AUTOPILOT_TASK_CATALOG = [
  { name: "mirror-sync",          desc: "Pull-sync all overdue repo mirrors" },
  { name: "merge-queue",          desc: "Advance serialised merge queues" },
  { name: "weekly-digest",        desc: "Send opt-in activity email digests" },
  { name: "advisory-rescan",      desc: "Re-evaluate security advisories against deps" },
  { name: "wait-timer-release",   desc: "Release expired deployment wait-timers" },
  { name: "scheduled-workflows",  desc: "Fire cron-triggered workflow runs" },
  { name: "auto-merge-sweep",     desc: "AI-gated auto-merge: close eligible PRs" },
  { name: "ai-build-from-issues", desc: "Dispatch ai:build issues → draft PRs" },
  { name: "sleep-mode-digest",    desc: "Send AI-hours-saved digest emails" },
  { name: "preview-expiry",       desc: "Expire stale branch-preview rows past their TTL" },
  { name: "onboarding-drip",      desc: "Send T+1d and T+3d onboarding drip emails to new users" },
] as const;

admin.get("/admin/autopilot", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const tick = getLastTick();
  const total = getTickCount();
  const disabled = process.env.AUTOPILOT_DISABLED === "1";
  const intervalRaw = process.env.AUTOPILOT_INTERVAL_MS;
  const intervalMs =
    intervalRaw && Number.isFinite(Number(intervalRaw)) && Number(intervalRaw) > 0
      ? Number(intervalRaw)
      : 5 * 60 * 1000;
  const msg = c.req.query("result") || c.req.query("error");
  const isErr = !!c.req.query("error");
  return c.html(
    <Layout title="Autopilot — admin" user={user}>
      <div class="adm-autopilot-wrap">
        <section class="adm-autopilot-hero">
          <div class="adm-autopilot-hero-orb" aria-hidden="true" />
          <div class="adm-autopilot-hero-inner">
            <div class="adm-autopilot-hero-text">
              <div class="adm-autopilot-eyebrow">
                <span class="adm-autopilot-eyebrow-pill" aria-hidden="true">{Icons.bot}</span>
                Site admin · Maintenance loop
              </div>
              <h1 class="adm-autopilot-title">
                <span class="adm-autopilot-title-grad">Autopilot</span>.
              </h1>
              <p class="adm-autopilot-sub">
                Periodic platform-maintenance loop — mirror sync, merge-queue
                progress, weekly digests, advisory rescans, wait-timer release,
                scheduled workflows (cron), AI-gated auto-merge sweep, and
                ai:build issue → PR dispatch.
              </p>
            </div>
            <a href="/admin" class="adm-autopilot-back">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        {msg && (
          <div class={"adm-autopilot-banner " + (isErr ? "is-error" : "is-ok")}>
            {decodeURIComponent(msg)}
          </div>
        )}

        <div class="adm-autopilot-statgrid">
          <div class="adm-autopilot-stat">
            <div class="adm-autopilot-stat-head">
              <span class="adm-autopilot-stat-label">Status</span>
              <span class={"adm-autopilot-pill " + (disabled ? "is-off" : "is-on")}>
                <span class="dot" aria-hidden="true" />
                {disabled ? "disabled" : "running"}
              </span>
            </div>
            <div class="adm-autopilot-stat-value" style="font-size:22px">
              {disabled ? "disabled" : "running"}
            </div>
            <div class="adm-autopilot-stat-hint">{disabled ? "AUTOPILOT_DISABLED=1" : "loop active"}</div>
          </div>
          <div class="adm-autopilot-stat">
            <div class="adm-autopilot-stat-head">
              <span class="adm-autopilot-stat-label">Interval</span>
              <span class="adm-autopilot-stat-icon" aria-hidden="true">{Icons.refresh}</span>
            </div>
            <div class="adm-autopilot-stat-value">{Math.round(intervalMs / 1000)}s</div>
            <div class="adm-autopilot-stat-hint">between ticks</div>
          </div>
          <div class="adm-autopilot-stat">
            <div class="adm-autopilot-stat-head">
              <span class="adm-autopilot-stat-label">Ticks this process</span>
              <span class="adm-autopilot-stat-icon" aria-hidden="true">{Icons.pulse}</span>
            </div>
            <div class="adm-autopilot-stat-value">{total}</div>
            <div class="adm-autopilot-stat-hint">since boot</div>
          </div>
          <div class="adm-autopilot-stat">
            <div class="adm-autopilot-stat-head">
              <span class="adm-autopilot-stat-label">Last tick</span>
              <span class="adm-autopilot-stat-icon" aria-hidden="true">{Icons.bot}</span>
            </div>
            <div class="adm-autopilot-stat-value is-mono">
              {tick ? tick.finishedAt : "never"}
            </div>
          </div>
        </div>

        <div class="adm-autopilot-actions">
          <form method="post" action="/admin/autopilot/run">
            <button class="adm-autopilot-btn adm-autopilot-btn-primary" type="submit">
              {Icons.bot}
              Run tick now
            </button>
          </form>
          <span class="adm-autopilot-action-hint">
            Executes all sub-tasks synchronously and records the result.
          </span>
        </div>

        <div class="adm-autopilot-h3">
          <h3>Last tick tasks</h3>
          {tick && (
            <span class="adm-autopilot-h3-meta">
              {tick.tasks.filter((t) => t.ok).length}/{tick.tasks.length} ok
            </span>
          )}
        </div>
        {tick ? (
          <div class="adm-autopilot-tasks">
            {tick.tasks.map((t) => (
              <div class={"adm-autopilot-task " + (t.ok ? "is-ok" : "is-fail")}>
                <div class="adm-autopilot-task-head">
                  <span
                    class={"adm-autopilot-task-light " + (t.ok ? "is-ok" : "is-fail")}
                    aria-label={t.ok ? "ok" : "failed"}
                  />
                  <span class="adm-autopilot-task-name">{t.name}</span>
                  <span class={"adm-autopilot-task-status " + (t.ok ? "is-ok" : "is-fail")}>
                    {t.ok ? "ok" : "failed"}
                  </span>
                </div>
                <div class="adm-autopilot-task-meta">
                  <span>duration</span>
                  <span>{t.durationMs}ms</span>
                </div>
                {t.error && (
                  <div class="adm-autopilot-task-err">{t.error}</div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div class="adm-autopilot-empty">
            <div class="adm-autopilot-empty-orb" aria-hidden="true" />
            <div class="adm-autopilot-empty-inner">
              <div class="adm-autopilot-empty-icon" aria-hidden="true">{Icons.bot}</div>
              <div class="adm-autopilot-empty-title">No ticks yet</div>
              <div class="adm-autopilot-empty-sub">
                The first tick fires after the interval elapses. Click "Run tick now" to fire one immediately.
              </div>
            </div>
          </div>
        )}
        <div class="adm-autopilot-h3" style="margin-top:28px">
          <h3>Configured tasks</h3>
          <span class="adm-autopilot-h3-meta">10 tasks · runs every tick</span>
        </div>
        <div class="adm-autopilot-tasks">
          {AUTOPILOT_TASK_CATALOG.map((t) => {
            const last = tick?.tasks.find((r) => r.name === t.name);
            return (
              <div class={"adm-autopilot-task " + (last ? (last.ok ? "is-ok" : "is-fail") : "")}>
                <div class="adm-autopilot-task-head">
                  <span
                    class={"adm-autopilot-task-light " + (last ? (last.ok ? "is-ok" : "is-fail") : "")}
                    aria-label={last ? (last.ok ? "ok" : "failed") : "not yet run"}
                  />
                  <span class="adm-autopilot-task-name">{t.name}</span>
                  {last && (
                    <span class={"adm-autopilot-task-status " + (last.ok ? "is-ok" : "is-fail")}>
                      {last.ok ? `ok · ${last.durationMs}ms` : "failed"}
                    </span>
                  )}
                </div>
                <div class="adm-autopilot-task-meta">
                  <span>{t.desc}</span>
                </div>
                {last?.error && <div class="adm-autopilot-task-err">{last.error}</div>}
              </div>
            );
          })}
        </div>

        <p class="adm-autopilot-foot">
          Opt out with env <code>AUTOPILOT_DISABLED=1</code>. Adjust cadence
          with <code>AUTOPILOT_INTERVAL_MS</code> (milliseconds).
        </p>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      <style dangerouslySetInnerHTML={{ __html: admAutopilotStyles }} />
    </Layout>
  );
});

admin.post("/admin/demo/reseed", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  try {
    const result = await ensureDemoContent({ force: true });
    const summary = `Demo reseed: user=${result.created.user ? "created" : "existed"}, repos=${result.created.repos.length}, issues=${result.created.issues}, prs=${result.created.prs}${result.errors.length ? `, errors=${result.errors.length}` : ""}`;
    await audit({
      userId: user.id,
      action: "admin.demo.reseed",
      targetType: "user",
      targetId: result.demoUser?.id ?? "demo",
      metadata: {
        createdUser: result.created.user,
        createdRepos: result.created.repos,
        createdIssues: result.created.issues,
        createdPrs: result.created.prs,
        errors: result.errors.slice(0, 5),
      },
    });
    return c.redirect(`/admin?result=${encodeURIComponent(summary)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/admin?error=${encodeURIComponent("Demo reseed failed: " + message)}`
    );
  }
});

// Public jump-to-demo — redirects to the first demo repo if present,
// otherwise to /explore. Useful as a landing-page-linkable "try it" URL.
admin.get("/demo", (c) => {
  return c.redirect(`/${DEMO_USERNAME}/hello-python`);
});

admin.post("/admin/autopilot/run", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  let summary = "";
  try {
    const result = await runAutopilotTick();
    const ok = result.tasks.filter((t) => t.ok).length;
    summary = `Tick complete: ${ok}/${result.tasks.length} tasks ok.`;
    await audit({
      userId: user.id,
      action: "admin.autopilot.run",
      targetType: "system",
      targetId: "autopilot",
      metadata: { ok, total: result.tasks.length },
    });
    return c.redirect(
      `/admin/autopilot?result=${encodeURIComponent(summary)}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/admin/autopilot?error=${encodeURIComponent("Tick failed: " + message)}`
    );
  }
});

// ─── AI Cost Breakdown (/admin/ai-costs) ─────────────────────────────────────

admin.get("/admin/ai-costs", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  // Start of current month (UTC)
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // Total spend this month
  const [totalRow] = await db
    .select({ total: sql<number>`coalesce(sum(cents_estimate), 0)::int` })
    .from(aiCostEvents)
    .where(gte(aiCostEvents.occurredAt, monthStart));
  const totalCents = Number(totalRow?.total ?? 0);

  // Breakdown by category
  const byCategory = await db
    .select({
      category: aiCostEvents.category,
      cents: sql<number>`sum(cents_estimate)::int`,
      calls: sql<number>`count(*)::int`,
    })
    .from(aiCostEvents)
    .where(gte(aiCostEvents.occurredAt, monthStart))
    .groupBy(aiCostEvents.category)
    .orderBy(sql`sum(cents_estimate) desc`);

  // Top 10 spenders (join users)
  const topSpenders = await db
    .select({
      username: users.username,
      cents: sql<number>`sum(${aiCostEvents.centsEstimate})::int`,
      calls: sql<number>`count(*)::int`,
    })
    .from(aiCostEvents)
    .innerJoin(users, eq(aiCostEvents.ownerUserId, users.id))
    .where(gte(aiCostEvents.occurredAt, monthStart))
    .groupBy(users.username)
    .orderBy(sql`sum(${aiCostEvents.centsEstimate}) desc`)
    .limit(10);

  const maxCents = Math.max(1, ...byCategory.map((r) => Number(r.cents)));
  const maxSpenderCents = Math.max(1, ...topSpenders.map((r) => Number(r.cents)));

  function fmtCents(c: number): string {
    if (c >= 100) return `$${(c / 100).toFixed(2)}`;
    return `${c}¢`;
  }

  const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return c.html(
    <Layout title="Admin — AI Costs" user={user}>
      <div class="adm-analytics-wrap">
        <section class="adm-analytics-hero">
          <div class="adm-analytics-hero-orb" aria-hidden="true" />
          <div class="adm-analytics-hero-inner">
            <div class="adm-analytics-hero-text">
              <div class="adm-analytics-eyebrow">
                <span class="adm-analytics-eyebrow-pill" aria-hidden="true">{Icons.dollarSign}</span>
                Site admin · Analytics
              </div>
              <h1 class="adm-analytics-title">
                <span class="adm-analytics-title-grad">AI cost breakdown</span>.
              </h1>
              <p class="adm-analytics-sub">
                Per-call AI spend for {monthName} — by feature category and top spenders.
              </p>
            </div>
            <a href="/admin" class="adm-analytics-back">{Icons.arrowLeft} Back</a>
          </div>
        </section>

        <div class="adm-analytics-statgrid">
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Total spend this month</div>
            <div class="adm-analytics-stat-value">{fmtCents(totalCents)}</div>
            <div class="adm-analytics-stat-hint">{monthName}</div>
          </div>
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Categories active</div>
            <div class="adm-analytics-stat-value">{byCategory.length}</div>
            <div class="adm-analytics-stat-hint">feature buckets with spend</div>
          </div>
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Total AI calls</div>
            <div class="adm-analytics-stat-value">
              {byCategory.reduce((s, r) => s + Number(r.calls), 0)}
            </div>
            <div class="adm-analytics-stat-hint">recorded events</div>
          </div>
        </div>

        <div class="adm-analytics-h3">
          <h3>By category</h3>
          <span class="adm-analytics-h3-meta">{monthName}</span>
        </div>
        {byCategory.length === 0 ? (
          <div class="adm-analytics-empty">No AI cost events recorded this month.</div>
        ) : (
          <table class="adm-analytics-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Spend</th>
                <th>Calls</th>
                <th style="width:200px">Distribution</th>
              </tr>
            </thead>
            <tbody>
              {byCategory.map((row) => {
                const pct = Math.round((Number(row.cents) / maxCents) * 100);
                return (
                  <tr>
                    <td><code>{row.category ?? "other"}</code></td>
                    <td>{fmtCents(Number(row.cents))}</td>
                    <td>{Number(row.calls).toLocaleString()}</td>
                    <td>
                      <div class="adm-analytics-bar-cell">
                        <div class="adm-analytics-bar-track">
                          <div class="adm-analytics-bar-fill" style={`width:${pct}%`} />
                        </div>
                        <span class="adm-analytics-bar-label">{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div class="adm-analytics-h3">
          <h3>Top 10 spenders</h3>
          <span class="adm-analytics-h3-meta">{monthName}</span>
        </div>
        {topSpenders.length === 0 ? (
          <div class="adm-analytics-empty">No per-user spend recorded this month.</div>
        ) : (
          <table class="adm-analytics-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Spend</th>
                <th>Calls</th>
                <th style="width:200px">Share</th>
              </tr>
            </thead>
            <tbody>
              {topSpenders.map((row, i) => {
                const pct = Math.round((Number(row.cents) / maxSpenderCents) * 100);
                return (
                  <tr>
                    <td>
                      <a href={`/${row.username}`} style="color:var(--accent);text-decoration:none;font-weight:600">
                        #{i + 1} {row.username}
                      </a>
                    </td>
                    <td>{fmtCents(Number(row.cents))}</td>
                    <td>{Number(row.calls).toLocaleString()}</td>
                    <td>
                      <div class="adm-analytics-bar-cell">
                        <div class="adm-analytics-bar-track">
                          <div class="adm-analytics-bar-fill" style={`width:${pct}%`} />
                        </div>
                        <span class="adm-analytics-bar-label">{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      <style dangerouslySetInnerHTML={{ __html: admAnalyticsStyles }} />
    </Layout>
  );
});

// ─── Autopilot Health (/admin/autopilot/health) ──────────────────────────────

const ALL_AUTOPILOT_TASKS = [
  "mirror-sync",
  "merge-queue",
  "weekly-digest",
  "advisory-rescan",
  "wait-timer-release",
  "scheduled-workflows",
  "auto-merge-sweep",
  "ai-build-from-issues",
  "sleep-mode-digest",
  "stale-pr-sweep",
] as const;

admin.get("/admin/autopilot/health", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Pull the last 200 audit log rows that match autopilot task patterns
  const logRows = await db
    .select({
      action: auditLog.action,
      createdAt: auditLog.createdAt,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(gte(auditLog.createdAt, since24h))
    .orderBy(desc(auditLog.createdAt))
    .limit(500);

  // Build per-task health from the last autopilot tick (in-memory)
  const tick = getLastTick();

  type TaskHealth = {
    name: string;
    lastRun: string | null;
    lastDurationMs: number | null;
    lastOk: boolean | null;
    lastError: string | null;
    successCount24h: number;
    errorCount24h: number;
  };

  const health: TaskHealth[] = ALL_AUTOPILOT_TASKS.map((taskName) => {
    // Count audit events in last 24h that look like this task
    const successCount24h = logRows.filter(
      (r) => r.action === `autopilot.task.ok.${taskName}`
    ).length;
    const errorCount24h = logRows.filter(
      (r) => r.action === `autopilot.task.error.${taskName}`
    ).length;

    // Get last tick result for this task (in-memory)
    const last = tick?.tasks.find((t) => t.name === taskName);

    return {
      name: taskName,
      lastRun: tick?.finishedAt ?? null,
      lastDurationMs: last?.durationMs ?? null,
      lastOk: last?.ok ?? null,
      lastError: last?.error ?? null,
      successCount24h,
      errorCount24h,
    };
  });

  const total = getTickCount();
  const disabled = process.env.AUTOPILOT_DISABLED === "1";

  return c.html(
    <Layout title="Autopilot Health — admin" user={user}>
      <div class="adm-analytics-wrap">
        <section class="adm-analytics-hero">
          <div class="adm-analytics-hero-orb" aria-hidden="true" />
          <div class="adm-analytics-hero-inner">
            <div class="adm-analytics-hero-text">
              <div class="adm-analytics-eyebrow">
                <span class="adm-analytics-eyebrow-pill" aria-hidden="true">{Icons.bot}</span>
                Site admin · Autopilot
              </div>
              <h1 class="adm-analytics-title">
                <span class="adm-analytics-title-grad">Autopilot health</span>.
              </h1>
              <p class="adm-analytics-sub">
                Last-tick status, duration, and 24h success/error counts for each autopilot task.
              </p>
            </div>
            <a href="/admin/autopilot" class="adm-analytics-back">{Icons.arrowLeft} Back</a>
          </div>
        </section>

        <div class="adm-analytics-statgrid">
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Status</div>
            <div class="adm-analytics-stat-value" style="font-size:22px">{disabled ? "disabled" : "running"}</div>
            <div class="adm-analytics-stat-hint">{disabled ? "AUTOPILOT_DISABLED=1" : "loop active"}</div>
          </div>
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Ticks (this process)</div>
            <div class="adm-analytics-stat-value">{total}</div>
            <div class="adm-analytics-stat-hint">since boot</div>
          </div>
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Last tick</div>
            <div class="adm-analytics-stat-value" style="font-size:14px;font-family:var(--font-mono);line-height:1.3">
              {tick?.finishedAt ?? "—"}
            </div>
          </div>
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Tasks OK (last tick)</div>
            <div class="adm-analytics-stat-value">
              {tick ? `${tick.tasks.filter((t) => t.ok).length}/${tick.tasks.length}` : "—"}
            </div>
          </div>
        </div>

        <div class="adm-analytics-h3">
          <h3>Per-task health</h3>
          <span class="adm-analytics-h3-meta">last tick + 24h audit window</span>
        </div>
        <table class="adm-analytics-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Last status</th>
              <th>Duration (last)</th>
              <th>OK (24h)</th>
              <th>Errors (24h)</th>
            </tr>
          </thead>
          <tbody>
            {health.map((t) => (
              <tr>
                <td><code>{t.name}</code></td>
                <td>
                  {t.lastOk === null ? (
                    <span style="color:var(--text-muted)">—</span>
                  ) : t.lastOk ? (
                    <span class="adm-analytics-pill is-ok">ok</span>
                  ) : (
                    <span class="adm-analytics-pill is-err" title={t.lastError ?? ""}>failed</span>
                  )}
                </td>
                <td>{t.lastDurationMs !== null ? `${t.lastDurationMs}ms` : "—"}</td>
                <td>
                  {t.successCount24h > 0 ? (
                    <span class="adm-analytics-pill is-ok">{t.successCount24h}</span>
                  ) : (
                    <span style="color:var(--text-muted)">—</span>
                  )}
                </td>
                <td>
                  {t.errorCount24h > 0 ? (
                    <span class="adm-analytics-pill is-err">{t.errorCount24h}</span>
                  ) : (
                    <span style="color:var(--text-muted)">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {tick?.tasks.some((t) => !t.ok && t.error) && (
          <>
            <div class="adm-analytics-h3" style="margin-top:28px">
              <h3>Last-tick errors</h3>
            </div>
            {tick.tasks.filter((t) => !t.ok && t.error).map((t) => (
              <div style="margin-bottom:12px;padding:12px 14px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.20);border-radius:10px;font-size:12.5px">
                <code style="color:#fecaca;font-weight:600">{t.name}</code>
                <div style="margin-top:6px;color:#fecaca;line-height:1.5;word-break:break-word">{t.error}</div>
              </div>
            ))}
          </>
        )}

        <p style="margin-top:24px;font-size:12.5px;color:var(--text-muted)">
          The 24h OK/error counts reflect <code style="font-family:var(--font-mono);font-size:11.5px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">audit_log</code> rows written by autopilot task wrappers. If those rows are absent, counts will show — (not yet instrumented).
        </p>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      <style dangerouslySetInnerHTML={{ __html: admAnalyticsStyles }} />
    </Layout>
  );
});

// ─── User Growth Chart (/admin/growth) ───────────────────────────────────────

admin.get("/admin/growth", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Daily signups last 30 days
  const dailySignups = await db
    .select({
      day: sql<string>`date_trunc('day', created_at)::date::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(users)
    .where(gte(users.createdAt, since30d))
    .groupBy(sql`date_trunc('day', created_at)`)
    .orderBy(sql`date_trunc('day', created_at)`);

  // Activation rate: users who created at least 1 repo (last 30d signups)
  const activatedRows = await db
    .select({
      userId: users.id,
    })
    .from(users)
    .innerJoin(repositories, eq(repositories.ownerId, users.id))
    .where(gte(users.createdAt, since30d))
    .groupBy(users.id);

  // Total signups in window
  const totalSignups = dailySignups.reduce((s, r) => s + Number(r.count), 0);
  const activated = activatedRows.length;
  const activationRate = totalSignups > 0 ? Math.round((activated / totalSignups) * 100) : 0;

  // All-time user count
  const [allTimeRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users);
  const allTime = Number(allTimeRow?.n ?? 0);

  // Build a 30-slot array (fill missing days with 0)
  const dayMap = new Map<string, number>();
  dailySignups.forEach((r) => dayMap.set(r.day, Number(r.count)));

  const slots: { label: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    slots.push({ label, count: dayMap.get(key) ?? 0 });
  }

  const maxCount = Math.max(1, ...slots.map((s) => s.count));

  return c.html(
    <Layout title="Admin — User Growth" user={user}>
      <div class="adm-analytics-wrap">
        <section class="adm-analytics-hero">
          <div class="adm-analytics-hero-orb" aria-hidden="true" />
          <div class="adm-analytics-hero-inner">
            <div class="adm-analytics-hero-text">
              <div class="adm-analytics-eyebrow">
                <span class="adm-analytics-eyebrow-pill" aria-hidden="true">{Icons.trendingUp}</span>
                Site admin · Analytics
              </div>
              <h1 class="adm-analytics-title">
                <span class="adm-analytics-title-grad">User growth</span>.
              </h1>
              <p class="adm-analytics-sub">
                Daily signups and activation rate over the last 30 days.
              </p>
            </div>
            <a href="/admin" class="adm-analytics-back">{Icons.arrowLeft} Back</a>
          </div>
        </section>

        <div class="adm-analytics-statgrid">
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Total users</div>
            <div class="adm-analytics-stat-value">{allTime}</div>
            <div class="adm-analytics-stat-hint">all time</div>
          </div>
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">New signups (30d)</div>
            <div class="adm-analytics-stat-value">{totalSignups}</div>
            <div class="adm-analytics-stat-hint">last 30 days</div>
          </div>
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Activation rate (30d)</div>
            <div class="adm-analytics-stat-value">{activationRate}%</div>
            <div class="adm-analytics-stat-hint">created ≥1 repo</div>
          </div>
          <div class="adm-analytics-stat">
            <div class="adm-analytics-stat-label">Activated users (30d)</div>
            <div class="adm-analytics-stat-value">{activated}</div>
            <div class="adm-analytics-stat-hint">out of {totalSignups} new</div>
          </div>
        </div>

        <div class="adm-analytics-h3">
          <h3>Daily signups — last 30 days</h3>
          <span class="adm-analytics-h3-meta">peak: {maxCount}</span>
        </div>

        {totalSignups === 0 ? (
          <div class="adm-analytics-empty">No signups in the last 30 days.</div>
        ) : (
          <table class="adm-analytics-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Signups</th>
                <th style="width:280px">Bar</th>
              </tr>
            </thead>
            <tbody>
              {slots.filter((s) => s.count > 0 || true).map((s) => {
                const pct = Math.round((s.count / maxCount) * 100);
                return (
                  <tr>
                    <td style="font-family:var(--font-mono);font-size:12px;color:var(--text)">{s.label}</td>
                    <td>{s.count}</td>
                    <td>
                      {s.count > 0 ? (
                        <div class="adm-analytics-bar-cell">
                          <div class="adm-analytics-bar-track">
                            <div class="adm-analytics-bar-fill" style={`width:${pct}%`} />
                          </div>
                          <span class="adm-analytics-bar-label">{s.count}</span>
                        </div>
                      ) : (
                        <span style="color:var(--text-faint);font-size:11px">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div class="adm-analytics-h3" style="margin-top:28px">
          <h3>Activation breakdown</h3>
          <span class="adm-analytics-h3-meta">30d cohort</span>
        </div>
        <table class="adm-analytics-table" style="max-width:500px">
          <thead>
            <tr>
              <th>Segment</th>
              <th>Count</th>
              <th style="width:200px">Rate</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>New signups (30d)</td>
              <td>{totalSignups}</td>
              <td>100%</td>
            </tr>
            <tr>
              <td>Activated (created ≥1 repo)</td>
              <td>{activated}</td>
              <td>
                <div class="adm-analytics-bar-cell">
                  <div class="adm-analytics-bar-track">
                    <div class="adm-analytics-bar-fill" style={`width:${activationRate}%`} />
                  </div>
                  <span class="adm-analytics-bar-label">{activationRate}%</span>
                </div>
              </td>
            </tr>
            <tr>
              <td>Not activated</td>
              <td>{totalSignups - activated}</td>
              <td>{100 - activationRate}%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      <style dangerouslySetInnerHTML={{ __html: admAnalyticsStyles }} />
    </Layout>
  );
});

export default admin;

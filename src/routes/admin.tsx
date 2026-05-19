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
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
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
  .admin-wrap { max-width: 1080px; margin: 0 auto; }

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
          <a href="/admin/diagnose" class="admin-action is-primary">
            <span class="admin-action-icon">{Icons.pulse}</span>
            Health / Diagnose
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
          <a href="/admin/autopilot" class="admin-action">
            <span class="admin-action-icon">{Icons.bot}</span>
            Autopilot
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

  return c.html(
    <Layout title="Admin — Users" user={user}>
      <div class="admin-wrap">
        <section class="admin-sec-hero">
          <div class="admin-sec-hero-text">
            <div class="admin-sec-eyebrow">Site admin</div>
            <h2 class="admin-sec-title">Users</h2>
            <p class="admin-sec-sub">
              Search, audit, and grant or revoke the site-admin flag.
              Showing up to 200 accounts ordered by signup recency.
            </p>
          </div>
          <div class="admin-sec-hero-actions">
            <a href="/admin" class="btn btn-sm">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        <form method="get" action="/admin/users" class="admin-search">
          <input
            type="text"
            name="q"
            value={q}
            placeholder="Search username or email"
            aria-label="Search username or email"
            class="admin-input"
          />
          <button type="submit" class="btn">
            Search
          </button>
          {q && (
            <a href="/admin/users" class="btn btn-sm">
              Clear
            </a>
          )}
        </form>

        <div class="admin-list">
          {rows.length === 0 ? (
            <div class="admin-list-empty">No users found.</div>
          ) : (
            rows.map((u) => {
              const isAdmin = adminIds.has(u.id);
              return (
                <div class="admin-list-row">
                  <div class="admin-list-main">
                    <span class={"admin-avatar" + (isAdmin ? " is-admin" : "")} aria-hidden="true">
                      {initials(u.username)}
                    </span>
                    <div class="admin-row-text">
                      <a href={`/${u.username}`} class="admin-row-title">
                        {u.username}
                      </a>
                      {isAdmin && (
                        <span class="admin-pill is-admin" style="margin-left:8px">
                          <span class="dot" aria-hidden="true" /> Admin
                        </span>
                      )}
                      <div class="admin-row-sub">
                        <span>{u.email}</span>
                        {u.createdAt && (
                          <span>
                            ·{" "}
                            {new Date(
                              u.createdAt as unknown as string
                            ).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <form
                    method="post"
                    action={`/admin/users/${u.id}/admin`}
                    onsubmit={
                      isAdmin
                        ? "return confirm('Revoke site admin?')"
                        : "return confirm('Grant site admin?')"
                    }
                  >
                    <button type="submit" class="btn btn-sm">
                      {isAdmin ? "Revoke admin" : "Grant admin"}
                    </button>
                  </form>
                </div>
              );
            })
          )}
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
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

  return c.html(
    <Layout title="Admin — Repos" user={user}>
      <div class="admin-wrap">
        <section class="admin-sec-hero">
          <div class="admin-sec-hero-text">
            <div class="admin-sec-eyebrow">Site admin</div>
            <h2 class="admin-sec-title">Repositories</h2>
            <p class="admin-sec-sub">
              Every repository on the platform — public and private.
              Delete is irreversible and audit-logged.
            </p>
          </div>
          <div class="admin-sec-hero-actions">
            <a href="/admin" class="btn btn-sm">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        <div class="admin-list">
          {rows.length === 0 ? (
            <div class="admin-list-empty">No repositories.</div>
          ) : (
            rows.map((r) => (
              <div class="admin-list-row">
                <div class="admin-list-main">
                  <span class="admin-avatar" aria-hidden="true">
                    {initials(r.ownerUsername)}
                  </span>
                  <div class="admin-row-text">
                    <a
                      href={`/${r.ownerUsername}/${r.name}`}
                      class="admin-row-title"
                    >
                      {r.ownerUsername}/{r.name}
                    </a>
                    <span
                      class={
                        "admin-pill " +
                        (r.isPrivate ? "is-private" : "is-public")
                      }
                      style="margin-left:8px"
                    >
                      {r.isPrivate ? "private" : "public"}
                    </span>
                    <div class="admin-row-sub">
                      <span>{r.starCount} star{r.starCount === 1 ? "" : "s"}</span>
                      <span>·</span>
                      <span>
                        {r.createdAt
                          ? new Date(r.createdAt as unknown as string).toLocaleDateString()
                          : ""}
                      </span>
                    </div>
                  </div>
                </div>
                <form
                  method="post"
                  action={`/admin/repos/${r.id}/delete`}
                  onsubmit="return confirm('Delete repository permanently? This cannot be undone.')"
                >
                  <button type="submit" class="btn btn-sm btn-danger">
                    Delete
                  </button>
                </form>
              </div>
            ))
          )}
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
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
      <div class="admin-wrap">
        <section class="admin-sec-hero">
          <div class="admin-sec-hero-text">
            <div class="admin-sec-eyebrow">Site admin</div>
            <h2 class="admin-sec-title">Site flags</h2>
            <p class="admin-sec-sub">
              Runtime feature flags surfaced to the rest of the app via
              <code style="margin:0 4px;padding:1px 5px;border-radius:4px;background:var(--bg-tertiary);font-family:var(--font-mono);font-size:12px">
                getFlag()
              </code>
              — registration lock, site banner, read-only mode, and more.
            </p>
          </div>
          <div class="admin-sec-hero-actions">
            <a href="/admin" class="btn btn-sm">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        <form method="post" action="/admin/flags" class="admin-card">
          <div class="admin-card-body">
            {keys.map((k) => {
              const current = existingMap.get(k) ?? (KNOWN_FLAGS as any)[k];
              return (
                <div class="admin-field">
                  <label>{k}</label>
                  <input
                    type="text"
                    name={k}
                    value={current}
                    aria-label={k}
                    class="admin-input-mono"
                  />
                  <div class="admin-field-hint">
                    default: <code>{(KNOWN_FLAGS as any)[k] || "(empty)"}</code>
                  </div>
                </div>
              );
            })}
          </div>
          <div class="admin-card-foot">
            <span class="admin-foot-hint">
              Saved values overwrite the defaults at runtime.
            </span>
            <button type="submit" class="btn btn-primary">
              Save
            </button>
          </div>
        </form>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
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
      <div class="admin-wrap">
        <section class="admin-sec-hero">
          <div class="admin-sec-hero-text">
            <div class="admin-sec-eyebrow">Site admin</div>
            <h2 class="admin-sec-title">Email digests</h2>
            <p class="admin-sec-sub">
              Manually trigger the weekly digest for every opted-in user
              or preview the email for a single account.
            </p>
          </div>
          <div class="admin-sec-hero-actions">
            <a href="/admin" class="btn btn-sm">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        {result && (
          <div class="admin-banner is-ok">{decodeURIComponent(result)}</div>
        )}
        {error && (
          <div class="admin-banner is-error">{decodeURIComponent(error)}</div>
        )}

        <div class="admin-card" style="margin-bottom:var(--space-5)">
          <div class="admin-card-body">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:var(--space-3);flex-wrap:wrap">
              <span class="admin-pill is-on">
                <span class="dot" aria-hidden="true" />
                {opted} opted-in
              </span>
              <span style="font-size:13px;color:var(--text-muted)">
                user{opted === 1 ? "" : "s"} subscribed to the weekly digest.
              </span>
            </div>
            <form method="post" action="/admin/digests/run" style="margin-bottom:var(--space-4)">
              <button
                type="submit"
                class="btn btn-primary"
                onclick="return confirm('Send weekly digest to all opted-in users now?')"
              >
                Send digests now
              </button>
            </form>
            <div style="border-top:1px solid var(--border-subtle);padding-top:var(--space-4)">
              <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:8px">
                Preview / one-off — send the digest to a single user.
              </div>
              <form
                method="post"
                action="/admin/digests/preview"
                class="admin-digest-row"
              >
                <input
                  type="text"
                  name="username"
                  placeholder="username"
                  required
                  aria-label="Username"
                  class="admin-input"
                  style="width:240px"
                />
                <button type="submit" class="btn btn-sm">
                  Send to one user
                </button>
              </form>
            </div>
          </div>
        </div>

        <div class="admin-h3">
          <h3>Recently sent</h3>
          <span class="admin-h3-meta">
            last {recentlySent.length}
          </span>
        </div>
        <div class="admin-list">
          {recentlySent.length === 0 ? (
            <div class="admin-list-empty">No digests have been sent yet.</div>
          ) : (
            recentlySent.map((u) => (
              <div class="admin-list-row">
                <div class="admin-list-main">
                  <span class="admin-avatar" aria-hidden="true">{initials(u.username)}</span>
                  <div class="admin-row-text">
                    <a href={`/${u.username}`} class="admin-row-title">
                      {u.username}
                    </a>
                    <div class="admin-row-sub">
                      <span>Sent</span>
                      <span>
                        {u.lastDigestSentAt
                          ? new Date(
                              u.lastDigestSentAt as unknown as string
                            ).toLocaleString()
                          : ""}
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
      <div class="admin-wrap" style="padding: var(--space-6) var(--space-4)">
        <section class="admin-sec-hero">
          <div class="admin-sec-hero-text">
            <div class="admin-sec-eyebrow">Site admin</div>
            <h2 class="admin-sec-title">Autopilot</h2>
            <p class="admin-sec-sub">
              Periodic platform-maintenance loop — mirror sync, merge-queue
              progress, weekly digests, advisory rescans, environment
              wait-timer release, and scheduled workflow triggers (cron).
            </p>
          </div>
          <div class="admin-sec-hero-actions">
            <a href="/admin" class="btn btn-sm">
              {Icons.arrowLeft} Back
            </a>
          </div>
        </section>

        {msg && (
          <div class={"admin-banner " + (isErr ? "is-error" : "is-ok")}>
            {decodeURIComponent(msg)}
          </div>
        )}

        <div class="admin-stat-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))">
          <div class="admin-stat">
            <div class="admin-stat-head">
              <span class="admin-stat-label">Status</span>
              <span class={"admin-pill " + (disabled ? "is-off" : "is-on")}>
                <span class="dot" aria-hidden="true" />
                {disabled ? "disabled" : "running"}
              </span>
            </div>
            <div class="admin-stat-value" style="font-size:22px">
              {disabled ? "disabled" : "running"}
            </div>
          </div>
          <div class="admin-stat">
            <div class="admin-stat-head">
              <span class="admin-stat-label">Interval</span>
            </div>
            <div class="admin-stat-value">{Math.round(intervalMs / 1000)}s</div>
            <div class="admin-stat-hint">between ticks</div>
          </div>
          <div class="admin-stat">
            <div class="admin-stat-head">
              <span class="admin-stat-label">Ticks this process</span>
            </div>
            <div class="admin-stat-value">{total}</div>
            <div class="admin-stat-hint">since boot</div>
          </div>
          <div class="admin-stat">
            <div class="admin-stat-head">
              <span class="admin-stat-label">Last tick</span>
            </div>
            <div
              class="admin-stat-value"
              style="font-size: 14px; font-family: var(--font-mono); line-height: 1.3"
            >
              {tick ? tick.finishedAt : "never"}
            </div>
          </div>
        </div>

        <form
          method="post"
          action="/admin/autopilot/run"
          style="margin-bottom: var(--space-5); display:flex; align-items:center; gap:12px; flex-wrap:wrap"
        >
          <button class="btn btn-primary" type="submit">
            Run tick now
          </button>
          <span style="color: var(--text-muted); font-size: 13px">
            Executes all sub-tasks synchronously and records the result.
          </span>
        </form>

        <div class="admin-h3">
          <h3>Last tick tasks</h3>
          {tick && (
            <span class="admin-h3-meta">
              {tick.tasks.filter((t) => t.ok).length}/{tick.tasks.length} ok
            </span>
          )}
        </div>
        {tick ? (
          <table class="admin-ap-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th style="text-align: right">Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {tick.tasks.map((t) => (
                <tr>
                  <td>
                    <code>{t.name}</code>
                  </td>
                  <td class={t.ok ? "admin-ap-status-ok" : "admin-ap-status-fail"}>
                    {t.ok ? "ok" : "failed"}
                  </td>
                  <td style="text-align: right">{t.durationMs}ms</td>
                  <td style="color: var(--text-muted); font-size: 12.5px">
                    {t.error || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div class="admin-ap-empty">
            No ticks have run yet. The first tick fires after the interval
            elapses. Click "Run tick now" to fire one immediately.
          </div>
        )}
        <p class="admin-ap-foot">
          Opt out with env <code>AUTOPILOT_DISABLED=1</code>. Adjust cadence
          with <code>AUTOPILOT_INTERVAL_MS</code> (milliseconds).
        </p>
      </div>
      <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
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

export default admin;

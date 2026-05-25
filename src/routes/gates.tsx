/**
 * Gates UI — gate run history + branch protection settings + repo settings toggles.
 *
 *   GET  /:owner/:repo/gates                   — per-repo gate run history
 *   GET  /:owner/:repo/gates/settings          — settings toggles + branch protection (owner-only)
 *   POST /:owner/:repo/gates/settings          — save toggles
 *   POST /:owner/:repo/gates/protection        — save/update branch protection rule
 *   POST /:owner/:repo/gates/protection/:id/delete — remove a protection rule
 *   POST /:owner/:repo/gates/run               — manually trigger a gate run on the default branch
 *
 * 2026 polish: hero + status card pattern shared with admin-integrations / admin-ops
 * / settings-2fa. Every selector scoped under `.gates-` so it cannot bleed into any
 * other surface. Form actions, validation, POST handlers, and audit hooks are
 * preserved verbatim — this is a security-critical surface.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  branchProtection,
  gateRuns,
  repoSettings,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getOrCreateSettings } from "../lib/repo-bootstrap";
import { getUnreadCount } from "../lib/unread";
import { audit } from "../lib/notify";

const gates = new Hono<AuthEnv>();
gates.use("*", softAuth);

async function loadRepo(owner: string, repo: string) {
  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
      ownerId: repositories.ownerId,
      starCount: repositories.starCount,
      forkCount: repositories.forkCount,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  return row;
}

function relTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - t.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return t.toLocaleDateString();
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.gates-` so this surface can't bleed
 * into other repo settings pages. Mirrors the gradient-hairline hero +
 * status card patterns from admin-integrations.tsx / admin-ops.tsx /
 * settings-2fa.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const gatesStyles = `
  .gates-wrap { max-width: 980px; margin: 0 auto; padding: var(--space-4) 0; }

  .gates-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .gates-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .gates-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .gates-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .gates-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .gates-eyebrow {
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
  .gates-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .gates-title {
    font-size: clamp(26px, 3.6vw, 36px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .gates-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .gates-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .gates-hero-link {
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
  .gates-hero-link:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  .gates-banner {
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
  .gates-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .gates-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Status card (top-of-page summary) ─── */
  .gates-status {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .gates-status.is-on {
    border-color: rgba(52,211,153,0.32);
    background: linear-gradient(135deg, rgba(52,211,153,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .gates-status.is-warn {
    border-color: rgba(248,113,113,0.32);
    background: linear-gradient(135deg, rgba(248,113,113,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .gates-status.is-empty {
    border-color: rgba(251,191,36,0.30);
    background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .gates-status-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .gates-status-mark {
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
  .gates-status.is-on .gates-status-mark {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    box-shadow: 0 8px 20px -8px rgba(16,185,129,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .gates-status.is-warn .gates-status-mark {
    background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
    box-shadow: 0 8px 20px -8px rgba(239,68,68,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .gates-status.is-empty .gates-status-mark {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    color: #1a1206;
    box-shadow: 0 8px 20px -8px rgba(251,191,36,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .gates-status-text { flex: 1; min-width: 220px; }
  .gates-status-headline {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .gates-status-desc {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .gates-status-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  /* ─── Stat grid ─── */
  .gates-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: var(--space-5);
  }
  @media (max-width: 640px) {
    .gates-stats { grid-template-columns: repeat(2, 1fr); }
  }
  .gates-stat {
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .gates-stat::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: currentColor;
    opacity: 0.55;
  }
  .gates-stat.is-pass { color: #34d399; }
  .gates-stat.is-repaired { color: #b69dff; }
  .gates-stat.is-fail { color: #f87171; }
  .gates-stat.is-skipped { color: var(--text-muted); }
  .gates-stat-num {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1;
    color: currentColor;
  }
  .gates-stat-label {
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  /* ─── Section card ─── */
  .gates-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .gates-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .gates-section-title {
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
  .gates-section-icon {
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
  .gates-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .gates-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Gate run rows ─── */
  .gates-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .gates-run {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .gates-run:hover {
    border-color: rgba(140,109,255,0.30);
    transform: translateY(-1px);
  }
  .gates-run-light {
    flex-shrink: 0;
    margin-top: 6px;
    width: 10px; height: 10px;
    border-radius: 9999px;
    background: #6b7280;
    box-shadow: 0 0 0 3px rgba(107,114,128,0.18);
  }
  .gates-run-light.is-pass { background: #34d399; box-shadow: 0 0 0 3px rgba(52,211,153,0.22), 0 0 8px rgba(52,211,153,0.40); }
  .gates-run-light.is-fail { background: #f87171; box-shadow: 0 0 0 3px rgba(248,113,113,0.22), 0 0 10px rgba(248,113,113,0.45); }
  .gates-run-light.is-repaired { background: #b69dff; box-shadow: 0 0 0 3px rgba(140,109,255,0.22), 0 0 8px rgba(140,109,255,0.40); }
  .gates-run-body { flex: 1; min-width: 0; }
  .gates-run-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .gates-run-name {
    font-weight: 600;
    color: var(--text-strong);
    font-size: 14px;
  }
  .gates-run-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-radius: 9999px;
  }
  .gates-run-pill.is-pass { background: rgba(52,211,153,0.14); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }
  .gates-run-pill.is-fail { background: rgba(248,113,113,0.14); color: #fecaca; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30); }
  .gates-run-pill.is-repaired { background: rgba(140,109,255,0.14); color: #c4b5fd; box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30); }
  .gates-run-pill.is-skipped { background: rgba(255,255,255,0.04); color: var(--text-muted); box-shadow: inset 0 0 0 1px var(--border); }
  .gates-run-meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .gates-run-meta a { color: var(--accent); text-decoration: none; }
  .gates-run-meta a:hover { text-decoration: underline; }
  .gates-run-meta code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }
  .gates-run-summary {
    margin-top: 6px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .gates-run-repair {
    margin-top: 6px;
    font-size: 12px;
    color: #c4b5fd;
  }
  .gates-run-repair a { color: inherit; text-decoration: underline; }

  /* ─── Empty state ─── */
  .gates-empty {
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    position: relative;
    overflow: hidden;
  }
  .gates-empty-orb {
    position: absolute;
    inset: -30% auto auto -10%;
    width: 260px; height: 260px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    opacity: 0.8;
    pointer-events: none;
  }
  .gates-empty-mark {
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
  .gates-empty-title {
    position: relative;
    z-index: 1;
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .gates-empty-body {
    position: relative;
    z-index: 1;
    margin: 0 auto;
    max-width: 440px;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }

  /* ─── Toggle list (settings page) ─── */
  .gates-toggles {
    display: flex;
    flex-direction: column;
  }
  .gates-toggle {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 16px;
    border-top: 1px solid var(--border);
    cursor: pointer;
    transition: background 120ms ease;
  }
  .gates-toggle:first-child { border-top: none; }
  .gates-toggle:hover { background: rgba(140,109,255,0.04); }
  .gates-toggle-input {
    margin-top: 3px;
    flex-shrink: 0;
    width: 18px; height: 18px;
    accent-color: #8c6dff;
    cursor: pointer;
  }
  .gates-toggle-text { flex: 1; min-width: 0; }
  .gates-toggle-name {
    font-weight: 600;
    color: var(--text-strong);
    font-size: 14px;
  }
  .gates-toggle-desc {
    margin-top: 3px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* ─── Protection rule cards ─── */
  .gates-rule {
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-bottom: 10px;
    transition: border-color 140ms ease;
  }
  .gates-rule:hover { border-color: rgba(140,109,255,0.28); }
  .gates-rule-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .gates-rule-pattern {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    background: rgba(140,109,255,0.10);
    border: 1px solid rgba(140,109,255,0.30);
    padding: 3px 10px;
    border-radius: 8px;
    font-weight: 600;
  }
  .gates-chips {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .gates-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 9999px;
    background: rgba(255,255,255,0.04);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .gates-chip.is-on {
    background: rgba(52,211,153,0.12);
    color: #6ee7b7;
    border-color: rgba(52,211,153,0.30);
  }
  .gates-chip.is-warn {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    border-color: rgba(251,191,36,0.30);
  }
  .gates-rule-actions {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .gates-rule-actions form { margin: 0; }

  /* ─── Form card ─── */
  .gates-form {
    padding: var(--space-5);
  }
  .gates-form-group { margin-bottom: var(--space-4); }
  .gates-form-group:last-child { margin-bottom: 0; }
  .gates-form-label {
    display: block;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .gates-input,
  .gates-select {
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
  .gates-input:focus,
  .gates-select:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .gates-number {
    width: 80px;
    text-align: center;
  }
  .gates-checkrow {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .gates-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 11px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--text);
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .gates-checkbox:hover { border-color: rgba(140,109,255,0.45); background: rgba(140,109,255,0.06); }
  .gates-checkbox input { accent-color: #8c6dff; cursor: pointer; }
  .gates-checkbox.is-num { gap: 8px; padding: 4px 8px 4px 11px; }

  /* ─── Buttons ─── */
  .gates-btn {
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
  .gates-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .gates-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .gates-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .gates-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .gates-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .gates-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
    text-decoration: none;
  }
  .gates-btn-sm { padding: 6px 11px; font-size: 12px; }
`;

/* ─── Inline icons (decorative — aria-hidden) ─── */
const ShieldGlyph = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
);
const WarnGlyph = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);
const EmptyGlyph = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);
const CogGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const ArrowLeft = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </svg>
);
const PlayGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);
const LockGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const SparkleGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 2l1.6 5.2L19 9l-5.4 1.8L12 16l-1.6-5.2L5 9l5.4-1.8L12 2z" />
  </svg>
);
const RocketGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
  </svg>
);
const HammerGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 7l5 5-9 9-5-5 9-9z" />
    <path d="M17 4l3 3" />
  </svg>
);

function statusClass(status: string): "is-pass" | "is-fail" | "is-repaired" | "is-skipped" {
  if (status === "passed") return "is-pass";
  if (status === "failed") return "is-fail";
  if (status === "repaired") return "is-repaired";
  return "is-skipped";
}

// ---------- Gate run history ----------

gates.get("/:owner/:repo/gates", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const runs = await db
    .select()
    .from(gateRuns)
    .where(eq(gateRuns.repositoryId, repoRow.id))
    .orderBy(desc(gateRuns.createdAt))
    .limit(100);

  const unread = user ? await getUnreadCount(user.id) : 0;
  const total = runs.length;
  const passed = runs.filter((r) => r.status === "passed").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const repaired = runs.filter((r) => r.status === "repaired").length;
  const skipped = runs.filter((r) => r.status === "skipped").length;

  const lastRun = runs[0];
  let statusVariant: "is-on" | "is-warn" | "is-empty" = "is-empty";
  let statusHead = "No gate runs yet";
  let statusDesc = "Push a commit to trigger the full green ecosystem — every enabled gate runs automatically.";
  let statusMark = <EmptyGlyph />;
  if (lastRun) {
    if (lastRun.status === "passed" || lastRun.status === "repaired") {
      statusVariant = "is-on";
      statusHead = `All clear · ${total} run${total === 1 ? "" : "s"} on file`;
      statusDesc = `Latest: ${lastRun.gateName} ${lastRun.status} on ${lastRun.commitSha.slice(0, 7)} (${relTime(lastRun.createdAt)}).`;
      statusMark = <ShieldGlyph />;
    } else if (lastRun.status === "failed") {
      statusVariant = "is-warn";
      statusHead = `${failed} failing · ${total} total`;
      statusDesc = `Latest: ${lastRun.gateName} failed on ${lastRun.commitSha.slice(0, 7)} (${relTime(lastRun.createdAt)}).`;
      statusMark = <WarnGlyph />;
    } else {
      statusVariant = "is-empty";
      statusHead = `${total} run${total === 1 ? "" : "s"} recorded`;
      statusDesc = `Latest: ${lastRun.gateName} ${lastRun.status} on ${lastRun.commitSha.slice(0, 7)} (${relTime(lastRun.createdAt)}).`;
    }
  }

  return c.html(
    <Layout
      title={`Gates — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="gates" />

      <div class="gates-wrap">
        <section class="gates-hero">
          <div class="gates-hero-orb" aria-hidden="true" />
          <div class="gates-hero-inner">
            <div class="gates-hero-text">
              <div class="gates-eyebrow">
                <span class="gates-eyebrow-pill" aria-hidden="true">
                  <ShieldGlyph />
                </span>
                Gates · {owner}/{repo}
              </div>
              <h1 class="gates-title">
                <span class="gates-title-grad">Push-time guards.</span>
              </h1>
              <p class="gates-sub">
                Every gate that ran against this repository — passing, failing,
                or auto-repaired. Configure which gates are enforced under
                settings.
              </p>
            </div>
            {user && user.id === repoRow.ownerId && (
              <a
                href={`/${owner}/${repo}/gates/settings`}
                class="gates-hero-link"
              >
                <CogGlyph /> Settings
              </a>
            )}
          </div>
        </section>

        <section class={`gates-status ${statusVariant}`}>
          <div class="gates-status-row">
            <span class="gates-status-mark" aria-hidden="true">
              {statusMark}
            </span>
            <div class="gates-status-text">
              <h2 class="gates-status-headline">{statusHead}</h2>
              <p class="gates-status-desc">{statusDesc}</p>
            </div>
          </div>
        </section>

        <div class="gates-stats">
          <div class="gates-stat is-pass">
            <div class="gates-stat-num">{passed}</div>
            <div class="gates-stat-label">Passed</div>
          </div>
          <div class="gates-stat is-repaired">
            <div class="gates-stat-num">{repaired}</div>
            <div class="gates-stat-label">Repaired</div>
          </div>
          <div class="gates-stat is-fail">
            <div class="gates-stat-num">{failed}</div>
            <div class="gates-stat-label">Failed</div>
          </div>
          <div class="gates-stat is-skipped">
            <div class="gates-stat-num">{skipped}</div>
            <div class="gates-stat-label">Skipped</div>
          </div>
        </div>

        {total === 0 ? (
          <div class="gates-empty">
            <div class="gates-empty-orb" aria-hidden="true" />
            <div class="gates-empty-mark" aria-hidden="true">
              <ShieldGlyph />
            </div>
            <h3 class="gates-empty-title">No gate runs yet</h3>
            <p class="gates-empty-body">
              Gates fire automatically on every push. Configure which gates are
              enabled in settings, then push a commit to see the green light
              show up here.
            </p>
          </div>
        ) : (
          <div class="gates-list">
            {runs.map((r) => (
              <div class="gates-run">
                <span class={`gates-run-light ${statusClass(r.status)}`} aria-hidden="true" />
                <div class="gates-run-body">
                  <div class="gates-run-head">
                    <span class="gates-run-name">{r.gateName}</span>
                    <span class={`gates-run-pill ${statusClass(r.status)}`}>
                      {r.status}
                    </span>
                  </div>
                  <div class="gates-run-meta">
                    <a href={`/${owner}/${repo}/commit/${r.commitSha}`}>
                      <code>{r.commitSha.slice(0, 7)}</code>
                    </a>
                    <span>·</span>
                    <span>{r.ref.replace(/^refs\/heads\//, "")}</span>
                    <span>·</span>
                    <span title={typeof r.createdAt === "string" ? r.createdAt : (r.createdAt as Date).toISOString()}>
                      {relTime(r.createdAt)}
                    </span>
                    {r.durationMs ? (
                      <>
                        <span>·</span>
                        <span>{(r.durationMs / 1000).toFixed(1)}s</span>
                      </>
                    ) : null}
                  </div>
                  {r.summary && <div class="gates-run-summary">{r.summary}</div>}
                  {r.repairCommitSha && (
                    <div class="gates-run-repair">
                      Auto-repaired in{" "}
                      <a href={`/${owner}/${repo}/commit/${r.repairCommitSha}`}>
                        {r.repairCommitSha.slice(0, 7)}
                      </a>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: gatesStyles }} />
    </Layout>
  );
});

// ---------- Settings UI ----------

gates.get("/:owner/:repo/gates/settings", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/gates`);

  const settings = await getOrCreateSettings(repoRow.id);
  const protections = await db
    .select()
    .from(branchProtection)
    .where(eq(branchProtection.repositoryId, repoRow.id));

  const unread = await getUnreadCount(user.id);
  const success = c.req.query("success");

  // Count of enabled gates for the status card
  const enabledGateCount = [
    settings!.gateTestEnabled,
    settings!.aiReviewEnabled,
    settings!.secretScanEnabled,
    settings!.securityScanEnabled,
    settings!.dependencyScanEnabled,
    settings!.lintEnabled,
    settings!.typeCheckEnabled,
    settings!.testEnabled,
  ].filter(Boolean).length;
  const totalGateCount = 8;

  const statusVariant = enabledGateCount === 0 ? "is-warn" : "is-on";
  const statusHead =
    enabledGateCount === 0
      ? "No gates active"
      : `${enabledGateCount} of ${totalGateCount} gates active`;
  const statusDesc =
    enabledGateCount === 0
      ? "Pushes are accepted without any push-time validation. Enable at least one gate below."
      : `${protections.length} branch protection rule${protections.length === 1 ? "" : "s"} · auto-repair ${settings!.autoFixEnabled ? "on" : "off"}.`;

  const toggle = (
    name: string,
    label: string,
    checked: boolean,
    desc?: string
  ) => (
    <label class="gates-toggle">
      <input
        type="checkbox"
        name={name}
        value="1"
        checked={checked}
        aria-label={label}
        class="gates-toggle-input"
      />
      <div class="gates-toggle-text">
        <div class="gates-toggle-name">{label}</div>
        {desc && <div class="gates-toggle-desc">{desc}</div>}
      </div>
    </label>
  );

  return c.html(
    <Layout
      title={`Gate settings — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user.username}
      />
      <RepoNav owner={owner} repo={repo} active="gates" />

      <div class="gates-wrap">
        <section class="gates-hero">
          <div class="gates-hero-orb" aria-hidden="true" />
          <div class="gates-hero-inner">
            <div class="gates-hero-text">
              <div class="gates-eyebrow">
                <span class="gates-eyebrow-pill" aria-hidden="true">
                  <ShieldGlyph />
                </span>
                Gate settings · {owner}/{repo}
              </div>
              <h1 class="gates-title">
                <span class="gates-title-grad">Wire the gates.</span>
              </h1>
              <p class="gates-sub">
                Toggle which gates run on every push, configure auto-repair, and
                lock down release branches with protection rules.
              </p>
            </div>
            <a href={`/${owner}/${repo}/gates`} class="gates-hero-link">
              <ArrowLeft /> Back to runs
            </a>
          </div>
        </section>

        {success && (
          <div class="gates-banner is-ok" role="status">
            <span class="gates-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}

        <section class={`gates-status ${statusVariant}`}>
          <div class="gates-status-row">
            <span class="gates-status-mark" aria-hidden="true">
              {enabledGateCount === 0 ? <WarnGlyph /> : <ShieldGlyph />}
            </span>
            <div class="gates-status-text">
              <h2 class="gates-status-headline">{statusHead}</h2>
              <p class="gates-status-desc">{statusDesc}</p>
            </div>
          </div>
        </section>

        <form method="post" action={`/${owner}/${repo}/gates/settings`}>
          <section class="gates-section">
            <header class="gates-section-head">
              <h3 class="gates-section-title">
                <span class="gates-section-icon" aria-hidden="true">
                  <ShieldGlyph />
                </span>
                Gates
              </h3>
              <p class="gates-section-sub">
                Every push runs the gates checked here. Failed gates can
                optionally auto-repair below.
              </p>
            </header>
            <div class="gates-toggles">
              {toggle("gateTestEnabled", "GateTest scan", settings!.gateTestEnabled, "External test/lint runner")}
              {toggle("aiReviewEnabled", "AI code review", settings!.aiReviewEnabled, "Claude reviews every PR")}
              {toggle("secretScanEnabled", "Secret scan", settings!.secretScanEnabled, "Regex + AI secret detection on every push")}
              {toggle("securityScanEnabled", "Security scan", settings!.securityScanEnabled, "Claude-powered semantic security review")}
              {toggle("dependencyScanEnabled", "Dependency scan", settings!.dependencyScanEnabled, "Vulnerability scanning on lockfiles")}
              {toggle("lintEnabled", "Lint", settings!.lintEnabled, "Auto-lint every push")}
              {toggle("typeCheckEnabled", "Type check", settings!.typeCheckEnabled)}
              {toggle("testEnabled", "Tests", settings!.testEnabled, "Run your test suite on every push")}
            </div>
          </section>

          <section class="gates-section">
            <header class="gates-section-head">
              <h3 class="gates-section-title">
                <span class="gates-section-icon" aria-hidden="true">
                  <HammerGlyph />
                </span>
                Auto-repair
              </h3>
              <p class="gates-section-sub">
                Let Claude attempt a fix before pinging a human.
              </p>
            </header>
            <div class="gates-toggles">
              {toggle("autoFixEnabled", "Auto-fix failing gates", settings!.autoFixEnabled, "Claude attempts a fix before a human is pinged")}
              {toggle("autoMergeResolveEnabled", "Auto-resolve merge conflicts", settings!.autoMergeResolveEnabled)}
              {toggle("autoFormatEnabled", "Auto-format on commit", settings!.autoFormatEnabled)}
            </div>
          </section>

          <section class="gates-section">
            <header class="gates-section-head">
              <h3 class="gates-section-title">
                <span class="gates-section-icon" aria-hidden="true">
                  <SparkleGlyph />
                </span>
                AI features
              </h3>
              <p class="gates-section-sub">
                Optional AI assistance for human-facing artefacts.
              </p>
            </header>
            <div class="gates-toggles">
              {toggle("aiCommitMessagesEnabled", "AI commit messages", settings!.aiCommitMessagesEnabled)}
              {toggle("aiPrSummaryEnabled", "AI PR summaries", settings!.aiPrSummaryEnabled)}
              {toggle("aiChangelogEnabled", "AI release changelogs", settings!.aiChangelogEnabled)}
            </div>
          </section>

          <section class="gates-section">
            <header class="gates-section-head">
              <h3 class="gates-section-title">
                <span class="gates-section-icon" aria-hidden="true">
                  <RocketGlyph />
                </span>
                Deploy
              </h3>
              <p class="gates-section-sub">
                Control whether green pushes deploy themselves.
              </p>
            </header>
            <div class="gates-toggles">
              {toggle("autoDeployEnabled", "Auto-deploy on green pushes to default branch", settings!.autoDeployEnabled)}
              {toggle("deployRequireAllGreen", "Block deploys unless all gates are green", settings!.deployRequireAllGreen)}
            </div>
          </section>

          <div style="display:flex;gap:8px;align-items:center;margin-bottom:var(--space-5)">
            <button type="submit" class="gates-btn gates-btn-primary">
              <PlayGlyph /> Save settings
            </button>
            <span style="font-size:12px;color:var(--text-muted)">
              Changes apply on the next push.
            </span>
          </div>
        </form>

        <section class="gates-section">
          <header class="gates-section-head">
            <h3 class="gates-section-title">
              <span class="gates-section-icon" aria-hidden="true">
                <LockGlyph />
              </span>
              Branch protection
            </h3>
            <p class="gates-section-sub">
              The default branch is protected on every new repo. Add extra rules
              for release branches — required PRs, green gates, AI approval,
              human reviewers, no force push.
            </p>
          </header>
          <div class="gates-section-body">
            {protections.length === 0 ? (
              <div class="gates-empty" style="padding:var(--space-5)">
                <div class="gates-empty-mark" aria-hidden="true">
                  <LockGlyph />
                </div>
                <h4 class="gates-empty-title">No protection rules yet</h4>
                <p class="gates-empty-body">
                  Add a rule below to gate merges into <code>main</code>,{" "}
                  <code>release/*</code>, or any glob you choose.
                </p>
              </div>
            ) : (
              protections.map((p) => (
                <div class="gates-rule">
                  <div class="gates-rule-head">
                    <span class="gates-rule-pattern">{p.pattern}</span>
                    <div class="gates-rule-actions">
                      <a
                        href={`/${owner}/${repo}/gates/protection/${p.id}/checks`}
                        class="gates-btn gates-btn-ghost gates-btn-sm"
                        title="Manage required status checks for this rule"
                      >
                        Required checks
                      </a>
                      <form
                        method="post"
                        action={`/${owner}/${repo}/gates/protection/${p.id}/delete`}
                        onsubmit="return confirm('Remove this rule?')"
                      >
                        <button type="submit" class="gates-btn gates-btn-danger gates-btn-sm">
                          Remove
                        </button>
                      </form>
                    </div>
                  </div>
                  <div class="gates-chips">
                    {p.requirePullRequest && <span class="gates-chip is-on">PR required</span>}
                    {p.requireGreenGates && <span class="gates-chip is-on">Green gates</span>}
                    {p.requireAiApproval && <span class="gates-chip is-on">AI approval</span>}
                    {p.requireHumanReview && (
                      <span class="gates-chip is-on">
                        {p.requiredApprovals} human approval{p.requiredApprovals === 1 ? "" : "s"}
                      </span>
                    )}
                    {p.enableAutoMerge && <span class="gates-chip is-on">AI auto-merge</span>}
                    {!p.allowForcePush && <span class="gates-chip">No force push</span>}
                    {!p.allowDeletion && <span class="gates-chip">No deletion</span>}
                    {p.allowForcePush && <span class="gates-chip is-warn">Force push allowed</span>}
                    {p.allowDeletion && <span class="gates-chip is-warn">Deletion allowed</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section class="gates-section">
          <header class="gates-section-head">
            <h3 class="gates-section-title">
              <span class="gates-section-icon" aria-hidden="true">
                <PlayGlyph />
              </span>
              Add protection rule
            </h3>
            <p class="gates-section-sub">
              Pattern matches branch names (supports globs like{" "}
              <code>release/*</code>).
            </p>
          </header>
          <form
            method="post"
            action={`/${owner}/${repo}/gates/protection`}
            class="gates-form"
          >
            <div class="gates-form-group">
              <label class="gates-form-label" for="gates-pattern">Pattern</label>
              <input
                type="text"
                name="pattern"
                id="gates-pattern"
                required
                placeholder="release/* or main"
                aria-label="Branch protection pattern"
                class="gates-input"
              />
            </div>
            <div class="gates-form-group">
              <label class="gates-form-label">Requirements</label>
              <div class="gates-checkrow">
                <label class="gates-checkbox">
                  <input type="checkbox" name="requirePullRequest" value="1" checked />
                  Require PR
                </label>
                <label class="gates-checkbox">
                  <input type="checkbox" name="requireGreenGates" value="1" checked />
                  Require green gates
                </label>
                <label class="gates-checkbox">
                  <input type="checkbox" name="requireAiApproval" value="1" checked />
                  Require AI approval
                </label>
                <label class="gates-checkbox">
                  <input type="checkbox" name="requireHumanReview" value="1" />
                  Require human review
                </label>
                <label class="gates-checkbox is-num">
                  Approvals
                  <input
                    type="number"
                    name="requiredApprovals"
                    min="0"
                    max="10"
                    value="1"
                    class="gates-input gates-number"
                  />
                </label>
                <label class="gates-checkbox">
                  <input type="checkbox" name="allowForcePush" value="1" />
                  Allow force push
                </label>
                <label class="gates-checkbox">
                  <input type="checkbox" name="allowDeletion" value="1" />
                  Allow deletion
                </label>
                <label
                  class="gates-checkbox"
                  title="K2 — Let the autopilot ticker auto-merge PRs that pass every gate this rule enforces."
                >
                  <input type="checkbox" name="enableAutoMerge" value="1" />
                  Enable AI auto-merge
                </label>
              </div>
            </div>
            <button type="submit" class="gates-btn gates-btn-primary">
              <LockGlyph /> Add rule
            </button>
          </form>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: gatesStyles }} />
    </Layout>
  );
});

gates.post("/:owner/:repo/gates/settings", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/gates`);

  const body = await c.req.parseBody();
  const b = (k: string) => body[k] === "1" || body[k] === "on";

  try {
    await db
      .update(repoSettings)
      .set({
        gateTestEnabled: b("gateTestEnabled"),
        aiReviewEnabled: b("aiReviewEnabled"),
        secretScanEnabled: b("secretScanEnabled"),
        securityScanEnabled: b("securityScanEnabled"),
        dependencyScanEnabled: b("dependencyScanEnabled"),
        lintEnabled: b("lintEnabled"),
        typeCheckEnabled: b("typeCheckEnabled"),
        testEnabled: b("testEnabled"),
        autoFixEnabled: b("autoFixEnabled"),
        autoMergeResolveEnabled: b("autoMergeResolveEnabled"),
        autoFormatEnabled: b("autoFormatEnabled"),
        aiCommitMessagesEnabled: b("aiCommitMessagesEnabled"),
        aiPrSummaryEnabled: b("aiPrSummaryEnabled"),
        aiChangelogEnabled: b("aiChangelogEnabled"),
        autoDeployEnabled: b("autoDeployEnabled"),
        deployRequireAllGreen: b("deployRequireAllGreen"),
        updatedAt: new Date(),
      })
      .where(eq(repoSettings.repositoryId, repoRow.id));
  } catch (err) {
    console.error("[gates] settings save:", err);
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "gates.settings.update",
  });

  return c.redirect(
    `/${owner}/${repo}/gates/settings?success=Settings+saved`
  );
});

gates.post("/:owner/:repo/gates/protection", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/gates`);

  const body = await c.req.parseBody();
  const pattern = String(body.pattern || "").trim();
  if (!pattern) return c.redirect(`/${owner}/${repo}/gates/settings`);
  const b = (k: string) => body[k] === "1" || body[k] === "on";
  const requiredApprovals = Math.max(
    0,
    Math.min(10, parseInt(String(body.requiredApprovals || "0"), 10) || 0)
  );

  try {
    await db.insert(branchProtection).values({
      repositoryId: repoRow.id,
      pattern,
      requirePullRequest: b("requirePullRequest"),
      requireGreenGates: b("requireGreenGates"),
      requireAiApproval: b("requireAiApproval"),
      requireHumanReview: b("requireHumanReview"),
      requiredApprovals,
      allowForcePush: b("allowForcePush"),
      allowDeletion: b("allowDeletion"),
      // K2 — opt-in flag for the autopilot auto-merger.
      enableAutoMerge: b("enableAutoMerge"),
    });
  } catch (err) {
    console.error("[gates] protection save:", err);
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "branch_protection.create",
    metadata: { pattern },
  });

  return c.redirect(
    `/${owner}/${repo}/gates/settings?success=Rule+added`
  );
});

gates.post(
  "/:owner/:repo/gates/protection/:id/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/gates`);
    await db
      .delete(branchProtection)
      .where(
        and(
          eq(branchProtection.id, id),
          eq(branchProtection.repositoryId, repoRow.id)
        )
      );
    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "branch_protection.delete",
      targetId: id,
    });
    return c.redirect(`/${owner}/${repo}/gates/settings?success=Rule+removed`);
  }
);

export default gates;

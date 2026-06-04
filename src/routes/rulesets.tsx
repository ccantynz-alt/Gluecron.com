/**
 * Block J6 — Ruleset management UI.
 *
 *   GET  /:owner/:repo/settings/rulesets            — list + create
 *   POST /:owner/:repo/settings/rulesets            — create
 *   GET  /:owner/:repo/settings/rulesets/:id        — detail, add rules
 *   POST /:owner/:repo/settings/rulesets/:id        — update enforcement
 *   POST /:owner/:repo/settings/rulesets/:id/delete
 *   POST /:owner/:repo/settings/rulesets/:id/rules  — add rule
 *   POST /:owner/:repo/settings/rulesets/:id/rules/:rid/delete
 *
 * 2026 polish: scoped under `.rs-` selectors. Form actions, validation, and
 * audit logging are preserved verbatim — this is a security-critical surface.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { audit } from "../lib/notify";
import {
  RULE_TYPES,
  addRule,
  createRuleset,
  deleteRule,
  deleteRuleset,
  getRuleset,
  listRulesetsForRepo,
  parseParams,
  updateRulesetEnforcement,
} from "../lib/rulesets";

const rulesets = new Hono<AuthEnv>();
rulesets.use("*", softAuth);

async function gate(c: any) {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return c.notFound();
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return c.notFound();
  if (user.id !== repo.ownerId) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }
  return { user, owner, repo, ownerName, repoName };
}

function ruleDescription(type: string, params: Record<string, unknown>): string {
  switch (type) {
    case "commit_message_pattern":
      return `commit message ${params.require === false ? "MUST NOT" : "must"} match /${params.pattern || ""}/`;
    case "branch_name_pattern":
      return `branch name ${params.require === false ? "MUST NOT" : "must"} match /${params.pattern || ""}/`;
    case "tag_name_pattern":
      return `tag name ${params.require === false ? "MUST NOT" : "must"} match /${params.pattern || ""}/`;
    case "blocked_file_paths":
      return `blocks changes to: ${(params.paths as string[] | undefined)?.join(", ") || "(none)"}`;
    case "max_file_size":
      return `max blob size ${params.bytes || 0}B`;
    case "forbid_force_push":
      return "force push forbidden";
    default:
      return type;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every selector under `.rs-` so this surface can't leak.
 * ───────────────────────────────────────────────────────────────────── */
const rsStyles = `
  .rs-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-4) 0; }

  .rs-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .rs-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .rs-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .rs-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .rs-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .rs-eyebrow {
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
  .rs-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .rs-title {
    font-size: clamp(26px, 3.6vw, 36px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .rs-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .rs-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .rs-hero-link {
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
  .rs-hero-link:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  .rs-banner {
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
  .rs-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .rs-banner.is-error { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }
  .rs-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* ─── Status card ─── */
  .rs-status {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .rs-status.is-on {
    border-color: rgba(52,211,153,0.32);
    background: linear-gradient(135deg, rgba(52,211,153,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .rs-status.is-warn {
    border-color: rgba(248,113,113,0.32);
    background: linear-gradient(135deg, rgba(248,113,113,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .rs-status.is-empty {
    border-color: rgba(251,191,36,0.30);
    background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .rs-status-row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .rs-status-mark {
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
  .rs-status.is-on .rs-status-mark {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    box-shadow: 0 8px 20px -8px rgba(16,185,129,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .rs-status.is-warn .rs-status-mark {
    background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
    box-shadow: 0 8px 20px -8px rgba(239,68,68,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .rs-status.is-empty .rs-status-mark {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    color: #1a1206;
    box-shadow: 0 8px 20px -8px rgba(251,191,36,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .rs-status-text { flex: 1; min-width: 220px; }
  .rs-status-headline {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .rs-status-desc { margin: 0; font-size: 13.5px; color: var(--text-muted); line-height: 1.5; }

  /* ─── Section card ─── */
  .rs-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .rs-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .rs-section-title {
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
  .rs-section-icon {
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
  .rs-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .rs-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Ruleset cards ─── */
  .rs-list { display: flex; flex-direction: column; gap: 10px; }
  .rs-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    text-decoration: none;
    color: inherit;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .rs-item:hover { border-color: rgba(140,109,255,0.30); transform: translateY(-1px); text-decoration: none; }
  .rs-item-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .rs-item-name { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--text-strong); letter-spacing: -0.012em; }
  .rs-item-meta { margin-top: 4px; font-size: 12px; color: var(--text-muted); }

  /* ─── Enforcement pills ─── */
  .rs-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-radius: 9999px;
  }
  .rs-pill.is-active { background: rgba(248,113,113,0.14); color: #fecaca; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32); }
  .rs-pill.is-evaluate { background: rgba(251,191,36,0.14); color: #fde68a; box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32); }
  .rs-pill.is-disabled { background: rgba(255,255,255,0.04); color: var(--text-muted); box-shadow: inset 0 0 0 1px var(--border); }
  .rs-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }

  .rs-chip {
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

  /* ─── Rule rows ─── */
  .rs-rule {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 12px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 8px;
  }
  .rs-rule:last-child { margin-bottom: 0; }
  .rs-rule-body { flex: 1; min-width: 0; }
  .rs-rule-type {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 5px;
    background: rgba(140,109,255,0.10);
    color: #c4b5fd;
    border: 1px solid rgba(140,109,255,0.25);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 700;
    margin-right: 8px;
  }
  .rs-rule-desc { font-size: 13px; color: var(--text); }

  /* ─── Empty state ─── */
  .rs-empty {
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    position: relative;
    overflow: hidden;
  }
  .rs-empty-orb {
    position: absolute;
    inset: -30% auto auto -10%;
    width: 260px; height: 260px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    opacity: 0.8;
    pointer-events: none;
  }
  .rs-empty-mark {
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
  .rs-empty-title { position: relative; z-index: 1; margin: 0 0 6px; font-family: var(--font-display); font-size: 17px; font-weight: 700; color: var(--text-strong); letter-spacing: -0.018em; }
  .rs-empty-body { position: relative; z-index: 1; margin: 0 auto; max-width: 460px; font-size: 13.5px; color: var(--text-muted); line-height: 1.55; }

  /* ─── Form card ─── */
  .rs-form { padding: var(--space-5); }
  .rs-form-group { margin-bottom: var(--space-4); }
  .rs-form-group:last-of-type { margin-bottom: var(--space-4); }
  .rs-form-label {
    display: block;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .rs-input,
  .rs-select,
  .rs-textarea {
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
  .rs-input:focus,
  .rs-select:focus,
  .rs-textarea:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .rs-textarea { font-size: 12px; line-height: 1.5; }
  .rs-inline-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .rs-inline-form .rs-select { width: auto; min-width: 180px; }
  .rs-form-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .rs-form-hint code { font-family: var(--font-mono); font-size: 11.5px; background: rgba(255,255,255,0.04); border: 1px solid var(--border); padding: 1px 6px; border-radius: 5px; color: var(--text); }

  /* ─── Buttons ─── */
  .rs-btn {
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
  .rs-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .rs-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .rs-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .rs-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .rs-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .rs-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
    text-decoration: none;
  }
  .rs-btn-sm { padding: 6px 11px; font-size: 12px; }

  /* ─── Danger zone ─── */
  .rs-danger {
    margin-top: var(--space-5);
    padding: var(--space-5);
    background: rgba(248,113,113,0.04);
    border: 1px solid rgba(248,113,113,0.30);
    border-radius: 14px;
  }
  .rs-danger h3 {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: #fecaca;
    letter-spacing: -0.012em;
  }
  .rs-danger p { margin: 0 0 var(--space-3); font-size: 12.5px; color: var(--text-muted); line-height: 1.5; }
`;

/* Icons */
const ListIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);
const ShieldIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
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
const SettingsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09c0 .61.36 1.17.92 1.42a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82c.25.56.81.92 1.42.92H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

function enforcementPill(enforcement: string) {
  const cls =
    enforcement === "active"
      ? "is-active"
      : enforcement === "evaluate"
      ? "is-evaluate"
      : "is-disabled";
  return (
    <span class={`rs-pill ${cls}`}>
      <span class="dot" aria-hidden="true" />
      {enforcement}
    </span>
  );
}

// ---------- List + create ----------

rulesets.get("/:owner/:repo/settings/rulesets", requireAuth, requireRepoAccess("admin"), async (c) => {
  const ctx = await gate(c);
  if (ctx instanceof Response) return ctx;
  const { ownerName, repoName, repo, user } = ctx;
  const all = await listRulesetsForRepo(repo.id);
  const message = c.req.query("message");
  const error = c.req.query("error");

  const activeCount = all.filter((rs) => rs.enforcement === "active").length;
  const evaluateCount = all.filter((rs) => rs.enforcement === "evaluate").length;

  let statusVariant: "is-on" | "is-warn" | "is-empty" = "is-empty";
  let statusHead = "No rulesets configured";
  let statusDesc =
    "Pushes are accepted as-is. Add a ruleset below to start enforcing commit-message, branch-name, or file-size policies.";
  let statusMark: any = <ShieldIcon />;
  if (all.length > 0) {
    statusVariant = activeCount > 0 ? "is-on" : "is-warn";
    statusHead = `${all.length} ruleset${all.length === 1 ? "" : "s"} configured`;
    const parts: string[] = [];
    if (activeCount) parts.push(`${activeCount} active`);
    if (evaluateCount) parts.push(`${evaluateCount} evaluate-only`);
    const disabled = all.length - activeCount - evaluateCount;
    if (disabled) parts.push(`${disabled} disabled`);
    statusDesc = parts.join(" · ");
  }

  return c.html(
    <Layout title={`Rulesets — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="settings" />

      <div class="rs-wrap">
        <section class="rs-hero">
          <div class="rs-hero-orb" aria-hidden="true" />
          <div class="rs-hero-inner">
            <div class="rs-hero-text">
              <div class="rs-eyebrow">
                <span class="rs-eyebrow-pill" aria-hidden="true">
                  <ListIcon />
                </span>
                Rulesets · {ownerName}/{repoName}
              </div>
              <h1 class="rs-title">
                <span class="rs-title-grad">Policy engine.</span>
              </h1>
              <p class="rs-sub">
                Extend branch protection with commit-message, branch/tag-name,
                blocked-path, and file-size policies. Enforcement modes:{" "}
                <strong>active</strong> blocks, <strong>evaluate</strong> only
                logs, <strong>disabled</strong> is inert.
              </p>
            </div>
            <a href={`/${ownerName}/${repoName}/settings`} class="rs-hero-link">
              <ArrowLeft /> Back to settings
            </a>
          </div>
        </section>

        {message && (
          <div class="rs-banner is-ok" role="status">
            <span class="rs-banner-dot" aria-hidden="true" />
            {decodeURIComponent(message)}
          </div>
        )}
        {error && (
          <div class="rs-banner is-error" role="alert">
            <span class="rs-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        <section class={`rs-status ${statusVariant}`}>
          <div class="rs-status-row">
            <span class="rs-status-mark" aria-hidden="true">
              {statusMark}
            </span>
            <div class="rs-status-text">
              <h2 class="rs-status-headline">{statusHead}</h2>
              <p class="rs-status-desc">{statusDesc}</p>
            </div>
          </div>
        </section>

        <section class="rs-section">
          <header class="rs-section-head">
            <h3 class="rs-section-title">
              <span class="rs-section-icon" aria-hidden="true">
                <ListIcon />
              </span>
              Existing rulesets
            </h3>
            <p class="rs-section-sub">
              Click into a ruleset to manage rules and change enforcement.
            </p>
          </header>
          <div class="rs-section-body">
            {all.length === 0 ? (
              <div class="rs-empty">
                <div class="rs-empty-orb" aria-hidden="true" />
                <div class="rs-empty-mark" aria-hidden="true">
                  <ListIcon />
                </div>
                <h4 class="rs-empty-title">No rulesets yet</h4>
                <p class="rs-empty-body">
                  Rulesets sit alongside branch protection — they let you
                  enforce per-commit policy (message format, blocked paths, max
                  file size, no force push) across branches and tags.
                </p>
              </div>
            ) : (
              <div class="rs-list">
                {all.map((rs) => (
                  <a
                    href={`/${ownerName}/${repoName}/settings/rulesets/${rs.id}`}
                    class="rs-item"
                  >
                    <div>
                      <div class="rs-item-head">
                        <span class="rs-item-name">{rs.name}</span>
                        {enforcementPill(rs.enforcement)}
                        <span class="rs-chip">
                          {rs.rules.length} rule
                          {rs.rules.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                    <span style="color:var(--text-muted);font-size:18px" aria-hidden="true">→</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </section>

        <section class="rs-section">
          <header class="rs-section-head">
            <h3 class="rs-section-title">
              <span class="rs-section-icon" aria-hidden="true">
                <PlusIcon />
              </span>
              New ruleset
            </h3>
            <p class="rs-section-sub">
              Give it a name, pick an enforcement mode, then add rules on the
              detail page.
            </p>
          </header>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/rulesets`}
            class="rs-form"
          >
            <div class="rs-form-group">
              <label class="rs-form-label" for="rs-name">Name</label>
              <input
                type="text"
                id="rs-name"
                name="name"
                placeholder="e.g. release-branches"
                required
                maxLength={120}
                class="rs-input"
              />
            </div>
            <div class="rs-form-group">
              <label class="rs-form-label" for="rs-enf">Enforcement</label>
              <select id="rs-enf" name="enforcement" required class="rs-select">
                <option value="active">active — block on violation</option>
                <option value="evaluate">evaluate — log only</option>
                <option value="disabled">disabled</option>
              </select>
            </div>
            <button type="submit" class="rs-btn rs-btn-primary">
              <PlusIcon /> Create ruleset
            </button>
          </form>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: rsStyles }} />
    </Layout>
  );
});

rulesets.post("/:owner/:repo/settings/rulesets", requireAuth, requireRepoAccess("admin"), async (c) => {
  const ctx = await gate(c);
  if (ctx instanceof Response) return ctx;
  const { ownerName, repoName, repo, user } = ctx;
  const body = await c.req.parseBody();
  const name = String(body.name || "");
  const enforcement = String(body.enforcement || "active") as
    | "active"
    | "evaluate"
    | "disabled";
  const result = await createRuleset({
    repositoryId: repo.id,
    name,
    enforcement,
    createdBy: user.id,
  });
  const base = `/${ownerName}/${repoName}/settings/rulesets`;
  if (!result.ok) {
    return c.redirect(`${base}?error=${encodeURIComponent(result.error)}`);
  }
  await audit({
    userId: user.id,
    repositoryId: repo.id,
    action: "ruleset.create",
    targetId: result.id,
    metadata: { name, enforcement },
  });
  return c.redirect(`${base}/${result.id}`);
});

// ---------- Detail ----------

rulesets.get(
  "/:owner/:repo/settings/rulesets/:id",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const rs = await getRuleset(id, repo.id);
    if (!rs) return c.notFound();
    const base = `/${ownerName}/${repoName}/settings/rulesets/${id}`;
    const message = c.req.query("message");
    const error = c.req.query("error");

    const statusVariant: "is-on" | "is-warn" | "is-empty" =
      rs.enforcement === "active"
        ? "is-on"
        : rs.enforcement === "evaluate"
        ? "is-warn"
        : "is-empty";
    const statusHead =
      rs.enforcement === "active"
        ? `Active · ${rs.rules.length} rule${rs.rules.length === 1 ? "" : "s"} enforced`
        : rs.enforcement === "evaluate"
        ? `Evaluate-only · ${rs.rules.length} rule${rs.rules.length === 1 ? "" : "s"} logged`
        : `Disabled · ${rs.rules.length} rule${rs.rules.length === 1 ? "" : "s"} inert`;
    const statusDesc =
      rs.enforcement === "active"
        ? "Pushes that violate any rule below are rejected."
        : rs.enforcement === "evaluate"
        ? "Violations are recorded but pushes still go through."
        : "This ruleset does nothing right now. Switch to active or evaluate to use it.";

    return c.html(
      <Layout
        title={`Ruleset ${rs.name} — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="settings" />

        <div class="rs-wrap">
          <section class="rs-hero">
            <div class="rs-hero-orb" aria-hidden="true" />
            <div class="rs-hero-inner">
              <div class="rs-hero-text">
                <div class="rs-eyebrow">
                  <span class="rs-eyebrow-pill" aria-hidden="true">
                    <ShieldIcon />
                  </span>
                  Ruleset · {ownerName}/{repoName}
                </div>
                <h1 class="rs-title">
                  <span class="rs-title-grad">{rs.name}</span>
                </h1>
                <p class="rs-sub">
                  Manage rules and enforcement for this ruleset. Add rules
                  below — each rule type uses a JSON params blob.
                </p>
              </div>
              <a
                href={`/${ownerName}/${repoName}/settings/rulesets`}
                class="rs-hero-link"
              >
                <ArrowLeft /> All rulesets
              </a>
            </div>
          </section>

          {message && (
            <div class="rs-banner is-ok" role="status">
              <span class="rs-banner-dot" aria-hidden="true" />
              {decodeURIComponent(message)}
            </div>
          )}
          {error && (
            <div class="rs-banner is-error" role="alert">
              <span class="rs-banner-dot" aria-hidden="true" />
              {decodeURIComponent(error)}
            </div>
          )}

          <section class={`rs-status ${statusVariant}`}>
            <div class="rs-status-row">
              <span class="rs-status-mark" aria-hidden="true">
                <ShieldIcon />
              </span>
              <div class="rs-status-text">
                <h2 class="rs-status-headline">{statusHead}</h2>
                <p class="rs-status-desc">{statusDesc}</p>
              </div>
              {enforcementPill(rs.enforcement)}
            </div>
          </section>

          <section class="rs-section">
            <header class="rs-section-head">
              <h3 class="rs-section-title">
                <span class="rs-section-icon" aria-hidden="true">
                  <SettingsIcon />
                </span>
                Enforcement mode
              </h3>
              <p class="rs-section-sub">
                Change how this ruleset behaves on push.
              </p>
            </header>
            <div class="rs-section-body">
              <form method="post" action={base} class="rs-inline-form">
                <select name="enforcement" class="rs-select">
                  <option value="active" selected={rs.enforcement === "active" as any}>
                    active — block on violation
                  </option>
                  <option value="evaluate" selected={rs.enforcement === "evaluate" as any}>
                    evaluate — log only
                  </option>
                  <option value="disabled" selected={rs.enforcement === "disabled" as any}>
                    disabled
                  </option>
                </select>
                <button type="submit" class="rs-btn rs-btn-primary rs-btn-sm">
                  Update
                </button>
              </form>
            </div>
          </section>

          <section class="rs-section">
            <header class="rs-section-head">
              <h3 class="rs-section-title">
                <span class="rs-section-icon" aria-hidden="true">
                  <ListIcon />
                </span>
                Rules
              </h3>
              <p class="rs-section-sub">
                Each rule defines one constraint. All rules in the ruleset must
                pass for the push to be allowed.
              </p>
            </header>
            <div class="rs-section-body">
              {rs.rules.length === 0 ? (
                <div class="rs-empty">
                  <div class="rs-empty-orb" aria-hidden="true" />
                  <div class="rs-empty-mark" aria-hidden="true">
                    <ListIcon />
                  </div>
                  <h4 class="rs-empty-title">No rules in this ruleset</h4>
                  <p class="rs-empty-body">
                    Add a rule below to make this ruleset do something. Until
                    then, no constraints are enforced.
                  </p>
                </div>
              ) : (
                rs.rules.map((r) => {
                  const params = parseParams(r.params);
                  return (
                    <div class="rs-rule">
                      <div class="rs-rule-body">
                        <span class="rs-rule-type">{r.ruleType}</span>
                        <span class="rs-rule-desc">
                          {ruleDescription(r.ruleType, params)}
                        </span>
                      </div>
                      <form method="post" action={`${base}/rules/${r.id}/delete`}>
                        <button
                          type="submit"
                          class="rs-btn rs-btn-danger rs-btn-sm"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section class="rs-section">
            <header class="rs-section-head">
              <h3 class="rs-section-title">
                <span class="rs-section-icon" aria-hidden="true">
                  <PlusIcon />
                </span>
                Add rule
              </h3>
              <p class="rs-section-sub">
                Pick a type and provide its JSON params.
              </p>
            </header>
            <form method="post" action={`${base}/rules`} class="rs-form">
              <div class="rs-form-group">
                <label class="rs-form-label" for="rt">Rule type</label>
                <select id="rt" name="rule_type" required class="rs-select">
                  {RULE_TYPES.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div class="rs-form-group">
                <label class="rs-form-label" for="rp">Params (JSON)</label>
                <textarea
                  id="rp"
                  name="params"
                  rows={4}
                  placeholder="{}"
                  class="rs-textarea"
                ></textarea>
                <div class="rs-form-hint">
                  Example: <code>{`{"pattern":"^(feat|fix|chore):"}`}</code>
                </div>
              </div>
              <button type="submit" class="rs-btn rs-btn-primary">
                <PlusIcon /> Add rule
              </button>
            </form>
          </section>

          <section class="rs-danger">
            <h3>Danger zone</h3>
            <p>
              Deleting a ruleset removes it and all of its rules permanently.
            </p>
            <form
              method="post"
              action={`${base}/delete`}
              onsubmit="return confirm('Delete this ruleset and all of its rules?')"
            >
              <button type="submit" class="rs-btn rs-btn-danger">
                Delete ruleset
              </button>
            </form>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: rsStyles }} />
      </Layout>
    );
  }
);

rulesets.post(
  "/:owner/:repo/settings/rulesets/:id",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const enforcement = String(body.enforcement || "active") as
      | "active"
      | "evaluate"
      | "disabled";
    const ok = await updateRulesetEnforcement(id, repo.id, enforcement);
    if (ok) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "ruleset.update",
        targetId: id,
        metadata: { enforcement },
      });
    }
    const base = `/${ownerName}/${repoName}/settings/rulesets/${id}`;
    return c.redirect(
      `${base}?${ok ? "message" : "error"}=${encodeURIComponent(
        ok ? "Updated." : "Update failed"
      )}`
    );
  }
);

rulesets.post(
  "/:owner/:repo/settings/rulesets/:id/delete",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const ok = await deleteRuleset(id, repo.id);
    if (ok) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "ruleset.delete",
        targetId: id,
      });
    }
    const base = `/${ownerName}/${repoName}/settings/rulesets`;
    return c.redirect(
      `${base}?${ok ? "message" : "error"}=${encodeURIComponent(
        ok ? "Ruleset deleted." : "Delete failed"
      )}`
    );
  }
);

rulesets.post(
  "/:owner/:repo/settings/rulesets/:id/rules",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const ruleType = String(body.rule_type || "") as any;
    const params = parseParams(String(body.params || "{}"));
    const base = `/${ownerName}/${repoName}/settings/rulesets/${id}`;
    const result = await addRule({
      rulesetId: id,
      repositoryId: repo.id,
      ruleType,
      params,
    });
    if (!result.ok) {
      return c.redirect(`${base}?error=${encodeURIComponent(result.error)}`);
    }
    await audit({
      userId: user.id,
      repositoryId: repo.id,
      action: "ruleset.rule.add",
      targetId: result.id,
      metadata: { ruleType, params },
    });
    return c.redirect(`${base}?message=${encodeURIComponent("Rule added.")}`);
  }
);

rulesets.post(
  "/:owner/:repo/settings/rulesets/:id/rules/:rid/delete",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const ctx = await gate(c);
    if (ctx instanceof Response) return ctx;
    const { ownerName, repoName, repo, user } = ctx;
    const id = c.req.param("id");
    const rid = c.req.param("rid");
    const ok = await deleteRule(rid, id, repo.id);
    if (ok) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "ruleset.rule.delete",
        targetId: rid,
      });
    }
    const base = `/${ownerName}/${repoName}/settings/rulesets/${id}`;
    return c.redirect(
      `${base}?${ok ? "message" : "error"}=${encodeURIComponent(
        ok ? "Rule removed." : "Delete failed"
      )}`
    );
  }
);

export default rulesets;

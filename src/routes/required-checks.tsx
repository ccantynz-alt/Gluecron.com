/**
 * Block E6 — Required status checks matrix settings UI.
 *
 *   GET  /:owner/:repo/gates/protection/:id/checks          — manage required checks
 *   POST /:owner/:repo/gates/protection/:id/checks          — add a check name
 *   POST /:owner/:repo/gates/protection/:id/checks/:cid/delete — remove
 *
 * Required checks are scoped to a single branch-protection rule. Adding a
 * check tells the merge handler "in addition to green gates, the check with
 * this name must have a passing gate_run OR workflow_run against the head
 * commit". Name matching is exact (case-sensitive); callers typically use
 * workflow `name:` or the gate kinds (e.g. `GateTest`, `AI Review`).
 *
 * 2026 polish: scoped under `.rc-`. Each check renders as a card with a
 * traffic-light dot showing the last observed status + duration pulled from
 * gate_runs. Form actions, validation, and POST handlers are preserved
 * verbatim — security-critical surface.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  branchProtection,
  branchRequiredChecks,
  gateRuns,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { listRequiredChecks } from "../lib/branch-protection";
import { audit } from "../lib/notify";

const required = new Hono<AuthEnv>();
required.use("*", softAuth);

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

async function loadRule(repositoryId: string, ruleId: string) {
  try {
    const [rule] = await db
      .select()
      .from(branchProtection)
      .where(
        and(
          eq(branchProtection.id, ruleId),
          eq(branchProtection.repositoryId, repositoryId)
        )
      )
      .limit(1);
    return rule || null;
  } catch {
    return null;
  }
}

interface CheckStatus {
  status: string | null;
  durationMs: number | null;
  createdAt: Date | null;
}

/**
 * Best-effort lookup of the most recent gate_run for a given check name in this repo.
 * Returns null if the table is unavailable or no run exists.
 */
async function lastStatusForCheck(
  repositoryId: string,
  checkName: string
): Promise<CheckStatus> {
  try {
    const [row] = await db
      .select({
        status: gateRuns.status,
        durationMs: gateRuns.durationMs,
        createdAt: gateRuns.createdAt,
      })
      .from(gateRuns)
      .where(
        and(
          eq(gateRuns.repositoryId, repositoryId),
          eq(gateRuns.gateName, checkName)
        )
      )
      .orderBy(desc(gateRuns.createdAt))
      .limit(1);
    return {
      status: row?.status ?? null,
      durationMs: row?.durationMs ?? null,
      createdAt: row?.createdAt ?? null,
    };
  } catch {
    return { status: null, durationMs: null, createdAt: null };
  }
}

function relTime(d: Date | null): string {
  if (!d) return "—";
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

function lightClass(status: string | null): "is-pass" | "is-fail" | "is-warn" | "is-idle" {
  if (status === "passed" || status === "repaired") return "is-pass";
  if (status === "failed") return "is-fail";
  if (status === "pending" || status === "running" || status === "skipped") return "is-warn";
  return "is-idle";
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every selector prefixed `.rc-` so this surface can't leak.
 * ───────────────────────────────────────────────────────────────────── */
const rcStyles = `
  .rc-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-4) 0; }

  .rc-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .rc-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .rc-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .rc-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .rc-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .rc-eyebrow {
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
  .rc-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .rc-title {
    font-size: clamp(26px, 3.6vw, 36px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .rc-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .rc-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .rc-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }
  .rc-hero-link {
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
  .rc-hero-link:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  .rc-banner {
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
  .rc-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .rc-banner.is-error { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }
  .rc-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* ─── Status card ─── */
  .rc-status {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .rc-status.is-on {
    border-color: rgba(52,211,153,0.32);
    background: linear-gradient(135deg, rgba(52,211,153,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .rc-status.is-warn {
    border-color: rgba(248,113,113,0.32);
    background: linear-gradient(135deg, rgba(248,113,113,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .rc-status.is-empty {
    border-color: rgba(251,191,36,0.30);
    background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .rc-status-row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .rc-status-mark {
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
  .rc-status.is-on .rc-status-mark {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    box-shadow: 0 8px 20px -8px rgba(16,185,129,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .rc-status.is-warn .rc-status-mark {
    background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
    box-shadow: 0 8px 20px -8px rgba(239,68,68,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .rc-status.is-empty .rc-status-mark {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    color: #1a1206;
    box-shadow: 0 8px 20px -8px rgba(251,191,36,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .rc-status-text { flex: 1; min-width: 220px; }
  .rc-status-headline {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .rc-status-desc { margin: 0; font-size: 13.5px; color: var(--text-muted); line-height: 1.5; }
  .rc-pattern-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-strong);
    background: rgba(140,109,255,0.10);
    border: 1px solid rgba(140,109,255,0.30);
    border-radius: 8px;
  }

  /* ─── Section card ─── */
  .rc-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .rc-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .rc-section-title {
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
  .rc-section-icon {
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
  .rc-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .rc-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Check cards ─── */
  .rc-list { display: flex; flex-direction: column; gap: 10px; }
  .rc-check {
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
  .rc-check:hover {
    border-color: rgba(140,109,255,0.30);
    transform: translateY(-1px);
  }
  .rc-check-main { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; }
  .rc-light {
    flex-shrink: 0;
    width: 14px; height: 14px;
    border-radius: 9999px;
    background: #6b7280;
    box-shadow: 0 0 0 3px rgba(107,114,128,0.18);
    position: relative;
  }
  .rc-light.is-pass {
    background: #34d399;
    box-shadow: 0 0 0 3px rgba(52,211,153,0.22), 0 0 10px rgba(52,211,153,0.45);
  }
  .rc-light.is-fail {
    background: #f87171;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.22), 0 0 12px rgba(248,113,113,0.50);
    animation: rcPulse 1.8s ease-in-out infinite;
  }
  .rc-light.is-warn {
    background: #fbbf24;
    box-shadow: 0 0 0 3px rgba(251,191,36,0.22), 0 0 10px rgba(251,191,36,0.40);
  }
  .rc-light.is-idle {
    background: #6b7280;
    box-shadow: 0 0 0 3px rgba(107,114,128,0.18);
  }
  @keyframes rcPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.75; transform: scale(0.92); }
  }
  @media (prefers-reduced-motion: reduce) {
    .rc-light.is-fail { animation: none; }
  }
  .rc-check-body { min-width: 0; flex: 1; }
  .rc-check-name {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 700;
    color: var(--text-strong);
    word-break: break-word;
  }
  .rc-check-meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .rc-check-pill {
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
  .rc-check-pill.is-pass { background: rgba(52,211,153,0.14); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32); }
  .rc-check-pill.is-fail { background: rgba(248,113,113,0.14); color: #fecaca; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32); }
  .rc-check-pill.is-warn { background: rgba(251,191,36,0.14); color: #fde68a; box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32); }
  .rc-check-pill.is-idle { background: rgba(255,255,255,0.04); color: var(--text-muted); box-shadow: inset 0 0 0 1px var(--border); }

  /* ─── Empty state ─── */
  .rc-empty {
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    position: relative;
    overflow: hidden;
  }
  .rc-empty-orb {
    position: absolute;
    inset: -30% auto auto -10%;
    width: 260px; height: 260px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    opacity: 0.8;
    pointer-events: none;
  }
  .rc-empty-mark {
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
  .rc-empty-title {
    position: relative;
    z-index: 1;
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .rc-empty-body {
    position: relative;
    z-index: 1;
    margin: 0 auto;
    max-width: 460px;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }

  /* ─── Form ─── */
  .rc-form { padding: var(--space-5); }
  .rc-form-group { margin-bottom: var(--space-4); }
  .rc-form-label {
    display: block;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .rc-input {
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
  .rc-input:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .rc-form-hint { margin-top: 6px; font-size: 12px; color: var(--text-muted); }
  .rc-form-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }

  /* ─── Buttons ─── */
  .rc-btn {
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
  .rc-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .rc-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .rc-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .rc-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
    text-decoration: none;
  }
  .rc-btn-sm { padding: 6px 11px; font-size: 12px; }
`;

/* Icons */
const ChecklistIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
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
const ShieldIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

required.get(
  "/:owner/:repo/gates/protection/:id/checks",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/gates`);
    }
    const rule = await loadRule(repoRow.id, id);
    if (!rule) {
      return c.redirect(
        `/${owner}/${repo}/gates/settings?error=${encodeURIComponent("Rule not found")}`
      );
    }

    const checks = await listRequiredChecks(rule.id);
    const success = c.req.query("success");
    const error = c.req.query("error");

    // Pull the last status for every required check in parallel so the page
    // renders fast even with a dozen entries.
    const statuses = await Promise.all(
      checks.map((ch) => lastStatusForCheck(repoRow.id, ch.checkName))
    );
    const enrichedChecks = checks.map((ch, i) => ({
      ...ch,
      lastStatus: statuses[i]!,
    }));

    const failingCount = enrichedChecks.filter(
      (c) => c.lastStatus.status === "failed"
    ).length;
    const passingCount = enrichedChecks.filter(
      (c) =>
        c.lastStatus.status === "passed" || c.lastStatus.status === "repaired"
    ).length;

    let statusVariant: "is-on" | "is-warn" | "is-empty" = "is-empty";
    let statusHead = "No required checks configured";
    let statusDesc =
      "Merges into matching branches don't require any named check right now. Add one below.";
    if (checks.length > 0) {
      if (failingCount > 0) {
        statusVariant = "is-warn";
        statusHead = `${failingCount} of ${checks.length} failing`;
        statusDesc = `Last observed run: ${failingCount} red, ${passingCount} green. Merges are blocked until they're all green.`;
      } else {
        statusVariant = "is-on";
        statusHead = `${checks.length} required check${checks.length === 1 ? "" : "s"} configured`;
        statusDesc =
          passingCount === checks.length
            ? "All required checks last reported green. Merges into matching branches will be allowed."
            : "Required checks haven't all reported yet. Merges block until each one has a passing run on the head commit.";
      }
    }

    return c.html(
      <Layout title={`Required checks — ${rule.pattern}`} user={user}>
        <RepoHeader
          owner={owner}
          repo={repo}
          starCount={repoRow.starCount}
          forkCount={repoRow.forkCount}
          currentUser={user.username}
        />
        <RepoNav owner={owner} repo={repo} active="gates" />

        <div class="rc-wrap">
          <section class="rc-hero">
            <div class="rc-hero-orb" aria-hidden="true" />
            <div class="rc-hero-inner">
              <div class="rc-hero-text">
                <div class="rc-eyebrow">
                  <span class="rc-eyebrow-pill" aria-hidden="true">
                    <ChecklistIcon />
                  </span>
                  Required checks · {owner}/{repo}
                </div>
                <h1 class="rc-title">
                  <span class="rc-title-grad">Mergeability gates.</span>
                </h1>
                <p class="rc-sub">
                  Merges into branches matching <code>{rule.pattern}</code>{" "}
                  require a passing run for each named check. Names match
                  against <code>gate_runs.gate_name</code> or a workflow{" "}
                  <code>name:</code> field.
                </p>
              </div>
              <a href={`/${owner}/${repo}/gates/settings`} class="rc-hero-link">
                <ArrowLeft /> Back to protection
              </a>
            </div>
          </section>

          {success && (
            <div class="rc-banner is-ok" role="status">
              <span class="rc-banner-dot" aria-hidden="true" />
              {decodeURIComponent(success)}
            </div>
          )}
          {error && (
            <div class="rc-banner is-error" role="alert">
              <span class="rc-banner-dot" aria-hidden="true" />
              {decodeURIComponent(error)}
            </div>
          )}

          <section class={`rc-status ${statusVariant}`}>
            <div class="rc-status-row">
              <span class="rc-status-mark" aria-hidden="true">
                <ChecklistIcon />
              </span>
              <div class="rc-status-text">
                <h2 class="rc-status-headline">{statusHead}</h2>
                <p class="rc-status-desc">{statusDesc}</p>
              </div>
              <span class="rc-pattern-pill">
                <ShieldIcon />
                {rule.pattern}
              </span>
            </div>
          </section>

          <section class="rc-section">
            <header class="rc-section-head">
              <h3 class="rc-section-title">
                <span class="rc-section-icon" aria-hidden="true">
                  <ChecklistIcon />
                </span>
                Configured checks
              </h3>
              <p class="rc-section-sub">
                Each check must have a passing run on the head commit before a
                merge is allowed.
              </p>
            </header>
            <div class="rc-section-body">
              {enrichedChecks.length === 0 ? (
                <div class="rc-empty">
                  <div class="rc-empty-orb" aria-hidden="true" />
                  <div class="rc-empty-mark" aria-hidden="true">
                    <ChecklistIcon />
                  </div>
                  <h4 class="rc-empty-title">No required checks yet</h4>
                  <p class="rc-empty-body">
                    Common names: <code>GateTest</code>, <code>AI Review</code>,{" "}
                    <code>Secret Scan</code>, <code>Type Check</code>. Add one
                    below to gate merges on it.
                  </p>
                </div>
              ) : (
                <div class="rc-list">
                  {enrichedChecks.map((ch) => {
                    const lc = lightClass(ch.lastStatus.status);
                    const dur = ch.lastStatus.durationMs
                      ? `${(ch.lastStatus.durationMs / 1000).toFixed(1)}s`
                      : null;
                    return (
                      <div class="rc-check">
                        <div class="rc-check-main">
                          <span
                            class={`rc-light ${lc}`}
                            aria-label={ch.lastStatus.status ?? "no runs yet"}
                          />
                          <div class="rc-check-body">
                            <div class="rc-check-name">{ch.checkName}</div>
                            <div class="rc-check-meta">
                              <span class={`rc-check-pill ${lc}`}>
                                {ch.lastStatus.status ?? "no runs"}
                              </span>
                              {dur && <span>·</span>}
                              {dur && <span>last run {dur}</span>}
                              <span>·</span>
                              <span>{relTime(ch.lastStatus.createdAt)}</span>
                            </div>
                          </div>
                        </div>
                        <form
                          method="post"
                          action={`/${owner}/${repo}/gates/protection/${rule.id}/checks/${ch.id}/delete`}
                          onsubmit="return confirm('Remove this required check?')"
                        >
                          <button type="submit" class="rc-btn rc-btn-danger rc-btn-sm">
                            Remove
                          </button>
                        </form>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section class="rc-section">
            <header class="rc-section-head">
              <h3 class="rc-section-title">
                <span class="rc-section-icon" aria-hidden="true">
                  <PlusIcon />
                </span>
                Add required check
              </h3>
              <p class="rc-section-sub">
                Names are case-sensitive. Match exactly the gate or workflow{" "}
                <code>name:</code>.
              </p>
            </header>
            <form
              method="post"
              action={`/${owner}/${repo}/gates/protection/${rule.id}/checks`}
              class="rc-form"
            >
              <div class="rc-form-group">
                <label class="rc-form-label" for="rc-check-name">Check name</label>
                <input
                  type="text"
                  id="rc-check-name"
                  name="checkName"
                  required
                  placeholder="GateTest"
                  aria-label="Check name"
                  class="rc-input"
                />
                <div class="rc-form-hint">
                  Examples: <code>GateTest</code>, <code>AI Review</code>,{" "}
                  <code>Secret Scan</code>, <code>Type Check</code>.
                </div>
              </div>
              <button type="submit" class="rc-btn rc-btn-primary">
                <PlusIcon /> Add required check
              </button>
            </form>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: rcStyles }} />
      </Layout>
    );
  }
);

required.post(
  "/:owner/:repo/gates/protection/:id/checks",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/gates`);
    }
    const rule = await loadRule(repoRow.id, id);
    if (!rule) {
      return c.redirect(
        `/${owner}/${repo}/gates/settings?error=${encodeURIComponent("Rule not found")}`
      );
    }

    const body = await c.req.parseBody();
    const checkName = String(body.checkName || "").trim();
    if (!checkName) {
      return c.redirect(
        `/${owner}/${repo}/gates/protection/${rule.id}/checks?error=${encodeURIComponent("Name required")}`
      );
    }

    try {
      await db
        .insert(branchRequiredChecks)
        .values({ branchProtectionId: rule.id, checkName });
    } catch (err) {
      // Likely a unique-index collision — treat as success.
      console.error("[required-checks] insert:", err);
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "branch_required_checks.create",
      targetId: rule.id,
      metadata: { checkName, pattern: rule.pattern },
    });

    return c.redirect(
      `/${owner}/${repo}/gates/protection/${rule.id}/checks?success=${encodeURIComponent("Check added")}`
    );
  }
);

required.post(
  "/:owner/:repo/gates/protection/:id/checks/:cid/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id, cid } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/gates`);
    }
    const rule = await loadRule(repoRow.id, id);
    if (!rule) {
      return c.redirect(
        `/${owner}/${repo}/gates/settings?error=${encodeURIComponent("Rule not found")}`
      );
    }

    try {
      await db
        .delete(branchRequiredChecks)
        .where(
          and(
            eq(branchRequiredChecks.id, cid),
            eq(branchRequiredChecks.branchProtectionId, rule.id)
          )
        );
    } catch (err) {
      console.error("[required-checks] delete:", err);
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "branch_required_checks.delete",
      targetId: rule.id,
    });

    return c.redirect(
      `/${owner}/${repo}/gates/protection/${rule.id}/checks?success=${encodeURIComponent("Check removed")}`
    );
  }
);

export default required;

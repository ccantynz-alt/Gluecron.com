/**
 * Block I6 — Sponsors.
 *
 *   GET  /sponsors/:username                  — public sponsor page
 *   GET  /settings/sponsors                   — maintain your own tiers + activity
 *   POST /settings/sponsors/tiers/new         — publish a tier
 *   POST /settings/sponsors/tiers/:id/delete  — retire a tier
 *   POST /sponsors/:username                  — record a sponsorship
 *
 * Payment rails are out of scope — this captures intent + thank-you notes.
 *
 * 2026 polish: scoped under `.spons-`. Tier cards render with $/mo, optional
 * description / benefits list, and a gradient "Become a sponsor" CTA. Every
 * form action, validation rule, and POST handler is preserved verbatim.
 */

import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  sponsorships,
  sponsorshipTiers,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const sponsors = new Hono<AuthEnv>();
sponsors.use("*", softAuth);

function formatCents(cents: number): string {
  if (cents === 0) return "Any amount";
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every selector prefixed `.spons-` so this surface can't leak.
 * ───────────────────────────────────────────────────────────────────── */
const sponsStyles = `
  .spons-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .spons-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .spons-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #ff7eb6 30%, #8c6dff 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .spons-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(255,126,182,0.18), rgba(140,109,255,0.12) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .spons-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .spons-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .spons-eyebrow {
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
  .spons-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(255,126,182,0.14);
    color: #ffb7d1;
    box-shadow: inset 0 0 0 1px rgba(255,126,182,0.35);
  }
  .spons-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .spons-title-grad {
    background-image: linear-gradient(135deg, #ff7eb6 0%, #a48bff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .spons-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .spons-sub a { color: var(--accent); text-decoration: none; }
  .spons-sub a:hover { text-decoration: underline; }

  .spons-banner {
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
  .spons-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .spons-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  /* ─── Status card ─── */
  .spons-status {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .spons-status.is-on {
    border-color: rgba(255,126,182,0.32);
    background: linear-gradient(135deg, rgba(255,126,182,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .spons-status.is-empty {
    border-color: rgba(251,191,36,0.30);
    background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .spons-status-row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .spons-status-mark {
    flex-shrink: 0;
    width: 52px; height: 52px;
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    background: linear-gradient(135deg, #ff7eb6 0%, #8c6dff 100%);
    box-shadow: 0 8px 20px -8px rgba(255,126,182,0.50), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .spons-status.is-empty .spons-status-mark {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    color: #1a1206;
    box-shadow: 0 8px 20px -8px rgba(251,191,36,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .spons-status-text { flex: 1; min-width: 220px; }
  .spons-status-headline {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .spons-status-desc { margin: 0; font-size: 13.5px; color: var(--text-muted); line-height: 1.5; }

  .spons-total {
    text-align: right;
  }
  .spons-total-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .spons-total-num {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1;
    color: var(--text-strong);
    margin-top: 2px;
    background-image: linear-gradient(135deg, #ff7eb6 0%, #8c6dff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }

  /* ─── Tier card grid ─── */
  .spons-tiers {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .spons-tier {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .spons-tier:hover { border-color: rgba(255,126,182,0.35); transform: translateY(-2px); }
  .spons-tier::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, #ff7eb6 30%, #8c6dff 70%, transparent);
    opacity: 0.55;
  }
  .spons-tier-name {
    margin: 0 0 var(--space-2);
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .spons-tier-price {
    display: flex;
    align-items: baseline;
    gap: 4px;
    margin-bottom: var(--space-3);
  }
  .spons-tier-price-num {
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 800;
    letter-spacing: -0.025em;
    background-image: linear-gradient(135deg, #ff7eb6 0%, #a48bff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    line-height: 1;
  }
  .spons-tier-price-unit {
    font-size: 13px;
    color: var(--text-muted);
    font-weight: 500;
  }
  .spons-tier-desc {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.55;
    flex: 1;
    margin: 0 0 var(--space-4);
  }
  .spons-tier-benefits {
    margin: 0 0 var(--space-4);
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .spons-tier-benefits li {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    font-size: 12.5px;
    color: var(--text);
    line-height: 1.45;
  }
  .spons-tier-benefits li svg { flex-shrink: 0; margin-top: 2px; color: #6ee7b7; }
  .spons-tier-select {
    padding: 8px 10px;
    font-size: 12.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    margin-bottom: 8px;
    font-family: inherit;
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    width: 100%;
    box-sizing: border-box;
  }
  .spons-tier-select:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* ─── Buttons ─── */
  .spons-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 18px;
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
  .spons-btn-primary {
    background: linear-gradient(135deg, #ff7eb6 0%, #8c6dff 60%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(255,126,182,0.45), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .spons-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(255,126,182,0.55), inset 0 1px 0 rgba(255,255,255,0.22);
    color: #fff;
    text-decoration: none;
  }
  .spons-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .spons-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .spons-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .spons-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
    text-decoration: none;
  }
  .spons-btn-sm { padding: 6px 11px; font-size: 12px; }
  .spons-btn-block { width: 100%; }

  /* ─── Section card ─── */
  .spons-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .spons-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .spons-section-title {
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
  .spons-section-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(255,126,182,0.12);
    color: #ffb7d1;
    box-shadow: inset 0 0 0 1px rgba(255,126,182,0.28);
    flex-shrink: 0;
  }
  .spons-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .spons-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Activity / recent sponsors rows ─── */
  .spons-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  .spons-row:first-child { border-top: none; padding-top: 4px; }
  .spons-row:last-child { padding-bottom: 4px; }
  .spons-row-name { font-weight: 600; color: var(--text-strong); font-size: 13.5px; }
  .spons-row-name a { color: inherit; text-decoration: none; }
  .spons-row-name a:hover { color: var(--accent); }
  .spons-row-note { margin-left: 8px; font-size: 13px; color: var(--text-muted); font-style: italic; }
  .spons-row-kind { margin-left: 8px; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); }
  .spons-row-meta {
    font-size: 12.5px;
    color: var(--text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Empty state ─── */
  .spons-empty {
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    position: relative;
    overflow: hidden;
  }
  .spons-empty-orb {
    position: absolute;
    inset: -30% auto auto -10%;
    width: 260px; height: 260px;
    background: radial-gradient(circle, rgba(255,126,182,0.16), rgba(140,109,255,0.08) 45%, transparent 70%);
    filter: blur(60px);
    opacity: 0.8;
    pointer-events: none;
  }
  .spons-empty-mark {
    position: relative;
    z-index: 1;
    margin: 0 auto var(--space-3);
    width: 52px; height: 52px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(255,126,182,0.18), rgba(140,109,255,0.12));
    box-shadow: inset 0 0 0 1px rgba(255,126,182,0.30);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffb7d1;
  }
  .spons-empty-title {
    position: relative;
    z-index: 1;
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .spons-empty-body {
    position: relative;
    z-index: 1;
    margin: 0 auto;
    max-width: 460px;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .spons-empty .spons-empty-form {
    position: relative;
    z-index: 1;
    margin-top: var(--space-4);
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
    align-items: center;
  }
  .spons-empty .spons-input-inline {
    padding: 9px 12px;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    width: 220px;
    max-width: 100%;
  }
  .spons-empty .spons-input-inline:focus {
    border-color: var(--border-focus, rgba(255,126,182,0.55));
    box-shadow: 0 0 0 3px rgba(255,126,182,0.18);
  }

  /* ─── Form ─── */
  .spons-form { padding: var(--space-5); }
  .spons-form-group { margin-bottom: var(--space-4); }
  .spons-form-label {
    display: block;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .spons-input, .spons-textarea {
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
  .spons-input:focus, .spons-textarea:focus {
    border-color: var(--border-focus, rgba(255,126,182,0.55));
    box-shadow: 0 0 0 3px rgba(255,126,182,0.18);
  }
  .spons-textarea { font-family: inherit; }
  .spons-form-hint { margin-top: 6px; font-size: 12px; color: var(--text-muted); }
`;

/* Icons */
const HeartIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </svg>
);
const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const TierIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="12 2 15 8.5 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 9 8.5 12 2" />
  </svg>
);
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const ActivityIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

// ---------- Public sponsor page ----------

sponsors.get("/sponsors/:username", async (c) => {
  const user = c.get("user");
  const targetName = c.req.param("username");
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.username, targetName))
    .limit(1);
  if (!target) return c.notFound();

  const tiers = await db
    .select()
    .from(sponsorshipTiers)
    .where(
      and(
        eq(sponsorshipTiers.maintainerId, target.id),
        eq(sponsorshipTiers.isActive, true)
      )
    )
    .orderBy(sponsorshipTiers.monthlyCents);

  const recentPublic = await db
    .select({
      id: sponsorships.id,
      amountCents: sponsorships.amountCents,
      createdAt: sponsorships.createdAt,
      note: sponsorships.note,
      sponsorName: users.username,
    })
    .from(sponsorships)
    .innerJoin(users, eq(sponsorships.sponsorId, users.id))
    .where(
      and(
        eq(sponsorships.maintainerId, target.id),
        eq(sponsorships.isPublic, true),
        isNull(sponsorships.cancelledAt)
      )
    )
    .orderBy(desc(sponsorships.createdAt))
    .limit(20);

  const thanks = c.req.query("thanks");

  const statusVariant: "is-on" | "is-empty" =
    tiers.length === 0 ? "is-empty" : "is-on";
  const statusHead =
    tiers.length === 0
      ? `No sponsorship tiers yet`
      : `Sponsorship enabled · ${tiers.length} tier${tiers.length === 1 ? "" : "s"}`;
  const statusDesc =
    tiers.length === 0
      ? `${targetName} hasn't published any tiers yet — you can still sponsor a custom amount below.`
      : `Pick a tier or contribute a one-time amount. ${recentPublic.length} recent sponsor${recentPublic.length === 1 ? "" : "s"}.`;

  return c.html(
    <Layout title={`Sponsor ${targetName}`} user={user}>
      <div class="spons-wrap">
        <section class="spons-hero">
          <div class="spons-hero-orb" aria-hidden="true" />
          <div class="spons-hero-inner">
            <div class="spons-hero-text">
              <div class="spons-eyebrow">
                <span class="spons-eyebrow-pill" aria-hidden="true">
                  <HeartIcon />
                </span>
                Sponsor · <a href={`/${targetName}`} style="color:var(--accent);text-decoration:none">{targetName}</a>
              </div>
              <h1 class="spons-title">
                <span class="spons-title-grad">Back {targetName}.</span>
              </h1>
              <p class="spons-sub">
                Support {targetName}'s open-source work on Gluecron. Pick a tier
                or contribute a one-time amount — every dollar lands directly
                with the maintainer.
              </p>
            </div>
          </div>
        </section>

        {thanks && (
          <div class="spons-banner is-ok" role="status">
            <span class="spons-banner-dot" aria-hidden="true" />
            Thank you for supporting {targetName}.
          </div>
        )}

        <section class={`spons-status ${statusVariant}`}>
          <div class="spons-status-row">
            <span class="spons-status-mark" aria-hidden="true">
              <HeartIcon />
            </span>
            <div class="spons-status-text">
              <h2 class="spons-status-headline">{statusHead}</h2>
              <p class="spons-status-desc">{statusDesc}</p>
            </div>
          </div>
        </section>

        {tiers.length === 0 ? (
          <div class="spons-empty">
            <div class="spons-empty-orb" aria-hidden="true" />
            <div class="spons-empty-mark" aria-hidden="true">
              <TierIcon />
            </div>
            <h3 class="spons-empty-title">No published tiers yet</h3>
            <p class="spons-empty-body">
              {targetName} hasn't set up sponsorship tiers, but you can still
              support them directly with a one-time amount.
            </p>
            {user ? (
              <form
                method="post"
                action={`/sponsors/${targetName}`}
                class="spons-empty-form"
              >
                <input
                  type="number"
                  name="amount_cents"
                  placeholder="Amount in cents (e.g. 500 = $5)"
                  min="100"
                  required
                  aria-label="Sponsorship amount in cents"
                  class="spons-input-inline"
                />
                <button type="submit" class="spons-btn spons-btn-primary">
                  <HeartIcon /> Sponsor (one-time)
                </button>
              </form>
            ) : (
              <div class="spons-empty-form">
                <a
                  href={`/login?next=/sponsors/${targetName}`}
                  class="spons-btn spons-btn-primary"
                >
                  <HeartIcon /> Sign in to sponsor
                </a>
              </div>
            )}
          </div>
        ) : (
          <div class="spons-tiers">
            {tiers.map((t) => (
              <form
                method="post"
                action={`/sponsors/${targetName}`}
                class="spons-tier"
              >
                <input type="hidden" name="tier_id" value={t.id} />
                <h3 class="spons-tier-name">{t.name}</h3>
                <div class="spons-tier-price">
                  <span class="spons-tier-price-num">
                    {formatCents(t.monthlyCents)}
                  </span>
                  {t.monthlyCents > 0 && (
                    <span class="spons-tier-price-unit">/ month</span>
                  )}
                </div>
                {t.description && (
                  <p class="spons-tier-desc">{t.description}</p>
                )}
                <ul class="spons-tier-benefits">
                  <li>
                    <CheckIcon />
                    <span>Listed as a sponsor on {targetName}'s profile</span>
                  </li>
                  <li>
                    <CheckIcon />
                    <span>Direct line to thank the maintainer</span>
                  </li>
                  {t.oneTimeAllowed && (
                    <li>
                      <CheckIcon />
                      <span>One-time contribution allowed</span>
                    </li>
                  )}
                </ul>
                {user ? (
                  <>
                    <select name="kind" class="spons-tier-select" aria-label="Sponsorship kind">
                      <option value="monthly">Monthly</option>
                      {t.oneTimeAllowed && (
                        <option value="one_time">One-time</option>
                      )}
                    </select>
                    <button
                      type="submit"
                      class="spons-btn spons-btn-primary spons-btn-block"
                    >
                      <HeartIcon /> Become a sponsor
                    </button>
                  </>
                ) : (
                  <a
                    href={`/login?next=/sponsors/${targetName}`}
                    class="spons-btn spons-btn-ghost spons-btn-block"
                  >
                    Sign in to sponsor
                  </a>
                )}
              </form>
            ))}
          </div>
        )}

        <section class="spons-section">
          <header class="spons-section-head">
            <h3 class="spons-section-title">
              <span class="spons-section-icon" aria-hidden="true">
                <ActivityIcon />
              </span>
              Recent sponsors
            </h3>
            <p class="spons-section-sub">
              People who've publicly backed {targetName} recently.
            </p>
          </header>
          <div class="spons-section-body">
            {recentPublic.length === 0 ? (
              <div class="spons-empty">
                <div class="spons-empty-orb" aria-hidden="true" />
                <div class="spons-empty-mark" aria-hidden="true">
                  <HeartIcon />
                </div>
                <h4 class="spons-empty-title">Be the first to sponsor</h4>
                <p class="spons-empty-body">
                  No public sponsors yet — pick a tier above and your name will
                  show up here.
                </p>
              </div>
            ) : (
              recentPublic.map((s) => (
                <div class="spons-row">
                  <div>
                    <span class="spons-row-name">
                      <a href={`/${s.sponsorName}`}>{s.sponsorName}</a>
                    </span>
                    {s.note && <span class="spons-row-note">"{s.note}"</span>}
                  </div>
                  <div class="spons-row-meta">
                    {formatCents(s.amountCents)} ·{" "}
                    {new Date(s.createdAt).toLocaleDateString()}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: sponsStyles }} />
    </Layout>
  );
});

// Record a sponsorship
sponsors.post("/sponsors/:username", requireAuth, async (c) => {
  const user = c.get("user")!;
  const targetName = c.req.param("username");
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.username, targetName))
    .limit(1);
  if (!target) return c.notFound();
  if (target.id === user.id) {
    return c.redirect(`/sponsors/${targetName}`);
  }
  const body = await c.req.parseBody();
  const tierId = body.tier_id ? String(body.tier_id) : null;
  let amountCents = 0;
  let kind = String(body.kind || "one_time");
  if (kind !== "monthly" && kind !== "one_time") kind = "one_time";

  if (tierId) {
    const [tier] = await db
      .select()
      .from(sponsorshipTiers)
      .where(eq(sponsorshipTiers.id, tierId))
      .limit(1);
    if (!tier || tier.maintainerId !== target.id) {
      return c.redirect(`/sponsors/${targetName}`);
    }
    amountCents = tier.monthlyCents;
  } else {
    amountCents = Math.max(0, parseInt(String(body.amount_cents || "0"), 10));
  }
  if (amountCents <= 0 && !tierId) {
    return c.redirect(`/sponsors/${targetName}`);
  }

  await db.insert(sponsorships).values({
    sponsorId: user.id,
    maintainerId: target.id,
    tierId: tierId || null,
    amountCents,
    kind,
    note: body.note ? String(body.note).slice(0, 200) : null,
    isPublic: body.is_public !== "0",
  });
  return c.redirect(`/sponsors/${targetName}?thanks=1`);
});

// ---------- Maintainer settings ----------

sponsors.get("/settings/sponsors", requireAuth, async (c) => {
  const user = c.get("user")!;
  const [tiers, activity] = await Promise.all([
    db
      .select()
      .from(sponsorshipTiers)
      .where(eq(sponsorshipTiers.maintainerId, user.id))
      .orderBy(sponsorshipTiers.monthlyCents),
    db
      .select({
        id: sponsorships.id,
        amountCents: sponsorships.amountCents,
        kind: sponsorships.kind,
        createdAt: sponsorships.createdAt,
        sponsorName: users.username,
      })
      .from(sponsorships)
      .innerJoin(users, eq(sponsorships.sponsorId, users.id))
      .where(eq(sponsorships.maintainerId, user.id))
      .orderBy(desc(sponsorships.createdAt))
      .limit(50),
  ]);
  const total = activity.reduce((sum, s) => sum + s.amountCents, 0);

  const statusVariant: "is-on" | "is-empty" =
    tiers.length === 0 ? "is-empty" : "is-on";
  const statusHead =
    tiers.length === 0
      ? "Sponsorship not configured"
      : `Sponsorship enabled · ${tiers.length} tier${tiers.length === 1 ? "" : "s"}`;
  const statusDesc =
    tiers.length === 0
      ? "Your public sponsor page renders an empty state. Add a tier below to start accepting support."
      : `Your public page is live at /sponsors/${user.username}. ${activity.length} contribution${activity.length === 1 ? "" : "s"} recorded.`;

  return c.html(
    <Layout title="Sponsorship settings" user={user}>
      <div class="spons-wrap">
        <section class="spons-hero">
          <div class="spons-hero-orb" aria-hidden="true" />
          <div class="spons-hero-inner">
            <div class="spons-hero-text">
              <div class="spons-eyebrow">
                <span class="spons-eyebrow-pill" aria-hidden="true">
                  <HeartIcon />
                </span>
                Sponsorship · {user.username}
              </div>
              <h1 class="spons-title">
                <span class="spons-title-grad">Tiers + activity.</span>
              </h1>
              <p class="spons-sub">
                Your public sponsor page is at{" "}
                <a href={`/sponsors/${user.username}`}>
                  /sponsors/{user.username}
                </a>
                . Publish tiers, retire them, and watch contributions roll in.
              </p>
            </div>
          </div>
        </section>

        <section class={`spons-status ${statusVariant}`}>
          <div class="spons-status-row">
            <span class="spons-status-mark" aria-hidden="true">
              <HeartIcon />
            </span>
            <div class="spons-status-text">
              <h2 class="spons-status-headline">{statusHead}</h2>
              <p class="spons-status-desc">{statusDesc}</p>
            </div>
            <div class="spons-total">
              <div class="spons-total-label">Total received</div>
              <div class="spons-total-num">{formatCents(total)}</div>
            </div>
          </div>
        </section>

        <section class="spons-section">
          <header class="spons-section-head">
            <h3 class="spons-section-title">
              <span class="spons-section-icon" aria-hidden="true">
                <TierIcon />
              </span>
              Tiers
            </h3>
            <p class="spons-section-sub">
              Published tiers appear on your public sponsor page. Retire any
              tier with the button on its card.
            </p>
          </header>
          <div class="spons-section-body">
            {tiers.length === 0 ? (
              <div class="spons-empty">
                <div class="spons-empty-orb" aria-hidden="true" />
                <div class="spons-empty-mark" aria-hidden="true">
                  <TierIcon />
                </div>
                <h4 class="spons-empty-title">No tiers published yet</h4>
                <p class="spons-empty-body">
                  Add a tier below — start with a low one ($5/mo) and a higher
                  one with perks. People sponsor more often when the choice is
                  easy.
                </p>
              </div>
            ) : (
              <div class="spons-tiers">
                {tiers.map((t) => (
                  <div class="spons-tier">
                    <h3 class="spons-tier-name">{t.name}</h3>
                    <div class="spons-tier-price">
                      <span class="spons-tier-price-num">
                        {formatCents(t.monthlyCents)}
                      </span>
                      {t.monthlyCents > 0 && (
                        <span class="spons-tier-price-unit">/ month</span>
                      )}
                    </div>
                    <p class="spons-tier-desc">
                      {t.description || "No description set."}
                    </p>
                    <form
                      method="post"
                      action={`/settings/sponsors/tiers/${t.id}/delete`}
                      onsubmit="return confirm('Retire this tier?')"
                    >
                      <button
                        type="submit"
                        class="spons-btn spons-btn-danger spons-btn-sm spons-btn-block"
                      >
                        Retire tier
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section class="spons-section">
          <header class="spons-section-head">
            <h3 class="spons-section-title">
              <span class="spons-section-icon" aria-hidden="true">
                <PlusIcon />
              </span>
              Add a tier
            </h3>
            <p class="spons-section-sub">
              Give it a name, a short description, and a monthly amount in
              cents.
            </p>
          </header>
          <form
            method="post"
            action="/settings/sponsors/tiers/new"
            class="spons-form"
          >
            <div class="spons-form-group">
              <label class="spons-form-label" for="spons-name">Name</label>
              <input
                type="text"
                id="spons-name"
                name="name"
                required
                aria-label="Tier name"
                class="spons-input"
                placeholder="Silver supporter"
              />
            </div>
            <div class="spons-form-group">
              <label class="spons-form-label" for="spons-desc">Description</label>
              <textarea
                id="spons-desc"
                name="description"
                rows={2}
                class="spons-textarea"
                placeholder="What does this tier get them?"
              />
            </div>
            <div class="spons-form-group">
              <label class="spons-form-label" for="spons-cents">
                Monthly amount (cents)
              </label>
              <input
                type="number"
                id="spons-cents"
                name="monthly_cents"
                min="0"
                placeholder="500 = $5/mo"
                required
                aria-label="Monthly amount in cents"
                class="spons-input"
              />
              <div class="spons-form-hint">
                Tip: 500 = $5/mo, 2500 = $25/mo, 10000 = $100/mo.
              </div>
            </div>
            <button type="submit" class="spons-btn spons-btn-primary">
              <PlusIcon /> Add tier
            </button>
          </form>
        </section>

        <section class="spons-section">
          <header class="spons-section-head">
            <h3 class="spons-section-title">
              <span class="spons-section-icon" aria-hidden="true">
                <ActivityIcon />
              </span>
              Recent activity
            </h3>
            <p class="spons-section-sub">
              Latest 50 contributions (monthly + one-time).
            </p>
          </header>
          <div class="spons-section-body">
            {activity.length === 0 ? (
              <div class="spons-empty">
                <div class="spons-empty-orb" aria-hidden="true" />
                <div class="spons-empty-mark" aria-hidden="true">
                  <ActivityIcon />
                </div>
                <h4 class="spons-empty-title">No sponsors yet</h4>
                <p class="spons-empty-body">
                  Once people sponsor you, every contribution lands here with
                  the kind (monthly/one-time) and amount.
                </p>
              </div>
            ) : (
              activity.map((a) => (
                <div class="spons-row">
                  <div>
                    <span class="spons-row-name">
                      <a href={`/${a.sponsorName}`}>{a.sponsorName}</a>
                    </span>
                    <span class="spons-row-kind">{a.kind}</span>
                  </div>
                  <div class="spons-row-meta">
                    {formatCents(a.amountCents)} ·{" "}
                    {new Date(a.createdAt).toLocaleDateString()}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: sponsStyles }} />
    </Layout>
  );
});

sponsors.post("/settings/sponsors/tiers/new", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  if (!name) return c.redirect("/settings/sponsors");
  const monthlyCents = Math.max(
    0,
    parseInt(String(body.monthly_cents || "0"), 10)
  );
  await db.insert(sponsorshipTiers).values({
    maintainerId: user.id,
    name,
    description: String(body.description || ""),
    monthlyCents,
  });
  return c.redirect("/settings/sponsors");
});

sponsors.post(
  "/settings/sponsors/tiers/:id/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    await db
      .update(sponsorshipTiers)
      .set({ isActive: false })
      .where(
        and(
          eq(sponsorshipTiers.id, id),
          eq(sponsorshipTiers.maintainerId, user.id)
        )
      );
    return c.redirect("/settings/sponsors");
  }
);

// Handy stat helper for other pages
export async function sponsorshipTotalForUser(
  userId: string
): Promise<number> {
  try {
    const [r] = await db
      .select({ n: sql<number>`coalesce(sum(${sponsorships.amountCents}), 0)::int` })
      .from(sponsorships)
      .where(eq(sponsorships.maintainerId, userId));
    return Number(r?.n || 0);
  } catch {
    return 0;
  }
}

/** Test-only hook. */
export const __internal = { formatCents };

export default sponsors;

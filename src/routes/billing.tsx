/**
 * Block F4 — Billing + quota UI.
 *
 *   GET  /settings/billing                  — personal quota view + plan table
 *   GET  /admin/billing                     — site admin: user list + overrides
 *   POST /admin/billing/:userId/plan        — set user's plan (audit-logged)
 *
 * All read operations degrade gracefully if the billing tables are empty
 * (FALLBACK_PLANS in lib/billing.ts mirror the seed rows). Plan assignment
 * is site-admin only; there is no self-service purchase flow here — that's
 * Stripe's job, and deliberately out-of-scope for the v1 panel.
 *
 * 2026 polish — gradient hairline hero, orb, eyebrow, featured current-plan
 * card, usage bars with tabular-nums, plan-compare grid, all scoped under
 * `.bill-*`.
 */

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { users, userQuotas } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";
import {
  formatPrice,
  getUserQuota,
  listPlans,
  setUserPlan,
} from "../lib/billing";
import {
  createBillingPortalSession,
  createCheckoutSession,
  findOrCreateCustomer,
} from "../lib/stripe";
import { config } from "../lib/config";

const billing = new Hono<AuthEnv>();
billing.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.bill-` so this surface can't bleed
 * into other pages. Mirrors the gradient hero + section card patterns
 * from admin-integrations.tsx, admin-ops.tsx, error-page.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .bill-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6, 32px) var(--space-4, 24px); }

  /* ─── Hero ─── */
  .bill-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .bill-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .bill-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .bill-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .bill-hero-text { max-width: 680px; flex: 1; min-width: 240px; }
  .bill-eyebrow {
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
  .bill-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .bill-eyebrow strong { color: var(--accent); font-weight: 600; letter-spacing: 0.04em; }
  .bill-title {
    font-family: var(--font-display);
    font-size: clamp(32px, 5vw, 48px);
    font-weight: 800;
    letter-spacing: -0.030em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .bill-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .bill-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 580px;
  }
  .bill-hero-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    font-size: 12.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 9px;
    text-decoration: none;
    font-weight: 500;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .bill-hero-back:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* ─── Banners ─── */
  .bill-banner {
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
  .bill-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .bill-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .bill-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Current-plan featured card ─── */
  .bill-current {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .bill-current.is-featured {
    border-color: rgba(140,109,255,0.40);
    background: linear-gradient(180deg, rgba(140,109,255,0.05), var(--bg-elevated) 60%);
  }
  .bill-current.is-featured::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.85;
    pointer-events: none;
  }
  .bill-current-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .bill-current-head {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-family: var(--font-mono);
    font-weight: 600;
    margin-bottom: 6px;
  }
  .bill-current-name {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    margin: 0 0 4px;
  }
  .bill-current-price {
    font-size: 14px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .bill-current-cycle {
    font-size: 12px;
    color: var(--text-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .bill-usage-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .bill-usage-row .bill-usage-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
    font-size: 13px;
  }
  .bill-usage-row .bill-usage-name {
    color: var(--text-strong);
    font-weight: 500;
  }
  .bill-usage-row .bill-usage-num {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 12.5px;
  }
  .bill-bar {
    background: var(--bg-secondary, rgba(0,0,0,0.20));
    height: 12px;
    border-radius: 7px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .bill-bar-fill {
    height: 100%;
    border-radius: 7px;
    transition: width 250ms ease;
  }
  .bill-bar-fill.is-ok { background: linear-gradient(90deg, #34d399, #10b981); }
  .bill-bar-fill.is-warn { background: linear-gradient(90deg, #fbbf24, #f59e0b); }
  .bill-bar-fill.is-bad { background: linear-gradient(90deg, #f87171, #ef4444); }

  /* ─── Section card (shared) ─── */
  .bill-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .bill-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .bill-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.014em;
  }
  .bill-section-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .bill-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Plan compare grid ─── */
  .bill-plans {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }
  .bill-plan {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
  }
  .bill-plan:hover {
    border-color: rgba(140,109,255,0.45);
    transform: translateY(-2px);
    box-shadow: 0 10px 28px -10px rgba(140,109,255,0.30);
  }
  .bill-plan.is-current {
    border-color: rgba(52,211,153,0.50);
    background: linear-gradient(180deg, rgba(52,211,153,0.05), var(--bg-elevated) 60%);
  }
  .bill-plan-badge {
    position: absolute;
    top: -10px; right: 14px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .bill-plan-badge.is-current {
    background: rgba(52,211,153,0.18);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.50);
  }
  .bill-plan-name {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
    letter-spacing: -0.012em;
  }
  .bill-plan-price {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 800;
    color: var(--text-strong);
    letter-spacing: -0.020em;
    margin: 2px 0 8px;
    font-variant-numeric: tabular-nums;
  }
  .bill-plan-feats {
    list-style: none;
    padding: 0;
    margin: 0 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    flex: 1;
  }
  .bill-plan-feats li {
    display: flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  .bill-plan-feats .check {
    flex-shrink: 0;
    color: #34d399;
    font-weight: 700;
  }
  .bill-plan-feats .x {
    flex-shrink: 0;
    color: var(--text-muted);
    opacity: 0.6;
  }
  .bill-plan-action { margin-top: auto; }
  .bill-plan-action form { margin: 0; }

  /* ─── Buttons ─── */
  .bill-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 14px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
    width: 100%;
  }
  .bill-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .bill-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .bill-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong, var(--border));
    width: auto;
  }
  .bill-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .bill-current-cta { display: inline-flex; }

  /* ─── Payment + invoices section ─── */
  .bill-pay-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .bill-pay-text {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 480px;
  }
  .bill-pay-text strong { color: var(--text); font-weight: 600; }

  /* ─── Invoices list (empty) ─── */
  .bill-invoices-empty {
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: 12px;
    background: rgba(255,255,255,0.012);
  }
  .bill-invoices-empty a { color: var(--accent); text-decoration: none; }
  .bill-invoices-empty a:hover { text-decoration: underline; }

  /* ─── Foot (link to /pricing) ─── */
  .bill-foot {
    margin-top: var(--space-5);
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .bill-foot a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .bill-foot a:hover { text-decoration: underline; }

  .bill-stripe-note {
    font-size: 12.5px;
    color: var(--text-muted);
    margin: var(--space-3) 0 0;
    font-style: italic;
    line-height: 1.5;
  }

  /* ─── Admin list ─── */
  .bill-admin-list {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .bill-admin-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .bill-admin-row:last-child { border-bottom: none; }
  .bill-admin-user a {
    font-weight: 600;
    color: var(--text-strong);
    text-decoration: none;
  }
  .bill-admin-user a:hover { color: var(--accent); }
  .bill-admin-meta {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .bill-admin-form {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0;
  }
  .bill-admin-form select {
    font-size: 12px;
    padding: 5px 8px;
    border-radius: 8px;
    background: var(--bg-secondary, rgba(0,0,0,0.15));
    border: 1px solid var(--border);
    color: var(--text);
  }
  .bill-403 {
    max-width: 540px;
    margin: var(--space-12, 96px) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .bill-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
`;

function barClass(pct: number): string {
  if (pct >= 90) return "is-bad";
  if (pct >= 70) return "is-warn";
  return "is-ok";
}

function IconWallet() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <rect x="16" y="12" width="6" height="5" rx="1" />
    </svg>
  );
}
function IconReceipt() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2V2H4z" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="8" y1="11" x2="16" y2="11" />
      <line x1="8" y1="15" x2="13" y2="15" />
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

// ----- Personal billing page -----

billing.get("/settings/billing", requireAuth, async (c) => {
  const user = c.get("user")!;
  const [quota, plans] = await Promise.all([
    getUserQuota(user.id),
    listPlans(),
  ]);

  const upgraded = c.req.query("upgraded") === "1";
  const canceled = c.req.query("canceled") === "1";
  const errorMsg = c.req.query("error");
  const isPaid = quota.planSlug !== "free";

  return c.html(
    <Layout title="Billing — Gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="bill-wrap">
        {/* ─── Hero ─── */}
        <section class="bill-hero">
          <div class="bill-hero-orb" aria-hidden="true" />
          <div class="bill-hero-inner">
            <div class="bill-hero-text">
              <div class="bill-eyebrow">
                <span class="bill-eyebrow-dot" aria-hidden="true" />
                Billing · <strong>@{user.username}</strong>
              </div>
              <h1 class="bill-title">
                <span class="bill-title-grad">Plan + usage.</span>
              </h1>
              <p class="bill-sub">
                Your current plan, this cycle's usage, and one-click upgrades.
                Cancel any time — your data stays on the free tier.
              </p>
            </div>
            <a href="/settings" class="bill-hero-back">
              <IconArrowLeft />
              Back to settings
            </a>
          </div>
        </section>

        {/* Sub-link out to the AI usage dashboard — keeps the locked
            settings-subnav unmodified while still surfacing the new page. */}
        <div style="margin-bottom:var(--space-4);display:flex;gap:12px;flex-wrap:wrap;font-size:13px">
          <a
            href="/billing/usage"
            style="color:var(--text-muted);text-decoration:none;padding:6px 12px;border-radius:9px;border:1px solid var(--border);background:rgba(255,255,255,0.02)"
          >
            AI usage + cost &rarr;
          </a>
        </div>

        {upgraded && (
          <div class="bill-banner is-ok" role="status">
            <span class="bill-banner-dot" aria-hidden="true" />
            Subscription updated — your new plan is active.
          </div>
        )}
        {canceled && (
          <div class="bill-banner" role="status">
            <span class="bill-banner-dot" aria-hidden="true" />
            Checkout canceled. You can upgrade any time.
          </div>
        )}
        {errorMsg && (
          <div class="bill-banner is-error" role="alert">
            <span class="bill-banner-dot" aria-hidden="true" />
            {decodeURIComponent(errorMsg)}
          </div>
        )}

        {/* ─── Featured current-plan card ─── */}
        <section class={"bill-current" + (isPaid ? " is-featured" : "")}>
          <div class="bill-current-row">
            <div>
              <div class="bill-current-head">Current plan</div>
              <h2 class="bill-current-name">{quota.plan.name}</h2>
              <div class="bill-current-price">{formatPrice(quota.plan.priceCents)}</div>
            </div>
            <div>
              {quota.planSlug === "free" && (
                <form method="post" action="/billing/upgrade/pro" class="bill-current-cta">
                  <button type="submit" class="bill-btn bill-btn-primary" style="width:auto">
                    Upgrade to Pro &rarr;
                  </button>
                </form>
              )}
              <div class="bill-current-cycle" style="margin-top:8px">
                {quota.cycleStart
                  ? `Cycle started ${new Date(quota.cycleStart).toLocaleDateString()}`
                  : "No cycle recorded"}
              </div>
            </div>
          </div>

          <div class="bill-usage-list">
            <div class="bill-usage-row">
              <div class="bill-usage-label">
                <span class="bill-usage-name">Storage</span>
                <span class="bill-usage-num">
                  {quota.usage.storageMbUsed} / {quota.plan.storageMbLimit} MB · {quota.percent.storage}%
                </span>
              </div>
              <div class="bill-bar">
                <div class={"bill-bar-fill " + barClass(quota.percent.storage)} style={`width:${quota.percent.storage}%`} />
              </div>
            </div>
            <div class="bill-usage-row">
              <div class="bill-usage-label">
                <span class="bill-usage-name">AI tokens (monthly)</span>
                <span class="bill-usage-num">
                  {quota.usage.aiTokensUsedThisMonth.toLocaleString()} / {quota.plan.aiTokensMonthly.toLocaleString()} · {quota.percent.aiTokens}%
                </span>
              </div>
              <div class="bill-bar">
                <div class={"bill-bar-fill " + barClass(quota.percent.aiTokens)} style={`width:${quota.percent.aiTokens}%`} />
              </div>
            </div>
            <div class="bill-usage-row">
              <div class="bill-usage-label">
                <span class="bill-usage-name">Bandwidth (monthly)</span>
                <span class="bill-usage-num">
                  {quota.usage.bandwidthGbUsedThisMonth} / {quota.plan.bandwidthGbMonthly} GB · {quota.percent.bandwidth}%
                </span>
              </div>
              <div class="bill-bar">
                <div class={"bill-bar-fill " + barClass(quota.percent.bandwidth)} style={`width:${quota.percent.bandwidth}%`} />
              </div>
            </div>
          </div>
        </section>

        {/* ─── Plan compare grid ─── */}
        <section class="bill-section">
          <header class="bill-section-head">
            <div>
              <h3 class="bill-section-title">Available plans</h3>
              <p class="bill-section-sub">
                Switch any time — pro-rated mid-cycle. Cancel and you keep your data on the free tier.
              </p>
            </div>
          </header>
          <div class="bill-section-body">
            <div class="bill-plans">
              {plans.map((p) => {
                const isCurrent = p.slug === quota.planSlug;
                return (
                  <div class={"bill-plan" + (isCurrent ? " is-current" : "")}>
                    {isCurrent && (
                      <span class="bill-plan-badge is-current">Current</span>
                    )}
                    <h4 class="bill-plan-name">{p.name}</h4>
                    <div class="bill-plan-price">{formatPrice(p.priceCents)}</div>
                    <ul class="bill-plan-feats">
                      <li><span class="check">✓</span> {p.repoLimit.toLocaleString()} repos</li>
                      <li><span class="check">✓</span> {p.storageMbLimit.toLocaleString()} MB storage</li>
                      <li><span class="check">✓</span> {p.aiTokensMonthly.toLocaleString()} AI tokens/mo</li>
                      <li><span class="check">✓</span> {p.bandwidthGbMonthly} GB bandwidth/mo</li>
                      <li>
                        {p.privateRepos
                          ? <><span class="check">✓</span> Private repos</>
                          : <><span class="x">—</span> Public repos only</>}
                      </li>
                    </ul>
                    <div class="bill-plan-action">
                      {!isCurrent && p.slug !== "free" && p.priceCents > 0 && (
                        <form method="post" action={`/billing/upgrade/${p.slug}`}>
                          <button type="submit" class="bill-btn bill-btn-primary">
                            {quota.planSlug === "free" ? "Upgrade" : "Switch"} to {p.name}
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ─── Payment method section ─── */}
        <section class="bill-section">
          <header class="bill-section-head">
            <div>
              <h3 class="bill-section-title">
                <IconWallet /> Payment method
              </h3>
              <p class="bill-section-sub">
                Card, invoices, and cancellation are handled by Stripe's Customer Portal.
              </p>
            </div>
          </header>
          <div class="bill-section-body">
            <div class="bill-pay-row">
              <div class="bill-pay-text">
                {isPaid ? (
                  <>Your card and billing address live in the <strong>Stripe Customer Portal</strong>. Update them, download invoices, or cancel any time.</>
                ) : (
                  <>You're on the <strong>Free</strong> tier — no card on file. Upgrade above to set one.</>
                )}
              </div>
              {isPaid && (
                <form method="post" action="/billing/manage" style="margin:0">
                  <button type="submit" class="bill-btn bill-btn-ghost">
                    Manage subscription &rarr;
                  </button>
                </form>
              )}
            </div>
            {!process.env.STRIPE_SECRET_KEY && (
              <p class="bill-stripe-note">
                (Stripe not yet configured on this instance — upgrade buttons return a
                setup error. Run the Stripe Bootstrap workflow to enable.)
              </p>
            )}
          </div>
        </section>

        {/* ─── Invoices section (empty state — Stripe owns the list) ─── */}
        <section class="bill-section">
          <header class="bill-section-head">
            <div>
              <h3 class="bill-section-title">
                <IconReceipt /> Invoices
              </h3>
              <p class="bill-section-sub">
                Past invoices live in the Stripe Customer Portal — click through above.
              </p>
            </div>
          </header>
          <div class="bill-section-body">
            <div class="bill-invoices-empty">
              {isPaid
                ? <>Receipts and PDFs are available in the <a href="#" onclick="document.querySelector('form[action=&quot;/billing/manage&quot;] button')?.click();return false;">Customer Portal</a>.</>
                : <>You'll see invoices here once you upgrade to a paid plan.</>}
            </div>
          </div>
        </section>

        {/* ─── Foot (link to /pricing) ─── */}
        <div class="bill-foot">
          Want the full breakdown of what's included?{" "}
          <a href="/pricing">Detailed plan comparison &rarr;</a>
        </div>
      </div>
    </Layout>
  );
});

// ----- Upgrade flow (Stripe Checkout) -----

billing.post("/billing/upgrade/:plan", requireAuth, async (c) => {
  const user = c.get("user")!;
  const planSlug = c.req.param("plan");
  if (planSlug !== "pro" && planSlug !== "team" && planSlug !== "enterprise") {
    return c.redirect("/settings/billing?error=invalid-plan");
  }

  const quota = await getUserQuota(user.id);
  const customer = await findOrCreateCustomer({
    userId: user.id,
    email: user.email ?? `${user.username}@gluecron.local`,
    existingCustomerId: quota.stripeCustomerId ?? null,
  });
  if (!customer.ok) {
    console.error(`[billing/upgrade] customer: ${customer.error}`);
    return c.redirect(
      `/settings/billing?error=${encodeURIComponent(customer.error)}`
    );
  }

  const base = (config.appBaseUrl || "").replace(/\/$/, "") || "";
  const session = await createCheckoutSession({
    customerId: customer.customerId,
    planSlug,
    successUrl: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/billing/cancel`,
    userId: user.id,
  });
  if (!session.ok) {
    console.error(`[billing/upgrade] checkout: ${session.error}`);
    return c.redirect(
      `/settings/billing?error=${encodeURIComponent(session.error)}`
    );
  }

  // Stash the customerId onto the quota row now (doesn't wait for webhook)
  // so subsequent upgrades don't re-create a customer.
  await db
    .update(userQuotas)
    .set({ stripeCustomerId: customer.customerId, updatedAt: new Date() })
    .where(eq(userQuotas.userId, user.id));

  return c.redirect(session.url, 303);
});

billing.get("/billing/success", requireAuth, async (c) => {
  // The webhook does the actual plan assignment; this is just a landing page.
  return c.redirect("/settings/billing?upgraded=1");
});

billing.get("/billing/cancel", requireAuth, async (c) => {
  return c.redirect("/settings/billing?canceled=1");
});

billing.post("/billing/manage", requireAuth, async (c) => {
  const user = c.get("user")!;
  const quota = await getUserQuota(user.id);
  if (!quota.stripeCustomerId) {
    return c.redirect("/settings/billing?error=no-subscription");
  }
  const base = (config.appBaseUrl || "").replace(/\/$/, "") || "";
  const session = await createBillingPortalSession({
    customerId: quota.stripeCustomerId,
    returnUrl: `${base}/settings/billing`,
  });
  if (!session.ok) {
    console.error(`[billing/manage] portal: ${session.error}`);
    return c.redirect(
      `/settings/billing?error=${encodeURIComponent(session.error)}`
    );
  }
  return c.redirect(session.url, 303);
});

// ----- Admin billing panel -----

billing.get("/admin/billing", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/billing");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="bill-403">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
      </Layout>,
      403
    );
  }

  const plans = await listPlans();
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      planSlug: userQuotas.planSlug,
      storageMbUsed: userQuotas.storageMbUsed,
      aiTokensUsedThisMonth: userQuotas.aiTokensUsedThisMonth,
    })
    .from(users)
    .leftJoin(userQuotas, eq(users.id, userQuotas.userId))
    .orderBy(desc(users.createdAt))
    .limit(200);

  return c.html(
    <Layout title="Admin — Billing" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="bill-wrap">
        <section class="bill-hero">
          <div class="bill-hero-orb" aria-hidden="true" />
          <div class="bill-hero-inner">
            <div class="bill-hero-text">
              <div class="bill-eyebrow">
                <span class="bill-eyebrow-dot" aria-hidden="true" />
                Admin · Billing
              </div>
              <h1 class="bill-title">
                <span class="bill-title-grad">All users.</span>
              </h1>
              <p class="bill-sub">
                Override any user's plan. Every change is audit-logged under
                <code style="font-family:var(--font-mono);font-size:13px;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:4px;margin-left:5px">admin.billing.set_plan</code>.
              </p>
            </div>
            <a href="/admin" class="bill-hero-back">
              <IconArrowLeft />
              Back to admin
            </a>
          </div>
        </section>

        <div class="bill-admin-list">
          {rows.length === 0 ? (
            <div class="bill-invoices-empty" style="margin:0;border:none">No users.</div>
          ) : (
            rows.map((r) => (
              <div class="bill-admin-row">
                <div class="bill-admin-user" style="flex:1;min-width:0">
                  <a href={`/${r.username}`}>{r.username}</a>
                  <div class="bill-admin-meta">
                    Plan: <strong>{r.planSlug || "free"}</strong> ·{" "}
                    {r.storageMbUsed || 0} MB ·{" "}
                    {(r.aiTokensUsedThisMonth || 0).toLocaleString()} tokens
                  </div>
                </div>
                <form
                  method="post"
                  action={`/admin/billing/${r.id}/plan`}
                  class="bill-admin-form"
                >
                  <select name="slug">
                    {plans.map((p) => (
                      <option
                        value={p.slug}
                        selected={(r.planSlug || "free") === p.slug}
                      >
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button type="submit" class="bill-btn bill-btn-ghost" style="padding:6px 12px;font-size:12px">
                    Set
                  </button>
                </form>
              </div>
            ))
          )}
        </div>
      </div>
    </Layout>
  );
});

billing.post("/admin/billing/:userId/plan", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/billing");
  if (!(await isSiteAdmin(user.id))) {
    return c.text("Forbidden", 403);
  }
  const userId = c.req.param("userId");
  const body = await c.req.parseBody();
  const slug = String(body.slug || "free");
  await setUserPlan(userId, slug);
  await audit({
    userId: user.id,
    action: "admin.billing.set_plan",
    targetType: "user",
    targetId: userId,
    metadata: { plan: slug },
  });
  return c.redirect("/admin/billing");
});

export default billing;

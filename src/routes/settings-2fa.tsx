/**
 * 2FA settings (Block B4).
 *
 * Routes:
 *   GET  /settings/2fa                   status + recovery code management
 *   POST /settings/2fa/enroll            generate a pending secret, show QR
 *   GET  /settings/2fa/enroll            same as POST (for bookmarks)
 *   POST /settings/2fa/confirm           verify first code, flip enabled
 *   POST /settings/2fa/disable           require password + disable + wipe
 *   POST /settings/2fa/recovery/regen    regenerate recovery codes
 *
 * 2026 polish: status card hero, numbered enrol step flow, amber warning
 * banner on disable. Every CSS rule scoped under `.tfa-*` — no shared
 * classes with passkeys or any other surface. ALL form actions, POST
 * handlers, and verification logic preserved unchanged.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, userTotp, userRecoveryCodes } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import { verifyPassword } from "../lib/auth";
import {
  generateTotpSecret,
  otpauthUrl,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "../lib/totp";
import { audit } from "../lib/notify";
import { config } from "../lib/config";

const settings2fa = new Hono<AuthEnv>();

settings2fa.use("/settings/2fa", requireAuth);
settings2fa.use("/settings/2fa/*", requireAuth);

function errorRedirect(path: string, msg: string) {
  return `${path}?error=${encodeURIComponent(msg)}`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.tfa-` so it cannot bleed into any
 * other surface (passkeys uses `.pk-`, admin pages use their own prefixes).
 * Mirrors the gradient-hairline hero + card patterns from
 * admin-integrations.tsx and admin-ops.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const tfaStyles = `
  .tfa-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .tfa-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .tfa-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .tfa-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .tfa-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .tfa-eyebrow {
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
  .tfa-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .tfa-crumb { color: var(--text-muted); text-decoration: none; }
  .tfa-crumb:hover { color: var(--text); text-decoration: none; }
  .tfa-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .tfa-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .tfa-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  /* ─── Flash banners ─── */
  .tfa-banner {
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
  .tfa-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .tfa-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .tfa-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Status card (the centrepiece) ─── */
  .tfa-status {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    overflow: hidden;
  }
  .tfa-status.is-on {
    border-color: rgba(52,211,153,0.32);
    background: linear-gradient(135deg, rgba(52,211,153,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .tfa-status.is-off {
    border-color: rgba(251,191,36,0.32);
    background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .tfa-status.is-pending {
    border-color: rgba(54,197,214,0.30);
    background: linear-gradient(135deg, rgba(54,197,214,0.07) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .tfa-status-mark {
    flex-shrink: 0;
    width: 56px; height: 56px;
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .tfa-status-mark.is-on {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    box-shadow: 0 8px 20px -8px rgba(16,185,129,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .tfa-status-mark.is-off {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    color: #1a1206;
    box-shadow: 0 8px 20px -8px rgba(251,191,36,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .tfa-status-mark.is-pending {
    background: linear-gradient(135deg, #36c5d6 0%, #0ea5e9 100%);
    box-shadow: 0 8px 20px -8px rgba(54,197,214,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .tfa-status-text { flex: 1; min-width: 220px; }
  .tfa-status-headline {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .tfa-status-desc {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .tfa-status-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  /* ─── Generic section card ─── */
  .tfa-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .tfa-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .tfa-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .tfa-section-title-icon {
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
  .tfa-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .tfa-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Numbered step list (enrol flow) ─── */
  .tfa-steps {
    list-style: none;
    padding: 0;
    margin: 0;
    counter-reset: tfa-step;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .tfa-step {
    counter-increment: tfa-step;
    position: relative;
    padding: var(--space-4) var(--space-5) var(--space-4) calc(var(--space-5) + 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
  }
  .tfa-step::before {
    content: counter(tfa-step);
    position: absolute;
    top: var(--space-4);
    left: var(--space-4);
    width: 32px;
    height: 32px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .tfa-step-title {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 15.5px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .tfa-step-body {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }

  .tfa-secret {
    margin-top: var(--space-3);
    padding: 14px 16px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
  }
  .tfa-secret-label {
    display: block;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .tfa-secret-value {
    font-family: var(--font-mono);
    font-size: 14px;
    color: var(--text-strong);
    word-break: break-all;
    display: block;
  }
  .tfa-secret-value.is-url {
    font-size: 11.5px;
    color: var(--text);
  }

  .tfa-form-row { margin-top: var(--space-3); display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .tfa-input-group { display: flex; flex-direction: column; gap: 6px; }
  .tfa-input-group label {
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .tfa-input {
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .tfa-input:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .tfa-input.is-code {
    letter-spacing: 0.5em;
    text-align: center;
    font-size: 22px;
    font-weight: 600;
    width: 200px;
    padding-right: 4px;
  }

  /* ─── Buttons ─── */
  .tfa-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 18px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .tfa-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .tfa-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .tfa-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .tfa-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .tfa-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .tfa-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
    text-decoration: none;
  }

  /* ─── Recovery badge inside status ─── */
  .tfa-recovery-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--text);
    margin-top: 8px;
  }
  .tfa-recovery-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: #34d399;
  }
  .tfa-recovery-pill.is-low .dot { background: #fbbf24; }
  .tfa-recovery-pill.is-empty .dot { background: #f87171; }

  /* ─── Warning banner (amber) ─── */
  .tfa-warning {
    margin-bottom: var(--space-4);
    padding: 12px 16px;
    border-radius: 10px;
    background: rgba(251,191,36,0.06);
    border: 1px solid rgba(251,191,36,0.32);
    color: #fde68a;
    font-size: 13px;
    line-height: 1.55;
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .tfa-warning-icon {
    flex-shrink: 0;
    width: 18px; height: 18px;
    margin-top: 1px;
    color: #fbbf24;
  }
  .tfa-warning strong { color: #fef3c7; font-weight: 700; }

  /* ─── Recovery code list ─── */
  .tfa-codes {
    margin: 0 0 var(--space-4);
    padding: 18px 20px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    font-family: var(--font-mono);
    font-size: 14.5px;
    line-height: 1.8;
    color: var(--text-strong);
    white-space: pre-wrap;
    overflow-x: auto;
  }
`;

/* ─── Inline SVGs (decorative — aria-hidden) ─── */
const ShieldIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const CheckIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const WarnIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);
const PendingIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);
const WarnBannerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tfa-warning-icon" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

/** Status page: either "off" (offer enroll), "pending" (finish enrol), "on" (disable + manage codes). */
settings2fa.get("/settings/2fa", async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");
  const success = c.req.query("success");

  let state: "off" | "pending" | "on" = "off";
  try {
    const [row] = await db
      .select({ enabledAt: userTotp.enabledAt })
      .from(userTotp)
      .where(eq(userTotp.userId, user.id))
      .limit(1);
    if (row) state = row.enabledAt ? "on" : "pending";
  } catch (err) {
    console.error("[2fa] status:", err);
  }

  let unusedRecovery = 0;
  try {
    const rows = await db
      .select({ usedAt: userRecoveryCodes.usedAt })
      .from(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, user.id));
    unusedRecovery = rows.filter((r) => !r.usedAt).length;
  } catch {
    /* ignore */
  }

  const recoveryClass =
    unusedRecovery === 0 ? "is-empty" : unusedRecovery <= 2 ? "is-low" : "";

  return c.html(
    <Layout title="Two-factor authentication" user={user}>
      <div class="tfa-wrap">
        <section class="tfa-hero">
          <div class="tfa-hero-orb" aria-hidden="true" />
          <div class="tfa-hero-inner">
            <div class="tfa-eyebrow">
              <span class="tfa-eyebrow-pill" aria-hidden="true">
                <ShieldIcon />
              </span>
              <a href="/settings" class="tfa-crumb">Settings</a>
              <span>/</span>
              <span>Two-factor auth</span>
            </div>
            <h2 class="tfa-title">
              <span class="tfa-title-grad">Two-factor auth.</span>
            </h2>
            <p class="tfa-sub">
              Require a 6-digit code from your authenticator app on every
              sign-in. Works with Google Authenticator, 1Password, Bitwarden,
              Authy, and any TOTP-compatible app.
            </p>
          </div>
        </section>

        {error && (
          <div class="tfa-banner is-error" role="alert">
            <span class="tfa-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}
        {success && (
          <div class="tfa-banner is-ok" role="status">
            <span class="tfa-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}

        {state === "on" && (
          <section class="tfa-status is-on" aria-label="Two-factor status">
            <div class="tfa-status-mark is-on" aria-hidden="true">
              <CheckIcon />
            </div>
            <div class="tfa-status-text">
              <h3 class="tfa-status-headline">Two-factor is ON</h3>
              <p class="tfa-status-desc">
                Your account is protected by an authenticator code on every
                sign-in.
              </p>
              <span class={"tfa-recovery-pill " + recoveryClass}>
                <span class="dot" aria-hidden="true" />
                {unusedRecovery} recovery code{unusedRecovery === 1 ? "" : "s"}{" "}
                remaining
              </span>
            </div>
          </section>
        )}

        {state === "pending" && (
          <section class="tfa-status is-pending" aria-label="Two-factor status">
            <div class="tfa-status-mark is-pending" aria-hidden="true">
              <PendingIcon />
            </div>
            <div class="tfa-status-text">
              <h3 class="tfa-status-headline">Enrolment in progress</h3>
              <p class="tfa-status-desc">
                You started enrolment but never confirmed the first code.
                Finish enrolling to protect your account.
              </p>
            </div>
            <div class="tfa-status-actions">
              <a href="/settings/2fa/enroll" class="tfa-btn tfa-btn-primary">
                Continue enrolment
              </a>
            </div>
          </section>
        )}

        {state === "off" && (
          <section class="tfa-status is-off" aria-label="Two-factor status">
            <div class="tfa-status-mark is-off" aria-hidden="true">
              <WarnIcon />
            </div>
            <div class="tfa-status-text">
              <h3 class="tfa-status-headline">Two-factor is OFF</h3>
              <p class="tfa-status-desc">
                Your account relies on a password alone. Turn on 2FA to add a
                second-factor code from your authenticator app.
              </p>
            </div>
            <div class="tfa-status-actions">
              <form method="post" action="/settings/2fa/enroll" style="margin:0">
                <button type="submit" class="tfa-btn tfa-btn-primary">
                  Enable two-factor
                </button>
              </form>
            </div>
          </section>
        )}

        {state === "on" && (
          <>
            <section class="tfa-section">
              <header class="tfa-section-head">
                <h3 class="tfa-section-title">
                  <span class="tfa-section-title-icon" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 2v6h-6" />
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                      <path d="M3 22v-6h6" />
                      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    </svg>
                  </span>
                  Recovery codes
                </h3>
                <p class="tfa-section-sub">
                  Single-use backup codes for when you lose access to your
                  authenticator. Store them in a password manager.
                </p>
              </header>
              <div class="tfa-section-body">
                <p style="margin:0 0 var(--space-3);font-size:13.5px;color:var(--text-muted);line-height:1.55">
                  <strong style="color:var(--text-strong)">{unusedRecovery}</strong>{" "}
                  unused recovery code{unusedRecovery === 1 ? "" : "s"}{" "}
                  remaining. Regenerating issues a new set and invalidates the
                  old ones.
                </p>
                <form
                  method="post"
                  action="/settings/2fa/recovery/regen"
                  style="margin:0"
                  onsubmit="return confirm('Regenerate recovery codes? Your existing codes will stop working.')"
                >
                  <button type="submit" class="tfa-btn tfa-btn-ghost">
                    Regenerate recovery codes
                  </button>
                </form>
              </div>
            </section>

            <section class="tfa-section">
              <header class="tfa-section-head">
                <h3 class="tfa-section-title">
                  <span class="tfa-section-title-icon" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  Disable two-factor
                </h3>
                <p class="tfa-section-sub">
                  Removes the second factor from your account. Confirm your
                  password to continue.
                </p>
              </header>
              <div class="tfa-section-body">
                <div class="tfa-warning" role="alert">
                  <WarnBannerIcon />
                  <div>
                    <strong>Heads up.</strong> Disabling 2FA leaves your
                    account password-only. Your recovery codes will be wiped
                    too — you'll need to re-enrol to get fresh ones.
                  </div>
                </div>
                <form method="post" action="/settings/2fa/disable">
                  <div class="tfa-form-row">
                    <div class="tfa-input-group" style="min-width:280px;flex:1;max-width:360px">
                      <label for="password">Current password</label>
                      <input
                        type="password"
                        id="password"
                        name="password"
                        required
                        autocomplete="current-password"
                        class="tfa-input"
                      />
                    </div>
                    <button type="submit" class="tfa-btn tfa-btn-danger">
                      Disable two-factor
                    </button>
                  </div>
                </form>
              </div>
            </section>
          </>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: tfaStyles }} />
    </Layout>
  );
});

/** Generate (or re-use pending) secret + show the QR enrolment page. */
async function showEnrolPage(c: any, user: any, error?: string) {
  let secret: string;
  try {
    const [existing] = await db
      .select()
      .from(userTotp)
      .where(eq(userTotp.userId, user.id))
      .limit(1);
    if (existing && !existing.enabledAt) {
      secret = existing.secret;
    } else if (existing && existing.enabledAt) {
      return c.redirect(
        errorRedirect("/settings/2fa", "2FA is already enabled")
      );
    } else {
      secret = generateTotpSecret();
      await db.insert(userTotp).values({ userId: user.id, secret });
    }
  } catch (err) {
    console.error("[2fa] enroll:", err);
    return c.redirect(errorRedirect("/settings/2fa", "Service unavailable"));
  }

  const url = otpauthUrl({
    secret,
    accountName: user.email || user.username,
    issuer: "gluecron",
  });
  return c.html(
    <Layout title="Enable 2FA" user={user}>
      <div class="tfa-wrap">
        <section class="tfa-hero">
          <div class="tfa-hero-orb" aria-hidden="true" />
          <div class="tfa-hero-inner">
            <div class="tfa-eyebrow">
              <span class="tfa-eyebrow-pill" aria-hidden="true">
                <ShieldIcon />
              </span>
              <a href="/settings" class="tfa-crumb">Settings</a>
              <span>/</span>
              <a href="/settings/2fa" class="tfa-crumb">Two-factor</a>
              <span>/</span>
              <span>Enrol</span>
            </div>
            <h2 class="tfa-title">
              <span class="tfa-title-grad">Set up your authenticator.</span>
            </h2>
            <p class="tfa-sub">
              Three steps. Less than a minute. Your authenticator generates a
              fresh 6-digit code every 30 seconds; we never see your secret
              after enrolment.
            </p>
          </div>
        </section>

        {error && (
          <div class="tfa-banner is-error" role="alert">
            <span class="tfa-banner-dot" aria-hidden="true" />
            {error}
          </div>
        )}

        <ol class="tfa-steps">
          <li class="tfa-step">
            <h3 class="tfa-step-title">Open your authenticator app</h3>
            <p class="tfa-step-body">
              Google Authenticator, 1Password, Bitwarden, Authy, or anything
              else that supports TOTP. Tap "add account".
            </p>
          </li>
          <li class="tfa-step">
            <h3 class="tfa-step-title">Scan the QR code, or enter the secret manually</h3>
            <p class="tfa-step-body">
              Most apps will read the <code style="font-family:var(--font-mono);font-size:12.5px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">otpauth://</code>{" "}
              URL directly. If yours can't scan, type the secret key by hand.
            </p>
            <div class="tfa-secret">
              <span class="tfa-secret-label">Secret key</span>
              <code class="tfa-secret-value">{secret}</code>
            </div>
            <div class="tfa-secret">
              <span class="tfa-secret-label">otpauth URL</span>
              <code class="tfa-secret-value is-url">{url}</code>
            </div>
          </li>
          <li class="tfa-step">
            <h3 class="tfa-step-title">Confirm with the 6-digit code</h3>
            <p class="tfa-step-body">
              Type the current code your authenticator shows. We'll mint your
              recovery codes immediately after — save them somewhere safe.
            </p>
            <form method="post" action="/settings/2fa/confirm">
              <div class="tfa-form-row">
                <div class="tfa-input-group">
                  <label for="code">Verification code</label>
                  <input
                    type="text"
                    id="code"
                    name="code"
                    required
                    pattern="[0-9]{6}"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxLength={6}
                    class="tfa-input is-code"
                    placeholder="000000"
                  />
                </div>
                <button type="submit" class="tfa-btn tfa-btn-primary">
                  Confirm + enable
                </button>
              </div>
            </form>
          </li>
        </ol>
      </div>
      <style dangerouslySetInnerHTML={{ __html: tfaStyles }} />
    </Layout>
  );
}

settings2fa.get("/settings/2fa/enroll", async (c) => {
  const user = c.get("user")!;
  return showEnrolPage(c, user);
});

settings2fa.post("/settings/2fa/enroll", async (c) => {
  const user = c.get("user")!;
  return showEnrolPage(c, user);
});

/** Verify the first code + flip enabled. Also mint recovery codes. */
settings2fa.post("/settings/2fa/confirm", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const code = String(body.code || "").trim();

  if (!/^\d{6}$/.test(code)) {
    return c.redirect(
      errorRedirect("/settings/2fa/enroll", "Enter the 6-digit code")
    );
  }

  try {
    const [row] = await db
      .select()
      .from(userTotp)
      .where(eq(userTotp.userId, user.id))
      .limit(1);
    if (!row || row.enabledAt) {
      return c.redirect("/settings/2fa");
    }
    const ok = await verifyTotpCode(row.secret, code);
    if (!ok) {
      return c.redirect(
        errorRedirect(
          "/settings/2fa/enroll",
          "Code did not verify — try again"
        )
      );
    }
    await db
      .update(userTotp)
      .set({ enabledAt: new Date(), lastUsedAt: new Date() })
      .where(eq(userTotp.userId, user.id));

    // Mint + store recovery codes
    const codes = generateRecoveryCodes(10);
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, user.id));
    await db.insert(userRecoveryCodes).values(
      hashes.map((h) => ({ userId: user.id, codeHash: h }))
    );

    await audit({
      userId: user.id,
      action: "2fa.enable",
      targetType: "user",
      targetId: user.id,
    });

    return c.html(
      <Layout title="Save your recovery codes" user={user}>
        <div class="tfa-wrap">
          <section class="tfa-hero">
            <div class="tfa-hero-orb" aria-hidden="true" />
            <div class="tfa-hero-inner">
              <div class="tfa-eyebrow">
                <span class="tfa-eyebrow-pill" aria-hidden="true">
                  <ShieldIcon />
                </span>
                <a href="/settings" class="tfa-crumb">Settings</a>
                <span>/</span>
                <a href="/settings/2fa" class="tfa-crumb">Two-factor</a>
                <span>/</span>
                <span>Recovery codes</span>
              </div>
              <h2 class="tfa-title">
                <span class="tfa-title-grad">Save your recovery codes.</span>
              </h2>
              <p class="tfa-sub">
                Two-factor is now on. These codes are your safety net if you
                ever lose access to your authenticator — store them somewhere
                you trust.
              </p>
            </div>
          </section>

          <div class="tfa-warning" role="alert">
            <WarnBannerIcon />
            <div>
              <strong>Shown only once.</strong> Copy them into your password
              manager or print them. Each code works one time.
            </div>
          </div>

          <pre class="tfa-codes" aria-label="Your recovery codes">{codes.join("\n")}</pre>

          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <a href="/settings/2fa" class="tfa-btn tfa-btn-primary">
              I've saved them
            </a>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: tfaStyles }} />
      </Layout>
    );
  } catch (err) {
    console.error("[2fa] confirm:", err);
    return c.redirect(
      errorRedirect("/settings/2fa/enroll", "Service unavailable")
    );
  }
});

settings2fa.post("/settings/2fa/disable", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const password = String(body.password || "");
  if (!password) {
    return c.redirect(
      errorRedirect("/settings/2fa", "Password is required")
    );
  }
  try {
    const [u] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (!u || !(await verifyPassword(password, u.passwordHash))) {
      return c.redirect(errorRedirect("/settings/2fa", "Invalid password"));
    }
    await db.delete(userTotp).where(eq(userTotp.userId, user.id));
    await db
      .delete(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, user.id));
    await audit({
      userId: user.id,
      action: "2fa.disable",
      targetType: "user",
      targetId: user.id,
    });
    return c.redirect("/settings/2fa?success=Two-factor+disabled");
  } catch (err) {
    console.error("[2fa] disable:", err);
    return c.redirect(errorRedirect("/settings/2fa", "Service unavailable"));
  }
});

settings2fa.post("/settings/2fa/recovery/regen", async (c) => {
  const user = c.get("user")!;
  try {
    const [row] = await db
      .select({ enabledAt: userTotp.enabledAt })
      .from(userTotp)
      .where(eq(userTotp.userId, user.id))
      .limit(1);
    if (!row || !row.enabledAt) {
      return c.redirect(
        errorRedirect("/settings/2fa", "Enable 2FA first")
      );
    }
    const codes = generateRecoveryCodes(10);
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    await db
      .delete(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, user.id));
    await db.insert(userRecoveryCodes).values(
      hashes.map((h) => ({ userId: user.id, codeHash: h }))
    );
    await audit({
      userId: user.id,
      action: "2fa.recovery.regenerate",
      targetType: "user",
      targetId: user.id,
    });
    return c.html(
      <Layout title="New recovery codes" user={user}>
        <div class="tfa-wrap">
          <section class="tfa-hero">
            <div class="tfa-hero-orb" aria-hidden="true" />
            <div class="tfa-hero-inner">
              <div class="tfa-eyebrow">
                <span class="tfa-eyebrow-pill" aria-hidden="true">
                  <ShieldIcon />
                </span>
                <a href="/settings" class="tfa-crumb">Settings</a>
                <span>/</span>
                <a href="/settings/2fa" class="tfa-crumb">Two-factor</a>
                <span>/</span>
                <span>New recovery codes</span>
              </div>
              <h2 class="tfa-title">
                <span class="tfa-title-grad">New recovery codes.</span>
              </h2>
              <p class="tfa-sub">
                Your previous codes have been wiped. Store this fresh set —
                you won't see them again.
              </p>
            </div>
          </section>

          <div class="tfa-warning" role="alert">
            <WarnBannerIcon />
            <div>
              <strong>Previous codes no longer work.</strong> Copy this set
              somewhere safe before navigating away.
            </div>
          </div>

          <pre class="tfa-codes" aria-label="Your new recovery codes">{codes.join("\n")}</pre>

          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <a href="/settings/2fa" class="tfa-btn tfa-btn-primary">
              Done
            </a>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: tfaStyles }} />
      </Layout>
    );
  } catch (err) {
    console.error("[2fa] regen:", err);
    return c.redirect(errorRedirect("/settings/2fa", "Service unavailable"));
  }
});

// Keep the import-check happy — config is intentionally available for
// future issuer customisation.
void config;

export default settings2fa;

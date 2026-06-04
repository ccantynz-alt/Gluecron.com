/**
 * WebAuthn passkey routes (Block B5).
 *
 * Registration (authed):
 *   POST /api/passkeys/register/options    → challenge + pubkey-cred-params
 *   POST /api/passkeys/register/verify     → save credential
 *   GET  /settings/passkeys                → list + add + rename + delete
 *   POST /settings/passkeys/:id/delete
 *   POST /settings/passkeys/:id/rename
 *
 * Authentication (unauthed):
 *   POST /api/passkeys/auth/options        → challenge (username optional)
 *   POST /api/passkeys/auth/verify         → issues full session on success
 *
 * The browser-side glue lives in `/views/components.tsx`
 * (`PasskeyScript`) — vanilla JS using the native `navigator.credentials` API.
 *
 * 2026 polish: status card hero, gradient-CTA register button, per-passkey
 * cards with device + last-used metadata, amber warning on remove. Every
 * CSS rule scoped under `.pk-*` — no overlap with 2FA's `.tfa-*`. ALL
 * WebAuthn ceremony JS, JSON endpoints, audit hooks, and POST handlers
 * preserved EXACTLY.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, userPasskeys, sessions } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import {
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
} from "../lib/webauthn";
import {
  generateSessionToken,
  sessionCookieOptions,
  sessionExpiry,
} from "../lib/auth";
import { audit } from "../lib/notify";

const passkeys = new Hono<AuthEnv>();

passkeys.use("/settings/passkeys", requireAuth);
passkeys.use("/settings/passkeys/*", requireAuth);
passkeys.use("/api/passkeys/register/*", requireAuth);

// --- Settings UI ------------------------------------------------------------

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.pk-` so it cannot bleed into
 * settings-2fa.tsx (`.tfa-`) or any other surface. Mirrors the
 * gradient-hairline hero + card patterns from admin-integrations.tsx and
 * admin-ops.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const pkStyles = `
  .pk-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .pk-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .pk-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .pk-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .pk-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .pk-eyebrow {
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
  .pk-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .pk-crumb { color: var(--text-muted); text-decoration: none; }
  .pk-crumb:hover { color: var(--text); text-decoration: none; }
  .pk-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .pk-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .pk-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  /* ─── Banners ─── */
  .pk-banner {
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
  .pk-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .pk-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .pk-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Status card ─── */
  .pk-status {
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
  .pk-status.is-on {
    border-color: rgba(52,211,153,0.32);
    background: linear-gradient(135deg, rgba(52,211,153,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .pk-status.is-off {
    border-color: rgba(251,191,36,0.32);
    background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .pk-status-mark {
    flex-shrink: 0;
    width: 56px; height: 56px;
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .pk-status-mark.is-on {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    box-shadow: 0 8px 20px -8px rgba(16,185,129,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .pk-status-mark.is-off {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    color: #1a1206;
    box-shadow: 0 8px 20px -8px rgba(251,191,36,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .pk-status-text { flex: 1; min-width: 220px; }
  .pk-status-headline {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .pk-status-desc {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .pk-status-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  /* ─── Section card ─── */
  .pk-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .pk-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .pk-section-head-text { flex: 1; min-width: 240px; }
  .pk-section-title {
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
  .pk-section-title-icon {
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
  .pk-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .pk-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Add-passkey CTA row ─── */
  .pk-cta-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .pk-cta-status {
    color: var(--text-muted);
    font-size: 13px;
    min-height: 18px;
  }
  .pk-cta-status.is-error { color: #fecaca; }
  .pk-cta-status.is-progress { color: #b69dff; }

  /* ─── Passkey list ─── */
  .pk-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .pk-card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 14px 16px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    flex-wrap: wrap;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .pk-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.02);
  }
  .pk-card-icon {
    flex-shrink: 0;
    width: 40px; height: 40px;
    border-radius: 10px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.22);
  }
  .pk-card-body { flex: 1; min-width: 200px; }
  .pk-card-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pk-card-name {
    font-family: var(--font-display);
    font-size: 14.5px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.008em;
  }
  .pk-card-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.25);
  }
  .pk-card-meta {
    margin-top: 4px;
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
  }
  .pk-card-meta .sep { color: var(--text-muted); opacity: 0.55; }
  .pk-card-meta-label {
    text-transform: uppercase;
    letter-spacing: 0.10em;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--text-muted);
    margin-right: 4px;
  }
  .pk-card-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .pk-card-rename {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
  }
  .pk-rename-input {
    width: 160px;
    padding: 7px 10px;
    font-size: 13px;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .pk-rename-input:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* ─── Empty state ─── */
  .pk-empty {
    padding: 32px 20px;
    text-align: center;
    color: var(--text-muted);
    background: var(--bg);
    border: 1px dashed var(--border-strong);
    border-radius: 12px;
  }
  .pk-empty-icon {
    margin: 0 auto 12px;
    width: 48px; height: 48px;
    border-radius: 12px;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.22);
  }
  .pk-empty-title {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
  }
  .pk-empty-body {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  /* ─── Buttons ─── */
  .pk-btn {
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
  .pk-btn-sm { padding: 7px 12px; font-size: 12.5px; border-radius: 8px; }
  .pk-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .pk-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .pk-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .pk-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .pk-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .pk-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
    text-decoration: none;
  }

  /* ─── Warning banner (amber) ─── */
  .pk-warning {
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
  .pk-warning-icon {
    flex-shrink: 0;
    width: 18px; height: 18px;
    margin-top: 1px;
    color: #fbbf24;
  }
  .pk-warning strong { color: #fef3c7; font-weight: 700; }

  /* ─── WebAuthn explainer ─── */
  .pk-explain-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3);
    margin-top: 4px;
  }
  .pk-explain {
    padding: 14px 16px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .pk-explain-icon {
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(54,197,214,0.10);
    color: #67e8f9;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.25);
    margin-bottom: 8px;
  }
  .pk-explain-title {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 13.5px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.008em;
  }
  .pk-explain-body {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
`;

const KeyIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);
const CheckIconLg = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const WarnIconLg = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);
const WarnBannerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="pk-warning-icon" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

// Pick a platform label from the transports array stored alongside the key.
// We don't know the OS, but transport hints tell us if it's hardware, USB,
// internal, etc. Keeps the visual chip honest without inventing data.
function describePasskey(transportsJson: string | null): {
  label: string;
  hint: string;
} {
  let arr: string[] = [];
  try {
    if (transportsJson) {
      const parsed = JSON.parse(transportsJson);
      if (Array.isArray(parsed)) arr = parsed.filter((s) => typeof s === "string");
    }
  } catch {
    /* ignore */
  }
  if (arr.includes("internal") && arr.includes("hybrid")) {
    return { label: "Phone or platform", hint: "internal + hybrid" };
  }
  if (arr.includes("internal")) {
    return { label: "Platform authenticator", hint: "this device" };
  }
  if (arr.includes("hybrid")) {
    return { label: "Cross-device", hint: "phone or QR pairing" };
  }
  if (arr.includes("usb")) {
    return { label: "Security key", hint: "USB" };
  }
  if (arr.includes("nfc") || arr.includes("ble")) {
    return { label: "Security key", hint: arr.join("·") };
  }
  return { label: "Passkey", hint: "registered" };
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

passkeys.get("/settings/passkeys", async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");
  const success = c.req.query("success");

  let keys: (typeof userPasskeys.$inferSelect)[] = [];
  try {
    keys = await db
      .select()
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, user.id));
  } catch (err) {
    console.error("[passkeys] list:", err);
  }

  const hasKeys = keys.length > 0;

  return c.html(
    <Layout title="Passkeys" user={user}>
      <div class="pk-wrap">
        <section class="pk-hero">
          <div class="pk-hero-orb" aria-hidden="true" />
          <div class="pk-hero-inner">
            <div class="pk-eyebrow">
              <span class="pk-eyebrow-pill" aria-hidden="true">
                <KeyIcon />
              </span>
              <a href="/settings" class="pk-crumb">Settings</a>
              <span>/</span>
              <span>Passkeys</span>
            </div>
            <h2 class="pk-title">
              <span class="pk-title-grad">Passkeys.</span>
            </h2>
            <p class="pk-sub">
              Phishing-resistant sign-in built into your device. The private
              key never leaves your authenticator — Touch ID, Face ID, Windows
              Hello, or a hardware security key.
            </p>
          </div>
        </section>

        {error && (
          <div class="pk-banner is-error" role="alert">
            <span class="pk-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}
        {success && (
          <div class="pk-banner is-ok" role="status">
            <span class="pk-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}

        {hasKeys ? (
          <section class="pk-status is-on" aria-label="Passkey status">
            <div class="pk-status-mark is-on" aria-hidden="true">
              <CheckIconLg />
            </div>
            <div class="pk-status-text">
              <h3 class="pk-status-headline">
                Passkeys are ON · {keys.length} registered
              </h3>
              <p class="pk-status-desc">
                You can sign in with any registered passkey. Keep at least one
                backup — losing your only passkey locks you out.
              </p>
            </div>
          </section>
        ) : (
          <section class="pk-status is-off" aria-label="Passkey status">
            <div class="pk-status-mark is-off" aria-hidden="true">
              <WarnIconLg />
            </div>
            <div class="pk-status-text">
              <h3 class="pk-status-headline">No passkeys yet</h3>
              <p class="pk-status-desc">
                Add one to enable phishing-resistant sign-in. We recommend
                registering at least two — one on your daily device and one
                stored as a backup.
              </p>
            </div>
          </section>
        )}

        <section class="pk-section">
          <header class="pk-section-head">
            <div class="pk-section-head-text">
              <h3 class="pk-section-title">
                <span class="pk-section-title-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </span>
                Register a new passkey
              </h3>
              <p class="pk-section-sub">
                Your browser will ask you to confirm with your biometric or
                security key. The whole exchange takes one tap.
              </p>
            </div>
          </header>
          <div class="pk-section-body">
            <div class="pk-cta-row">
              <button type="button" id="pk-add-btn" class="pk-btn pk-btn-primary">
                <KeyIcon />
                Register a new passkey
              </button>
              <span id="pk-add-status" class="pk-cta-status" aria-live="polite" />
            </div>

            <div class="pk-explain-grid" style="margin-top: var(--space-4)">
              <div class="pk-explain">
                <div class="pk-explain-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <h4 class="pk-explain-title">Private key stays local</h4>
                <p class="pk-explain-body">
                  Generated and held inside your device's secure element.
                  Never leaves, never crosses the network.
                </p>
              </div>
              <div class="pk-explain">
                <div class="pk-explain-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <h4 class="pk-explain-title">Phishing-resistant</h4>
                <p class="pk-explain-body">
                  The credential is bound to <code style="font-family:var(--font-mono);font-size:11px;background:var(--bg-tertiary);padding:1px 4px;border-radius:3px">gluecron.com</code>{" "}
                  — a lookalike site simply can't reuse it.
                </p>
              </div>
              <div class="pk-explain">
                <div class="pk-explain-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                </div>
                <h4 class="pk-explain-title">One tap to sign in</h4>
                <p class="pk-explain-body">
                  Touch ID, Face ID, Windows Hello, or a hardware security
                  key. No password, no TOTP prompt.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section class="pk-section">
          <header class="pk-section-head">
            <div class="pk-section-head-text">
              <h3 class="pk-section-title">
                <span class="pk-section-title-icon" aria-hidden="true">
                  <KeyIcon />
                </span>
                Registered passkeys
              </h3>
              <p class="pk-section-sub">
                Rename a passkey to make it easier to identify, or revoke one
                you no longer use.
              </p>
            </div>
          </header>
          <div class="pk-section-body">
            {hasKeys ? (
              <ul class="pk-list">
                {keys.map((k) => {
                  const desc = describePasskey(k.transports ?? null);
                  return (
                    <li class="pk-card">
                      <div class="pk-card-icon" aria-hidden="true">
                        <KeyIcon />
                      </div>
                      <div class="pk-card-body">
                        <div class="pk-card-name-row">
                          <span class="pk-card-name">{k.name}</span>
                          <span class="pk-card-tag" title={desc.hint}>
                            {desc.label}
                          </span>
                        </div>
                        <div class="pk-card-meta">
                          <span>
                            <span class="pk-card-meta-label">Added</span>
                            {formatDate(k.createdAt)}
                          </span>
                          <span class="sep">·</span>
                          <span>
                            <span class="pk-card-meta-label">Last used</span>
                            {k.lastUsedAt ? formatDate(k.lastUsedAt) : "never"}
                          </span>
                        </div>
                      </div>
                      <div class="pk-card-actions">
                        <form
                          method="post"
                          action={`/settings/passkeys/${k.id}/rename`}
                          class="pk-card-rename"
                        >
                          <input
                            type="text"
                            name="name"
                            defaultValue={k.name}
                            maxLength={60}
                            aria-label="Passkey name"
                            class="pk-rename-input"
                          />
                          <button type="submit" class="pk-btn pk-btn-ghost pk-btn-sm">
                            Save
                          </button>
                        </form>
                        <form
                          method="post"
                          action={`/settings/passkeys/${k.id}/delete`}
                          onsubmit="return confirm('Remove this passkey? You can no longer sign in with it.')"
                          style="margin:0"
                        >
                          <button type="submit" class="pk-btn pk-btn-danger pk-btn-sm">
                            Revoke
                          </button>
                        </form>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div class="pk-empty">
                <div class="pk-empty-icon" aria-hidden="true">
                  <KeyIcon />
                </div>
                <h4 class="pk-empty-title">No passkeys registered yet</h4>
                <p class="pk-empty-body">
                  Hit the button above to register your first one.
                </p>
              </div>
            )}

            {hasKeys && (
              <div class="pk-warning" role="alert" style="margin-top: var(--space-4); margin-bottom: 0">
                <WarnBannerIcon />
                <div>
                  <strong>Revoking a passkey is immediate.</strong> Any device
                  signed in with it stays signed in until the session expires,
                  but it can no longer be used for new logins. Make sure you
                  have at least one other way to sign in before removing your
                  last passkey.
                </div>
              </div>
            )}
          </div>
        </section>

        <script
          dangerouslySetInnerHTML={{
            __html: /* js */ `
              (function () {
                const btn = document.getElementById('pk-add-btn');
                const status = document.getElementById('pk-add-status');
                if (!btn) return;
                function setStatus(text, kind) {
                  status.textContent = text;
                  status.classList.remove('is-error', 'is-progress');
                  if (kind === 'error') status.classList.add('is-error');
                  if (kind === 'progress') status.classList.add('is-progress');
                }
                function b64uToBuf(s) {
                  s = s.replace(/-/g,'+').replace(/_/g,'/');
                  while (s.length % 4) s += '=';
                  const bin = atob(s);
                  const buf = new Uint8Array(bin.length);
                  for (let i=0;i<bin.length;i++) buf[i] = bin.charCodeAt(i);
                  return buf.buffer;
                }
                function bufToB64u(buf) {
                  const bytes = new Uint8Array(buf);
                  let bin = '';
                  for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
                  return btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
                }
                btn.addEventListener('click', async function () {
                  if (!window.PublicKeyCredential) {
                    setStatus('Passkeys not supported in this browser.', 'error');
                    return;
                  }
                  setStatus('Preparing…', 'progress');
                  try {
                    const optsRes = await fetch('/api/passkeys/register/options', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: '{}'
                    });
                    if (!optsRes.ok) throw new Error('options failed');
                    const { options, sessionKey } = await optsRes.json();
                    options.challenge = b64uToBuf(options.challenge);
                    options.user.id = b64uToBuf(options.user.id);
                    if (options.excludeCredentials) {
                      options.excludeCredentials = options.excludeCredentials.map(function (c) {
                        return Object.assign({}, c, { id: b64uToBuf(c.id) });
                      });
                    }
                    setStatus('Touch your authenticator…', 'progress');
                    const cred = await navigator.credentials.create({ publicKey: options });
                    const resp = {
                      id: cred.id,
                      rawId: bufToB64u(cred.rawId),
                      type: cred.type,
                      response: {
                        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                        attestationObject: bufToB64u(cred.response.attestationObject),
                        transports: cred.response.getTransports ? cred.response.getTransports() : []
                      },
                      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
                    };
                    const verifyRes = await fetch('/api/passkeys/register/verify', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ sessionKey: sessionKey, response: resp })
                    });
                    if (!verifyRes.ok) {
                      const j = await verifyRes.json().catch(() => ({}));
                      throw new Error(j.error || 'verify failed');
                    }
                    setStatus('Saved. Reloading…', 'progress');
                    window.location.reload();
                  } catch (e) {
                    setStatus('Error: ' + (e && e.message ? e.message : e), 'error');
                  }
                });
              })();
            `,
          }}
        />
      </div>
      <style dangerouslySetInnerHTML={{ __html: pkStyles }} />
    </Layout>
  );
});

passkeys.post("/settings/passkeys/:id/delete", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    const [row] = await db
      .select({ id: userPasskeys.id, userId: userPasskeys.userId })
      .from(userPasskeys)
      .where(eq(userPasskeys.id, id))
      .limit(1);
    if (!row || row.userId !== user.id) {
      return c.redirect("/settings/passkeys?error=Not+found");
    }
    await db.delete(userPasskeys).where(eq(userPasskeys.id, id));
    await audit({
      userId: user.id,
      action: "passkey.delete",
      targetType: "passkey",
      targetId: id,
    });
    return c.redirect("/settings/passkeys?success=Passkey+removed");
  } catch (err) {
    console.error("[passkeys] delete:", err);
    return c.redirect("/settings/passkeys?error=Service+unavailable");
  }
});

passkeys.post("/settings/passkeys/:id/rename", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim().slice(0, 60);
  if (!name) {
    return c.redirect("/settings/passkeys?error=Name+required");
  }
  try {
    const [row] = await db
      .select({ id: userPasskeys.id, userId: userPasskeys.userId })
      .from(userPasskeys)
      .where(eq(userPasskeys.id, id))
      .limit(1);
    if (!row || row.userId !== user.id) {
      return c.redirect("/settings/passkeys?error=Not+found");
    }
    await db
      .update(userPasskeys)
      .set({ name })
      .where(eq(userPasskeys.id, id));
    return c.redirect("/settings/passkeys?success=Renamed");
  } catch (err) {
    console.error("[passkeys] rename:", err);
    return c.redirect("/settings/passkeys?error=Service+unavailable");
  }
});

// --- Registration JSON endpoints (authed) -----------------------------------

passkeys.post("/api/passkeys/register/options", async (c) => {
  const user = c.get("user")!;
  try {
    const existing = await db
      .select({ credentialId: userPasskeys.credentialId })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, user.id));
    const { options, sessionKey } = await startRegistration({
      userId: user.id,
      userName: user.username,
      userDisplayName: user.displayName || user.username,
      excludeCredentialIds: existing.map((e) => e.credentialId),
    });
    return c.json({ options, sessionKey });
  } catch (err) {
    console.error("[passkeys] register/options:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

passkeys.post("/api/passkeys/register/verify", async (c) => {
  const user = c.get("user")!;
  let body: { sessionKey: string; response: any };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.sessionKey || !body.response) {
    return c.json({ error: "sessionKey and response required" }, 400);
  }
  const result = await finishRegistration({
    sessionKey: body.sessionKey,
    response: body.response,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  try {
    const transports = Array.isArray(body.response?.response?.transports)
      ? JSON.stringify(body.response.response.transports)
      : null;
    await db.insert(userPasskeys).values({
      userId: user.id,
      credentialId: result.credentialId,
      publicKey: result.publicKey,
      counter: result.counter,
      transports,
    });
    await audit({
      userId: user.id,
      action: "passkey.create",
      targetType: "passkey",
      metadata: { credentialId: result.credentialId },
    });
    return c.json({ ok: true });
  } catch (err: any) {
    if (String(err?.message || err).includes("user_passkeys")) {
      return c.json({ error: "Credential already registered" }, 409);
    }
    console.error("[passkeys] register save:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

// --- Authentication JSON endpoints (unauthed) -------------------------------

passkeys.post("/api/passkeys/auth/options", async (c) => {
  let body: { username?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    let userId: string | undefined;
    let allowCreds: string[] = [];
    if (body.username) {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, body.username.trim().toLowerCase()))
        .limit(1);
      if (u) {
        userId = u.id;
        const rows = await db
          .select({ credentialId: userPasskeys.credentialId })
          .from(userPasskeys)
          .where(eq(userPasskeys.userId, u.id));
        allowCreds = rows.map((r) => r.credentialId);
      }
    }
    const { options, sessionKey } = await startAuthentication({
      userId,
      allowCredentialIds: allowCreds,
    });
    return c.json({ options, sessionKey });
  } catch (err) {
    console.error("[passkeys] auth/options:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

passkeys.post("/api/passkeys/auth/verify", async (c) => {
  let body: { sessionKey: string; response: any };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.sessionKey || !body.response) {
    return c.json({ error: "sessionKey and response required" }, 400);
  }
  const result = await finishAuthentication({
    sessionKey: body.sessionKey,
    response: body.response,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  try {
    // Passkey is phishing-resistant + user-verifying; skip TOTP prompt.
    const token = generateSessionToken();
    await db.insert(sessions).values({
      userId: result.userId,
      token,
      expiresAt: sessionExpiry(),
      requires2fa: false,
    });
    setCookie(c, "session", token, sessionCookieOptions());
    await audit({
      userId: result.userId,
      action: "passkey.login",
      targetType: "passkey",
      metadata: { credentialId: result.credentialId },
    });
    return c.json({ ok: true });
  } catch (err) {
    console.error("[passkeys] auth/verify:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

export default passkeys;

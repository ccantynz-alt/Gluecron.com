/**
 * Block P2 — email verification routes.
 *
 *   GET  /verify-email?token=…    Consume a token. On success: 302 to
 *                                  /dashboard?verified=1 and fire-and-forget
 *                                  the welcome email. On failure: render a
 *                                  "link expired" page.
 *   POST /verify-email/resend     requireAuth. Issues a fresh verification
 *                                  token. Rate-limited per user (3/hour).
 *
 * 2026 polish: the dead-link page renders inside the shared `.auth-container`
 * gateway with a display headline, supporting subtitle, an Alert banner that
 * matches the rest of the auth surface, and an explicit "what to do next"
 * block — plus a resend form so the user can recover in-place if they're
 * already signed in (the heavy lifting still happens server-side in the
 * existing POST handler; the form is just the polished trigger).
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { Layout } from "../views/layout";
import { Alert, Text } from "../views/ui";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { config } from "../lib/config";
import {
  consumeVerificationToken,
  startEmailVerification,
  sendWelcomeEmail,
} from "../lib/email-verification";

const verify = new Hono<AuthEnv>();

const RESEND_LIMIT = 3;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const _resendLog: Map<string, number[]> = new Map();

function checkResendRate(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const cutoff = now - RESEND_WINDOW_MS;
  const recent = (_resendLog.get(userId) || []).filter((t) => t > cutoff);
  if (recent.length >= RESEND_LIMIT) {
    _resendLog.set(userId, recent);
    return { allowed: false, remaining: 0 };
  }
  recent.push(now);
  _resendLog.set(userId, recent);
  return { allowed: true, remaining: RESEND_LIMIT - recent.length };
}

/** Test-only: wipe the in-memory rate-limit counters. */
export function __resetResendRateLimitForTests(): void {
  _resendLog.clear();
}

// ---------------------------------------------------------------------------
// Per-page CSS — `.auth-extra-ev-*` so it can never collide with the
// locked .auth-container rules in layout.tsx.
// ---------------------------------------------------------------------------
function VerifyExtraStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        .auth-extra-ev-headline {
          font-family: var(--font-display);
          font-weight: 700;
          font-size: clamp(28px, 4.6vw, 40px);
          line-height: 1.08;
          letter-spacing: -0.028em;
          color: var(--text-strong);
          margin: 0 0 10px;
        }
        .auth-extra-ev-sub {
          color: var(--text-muted);
          font-size: 14.5px;
          line-height: 1.55;
          margin: 0 0 22px;
        }
        .auth-extra-ev-next {
          margin-top: 14px;
          padding: 12px 14px;
          background: var(--bg-tertiary, var(--bg-secondary));
          border: 1px solid var(--border);
          border-radius: var(--r-sm, 6px);
          color: var(--text-muted);
          font-size: 13px;
          line-height: 1.55;
        }
        .auth-extra-ev-next strong { color: var(--text); font-weight: 600; }
        .auth-extra-ev-meta {
          color: var(--text-muted);
          font-size: 13px;
          line-height: 1.55;
          margin: 6px 0 0;
          text-align: center;
        }
        .auth-extra-ev-meta code {
          font-family: var(--font-mono);
          font-size: 12px;
          background: var(--bg-tertiary, var(--bg-secondary));
          padding: 1px 6px;
          border-radius: 3px;
        }
        .auth-extra-ev-resend {
          margin-top: 16px;
          display: flex;
          justify-content: center;
        }
        .auth-extra-ev-resend button {
          width: 100%;
          padding: 11px 16px;
          font-size: 14.5px;
          font-weight: 600;
        }
        .auth-extra-ev-resend button[aria-busy="true"] {
          opacity: 0.78;
          cursor: progress;
          pointer-events: none;
        }
        .auth-extra-ev-resend button[aria-busy="true"]::after {
          content: '';
          display: inline-block;
          width: 12px;
          height: 12px;
          margin-left: 8px;
          vertical-align: -2px;
          border: 2px solid currentColor;
          border-right-color: transparent;
          border-radius: 50%;
          animation: auth-extra-ev-spin 0.7s linear infinite;
        }
        @keyframes auth-extra-ev-spin {
          to { transform: rotate(360deg); }
        }
        `,
      }}
    />
  );
}

function VerifySubmitBusyScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: /* js */ `
        (function () {
          try {
            var forms = document.querySelectorAll('form[data-auth-extra-ev]');
            forms.forEach(function (f) {
              f.addEventListener('submit', function () {
                var btn = f.querySelector('button[type=submit]');
                if (btn) btn.setAttribute('aria-busy', 'true');
              });
            });
          } catch (e) { /* no-op */ }
        })();
        `,
      }}
    />
  );
}

verify.get("/verify-email", softAuth, async (c) => {
  const token = c.req.query("token") || "";
  const user = c.get("user") || null;
  const result = await consumeVerificationToken(token);

  if (result.ok && result.userId) {
    void sendWelcomeEmail(result.userId);
    return c.redirect("/dashboard?verified=1");
  }

  const csrf = c.get("csrfToken") as string | undefined;
  const userEmail = (user as any)?.email as string | undefined;

  return c.html(
    <Layout title="Verification link expired" user={user}>
      <div class="auth-container">
        <VerifyExtraStyles />
        <h2 class="auth-extra-ev-headline">Link expired</h2>
        <p class="auth-extra-ev-sub">
          That email-verification link is no longer valid. Verification
          links live for <strong>24 hours</strong> and can only be used once.
        </p>
        <Alert variant="error">
          Reset your verification by requesting a fresh link — the one you
          clicked is expired, already used, or unknown.
        </Alert>
        <div class="auth-extra-ev-next">
          <strong>What to do next:</strong>{" "}
          {user
            ? "tap Resend below and we'll dispatch a brand-new link to your account email — usually arrives in under a minute."
            : "sign in to your account first, then request a fresh verification link from your dashboard."}
        </div>
        {user && userEmail && (
          <p class="auth-extra-ev-meta">
            We'll send the new link to <code>{userEmail}</code>.
          </p>
        )}
        {user ? (
          <form
            method="post"
            action="/verify-email/resend"
            class="auth-extra-ev-resend"
            data-auth-extra-ev="1"
          >
            {csrf && <input type="hidden" name="_csrf" value={csrf} />}
            <button type="submit" class="btn btn-primary">
              Resend verification email
            </button>
          </form>
        ) : (
          <p class="auth-switch" style="margin-top:18px">
            <a href="/login">Sign in</a>
          </p>
        )}
        <p class="auth-switch">
          <Text>
            Didn't expect this email?{" "}
            <a href="/login">Back to sign in</a>.
          </Text>
        </p>
        <VerifySubmitBusyScript />
      </div>
    </Layout>
  );
});

verify.post("/verify-email/resend", requireAuth, async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login");

  // If the caller posted from /settings/email-verification, send them back
  // there instead of the dashboard so the banner shows next to the page they
  // were on. Pure cosmetic — the underlying flow is unchanged.
  const referrer = c.req.header("referer") || "";
  const fromSettings = referrer.includes("/settings/email-verification");

  let email = user.email;
  let verifiedAt: Date | null = (user as any).emailVerifiedAt
    ? new Date((user as any).emailVerifiedAt as string | Date)
    : null;
  try {
    const [fresh] = await db
      .select({
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (fresh) {
      email = fresh.email;
      verifiedAt = fresh.emailVerifiedAt
        ? new Date(fresh.emailVerifiedAt as unknown as string | Date)
        : null;
    }
  } catch {
    // best effort
  }

  if (verifiedAt) {
    return c.redirect(
      fromSettings ? "/settings/email-verification?verified=1" : "/dashboard?verified=1"
    );
  }

  const rate = checkResendRate(user.id);
  if (!rate.allowed) {
    return c.redirect(
      fromSettings
        ? "/settings/email-verification?verify=rate_limited"
        : "/dashboard?verify=rate_limited"
    );
  }

  // If the operator hasn't wired a real email provider, fire the verification
  // anyway (it still writes a row + logs to stderr so the admin can grab the
  // token), but redirect to a state the banner can describe honestly. Lying
  // "Sent! Check your inbox" when the inbox will never receive it is the
  // exact frustration the user flagged.
  void startEmailVerification(user.id, email);
  if (config.emailProvider !== "resend" || !config.resendApiKey) {
    return c.redirect(
      fromSettings
        ? "/settings/email-verification?verify=not_configured"
        : "/dashboard?verify=not_configured"
    );
  }
  return c.redirect(
    fromSettings ? "/settings/email-verification?verify=sent" : "/dashboard?verify=sent"
  );
});

// ─── Scoped CSS (.ev-*) — settings page polish ─────────────────────────────
// Every selector prefixed `.ev-*` so this surface can't bleed into the
// auth-extra-ev-* styles used by the dead-link page above, or any other
// page. Mirrors the gradient-hairline hero + card pattern from
// settings-2fa.tsx and admin-integrations.tsx.
const evStyles = `
  .ev-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .ev-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ev-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ev-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .ev-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .ev-eyebrow {
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
  .ev-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .ev-crumb { color: var(--text-muted); text-decoration: none; }
  .ev-crumb:hover { color: var(--text); }
  .ev-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .ev-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ev-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  /* ─── Banner ─── */
  .ev-banner {
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
  .ev-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .ev-banner.is-warn {
    border-color: rgba(251,191,36,0.40);
    background: rgba(251,191,36,0.08);
    color: #fde68a;
  }
  .ev-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .ev-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Status card ─── */
  .ev-status {
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
  .ev-status.is-on {
    border-color: rgba(52,211,153,0.32);
    background: linear-gradient(135deg, rgba(52,211,153,0.08) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .ev-status.is-off {
    border-color: rgba(251,191,36,0.32);
    background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(15,17,26,0) 60%), var(--bg-elevated);
  }
  .ev-status-mark {
    flex-shrink: 0;
    width: 56px; height: 56px;
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .ev-status-mark.is-on {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    box-shadow: 0 8px 20px -8px rgba(16,185,129,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .ev-status-mark.is-off {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    color: #1a1206;
    box-shadow: 0 8px 20px -8px rgba(251,191,36,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .ev-status-text { flex: 1; min-width: 220px; }
  .ev-status-headline {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .ev-status-desc {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .ev-status-desc code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 5px;
    color: var(--text);
  }

  /* ─── Section card ─── */
  .ev-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .ev-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .ev-section-title {
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
  .ev-section-title-icon {
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
  .ev-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .ev-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Buttons ─── */
  .ev-btn {
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
  .ev-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .ev-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .ev-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .ev-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  .ev-meta {
    margin-top: var(--space-3);
    padding: 12px 14px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .ev-meta strong { color: var(--text-strong); }
  .ev-meta code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
  }
`;

const EvIconShield = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);
const EvCheckIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const EvWarnIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

// ─── /settings/email-verification — verification status + resend ───────────
// Visual sibling to /settings/2fa: status hero, single action card. The
// underlying resend flow points at the existing POST /verify-email/resend
// handler so all rate-limit + email-dispatch logic is unchanged.
verify.get("/settings/email-verification", requireAuth, async (c) => {
  const user = c.get("user")!;
  const csrf = c.get("csrfToken") as string | undefined;

  // Always read fresh from DB so a stale session doesn't show an outdated
  // unverified state right after the user clicks the verification link.
  let email = user.email;
  let verifiedAt: Date | null = (user as any).emailVerifiedAt
    ? new Date((user as any).emailVerifiedAt as string | Date)
    : null;
  try {
    const [fresh] = await db
      .select({
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (fresh) {
      email = fresh.email;
      verifiedAt = fresh.emailVerifiedAt
        ? new Date(fresh.emailVerifiedAt as unknown as string | Date)
        : null;
    }
  } catch {
    /* best effort */
  }

  const verified = !!verifiedAt;
  const flag = c.req.query("verify") || (c.req.query("verified") ? "ok" : "");
  let banner: { kind: "ok" | "warn" | "error"; text: string } | null = null;
  if (flag === "sent") {
    banner = { kind: "ok", text: "Verification email dispatched. Check your inbox — it usually lands in under a minute." };
  } else if (flag === "not_configured") {
    banner = { kind: "warn", text: "Verification token issued but no email provider is configured. The site admin can fetch the link from server logs." };
  } else if (flag === "rate_limited") {
    banner = { kind: "error", text: "Hold up — you've already requested a few links in the last hour. Try again later." };
  } else if (flag === "ok" || flag === "1") {
    banner = { kind: "ok", text: "Your email is verified." };
  }

  const providerWired = config.emailProvider === "resend" && !!config.resendApiKey;

  return c.html(
    <Layout title="Email verification" user={user}>
      <div class="ev-wrap">
        <section class="ev-hero">
          <div class="ev-hero-orb" aria-hidden="true" />
          <div class="ev-hero-inner">
            <div class="ev-eyebrow">
              <span class="ev-eyebrow-pill" aria-hidden="true">
                <EvIconShield />
              </span>
              <a href="/settings" class="ev-crumb">Settings</a>
              <span>/</span>
              <span>Email verification</span>
            </div>
            <h2 class="ev-title">
              <span class="ev-title-grad">Email verification.</span>
            </h2>
            <p class="ev-sub">
              Confirms you own the email on file. Required for password resets,
              security alerts, and (soon) repo transfers. Links live for
              24 hours and can only be used once.
            </p>
          </div>
        </section>

        {banner && (
          <div class={`ev-banner is-${banner.kind}`} role={banner.kind === "error" ? "alert" : "status"}>
            <span class="ev-banner-dot" aria-hidden="true" />
            {banner.text}
          </div>
        )}

        {verified ? (
          <section class="ev-status is-on" aria-label="Email verification status">
            <div class="ev-status-mark is-on" aria-hidden="true">
              <EvCheckIcon />
            </div>
            <div class="ev-status-text">
              <h3 class="ev-status-headline">Email verified</h3>
              <p class="ev-status-desc">
                <code>{email}</code> is confirmed
                {verifiedAt ? ` since ${verifiedAt.toLocaleDateString()}` : ""}.
                You're all set.
              </p>
            </div>
          </section>
        ) : (
          <section class="ev-status is-off" aria-label="Email verification status">
            <div class="ev-status-mark is-off" aria-hidden="true">
              <EvWarnIcon />
            </div>
            <div class="ev-status-text">
              <h3 class="ev-status-headline">Email not yet verified</h3>
              <p class="ev-status-desc">
                Send a fresh verification link to <code>{email}</code>. The
                link expires after 24 hours; you can request up to three per
                hour.
              </p>
            </div>
          </section>
        )}

        {!verified && (
          <section class="ev-section">
            <header class="ev-section-head">
              <h3 class="ev-section-title">
                <span class="ev-section-title-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                </span>
                Send a verification link
              </h3>
              <p class="ev-section-sub">
                Tap the button below to dispatch a brand-new link. We'll send
                it to your account email on file.
              </p>
            </header>
            <div class="ev-section-body">
              <form method="post" action="/verify-email/resend" style="margin:0">
                {csrf && <input type="hidden" name="_csrf" value={csrf} />}
                <button type="submit" class="ev-btn ev-btn-primary">
                  Send verification email
                </button>
              </form>
              {!providerWired && (
                <div class="ev-meta">
                  <strong>Heads up:</strong> the site operator hasn't wired a
                  production email provider yet. The verification row will be
                  created, but the link won't actually be emailed — an admin
                  can grab it from <code>server logs</code> for testing.
                </div>
              )}
              {providerWired && (
                <div class="ev-meta">
                  Need to change the email address itself? Update it on{" "}
                  <a href="/settings">your profile settings</a>.
                </div>
              )}
            </div>
          </section>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: evStyles }} />
    </Layout>
  );
});

export default verify;

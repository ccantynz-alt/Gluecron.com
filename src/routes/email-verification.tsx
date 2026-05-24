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
    return c.redirect("/dashboard?verified=1");
  }

  const rate = checkResendRate(user.id);
  if (!rate.allowed) {
    return c.redirect("/dashboard?verify=rate_limited");
  }

  // If the operator hasn't wired a real email provider, fire the verification
  // anyway (it still writes a row + logs to stderr so the admin can grab the
  // token), but redirect to a state the banner can describe honestly. Lying
  // "Sent! Check your inbox" when the inbox will never receive it is the
  // exact frustration the user flagged.
  void startEmailVerification(user.id, email);
  if (config.emailProvider !== "resend" || !config.resendApiKey) {
    return c.redirect("/dashboard?verify=not_configured");
  }
  return c.redirect("/dashboard?verify=sent");
});

export default verify;

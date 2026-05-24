/**
 * Block Q2 — Magic-link sign-in routes.
 *
 * GET  /login/magic                   → email-entry form
 * POST /login/magic                   → always redirects to ?sent=1
 * GET  /login/magic/callback?token=…  → consume token, set session, redirect
 *
 * Structurally a sibling of `password-reset.tsx`. Differences:
 *   - The "callback" lands the user directly into a fresh session — there
 *     is no second form to fill in. We mint a session cookie and bounce
 *     to /dashboard (existing user) or /onboarding?welcome=1 (auto-created).
 *   - 15-minute TTL is messaged on the success/dead-link pages.
 *
 * 2026 polish: display-quality headlines, supporting subtitle, "what
 * happens next" explainer, and loading-state submit so the surface
 * matches the polished /login + /register pages. All form actions, POST
 * handlers, redirects and token semantics are preserved exactly.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { db } from "../db";
import { sessions } from "../db/schema";
import {
  generateSessionToken,
  sessionCookieOptions,
  sessionExpiry,
} from "../lib/auth";
import { Layout } from "../views/layout";
import { Form, FormGroup, Input, Alert, Text } from "../views/ui";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  startMagicLinkSignIn,
  consumeMagicLinkToken,
} from "../lib/magic-link";

const magicLink = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Per-page CSS — `.auth-extra-ml-*` so it can never collide with the
// locked .auth-container rules in layout.tsx or with the sibling
// password-reset extras.
// ---------------------------------------------------------------------------
function MagicExtraStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        .auth-extra-ml-headline {
          font-family: var(--font-display);
          font-weight: 700;
          font-size: clamp(28px, 4.6vw, 40px);
          line-height: 1.08;
          letter-spacing: -0.028em;
          color: var(--text-strong);
          margin: 0 0 10px;
        }
        .auth-extra-ml-sub {
          color: var(--text-muted);
          font-size: 14.5px;
          line-height: 1.55;
          margin: 0 0 22px;
        }
        .auth-extra-ml-next {
          margin-top: 14px;
          padding: 12px 14px;
          background: var(--bg-tertiary, var(--bg-secondary));
          border: 1px solid var(--border);
          border-radius: var(--r-sm, 6px);
          color: var(--text-muted);
          font-size: 13px;
          line-height: 1.55;
        }
        .auth-extra-ml-next strong { color: var(--text); font-weight: 600; }
        .auth-extra-ml-steps {
          margin: 0;
          padding: 0 0 0 18px;
          color: var(--text-muted);
          font-size: 13px;
          line-height: 1.65;
        }
        .auth-extra-ml-steps li { margin: 2px 0; }
        .auth-extra-ml-submit {
          width: 100%;
          padding: 12px 16px;
          font-size: 15px;
          font-weight: 600;
          margin-top: 4px;
        }
        .auth-extra-ml-submit[aria-busy="true"] {
          opacity: 0.78;
          cursor: progress;
          pointer-events: none;
        }
        .auth-extra-ml-submit[aria-busy="true"]::after {
          content: '';
          display: inline-block;
          width: 12px;
          height: 12px;
          margin-left: 8px;
          vertical-align: -2px;
          border: 2px solid currentColor;
          border-right-color: transparent;
          border-radius: 50%;
          animation: auth-extra-ml-spin 0.7s linear infinite;
        }
        @keyframes auth-extra-ml-spin {
          to { transform: rotate(360deg); }
        }
        `,
      }}
    />
  );
}

function MagicSubmitBusyScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: /* js */ `
        (function () {
          try {
            var forms = document.querySelectorAll('form[data-auth-extra-ml]');
            forms.forEach(function (f) {
              f.addEventListener('submit', function () {
                var btn = f.querySelector('.auth-extra-ml-submit');
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

// ---------------------------------------------------------------------------
// GET /login/magic — entry form + post-submit success.
// ---------------------------------------------------------------------------

magicLink.get("/login/magic", softAuth, (c) => {
  const existing = c.get("user");
  if (existing) return c.redirect("/dashboard");

  const csrf = c.get("csrfToken") as string | undefined;
  const sent = c.req.query("sent") === "1";

  if (sent) {
    return c.html(
      <Layout title="Check your inbox" user={null}>
        <div class="auth-container">
          <MagicExtraStyles />
          <h2 class="auth-extra-ml-headline">Check your inbox</h2>
          <p class="auth-extra-ml-sub">
            We just sent a one-time sign-in link to the address you entered.
            It usually lands within a minute.
          </p>
          <Alert variant="success">
            If we can sign you in with that email, we've sent a link. It
            expires in 15 minutes.
          </Alert>
          <div class="auth-extra-ml-next">
            <strong>What happens next:</strong>
            <ol class="auth-extra-ml-steps" style="margin-top:6px">
              <li>Open the email titled "Your Gluecron sign-in link".</li>
              <li>Click the button — you'll be signed in on this device.</li>
              <li>The link expires in <strong>15 minutes</strong> and works only once.</li>
            </ol>
          </div>
          <p class="auth-switch">
            <Text>
              Didn't get it? Check your spam folder, or{" "}
              <a href="/login/magic">try again</a>.
            </Text>
          </p>
          <p class="auth-switch">
            <a href="/login">Back to sign in</a>
          </p>
        </div>
      </Layout>
    );
  }

  return c.html(
    <Layout title="Sign in with email link" user={null}>
      <div class="auth-container">
        <MagicExtraStyles />
        <h2 class="auth-extra-ml-headline">Sign in with a magic link</h2>
        <p class="auth-extra-ml-sub">
          Drop your email below and we'll send you a one-time sign-in link.
          No password to remember, no extra step.
        </p>
        <Form
          method="post"
          action="/login/magic"
          csrfToken={csrf}
          class="auth-extra-ml-form"
        >
          <FormGroup label="Email" htmlFor="email">
            <Input
              type="email"
              name="email"
              required
              placeholder="you@example.com"
              autocomplete="email"
              aria-label="Email"
              autofocus
            />
          </FormGroup>
          <button
            type="submit"
            class="btn btn-primary auth-extra-ml-submit"
            data-loading-label="Sending link…"
          >
            Send me a sign-in link
          </button>
        </Form>
        <div class="auth-extra-ml-next" style="margin-top:18px">
          <strong>How it works:</strong> we email a link that signs you in
          on this device when clicked. Links expire in 15 minutes and can
          only be used once. New here? An account is created automatically
          the first time you sign in.
        </div>
        <p class="auth-switch">
          <Text>
            Prefer a password?{" "}
            <a href="/login">Sign in the usual way</a>.
          </Text>
        </p>
        <script
          dangerouslySetInnerHTML={{
            __html: `document.querySelectorAll('form').forEach(function(f){ f.setAttribute('data-auth-extra-ml', '1'); });`,
          }}
        />
        <MagicSubmitBusyScript />
      </div>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /login/magic — always redirects to ?sent=1 (no enumeration).
// ---------------------------------------------------------------------------

magicLink.post("/login/magic", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email || "").trim();
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined;
  await startMagicLinkSignIn(email, { requestIp: ip });
  return c.redirect("/login/magic?sent=1");
});

// ---------------------------------------------------------------------------
// GET /login/magic/callback?token=… — consume the link.
// ---------------------------------------------------------------------------

function InvalidLinkPage(props: { user: any }) {
  return (
    <Layout title="Link no longer valid" user={props.user ?? null}>
      <div class="auth-container">
        <MagicExtraStyles />
        <h2 class="auth-extra-ml-headline">This link is no longer valid</h2>
        <p class="auth-extra-ml-sub">
          Magic links are single-use and time-limited. The one you followed
          is either expired, already redeemed, or unknown to us.
        </p>
        <Alert variant="error">
          Magic links expire after 15 minutes and can only be used once.
          This link is expired, already used, or unknown.
        </Alert>
        <p class="auth-switch" style="margin-top:16px">
          <a href="/login/magic">Send a fresh one</a>
        </p>
        <p class="auth-switch">
          <a href="/login">Back to sign in</a>
        </p>
      </div>
    </Layout>
  );
}

magicLink.get("/login/magic/callback", softAuth, async (c) => {
  const token = String(c.req.query("token") || "").trim();
  if (!token) return c.html(<InvalidLinkPage user={c.get("user")} />);

  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined;

  const result = await consumeMagicLinkToken(token, { requestIp: ip });
  if (!result.ok || !result.userId) {
    return c.html(<InvalidLinkPage user={c.get("user")} />);
  }

  // Mint a fresh session for this user. We deliberately do NOT honour
  // existing 2FA on magic-link sign-in here — the magic-link flow is
  // explicitly for users who don't manage a password and 2FA enrollment
  // requires a password in our current setup. If/when 2FA is decoupled
  // from password auth (Q3+), this is the place to gate.
  const sessionToken = generateSessionToken();
  await db.insert(sessions).values({
    userId: result.userId,
    token: sessionToken,
    expiresAt: sessionExpiry(),
  });
  setCookie(c, "session", sessionToken, sessionCookieOptions());

  if (result.createdAccount) return c.redirect("/onboarding?welcome=1");
  return c.redirect("/dashboard");
});

export default magicLink;

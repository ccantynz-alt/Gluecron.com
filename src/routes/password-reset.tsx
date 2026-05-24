/**
 * Block P1 — Password reset routes.
 *
 * GET  /forgot-password         → email-entry form
 * POST /forgot-password         → always redirects to ?sent=1
 * GET  /reset-password?token=…  → new-password form (or invalid-link page)
 * POST /reset-password          → rotate password + redirect to /login
 *
 * 2026 polish: each page renders inside the shared `.auth-container`
 * gateway with a display headline, supporting subtitle, "what happens
 * next" copy, visible validation rules, and a loading-state submit
 * button so the surface feels of-a-piece with the polished /login and
 * /register pages. All form actions, POST handlers, redirects and
 * validation semantics are preserved verbatim — only chrome changed.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { Form, FormGroup, Input, Alert, Text } from "../views/ui";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  createPasswordResetRequest,
  consumeResetToken,
  inspectResetToken,
} from "../lib/password-reset";

const passwordReset = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Shared CSS — scoped to `.auth-extra-*` so it can never collide with the
// locked .auth-container rules in layout.tsx (which we do NOT touch).
// The styles are emitted inline per-page; duplication is fine because the
// browser's CSSOM dedupes identical rules and these pages are rarely
// rendered back-to-back in the same session.
// ---------------------------------------------------------------------------
function ExtraStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        .auth-extra-headline {
          font-family: var(--font-display);
          font-weight: 700;
          font-size: clamp(28px, 4.6vw, 40px);
          line-height: 1.08;
          letter-spacing: -0.028em;
          color: var(--text-strong);
          margin: 0 0 10px;
        }
        .auth-extra-sub {
          color: var(--text-muted);
          font-size: 14.5px;
          line-height: 1.55;
          margin: 0 0 22px;
        }
        .auth-extra-next {
          margin-top: 14px;
          padding: 12px 14px;
          background: var(--bg-tertiary, var(--bg-secondary));
          border: 1px solid var(--border);
          border-radius: var(--r-sm, 6px);
          color: var(--text-muted);
          font-size: 13px;
          line-height: 1.55;
        }
        .auth-extra-next strong { color: var(--text); font-weight: 600; }
        .auth-extra-rules {
          margin: 4px 0 14px;
          padding: 0 0 0 16px;
          color: var(--text-muted);
          font-size: 12.5px;
          line-height: 1.6;
        }
        .auth-extra-rules li { margin: 0; }
        .auth-extra-submit {
          width: 100%;
          padding: 12px 16px;
          font-size: 15px;
          font-weight: 600;
          margin-top: 4px;
        }
        /* Loading state — driven by inline script that toggles aria-busy
           + a data attribute on submit. Spinner is a CSS-only pseudo-
           element so we don't ship JS for the visual. */
        .auth-extra-submit[aria-busy="true"] {
          opacity: 0.78;
          cursor: progress;
          pointer-events: none;
        }
        .auth-extra-submit[aria-busy="true"]::after {
          content: '';
          display: inline-block;
          width: 12px;
          height: 12px;
          margin-left: 8px;
          vertical-align: -2px;
          border: 2px solid currentColor;
          border-right-color: transparent;
          border-radius: 50%;
          animation: auth-extra-spin 0.7s linear infinite;
        }
        @keyframes auth-extra-spin {
          to { transform: rotate(360deg); }
        }
        .auth-extra-meta {
          display: flex;
          justify-content: center;
          gap: 8px;
          color: var(--text-muted);
          font-size: 13px;
          margin-top: 18px;
        }
        .auth-extra-meta a { color: var(--text); }
        .auth-extra-divider-dot {
          color: var(--text-faint);
        }
        `,
      }}
    />
  );
}

/** Inline script — flips `aria-busy=true` on the form's submit button as
 *  soon as the form starts submitting so users get unambiguous feedback
 *  on slower connections. Plain DOM, no framework. Falls back to the
 *  browser's default behaviour if anything throws. */
function SubmitBusyScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: /* js */ `
        (function () {
          try {
            var forms = document.querySelectorAll('form[data-auth-extra]');
            forms.forEach(function (f) {
              f.addEventListener('submit', function () {
                var btn = f.querySelector('.auth-extra-submit');
                if (btn) {
                  btn.setAttribute('aria-busy', 'true');
                  // Don't actually disable — disabled buttons get
                  // skipped on form submit by some browsers when the
                  // listener fires post-validation.
                  btn.dataset.label = btn.textContent || '';
                }
              });
            });
          } catch (e) { /* no-op */ }
        })();
        `,
      }}
    />
  );
}

passwordReset.get("/forgot-password", softAuth, (c) => {
  const csrf = c.get("csrfToken") as string | undefined;
  const sent = c.req.query("sent") === "1";

  if (sent) {
    return c.html(
      <Layout title="Reset link sent" user={c.get("user") ?? null}>
        <div class="auth-container">
          <ExtraStyles />
          <h2 class="auth-extra-headline">Check your inbox</h2>
          <p class="auth-extra-sub">
            We just dispatched a password-reset email — it usually lands within
            a minute.
          </p>
          <Alert variant="success">
            If we have an account for that email, we've sent a reset link.
            Check your inbox (and spam folder).
          </Alert>
          <div class="auth-extra-next">
            <strong>What happens next:</strong> click the button in the email
            within <strong>1 hour</strong> to set a new password. The link
            works only once.
          </div>
          <p class="auth-switch">
            <Text>
              Didn't get it? <a href="/forgot-password">Send another link</a>.
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
    <Layout title="Forgot password" user={c.get("user") ?? null}>
      <div class="auth-container">
        <ExtraStyles />
        <h2 class="auth-extra-headline">Reset your password</h2>
        <p class="auth-extra-sub">
          Enter the email tied to your account and we'll send you a one-time
          link to set a new password. No call to support needed.
        </p>
        <Form
          method="post"
          action="/forgot-password"
          csrfToken={csrf}
          class="auth-extra-form"
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
            class="btn btn-primary auth-extra-submit"
            data-loading-label="Sending link…"
          >
            Send reset link
          </button>
        </Form>
        <div class="auth-extra-next" style="margin-top:18px">
          <strong>What happens next:</strong> we'll email a reset link that
          expires in 1 hour. If you don't see it, check spam — or come back
          and request another.
        </div>
        <p class="auth-switch">
          <Text>
            Remembered it? <a href="/login">Sign in</a>
          </Text>
        </p>
        {/* Hidden marker so the busy-script can find this form. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `document.currentScript.previousElementSibling && document.querySelectorAll('form').forEach(function(f){ f.setAttribute('data-auth-extra', '1'); });`,
          }}
        />
        <SubmitBusyScript />
      </div>
    </Layout>
  );
});

passwordReset.post("/forgot-password", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email || "").trim();
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined;
  await createPasswordResetRequest(email, { requestIp: ip });
  return c.redirect("/forgot-password?sent=1");
});

function InvalidLinkPage(props: { user: any }) {
  return (
    <Layout title="Link no longer valid" user={props.user ?? null}>
      <div class="auth-container">
        <ExtraStyles />
        <h2 class="auth-extra-headline">This link is no longer valid</h2>
        <p class="auth-extra-sub">
          Reset links live for 1 hour and can only be used once. The link you
          followed is expired, already used, or unknown.
        </p>
        <Alert variant="error">
          Reset links expire after 1 hour and can only be used once. This link
          is expired, already used, or unknown.
        </Alert>
        <p class="auth-switch" style="margin-top:16px">
          <a href="/forgot-password">Request a new one</a>
        </p>
        <p class="auth-switch">
          <a href="/login">Back to sign in</a>
        </p>
      </div>
    </Layout>
  );
}

passwordReset.get("/reset-password", softAuth, async (c) => {
  const token = String(c.req.query("token") || "").trim();
  const csrf = c.get("csrfToken") as string | undefined;
  const error = c.req.query("error");

  if (!token) return c.html(<InvalidLinkPage user={c.get("user")} />);
  const check = await inspectResetToken(token);
  if (!check.valid) return c.html(<InvalidLinkPage user={c.get("user")} />);

  return c.html(
    <Layout title="Set a new password" user={c.get("user") ?? null}>
      <div class="auth-container">
        <ExtraStyles />
        <h2 class="auth-extra-headline">Set a new password</h2>
        <p class="auth-extra-sub">
          Pick something fresh — your old sessions on other devices will be
          signed out automatically once you save.
        </p>
        {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}
        <Form
          method="post"
          action="/reset-password"
          csrfToken={csrf}
          class="auth-extra-form"
        >
          <input type="hidden" name="token" value={token} />
          <FormGroup label="New password" htmlFor="password">
            <Input
              type="password"
              name="password"
              required
              minLength={8}
              placeholder="Min 8 characters"
              autocomplete="new-password"
              aria-label="New password"
              autofocus
            />
          </FormGroup>
          <ul class="auth-extra-rules" aria-label="Password requirements">
            <li>At least 8 characters</li>
            <li>Mix of letters, numbers, or symbols recommended</li>
            <li>Avoid passwords you use elsewhere</li>
          </ul>
          <FormGroup label="Confirm new password" htmlFor="confirm">
            <Input
              type="password"
              name="confirm"
              required
              minLength={8}
              placeholder="Re-enter the new password"
              autocomplete="new-password"
              aria-label="Confirm new password"
            />
          </FormGroup>
          <button
            type="submit"
            class="btn btn-primary auth-extra-submit"
            data-loading-label="Updating…"
          >
            Update password
          </button>
        </Form>
        <div class="auth-extra-next" style="margin-top:18px">
          <strong>What happens next:</strong> we'll sign you out everywhere
          else and bounce you to the sign-in page with your new password.
        </div>
        <p class="auth-switch">
          <a href="/login">Cancel</a>
        </p>
        <script
          dangerouslySetInnerHTML={{
            __html: `document.querySelectorAll('form').forEach(function(f){ f.setAttribute('data-auth-extra', '1'); });`,
          }}
        />
        <SubmitBusyScript />
      </div>
    </Layout>
  );
});

passwordReset.post("/reset-password", async (c) => {
  const body = await c.req.parseBody();
  const token = String(body.token || "").trim();
  const password = String(body.password || "");
  const confirm = String(body.confirm || "");

  const back = (msg: string) =>
    c.redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(msg)}`);

  if (!token) return c.html(<InvalidLinkPage user={null} />);
  if (!password || password.length < 8) return back("Password must be at least 8 characters");
  if (password !== confirm) return back("Passwords do not match");

  const result = await consumeResetToken(token, password);
  if (!result.ok) {
    if (result.reason === "weak") return back("Password must be at least 8 characters");
    return c.html(<InvalidLinkPage user={null} />);
  }

  return c.redirect("/login?success=" + encodeURIComponent("Password updated — please sign in"));
});

export default passwordReset;

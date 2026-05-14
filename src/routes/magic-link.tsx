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
import { Form, FormGroup, Input, Button, Alert, Text } from "../views/ui";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  startMagicLinkSignIn,
  consumeMagicLinkToken,
} from "../lib/magic-link";

const magicLink = new Hono<AuthEnv>();

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
          <h2>Check your inbox</h2>
          <Alert variant="success">
            If we can sign you in with that email, we've sent a link. It
            expires in 15 minutes.
          </Alert>
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
        <h2>Sign in with a magic link</h2>
        <p class="auth-switch" style="margin-bottom:16px;margin-top:0">
          <Text>
            Enter your email and we'll send you a one-time sign-in link. No
            password needed.
          </Text>
        </p>
        <Form method="post" action="/login/magic" csrfToken={csrf}>
          <FormGroup label="Email" htmlFor="email">
            <Input
              type="email"
              name="email"
              required
              placeholder="you@example.com"
              autocomplete="email"
              aria-label="Email"
            />
          </FormGroup>
          <Button type="submit" variant="primary">
            Send me a sign-in link
          </Button>
        </Form>
        <p class="auth-switch">
          <Text>
            Prefer a password?{" "}
            <a href="/login">Sign in the usual way</a>.
          </Text>
        </p>
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
        <h2>This link is no longer valid</h2>
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

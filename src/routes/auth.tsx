/**
 * Auth routes — register, login, logout (web + API).
 */

import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  sessions,
  organizations,
  userTotp,
  userRecoveryCodes,
  loginAttempts,
} from "../db/schema";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  sessionCookieOptions,
  sessionExpiry,
} from "../lib/auth";
import { verifyTotpCode, hashRecoveryCode } from "../lib/totp";
import { cancelAccountDeletion } from "../lib/account-deletion";
import { audit } from "../lib/notify";
import {
  getSsoConfig,
  getGithubOauthConfig,
  getGoogleOauthConfig,
} from "../lib/sso";
import { Layout } from "../views/layout";
import {
  Form,
  FormGroup,
  Input,
  Button,
  LinkButton,
  Alert,
  Text,
} from "../views/ui";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const auth = new Hono<AuthEnv>();

// One-shot latch — log the auto-verify warning at most once per process,
// since the misconfiguration is operator-level (env var) and won't change
// between requests.
let _autoVerifyWarned = false;

// ───────────────────────────────────────────────────────────────────────
// Scoped mobile polish — tightens the existing `.auth-container` shell
// from layout.tsx for ≤720px viewports. Only adds rules; does not
// redefine the desktop styling. Kept inline so this file remains the
// single source of truth for the auth surface.
// ───────────────────────────────────────────────────────────────────────
const authMobileCss = `
  @media (max-width: 720px) {
    .auth-container {
      margin: 24px 12px;
      padding: 24px 20px 22px;
      max-width: 100%;
    }
    .auth-container .btn-primary { min-height: 44px; }
    .auth-container .oauth-btn { min-height: 44px; }
    .auth-container input[type="text"],
    .auth-container input[type="email"],
    .auth-container input[type="password"] { min-height: 44px; }
    .auth-forgot { text-align: left !important; }
  }
`;
const AuthMobileStyle = () => (
  <style dangerouslySetInnerHTML={{ __html: authMobileCss }} />
);

// --- Web UI ---

auth.get("/register", softAuth, (c) => {
  // If the user is already signed in, drop them on their dashboard rather
  // than rendering the logged-out sign-up shell over an authed session.
  const existing = c.get("user");
  if (existing) return c.redirect("/dashboard");
  const error = c.req.query("error");
  const csrf = c.get("csrfToken") as string | undefined;
  return c.html(
    <Layout title="Register" user={null}>
      <AuthMobileStyle />
      <div class="auth-container">
        <h2>Create your account</h2>
        <p class="auth-subtitle">
          Get the full AI suite — code review, auto-merge, spec-to-PR — on
          unlimited public repos. No credit card.
        </p>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <Form method="post" action="/register" csrfToken={csrf}>
          <FormGroup label="Username" htmlFor="username">
            <Input
              id="username"
              type="text"
              name="username"
              required
              pattern="^[a-zA-Z0-9_-]+$"
              minLength={2}
              maxLength={39}
              placeholder="your-username"
              autocomplete="username"
            />
          </FormGroup>
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
          <FormGroup label="Password" htmlFor="password">
            <Input
              type="password"
              name="password"
              required
              minLength={8}
              placeholder="Min 8 characters"
              autocomplete="new-password"
              aria-label="Password"
            />
          </FormGroup>
          {/* P3 — Terms / Privacy acceptance. Required client-side via the
              `required` attribute; server-side re-checked in POST handler. */}
          <div class="form-group" style="margin: 12px 0">
            <label style="display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: var(--text-muted)">
              <input
                type="checkbox"
                name="accept_terms"
                value="1"
                required
                style="margin-top: 3px"
                aria-label="Accept Terms of Service and Privacy Policy"
              />
              <span>
                I agree to the{" "}
                <a href="/terms" target="_blank" rel="noopener">
                  Terms of Service
                </a>{" "}
                and{" "}
                <a href="/privacy" target="_blank" rel="noopener">
                  Privacy Policy
                </a>
                .
              </span>
            </label>
          </div>
          <Button type="submit" variant="primary">
            Create account
          </Button>
        </Form>
        <p class="auth-switch">
          <Text>Already have an account? <a href="/login">Sign in</a></Text>
        </p>
      </div>
    </Layout>
  );
});

auth.post("/register", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username || "").trim();
  const email = String(body.email || "").trim();
  const password = String(body.password || "");

  if (!username || !email || !password) {
    return c.redirect("/register?error=All+fields+are+required");
  }

  // Block P3 — Terms acceptance is required. The form's checkbox has
  // `required` so browsers normally enforce client-side; the server
  // re-checks for defensive depth (curl, scripted POST, etc.).
  if (!body.accept_terms) {
    return c.redirect(
      "/register?error=Please+accept+the+Terms+of+Service+and+Privacy+Policy"
    );
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return c.redirect(
      "/register?error=Username+may+only+contain+letters%2C+numbers%2C+hyphens+and+underscores"
    );
  }

  if (password.length < 8) {
    return c.redirect("/register?error=Password+must+be+at+least+8+characters");
  }

  // Check existing
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existingUser) {
    return c.redirect("/register?error=Username+already+taken");
  }

  // B2: usernames share the URL namespace with org slugs; refuse collisions.
  const [existingOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, username.toLowerCase()))
    .limit(1);
  if (existingOrg) {
    return c.redirect("/register?error=Username+already+taken");
  }

  const [existingEmail] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existingEmail) {
    return c.redirect("/register?error=Email+already+registered");
  }

  const passwordHash = await hashPassword(password);

  // First user ever registered becomes admin automatically
  const [userCount] = await db
    .select({ count: sql`count(*)::int` })
    .from(users);
  const isFirstUser = (userCount?.count as number) === 0;

  const [user] = await db
    .insert(users)
    .values({
      username,
      email,
      passwordHash,
      isAdmin: isFirstUser,
      // P3 — record terms acceptance now. Version bumps when Terms change.
      termsAcceptedAt: new Date(),
      termsVersion: "1.0",
    })
    .returning();

  // If username matches SITE_ADMIN_USERNAME env, grant site admin instantly
  // so the operator doesn't have to wait for the next boot's bootstrap pass.
  await import("../lib/admin-bootstrap")
    .then((m) => m.ensureEnvAdminOnRegister({ userId: user.id, username }))
    .catch((err) => {
      console.warn(
        `[admin-bootstrap] ensureEnvAdminOnRegister failed for ${username}:`,
        err instanceof Error ? err.message : err
      );
    });

  // Create session
  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
  });

  setCookie(c, "session", token, sessionCookieOptions());

  // Block P2 — email verification. If RESEND_API_KEY is configured the
  // verification email goes out and the user clicks the link to verify.
  // If email is NOT configured (EMAIL_PROVIDER=log, no RESEND_API_KEY,
  // etc.), the email would silently never arrive and the user would be
  // locked out — AUDIT-v2.md P0 #3. In that case, auto-verify the
  // account on registration so the user can actually use the site.
  // Operators who want real verification should set EMAIL_PROVIDER=resend
  // + RESEND_API_KEY in their environment.
  const { config: _emailConfig } = await import("../lib/config");
  const emailConfigured =
    _emailConfig.emailProvider === "resend" && !!_emailConfig.resendApiKey;
  if (emailConfigured) {
    import("../lib/email-verification")
      .then((m) => m.startEmailVerification(user.id, email))
      .catch((err) => {
        console.error(
          `[auth] startEmailVerification failed for ${user.id}:`,
          err instanceof Error ? err.message : err
        );
      });
  } else {
    // Auto-verify immediately so the user isn't trapped in an unverified
    // state. Log once so operators notice the misconfiguration.
    if (!_autoVerifyWarned) {
      _autoVerifyWarned = true;
      console.warn(
        "[auth] EMAIL_PROVIDER is not configured (set EMAIL_PROVIDER=resend + RESEND_API_KEY). Auto-verifying new account email addresses to avoid lockout."
      );
    }
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, user.id))
      .catch((err) => {
        console.error(
          `[auth] auto-verify failed for ${user.id}:`,
          err instanceof Error ? err.message : err
        );
      });
  }

  // Onboarding drip — T+0 "welcome" email. Fire-and-forget; never blocks
  // the redirect. Silently skips when email is not configured.
  import("../lib/onboarding-drip")
    .then((m) => m.sendWelcomeEmail(user.id))
    .catch((err) => {
      console.error(
        `[auth] onboarding welcome email failed for ${user.id}:`,
        err instanceof Error ? err.message : err
      );
    });

  // P3 — default landing is /onboarding (the guided first-five-minutes
  // flow). The `redirect=` query is still honoured for OAuth-style flows.
  const redirect = c.req.query("redirect") || "/onboarding?welcome=1";
  return c.redirect(redirect);
});

auth.get("/login", softAuth, async (c) => {
  // Already-authed users hitting the sign-in page get bounced to their
  // dashboard (or the `redirect=` target if one was supplied).
  const existing = c.get("user");
  const error = c.req.query("error");
  const success = c.req.query("success");
  const redirect = c.req.query("redirect") || "";
  if (existing) return c.redirect(redirect || "/dashboard");
  const ssoCfg = await getSsoConfig();
  const ssoEnabled =
    !!ssoCfg?.enabled &&
    !!ssoCfg.authorizationEndpoint &&
    !!ssoCfg.tokenEndpoint &&
    !!ssoCfg.userinfoEndpoint &&
    !!ssoCfg.clientId &&
    !!ssoCfg.clientSecret;
  const ssoLabel =
    ssoCfg?.providerName || inferSsoProviderName(ssoCfg) || "SSO";
  // Block L6 — "Sign in with GitHub" (separate row keyed id='github').
  const githubCfg = await getGithubOauthConfig();
  const githubEnabled =
    !!githubCfg?.enabled && !!githubCfg.clientId && !!githubCfg.clientSecret;
  // "Sign in with Google" (separate row keyed id='google'). Same wiring
  // pattern as GitHub OAuth.
  const googleCfg = await getGoogleOauthConfig();
  const googleEnabled =
    !!googleCfg?.enabled && !!googleCfg.clientId && !!googleCfg.clientSecret;
  const csrf = c.get("csrfToken") as string | undefined;
  return c.html(
    <Layout title="Sign in" user={null}>
      <AuthMobileStyle />
      <div class="auth-container">
        <h2>Welcome back</h2>
        <p class="auth-subtitle">
          Sign in to your gluecron account.
        </p>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        <Form
          method="post"
          action={`/login${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}`}
          csrfToken={csrf}
        >
          <FormGroup label="Username or email" htmlFor="username">
            <Input
              type="text"
              name="username"
              required
              placeholder="username or email"
              autocomplete="username"
              aria-label="Username or email"
            />
          </FormGroup>
          <FormGroup label="Password" htmlFor="password">
            <Input
              type="password"
              name="password"
              required
              placeholder="Password"
              autocomplete="current-password"
              aria-label="Password"
            />
          </FormGroup>
          <div class="auth-forgot" style="margin:-8px 0 12px;text-align:right;font-size:13px">
            <a href="/forgot-password">Forgot password?</a>
            {/* BLOCK Q2 — magic-link sign-in. */}
            <span style="margin:0 6px;color:var(--text-muted)">·</span>
            <a href="/login/magic">Sign in with a magic link instead</a>
          </div>
          <Button type="submit" variant="primary">
            Sign in
          </Button>
        </Form>
        {/* Provider buttons (Google + GitHub) — only rendered when the
            admin has configured + enabled them via /admin/google-oauth or
            /admin/github-oauth. The "or" divider above the first available
            provider sets the visual break from the password form. */}
        {(googleEnabled || githubEnabled) && (
          <div class="auth-divider">or</div>
        )}
        {googleEnabled && (
          <a
            href="/login/google"
            class="btn btn-block oauth-btn oauth-google"
            aria-label="Sign in with Google"
          >
            <svg
              class="oauth-icon"
              width="18"
              height="18"
              viewBox="0 0 18 18"
              aria-hidden="true"
            >
              <path
                d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                fill="#4285F4"
              />
              <path
                d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
                fill="#34A853"
              />
              <path
                d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                fill="#FBBC05"
              />
              <path
                d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                fill="#EA4335"
              />
            </svg>
            <span>Sign in with Google</span>
          </a>
        )}
        {githubEnabled && (
          <a
            href="/login/github"
            class="btn btn-block oauth-btn oauth-github"
            aria-label="Sign in with GitHub"
            style={googleEnabled ? "margin-top:8px" : undefined}
          >
            <svg
              class="oauth-icon"
              width="18"
              height="18"
              viewBox="0 0 16 16"
              aria-hidden="true"
              fill="currentColor"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span>Sign in with GitHub</span>
          </a>
        )}
        {ssoEnabled && (
          <a
            href="/login/sso"
            class="btn btn-block oauth-btn oauth-sso"
            aria-label={`Sign in with ${ssoLabel}`}
            style={(googleEnabled || githubEnabled) ? "margin-top:8px" : undefined}
          >
            <span>Sign in with {ssoLabel}</span>
          </a>
        )}
        <div class="auth-passkey">
          <div class="auth-divider">or</div>
          <button type="button" id="pk-signin-btn" class="btn">
            Sign in with passkey
          </button>
          <div
            id="pk-signin-status"
            class="auth-status"
            aria-live="polite"
          ></div>
        </div>
        <p class="auth-switch">
          <Text>New to gluecron? <a href="/register">Create an account</a></Text>
        </p>
        <script
          dangerouslySetInnerHTML={{
            __html: /* js */ `
              (function () {
                const btn = document.getElementById('pk-signin-btn');
                const status = document.getElementById('pk-signin-status');
                const userInput = document.getElementById('username');
                const redirect = ${JSON.stringify(redirect || "/")};
                if (!btn) return;
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
                    status.textContent = 'Passkeys not supported in this browser.';
                    return;
                  }
                  status.textContent = 'Preparing…';
                  try {
                    const username = (userInput && userInput.value || '').trim();
                    const optsRes = await fetch('/api/passkeys/auth/options', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(username ? { username: username } : {})
                    });
                    if (!optsRes.ok) throw new Error('options failed');
                    const { options, sessionKey } = await optsRes.json();
                    options.challenge = b64uToBuf(options.challenge);
                    if (options.allowCredentials) {
                      options.allowCredentials = options.allowCredentials.map(function (c) {
                        return Object.assign({}, c, { id: b64uToBuf(c.id) });
                      });
                    }
                    status.textContent = 'Touch your authenticator…';
                    const cred = await navigator.credentials.get({ publicKey: options });
                    const resp = {
                      id: cred.id,
                      rawId: bufToB64u(cred.rawId),
                      type: cred.type,
                      response: {
                        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                        authenticatorData: bufToB64u(cred.response.authenticatorData),
                        signature: bufToB64u(cred.response.signature),
                        userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null
                      },
                      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
                    };
                    const verifyRes = await fetch('/api/passkeys/auth/verify', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ sessionKey: sessionKey, response: resp })
                    });
                    if (!verifyRes.ok) {
                      const j = await verifyRes.json().catch(function () { return {}; });
                      throw new Error(j.error || 'verify failed');
                    }
                    status.textContent = 'Signed in. Redirecting…';
                    window.location.href = redirect;
                  } catch (e) {
                    status.textContent = 'Error: ' + (e && e.message ? e.message : e);
                  }
                });
              })();
            `,
          }}
        />
      </div>
    </Layout>
  );
});

// ── Account lockout constants (SOC 2 CC6.1) ─────────────────────────────
const LOGIN_FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Returns the number of failed login attempts for `email` in the last
 * `LOGIN_FAIL_WINDOW_MS` milliseconds.
 */
async function countRecentFailures(email: string): Promise<number> {
  const since = new Date(Date.now() - LOGIN_FAIL_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, email.toLowerCase()),
        eq(loginAttempts.success, false),
        gte(loginAttempts.createdAt, since)
      )
    );
  return row?.count ?? 0;
}

auth.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const identifier = String(body.username || "").trim();
  const password = String(body.password || "");
  const redirect = c.req.query("redirect") || "/";
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown";
  const ua = c.req.header("user-agent") || "";

  if (!identifier || !password) {
    return c.redirect("/login?error=All+fields+are+required");
  }

  // Resolve the canonical email for lockout checks regardless of whether
  // the user typed username or email.
  const isEmail = identifier.includes("@");
  const [user] = await db
    .select()
    .from(users)
    .where(
      isEmail
        ? eq(users.email, identifier)
        : eq(users.username, identifier)
    )
    .limit(1);

  // Determine the email key for lockout (use identifier if user not found
  // so we still record the attempt without leaking account existence).
  const emailKey = (user?.email ?? identifier).toLowerCase();

  // ── Lockout check ───────────────────────────────────────────────────
  // Check whether this email is currently locked out (≥ LOGIN_FAIL_LIMIT
  // failures in the last LOGIN_FAIL_WINDOW_MS). We check before password
  // verification so brute-forcers can't time-diff their way around it.
  const recentFailures = await countRecentFailures(emailKey);
  if (recentFailures >= LOGIN_FAIL_LIMIT) {
    // Record that we blocked this attempt (success=false) so the window
    // keeps rolling while the attacker keeps trying.
    await db
      .insert(loginAttempts)
      .values({ email: emailKey, ip, success: false })
      .catch(() => {});
    await audit({
      userId: user?.id ?? null,
      action: "auth.login.locked",
      ip,
      userAgent: ua,
      metadata: { email: emailKey, recentFailures },
    });
    return c.redirect(
      "/login?error=Account+temporarily+locked+due+to+too+many+failed+login+attempts.+Please+try+again+in+15+minutes."
    );
  }

  if (!user) {
    // Record failed attempt (unknown user) and return generic error.
    await db
      .insert(loginAttempts)
      .values({ email: emailKey, ip, success: false })
      .catch(() => {});
    return c.redirect("/login?error=Invalid+credentials");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    // Record failed attempt.
    await db
      .insert(loginAttempts)
      .values({ email: emailKey, ip, success: false })
      .catch(() => {});
    await audit({
      userId: user.id,
      action: "auth.login.failed",
      ip,
      userAgent: ua,
      metadata: { email: emailKey, attempt: recentFailures + 1 },
    });
    // Check if this failure just crossed the threshold.
    if (recentFailures + 1 >= LOGIN_FAIL_LIMIT) {
      await audit({
        userId: user.id,
        action: "auth.login.locked",
        ip,
        userAgent: ua,
        metadata: { email: emailKey, recentFailures: recentFailures + 1 },
      });
      return c.redirect(
        "/login?error=Account+temporarily+locked+due+to+too+many+failed+login+attempts.+Please+try+again+in+15+minutes."
      );
    }
    return c.redirect("/login?error=Invalid+credentials");
  }

  // Successful login — record success and clear old failure window.
  await db
    .insert(loginAttempts)
    .values({ email: emailKey, ip, success: true })
    .catch(() => {});

  // B4: if the user has TOTP enabled, issue a pending-2fa session and
  // redirect to the code prompt.
  const [totp] = await db
    .select({ enabledAt: userTotp.enabledAt })
    .from(userTotp)
    .where(eq(userTotp.userId, user.id))
    .limit(1);
  const needs2fa = !!(totp && totp.enabledAt);

  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
    requires2fa: needs2fa,
    ip,
    userAgent: ua,
    lastSeenAt: new Date(),
  });

  setCookie(c, "session", token, sessionCookieOptions());

  // Block P5 — If account was scheduled for deletion but user signed back
  // in, cancel the deletion. Safe regardless of 2FA: password was proven.
  if (user.deletedAt) {
    await cancelAccountDeletion(user.id);
  }

  if (needs2fa) {
    return c.redirect(
      `/login/2fa?redirect=${encodeURIComponent(redirect)}`
    );
  }
  return c.redirect(redirect);
});

// --- 2FA verify (B4) ---
auth.get("/login/2fa", async (c) => {
  const token = getCookie(c, "session");
  if (!token) return c.redirect("/login");
  const error = c.req.query("error");
  const redirect = c.req.query("redirect") || "/";
  return c.html(
    <Layout title="Two-factor authentication" user={null}>
      <AuthMobileStyle />
      <div class="auth-container">
        <h2>Enter your code</h2>
        <p
          class="auth-switch"
          style="margin-bottom: 16px; margin-top: 0"
        >
          Open your authenticator app and enter the 6-digit code. Lost your
          device? Paste a recovery code instead.
        </p>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form
          method="post"
          action={`/login/2fa?redirect=${encodeURIComponent(redirect)}`}
        >
          <input type="hidden" name="_csrf" value={(c.get("csrfToken") as string | undefined) || ""} />
          <div class="form-group">
            <label for="code">Code</label>
            <input
              type="text"
              id="code"
              name="code"
              required
              autocomplete="one-time-code"
              inputmode="numeric"
              maxLength={24}
              placeholder="123456 or xxxx-xxxx-xxxx"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Verify
          </button>
        </form>
        <p class="auth-switch">
          <a href="/logout">Cancel</a>
        </p>
      </div>
    </Layout>
  );
});

auth.post("/login/2fa", async (c) => {
  const token = getCookie(c, "session");
  if (!token) return c.redirect("/login");
  const body = await c.req.parseBody();
  const code = String(body.code || "").trim();
  const redirect = c.req.query("redirect") || "/";

  if (!code) {
    return c.redirect(
      `/login/2fa?error=Code+is+required&redirect=${encodeURIComponent(redirect)}`
    );
  }

  try {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1);
    if (
      !session ||
      new Date(session.expiresAt) < new Date() ||
      !session.requires2fa
    ) {
      return c.redirect("/login");
    }

    const [totp] = await db
      .select()
      .from(userTotp)
      .where(eq(userTotp.userId, session.userId))
      .limit(1);
    if (!totp || !totp.enabledAt) {
      // User doesn't have 2FA actually enabled — clear the flag and let
      // them in. This can only happen if 2FA was disabled in another
      // session between password check and code prompt.
      await db
        .update(sessions)
        .set({ requires2fa: false })
        .where(eq(sessions.token, token));
      return c.redirect(redirect);
    }

    // Try TOTP code first.
    const isSix = /^\d{6}$/.test(code);
    let ok = false;
    if (isSix) {
      ok = await verifyTotpCode(totp.secret, code);
    }
    // Fall through to recovery code.
    if (!ok) {
      const hash = await hashRecoveryCode(code);
      const [rec] = await db
        .select()
        .from(userRecoveryCodes)
        .where(
          and(
            eq(userRecoveryCodes.userId, session.userId),
            eq(userRecoveryCodes.codeHash, hash),
            isNull(userRecoveryCodes.usedAt)
          )
        )
        .limit(1);
      if (rec) {
        await db
          .update(userRecoveryCodes)
          .set({ usedAt: new Date() })
          .where(eq(userRecoveryCodes.id, rec.id));
        ok = true;
      }
    }

    if (!ok) {
      return c.redirect(
        `/login/2fa?error=Invalid+code&redirect=${encodeURIComponent(redirect)}`
      );
    }

    await db
      .update(sessions)
      .set({ requires2fa: false })
      .where(eq(sessions.token, token));
    await db
      .update(userTotp)
      .set({ lastUsedAt: new Date() })
      .where(eq(userTotp.userId, session.userId));

    return c.redirect(redirect);
  } catch (err) {
    console.error("[auth] 2fa verify:", err);
    return c.redirect(
      `/login/2fa?error=Service+unavailable&redirect=${encodeURIComponent(redirect)}`
    );
  }
});

auth.get("/logout", async (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/");
});

// --- API ---

auth.post("/api/auth/register", async (c) => {
  const body = await c.req.json<{
    username: string;
    email: string;
    password: string;
  }>();

  if (!body.username || !body.email || !body.password) {
    return c.json({ error: "username, email, and password are required" }, 400);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(body.username)) {
    return c.json({ error: "Invalid username" }, 400);
  }

  if (body.password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, body.username))
    .limit(1);
  if (existing) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  const [user] = await db
    .insert(users)
    .values({
      username: body.username,
      email: body.email,
      passwordHash,
    })
    .returning();

  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
  });

  return c.json(
    {
      user: { id: user.id, username: user.username, email: user.email },
      token,
    },
    201
  );
});

auth.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();

  if (!body.username || !body.password) {
    return c.json({ error: "username and password are required" }, 400);
  }

  const isEmail = body.username.includes("@");
  const [user] = await db
    .select()
    .from(users)
    .where(
      isEmail
        ? eq(users.email, body.username)
        : eq(users.username, body.username)
    )
    .limit(1);

  if (!user) return c.json({ error: "Invalid credentials" }, 401);

  const valid = await verifyPassword(body.password, user.passwordHash);
  if (!valid) return c.json({ error: "Invalid credentials" }, 401);

  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
  });

  return c.json({
    user: { id: user.id, username: user.username, email: user.email },
    token,
  });
});

/**
 * Pick a friendly provider name for the "Sign in with X" button when the
 * admin hasn't set one explicitly. Looks at the configured IdP URLs.
 * Falls back to undefined so the caller can default to a literal "SSO".
 */
function inferSsoProviderName(
  cfg: { issuer?: string | null; authorizationEndpoint?: string | null } | null | undefined
): string | undefined {
  const urls = [cfg?.issuer, cfg?.authorizationEndpoint]
    .filter((s): s is string => !!s)
    .join(" ")
    .toLowerCase();
  if (!urls) return undefined;
  if (urls.includes("google")) return "Google";
  if (urls.includes("okta")) return "Okta";
  if (urls.includes("microsoftonline") || urls.includes("azure")) return "Microsoft";
  if (urls.includes("auth0.com")) return "Auth0";
  if (urls.includes("authentik")) return "Authentik";
  return undefined;
}

export default auth;

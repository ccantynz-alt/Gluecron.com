/**
 * Auth routes — register, login, logout (web + API).
 */

import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  sessions,
  organizations,
  userTotp,
  userRecoveryCodes,
} from "../db/schema";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  sessionCookieOptions,
  sessionExpiry,
} from "../lib/auth";
import { verifyTotpCode, hashRecoveryCode } from "../lib/totp";
import { getSsoConfig, getGithubOauthConfig } from "../lib/sso";
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
      <div class="auth-container">
        <h2>Create account</h2>
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
    .values({ username, email, passwordHash, isAdmin: isFirstUser })
    .returning();

  // If username matches SITE_ADMIN_USERNAME env, grant site admin instantly
  // so the operator doesn't have to wait for the next boot's bootstrap pass.
  await import("../lib/admin-bootstrap").then((m) =>
    m.ensureEnvAdminOnRegister({ userId: user.id, username })
  ).catch(() => {});

  // Create session
  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
  });

  setCookie(c, "session", token, sessionCookieOptions());

  const redirect = c.req.query("redirect") || "/";
  return c.redirect(redirect);
});

auth.get("/login", softAuth, async (c) => {
  // Already-authed users hitting the sign-in page get bounced to their
  // dashboard (or the `redirect=` target if one was supplied).
  const existing = c.get("user");
  const error = c.req.query("error");
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
  const csrf = c.get("csrfToken") as string | undefined;
  return c.html(
    <Layout title="Sign in" user={null}>
      <div class="auth-container">
        <h2>Sign in</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
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
          <Button type="submit" variant="primary">
            Sign in
          </Button>
        </Form>
        {githubEnabled && (
          <div class="auth-sso">
            <div class="auth-divider">or</div>
            <LinkButton href="/login/github">Sign in with GitHub</LinkButton>
          </div>
        )}
        {ssoEnabled && (
          <div class="auth-sso">
            <div class="auth-divider">or</div>
            <LinkButton href="/login/sso">Sign in with {ssoLabel}</LinkButton>
          </div>
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

auth.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const identifier = String(body.username || "").trim();
  const password = String(body.password || "");
  const redirect = c.req.query("redirect") || "/";

  if (!identifier || !password) {
    return c.redirect("/login?error=All+fields+are+required");
  }

  // Find user by username or email
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

  if (!user) {
    return c.redirect("/login?error=Invalid+credentials");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.redirect("/login?error=Invalid+credentials");
  }

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
  });

  setCookie(c, "session", token, sessionCookieOptions());
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

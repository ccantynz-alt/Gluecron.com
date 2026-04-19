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
import { getSsoConfig } from "../lib/sso";
import { Layout } from "../views/layout";
import {
  Form,
  FormGroup,
  Input,
  Button,
  Alert,
  Text,
} from "../views/ui";
import type { AuthEnv } from "../middleware/auth";

const auth = new Hono<AuthEnv>();

// --- Web UI ---

auth.get("/register", (c) => {
  const error = c.req.query("error");
  return c.html(
    <Layout title="Register">
      <div class="auth-container">
        <h2>Create account</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <Form method="post" action="/register">
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

auth.get("/login", async (c) => {
  const error = c.req.query("error");
  const redirect = c.req.query("redirect") || "";
  const ssoCfg = await getSsoConfig();
  const ssoEnabled =
    !!ssoCfg?.enabled &&
    !!ssoCfg.authorizationEndpoint &&
    !!ssoCfg.tokenEndpoint &&
    !!ssoCfg.userinfoEndpoint &&
    !!ssoCfg.clientId &&
    !!ssoCfg.clientSecret;
  const ssoLabel = ssoCfg?.providerName || "SSO";
  return c.html(
    <Layout title="Sign in">
      <div class="auth-container">
        <h2>Sign in</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <Form
          method="post"
          action={`/login${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}`}
        >
          <FormGroup label="Username or email" htmlFor="username">
            <Input
              type="text"
              name="username"
              required
              placeholder="username or email"
              autocomplete="username"
            />
          </FormGroup>
          <FormGroup label="Password" htmlFor="password">
            <Input
              type="password"
              name="password"
              required
              placeholder="Password"
              autocomplete="current-password"
            />
          </FormGroup>
          <Button type="submit" variant="primary">
            Sign in
          </Button>
        </Form>
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
    <Layout title="Two-factor authentication">
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

export default auth;

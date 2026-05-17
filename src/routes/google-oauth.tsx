/**
 * "Sign in with Google" routes.
 *
 *   GET  /admin/google-oauth          — site-admin config page
 *   POST /admin/google-oauth          — save Client ID + Secret + toggle
 *   GET  /login/google                — kick off OAuth (redirect to Google)
 *   GET  /login/google/callback       — exchange code, sign user in
 *
 * Mirrors the structure of `src/routes/github-oauth.tsx`. Reuses the
 * existing `sso_user_links` table with `subject = "google:<sub>"` so it
 * sits alongside the enterprise IdP (id='default') and the GitHub
 * provider (id='github') without colliding.
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";
import {
  findOrCreateUserFromGoogle,
  getGoogleOauthConfig,
  googleOauthRedirectUri,
  issueSsoSession,
  randomToken,
  upsertGoogleOauthConfig,
  type GoogleProfile,
} from "../lib/sso";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  fetchGoogleUserinfo,
} from "../lib/google-oauth";
import { sessionCookieOptions } from "../lib/auth";

const googleOauth = new Hono<AuthEnv>();
googleOauth.use("*", softAuth);

function stateCookieOpts(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600, // 10 min to complete the flow
  };
}

// ----------------------------------------------------------------------------
// Admin config page
// ----------------------------------------------------------------------------

async function adminGate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/google-oauth");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to configure Google sign-in.</p>
        </div>
      </Layout>,
      403
    );
  }
  return { user };
}

googleOauth.get("/admin/google-oauth", requireAuth, async (c) => {
  const g = await adminGate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const cfg = await getGoogleOauthConfig();
  const success = c.req.query("success");
  const error = c.req.query("error");
  const redirectUri = googleOauthRedirectUri();

  return c.html(
    <Layout title="Google sign-in — Admin" user={user}>
      <div class="settings-container" style="max-width:780px">
        <h2>Sign in with Google</h2>
        <p style="color:var(--text-muted)">
          Let any developer sign in to gluecron with their Google account in
          one click. Create an OAuth 2.0 Client at{" "}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer noopener"
          >
            console.cloud.google.com/apis/credentials
          </a>{" "}
          (set application type = Web), then paste the Client ID + Secret here.
        </p>
        <div class="panel" style="padding:12px;margin-bottom:16px">
          <div
            style="font-size:12px;text-transform:uppercase;color:var(--text-muted)"
          >
            Authorised redirect URI — paste this into Google Cloud Console
          </div>
          <code id="g-redirect-uri" style="font-size:13px">
            {redirectUri}
          </code>
          <button
            type="button"
            class="btn"
            style="margin-left:8px"
            onclick={`navigator.clipboard.writeText(${JSON.stringify(redirectUri)});this.textContent='Copied';setTimeout(()=>this.textContent='Copy',1500)`}
          >
            Copy
          </button>
        </div>

        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}

        <form
          method="post"
          action="/admin/google-oauth"
          class="panel"
          style="padding:16px"
        >
          <label
            style="display:flex;gap:8px;align-items:center;margin-bottom:12px"
          >
            <input
              type="checkbox"
              name="enabled"
              value="1"
              checked={!!cfg?.enabled}
              aria-label="Enable Google sign-in on /login"
            />
            <span>Enable Google sign-in on /login</span>
          </label>
          <div class="form-group">
            <label for="g_client_id">Client ID</label>
            <input
              type="text"
              id="g_client_id"
              name="client_id"
              value={cfg?.clientId || ""}
              autocomplete="off"
              placeholder="123456789-xxxxxxxxx.apps.googleusercontent.com"
            />
          </div>
          <div class="form-group">
            <label for="g_client_secret">Client secret</label>
            <input
              type="password"
              id="g_client_secret"
              name="client_secret"
              value={cfg?.clientSecret || ""}
              autocomplete="off"
              placeholder={
                cfg?.clientSecret ? "(stored — leave blank to keep)" : ""
              }
            />
          </div>
          <div class="form-group">
            <label for="g_allowed_email_domains">
              Allowed email domains (comma-separated, empty = any)
            </label>
            <input
              type="text"
              id="g_allowed_email_domains"
              name="allowed_email_domains"
              value={cfg?.allowedEmailDomains || ""}
              placeholder="example.com, acme.io"
            />
          </div>
          <label
            style="display:flex;gap:8px;align-items:center;margin:12px 0"
          >
            <input
              type="checkbox"
              name="auto_create_users"
              value="1"
              checked={cfg ? cfg.autoCreateUsers : true}
              aria-label="Auto-create users on first Google sign-in"
            />
            <span>Auto-create local accounts on first Google sign-in</span>
          </label>
          <button type="submit" class="btn btn-primary">
            Save Google settings
          </button>
        </form>
      </div>
    </Layout>
  );
});

googleOauth.post("/admin/google-oauth", requireAuth, async (c) => {
  const g = await adminGate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const body = await c.req.parseBody();
  const existing = await getGoogleOauthConfig();
  const secretSubmitted = String(body.client_secret || "");
  const result = await upsertGoogleOauthConfig({
    enabled: String(body.enabled || "") === "1",
    clientId: String(body.client_id || ""),
    clientSecret:
      secretSubmitted.trim().length === 0 && existing?.clientSecret
        ? existing.clientSecret
        : secretSubmitted,
    allowedEmailDomains: String(body.allowed_email_domains || ""),
    autoCreateUsers: String(body.auto_create_users || "") === "1",
  });

  if (!result.ok) {
    return c.redirect(
      `/admin/google-oauth?error=${encodeURIComponent(result.error)}`
    );
  }

  await audit({
    userId: user.id,
    action: "admin.google_oauth.configure",
    metadata: {
      enabled: String(body.enabled || "") === "1",
      autoCreateUsers: String(body.auto_create_users || "") === "1",
      allowedDomains: String(body.allowed_email_domains || "") || null,
    },
  });

  return c.redirect(
    `/admin/google-oauth?success=${encodeURIComponent("Google sign-in settings saved.")}`
  );
});

// ----------------------------------------------------------------------------
// OAuth flow
// ----------------------------------------------------------------------------

googleOauth.get("/login/google", async (c) => {
  const cfg = await getGoogleOauthConfig();
  if (!cfg || !cfg.enabled) {
    return c.redirect(
      `/login?error=${encodeURIComponent("Google sign-in is not enabled")}`
    );
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    return c.redirect(
      `/login?error=${encodeURIComponent("Google sign-in is not fully configured")}`
    );
  }
  const state = randomToken(16);
  const nonce = randomToken(16);
  const redirectUri = googleOauthRedirectUri();
  let target: string;
  try {
    target = buildGoogleAuthorizeUrl(cfg, state, redirectUri, nonce);
  } catch (err) {
    return c.redirect(
      `/login?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Google sign-in misconfigured"
      )}`
    );
  }
  setCookie(c, "g_oauth_state", state, stateCookieOpts());
  setCookie(c, "g_oauth_nonce", nonce, stateCookieOpts());
  return c.redirect(target);
});

googleOauth.get("/login/google/callback", async (c) => {
  const cfg = await getGoogleOauthConfig();
  if (!cfg || !cfg.enabled) {
    return c.redirect(
      `/login?error=${encodeURIComponent("Google sign-in is not enabled")}`
    );
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const errCode = c.req.query("error");
  if (errCode) {
    return c.redirect(
      `/login?error=${encodeURIComponent(`Google error: ${errCode}`)}`
    );
  }
  if (!code || !state) {
    return c.redirect(
      `/login?error=${encodeURIComponent("Missing code or state")}`
    );
  }

  const expectedState = getCookie(c, "g_oauth_state");
  if (!expectedState || expectedState !== state) {
    return c.redirect(
      `/login?error=${encodeURIComponent(
        "Google state mismatch. Please try again."
      )}`
    );
  }

  // One-shot cookies — burn even on failure
  deleteCookie(c, "g_oauth_state", { path: "/" });
  deleteCookie(c, "g_oauth_nonce", { path: "/" });

  try {
    const { accessToken } = await exchangeGoogleCode(
      cfg,
      code,
      googleOauthRedirectUri()
    );
    const userinfo = await fetchGoogleUserinfo(cfg, accessToken);

    const profile: GoogleProfile = {
      sub: userinfo.sub,
      email: userinfo.email,
      emailVerified: userinfo.emailVerified,
      name: userinfo.name,
      picture: userinfo.picture,
    };

    const result = await findOrCreateUserFromGoogle(profile, cfg);
    if (!result.ok) {
      return c.redirect(`/login?error=${encodeURIComponent(result.error)}`);
    }

    const token = await issueSsoSession(result.user.id);
    setCookie(c, "session", token, sessionCookieOptions());

    await audit({
      userId: result.user.id,
      action: "auth.google.login",
      metadata: {
        googleSub: profile.sub,
        email: profile.email || null,
      },
    });

    return c.redirect("/");
  } catch (err) {
    console.error("[google-oauth] callback error:", err);
    return c.redirect(
      `/login?error=${encodeURIComponent(
        err instanceof Error
          ? `Google sign-in failed: ${err.message}`
          : "Google sign-in failed"
      )}`
    );
  }
});

export default googleOauth;

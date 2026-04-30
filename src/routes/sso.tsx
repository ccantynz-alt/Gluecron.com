/**
 * Block I10 — Enterprise SSO (OIDC) routes.
 *
 *   GET  /admin/sso                — site-admin config page
 *   POST /admin/sso                — save config
 *   GET  /login/sso                — begin OIDC flow (redirect to IdP)
 *   GET  /login/sso/callback       — handle IdP redirect, create session
 *   POST /settings/sso/unlink      — user drops their SSO link
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db } from "../db";
import { ssoUserLinks } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  findOrCreateUserFromSso,
  getSsoConfig,
  issueSsoSession,
  randomToken,
  ssoRedirectUri,
  upsertSsoConfig,
} from "../lib/sso";
import { sessionCookieOptions } from "../lib/auth";

const sso = new Hono<AuthEnv>();
sso.use("*", softAuth);

// Re-export the shared cookie options under the SSO namespace (buildable types)
// — defined here so we don't double-import under the same name.
function ssoStateCookieOpts(): {
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
  if (!user) return c.redirect("/login?next=/admin/sso");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to configure SSO.</p>
        </div>
      </Layout>,
      403
    );
  }
  return { user };
}

sso.get("/admin/sso", requireAuth, async (c) => {
  const g = await adminGate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const cfg = await getSsoConfig();
  const success = c.req.query("success");
  const error = c.req.query("error");
  const redirectUri = ssoRedirectUri();

  return c.html(
    <Layout title="SSO — Admin" user={user}>
      <div class="settings-container" style="max-width:780px">
        <h2>Enterprise SSO (OpenID Connect)</h2>
        <p style="color:var(--text-muted)">
          Configure a single site-wide OIDC provider. Users will see a
          "Sign in with{" "}
          <code>{cfg?.providerName || "SSO"}</code>" button on /login.
        </p>
        <div class="panel" style="padding:12px;margin-bottom:16px">
          <div
            style="font-size:12px;text-transform:uppercase;color:var(--text-muted)"
          >
            Redirect URI — paste this into your IdP
          </div>
          <code style="font-size:13px">{redirectUri}</code>
        </div>

        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}

        <form
          method="post"
          action="/admin/sso"
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
              aria-label="Enable SSO sign-in on /login"
            />
            <span>Enable SSO sign-in on /login</span>
          </label>
          <div class="form-group">
            <label for="provider_name">Button label</label>
            <input
              type="text"
              id="provider_name"
              name="provider_name"
              value={cfg?.providerName || "SSO"}
              maxLength={120}
              placeholder="Okta"
            />
          </div>
          <div class="form-group">
            <label for="issuer">Issuer URL</label>
            <input
              type="text"
              id="issuer"
              name="issuer"
              value={cfg?.issuer || ""}
              placeholder="https://example.okta.com"
            />
          </div>
          <div class="form-group">
            <label for="authorization_endpoint">Authorization endpoint</label>
            <input
              type="text"
              id="authorization_endpoint"
              name="authorization_endpoint"
              value={cfg?.authorizationEndpoint || ""}
              placeholder="https://example.okta.com/oauth2/v1/authorize"
            />
          </div>
          <div class="form-group">
            <label for="token_endpoint">Token endpoint</label>
            <input
              type="text"
              id="token_endpoint"
              name="token_endpoint"
              value={cfg?.tokenEndpoint || ""}
              placeholder="https://example.okta.com/oauth2/v1/token"
            />
          </div>
          <div class="form-group">
            <label for="userinfo_endpoint">Userinfo endpoint</label>
            <input
              type="text"
              id="userinfo_endpoint"
              name="userinfo_endpoint"
              value={cfg?.userinfoEndpoint || ""}
              placeholder="https://example.okta.com/oauth2/v1/userinfo"
            />
          </div>
          <div class="form-group">
            <label for="client_id">Client ID</label>
            <input
              type="text"
              id="client_id"
              name="client_id"
              value={cfg?.clientId || ""}
              autocomplete="off"
            />
          </div>
          <div class="form-group">
            <label for="client_secret">Client secret</label>
            <input
              type="password"
              id="client_secret"
              name="client_secret"
              value={cfg?.clientSecret || ""}
              autocomplete="off"
              placeholder={
                cfg?.clientSecret ? "(stored — leave blank to keep)" : ""
              }
            />
          </div>
          <div class="form-group">
            <label for="scopes">OIDC scopes</label>
            <input
              type="text"
              id="scopes"
              name="scopes"
              value={cfg?.scopes || "openid profile email"}
            />
          </div>
          <div class="form-group">
            <label for="allowed_email_domains">
              Allowed email domains (comma-separated, empty = any)
            </label>
            <input
              type="text"
              id="allowed_email_domains"
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
              aria-label="Auto-create users on first SSO sign-in"
            />
            <span>
              Auto-create local accounts on first SSO sign-in (turn off to
              require admins to pre-provision users)
            </span>
          </label>
          <button type="submit" class="btn btn-primary">
            Save SSO settings
          </button>
        </form>
      </div>
    </Layout>
  );
});

sso.post("/admin/sso", requireAuth, async (c) => {
  const g = await adminGate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const body = await c.req.parseBody();
  const existing = await getSsoConfig();
  const secretSubmitted = String(body.client_secret || "");
  const result = await upsertSsoConfig({
    enabled: String(body.enabled || "") === "1",
    providerName: String(body.provider_name || "SSO"),
    issuer: String(body.issuer || ""),
    authorizationEndpoint: String(body.authorization_endpoint || ""),
    tokenEndpoint: String(body.token_endpoint || ""),
    userinfoEndpoint: String(body.userinfo_endpoint || ""),
    clientId: String(body.client_id || ""),
    clientSecret:
      secretSubmitted.trim().length === 0 && existing?.clientSecret
        ? existing.clientSecret
        : secretSubmitted,
    scopes: String(body.scopes || "openid profile email"),
    allowedEmailDomains: String(body.allowed_email_domains || ""),
    autoCreateUsers: String(body.auto_create_users || "") === "1",
  });

  if (!result.ok) {
    return c.redirect(
      `/admin/sso?error=${encodeURIComponent(result.error)}`
    );
  }

  await audit({
    userId: user.id,
    action: "admin.sso.configure",
    metadata: {
      enabled: String(body.enabled || "") === "1",
      provider: String(body.provider_name || "SSO"),
      autoCreateUsers: String(body.auto_create_users || "") === "1",
      allowedDomains: String(body.allowed_email_domains || "") || null,
    },
  });

  return c.redirect(
    `/admin/sso?success=${encodeURIComponent("SSO settings saved.")}`
  );
});

// ----------------------------------------------------------------------------
// OIDC flow
// ----------------------------------------------------------------------------

sso.get("/login/sso", async (c) => {
  const cfg = await getSsoConfig();
  if (!cfg || !cfg.enabled) {
    return c.redirect(
      `/login?error=${encodeURIComponent("SSO is not enabled")}`
    );
  }
  if (
    !cfg.authorizationEndpoint ||
    !cfg.tokenEndpoint ||
    !cfg.userinfoEndpoint ||
    !cfg.clientId ||
    !cfg.clientSecret
  ) {
    return c.redirect(
      `/login?error=${encodeURIComponent("SSO is not fully configured")}`
    );
  }
  const state = randomToken(16);
  const nonce = randomToken(16);
  const redirectUri = ssoRedirectUri();
  let target: string;
  try {
    target = buildAuthorizeUrl(cfg, state, nonce, redirectUri);
  } catch (err) {
    return c.redirect(
      `/login?error=${encodeURIComponent(
        err instanceof Error ? err.message : "SSO misconfigured"
      )}`
    );
  }
  setCookie(c, "sso_state", state, ssoStateCookieOpts());
  setCookie(c, "sso_nonce", nonce, ssoStateCookieOpts());
  return c.redirect(target);
});

sso.get("/login/sso/callback", async (c) => {
  const cfg = await getSsoConfig();
  if (!cfg || !cfg.enabled) {
    return c.redirect(
      `/login?error=${encodeURIComponent("SSO is not enabled")}`
    );
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const errCode = c.req.query("error");
  if (errCode) {
    return c.redirect(
      `/login?error=${encodeURIComponent(
        `SSO provider error: ${errCode}`
      )}`
    );
  }
  if (!code || !state) {
    return c.redirect(
      `/login?error=${encodeURIComponent("Missing code or state")}`
    );
  }

  const expectedState = getCookie(c, "sso_state");
  if (!expectedState || expectedState !== state) {
    return c.redirect(
      `/login?error=${encodeURIComponent(
        "SSO state mismatch. Please try again."
      )}`
    );
  }

  // One-shot cookies — burn them even on failure
  deleteCookie(c, "sso_state", { path: "/" });
  deleteCookie(c, "sso_nonce", { path: "/" });

  try {
    const tokens = await exchangeCode(cfg, code, ssoRedirectUri());
    const claims = await fetchUserinfo(cfg, tokens.access_token);
    const result = await findOrCreateUserFromSso(claims, cfg);
    if (!result.ok) {
      return c.redirect(`/login?error=${encodeURIComponent(result.error)}`);
    }

    const token = await issueSsoSession(result.user.id);
    setCookie(c, "session", token, sessionCookieOptions());

    await audit({
      userId: result.user.id,
      action: "auth.sso.login",
      metadata: {
        provider: cfg.providerName,
        sub: claims.sub,
        email: claims.email || null,
      },
    });

    return c.redirect("/");
  } catch (err) {
    console.error("[sso] callback error:", err);
    return c.redirect(
      `/login?error=${encodeURIComponent(
        err instanceof Error
          ? `SSO sign-in failed: ${err.message}`
          : "SSO sign-in failed"
      )}`
    );
  }
});

// ----------------------------------------------------------------------------
// User: unlink SSO
// ----------------------------------------------------------------------------

sso.post("/settings/sso/unlink", requireAuth, async (c) => {
  const user = c.get("user")!;
  const links = await db
    .select({ id: ssoUserLinks.id })
    .from(ssoUserLinks)
    .where(eq(ssoUserLinks.userId, user.id));
  if (links.length === 0) {
    return c.redirect("/settings?error=" + encodeURIComponent("No SSO link"));
  }
  await db.delete(ssoUserLinks).where(eq(ssoUserLinks.userId, user.id));
  await audit({
    userId: user.id,
    action: "auth.sso.unlink",
    metadata: { removedLinks: links.length },
  });
  return c.redirect(
    "/settings?success=" + encodeURIComponent("SSO link removed.")
  );
});

export default sso;

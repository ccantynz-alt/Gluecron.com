/**
 * Block L6 — "Sign in with GitHub" routes.
 *
 *   GET  /admin/github-oauth          — site-admin config page
 *   POST /admin/github-oauth          — save Client ID + Secret + toggle
 *   GET  /login/github                — kick off OAuth (redirect to GitHub)
 *   GET  /login/github/callback       — exchange code, sign user in
 *
 * Reuses the existing `sso_user_links` table with `subject = "github:<id>"`
 * so it sits alongside the enterprise IdP at id='default' without colliding.
 *
 * NOTE: file extension is .tsx (not the .ts the spec mentioned) because the
 * admin config page renders JSX via Hono's hono/jsx pragma — matches the
 * convention in `routes/sso.tsx`.
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";
import {
  findOrCreateUserFromGithub,
  getGithubOauthConfig,
  githubOauthRedirectUri,
  issueSsoSession,
  randomToken,
  upsertGithubOauthConfig,
  type GithubProfile,
} from "../lib/sso";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubPrimaryEmail,
  fetchGithubUserinfo,
} from "../lib/github-oauth";
import { sessionCookieOptions } from "../lib/auth";

const githubOauth = new Hono<AuthEnv>();
githubOauth.use("*", softAuth);

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
  if (!user) return c.redirect("/login?next=/admin/github-oauth");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to configure GitHub sign-in.</p>
        </div>
      </Layout>,
      403
    );
  }
  return { user };
}

githubOauth.get("/admin/github-oauth", requireAuth, async (c) => {
  const g = await adminGate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const cfg = await getGithubOauthConfig();
  const success = c.req.query("success");
  const error = c.req.query("error");
  const redirectUri = githubOauthRedirectUri();

  return c.html(
    <Layout title="GitHub sign-in — Admin" user={user}>
      <div class="settings-container" style="max-width:780px">
        <h2>Sign in with GitHub</h2>
        <p style="color:var(--text-muted)">
          Let any developer sign in to gluecron with their existing GitHub
          account in one click. Register an OAuth app at{" "}
          <a
            href="https://github.com/settings/developers"
            target="_blank"
            rel="noreferrer noopener"
          >
            github.com/settings/developers
          </a>{" "}
          and paste the Client ID + Secret here.
        </p>
        <div class="panel" style="padding:12px;margin-bottom:16px">
          <div
            style="font-size:12px;text-transform:uppercase;color:var(--text-muted)"
          >
            Authorization callback URL — paste this into GitHub
          </div>
          <code id="gh-redirect-uri" style="font-size:13px">
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
          action="/admin/github-oauth"
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
              aria-label="Enable GitHub sign-in on /login"
            />
            <span>Enable GitHub sign-in on /login</span>
          </label>
          <div class="form-group">
            <label for="gh_client_id">Client ID</label>
            <input
              type="text"
              id="gh_client_id"
              name="client_id"
              value={cfg?.clientId || ""}
              autocomplete="off"
              placeholder="Iv1.xxxxxxxxxxxxxxxx"
            />
          </div>
          <div class="form-group">
            <label for="gh_client_secret">Client secret</label>
            <input
              type="password"
              id="gh_client_secret"
              name="client_secret"
              value={cfg?.clientSecret || ""}
              autocomplete="off"
              placeholder={
                cfg?.clientSecret ? "(stored — leave blank to keep)" : ""
              }
            />
          </div>
          <div class="form-group">
            <label for="gh_allowed_email_domains">
              Allowed email domains (comma-separated, empty = any)
            </label>
            <input
              type="text"
              id="gh_allowed_email_domains"
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
              aria-label="Auto-create users on first GitHub sign-in"
            />
            <span>
              Auto-create local accounts on first GitHub sign-in
            </span>
          </label>
          <button type="submit" class="btn btn-primary">
            Save GitHub settings
          </button>
        </form>
      </div>
    </Layout>
  );
});

githubOauth.post("/admin/github-oauth", requireAuth, async (c) => {
  const g = await adminGate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const body = await c.req.parseBody();
  const existing = await getGithubOauthConfig();
  const secretSubmitted = String(body.client_secret || "");
  const result = await upsertGithubOauthConfig({
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
      `/admin/github-oauth?error=${encodeURIComponent(result.error)}`
    );
  }

  await audit({
    userId: user.id,
    action: "admin.github_oauth.configure",
    metadata: {
      enabled: String(body.enabled || "") === "1",
      autoCreateUsers: String(body.auto_create_users || "") === "1",
      allowedDomains: String(body.allowed_email_domains || "") || null,
    },
  });

  return c.redirect(
    `/admin/github-oauth?success=${encodeURIComponent("GitHub sign-in settings saved.")}`
  );
});

// ----------------------------------------------------------------------------
// OAuth flow
// ----------------------------------------------------------------------------

githubOauth.get("/login/github", async (c) => {
  const cfg = await getGithubOauthConfig();
  if (!cfg || !cfg.enabled) {
    return c.redirect(
      `/login?error=${encodeURIComponent("GitHub sign-in is not enabled")}`
    );
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    return c.redirect(
      `/login?error=${encodeURIComponent("GitHub sign-in is not fully configured")}`
    );
  }
  const state = randomToken(16);
  const redirectUri = githubOauthRedirectUri();
  let target: string;
  try {
    target = buildGithubAuthorizeUrl(cfg, state, redirectUri);
  } catch (err) {
    return c.redirect(
      `/login?error=${encodeURIComponent(
        err instanceof Error ? err.message : "GitHub sign-in misconfigured"
      )}`
    );
  }
  setCookie(c, "gh_oauth_state", state, stateCookieOpts());
  return c.redirect(target);
});

githubOauth.get("/login/github/callback", async (c) => {
  const cfg = await getGithubOauthConfig();
  if (!cfg || !cfg.enabled) {
    return c.redirect(
      `/login?error=${encodeURIComponent("GitHub sign-in is not enabled")}`
    );
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const errCode = c.req.query("error");
  if (errCode) {
    return c.redirect(
      `/login?error=${encodeURIComponent(`GitHub error: ${errCode}`)}`
    );
  }
  if (!code || !state) {
    return c.redirect(
      `/login?error=${encodeURIComponent("Missing code or state")}`
    );
  }

  const expectedState = getCookie(c, "gh_oauth_state");
  if (!expectedState || expectedState !== state) {
    return c.redirect(
      `/login?error=${encodeURIComponent(
        "GitHub state mismatch. Please try again."
      )}`
    );
  }

  // One-shot cookie — burn it even on failure
  deleteCookie(c, "gh_oauth_state", { path: "/" });

  try {
    const { accessToken } = await exchangeGithubCode(
      cfg,
      code,
      githubOauthRedirectUri()
    );
    const userinfo = await fetchGithubUserinfo(accessToken);

    // GitHub may hide email when the user marks all addresses private.
    let email = userinfo.email;
    if (!email) {
      email = await fetchGithubPrimaryEmail(accessToken);
    }

    const profile: GithubProfile = {
      id: userinfo.id,
      login: userinfo.login,
      name: userinfo.name,
      email,
      avatarUrl: userinfo.avatarUrl,
    };

    const result = await findOrCreateUserFromGithub(profile, cfg);
    if (!result.ok) {
      return c.redirect(`/login?error=${encodeURIComponent(result.error)}`);
    }

    const token = await issueSsoSession(result.user.id);
    setCookie(c, "session", token, sessionCookieOptions());

    await audit({
      userId: result.user.id,
      action: "auth.github.login",
      metadata: {
        githubId: profile.id,
        login: profile.login,
        email: profile.email || null,
      },
    });

    return c.redirect("/");
  } catch (err) {
    console.error("[github-oauth] callback error:", err);
    return c.redirect(
      `/login?error=${encodeURIComponent(
        err instanceof Error
          ? `GitHub sign-in failed: ${err.message}`
          : "GitHub sign-in failed"
      )}`
    );
  }
});

export default githubOauth;

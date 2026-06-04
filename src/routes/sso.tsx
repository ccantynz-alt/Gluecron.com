/**
 * Block I10 — Enterprise SSO (OIDC) routes.
 *
 *   GET  /admin/sso                — site-admin config page
 *   POST /admin/sso                — save config
 *   GET  /login/sso                — begin OIDC flow (redirect to IdP)
 *   GET  /login/sso/callback       — handle IdP redirect, create session
 *   POST /settings/sso/unlink      — user drops their SSO link
 *
 * Visual polish (2026): gradient hairline + orb hero + provider preset cards
 * + status pills + section forms. Scoped under `.sso-*` so it can't bleed
 * into other admin pages. Every OIDC flow, redirect URI, state/nonce, and
 * session issuance path is preserved EXACTLY — this is security-critical.
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
// Scoped styles — every class prefixed `.sso-` so this surface can't bleed
// into other admin pages.
// ----------------------------------------------------------------------------
const ssoStyles = `
  .sso-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .sso-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .sso-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .sso-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .sso-hero-inner { position: relative; z-index: 1; max-width: 680px; }
  .sso-eyebrow {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .sso-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .sso-title {
    font-size: clamp(26px, 3.5vw, 38px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.06;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .sso-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .sso-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }
  .sso-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text);
  }

  /* ─── Status pill (hero corner) ─── */
  .sso-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: var(--space-2);
    padding: 4px 12px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .sso-status-pill.is-on {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.36);
  }
  .sso-status-pill.is-off {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .sso-status-pill.is-missing {
    background: rgba(148,163,184,0.10);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.28);
  }
  .sso-status-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }

  /* ─── Banner ─── */
  .sso-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .sso-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .sso-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  /* ─── Section card ─── */
  .sso-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .sso-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .sso-section-head-text { flex: 1; min-width: 240px; }
  .sso-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
  }
  .sso-section-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .sso-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Redirect-URI callout (copyable) ─── */
  .sso-callout {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: 12px 14px;
    background: rgba(140,109,255,0.05);
    border: 1px dashed rgba(140,109,255,0.30);
    border-radius: 12px;
    flex-wrap: wrap;
  }
  .sso-callout-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    color: var(--text-muted);
    font-weight: 700;
    flex-shrink: 0;
  }
  .sso-callout code {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 6px 10px;
    border-radius: 8px;
    word-break: break-all;
    overflow-wrap: anywhere;
  }

  /* ─── Provider preset cards ─── */
  .sso-providers {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--space-2);
  }
  .sso-provider {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: rgba(255,255,255,0.02);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    text-align: left;
    transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
  }
  .sso-provider:hover {
    transform: translateY(-1px);
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.06);
  }
  .sso-provider-icon {
    flex-shrink: 0;
    width: 36px; height: 36px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.14));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 800;
    color: #e9d5ff;
  }
  .sso-provider-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    line-height: 1.2;
  }
  .sso-provider-kind {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 1px;
  }

  /* ─── Form group ─── */
  .sso-field { margin-bottom: var(--space-4); }
  .sso-field:last-child { margin-bottom: 0; }
  .sso-field-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: 6px;
  }
  .sso-field label {
    display: block;
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .sso-input {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .sso-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .sso-hint {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .sso-toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: var(--space-4);
  }
  .sso-toggle-row input[type="checkbox"] { margin-top: 2px; flex-shrink: 0; }
  .sso-toggle-row span {
    font-size: 13px;
    color: var(--text);
    line-height: 1.45;
  }

  /* ─── Buttons ─── */
  .sso-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 11px 18px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .sso-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .sso-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .sso-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .sso-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* ─── Section foot bar (save button) ─── */
  .sso-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .sso-foot-hint {
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ─── 403 ─── */
  .sso-403 {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .sso-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .sso-403 p { color: var(--text-muted); margin: 0; font-size: 14px; }
`;

// ----------------------------------------------------------------------------
// Admin config page
// ----------------------------------------------------------------------------

async function adminGate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/sso");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="sso-wrap">
          <div class="sso-403">
            <h2>403 — Not a site admin</h2>
            <p>You don't have permission to configure SSO.</p>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: ssoStyles }} />
      </Layout>,
      403
    );
  }
  return { user };
}

/** Compute the per-card status — used for the provider list + the hero pill. */
function ssoStatus(cfg: Awaited<ReturnType<typeof getSsoConfig>>): {
  kind: "configured" | "incomplete" | "missing";
  label: string;
} {
  if (!cfg) return { kind: "missing", label: "Not configured" };
  const hasAll =
    cfg.issuer &&
    cfg.authorizationEndpoint &&
    cfg.tokenEndpoint &&
    cfg.userinfoEndpoint &&
    cfg.clientId &&
    cfg.clientSecret;
  if (!hasAll) return { kind: "incomplete", label: "Incomplete" };
  if (!cfg.enabled) return { kind: "incomplete", label: "Configured · disabled" };
  return { kind: "configured", label: "Live · accepting sign-ins" };
}

sso.get("/admin/sso", requireAuth, async (c) => {
  const g = await adminGate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const cfg = await getSsoConfig();
  const success = c.req.query("success");
  const error = c.req.query("error");
  const redirectUri = ssoRedirectUri();
  const status = ssoStatus(cfg);
  const pillClass =
    status.kind === "configured"
      ? "is-on"
      : status.kind === "incomplete"
        ? "is-off"
        : "is-missing";

  return c.html(
    <Layout title="SSO — Admin" user={user}>
      <div class="sso-wrap">
        <section class="sso-hero">
          <div class="sso-hero-orb" aria-hidden="true" />
          <div class="sso-hero-inner">
            <div class="sso-eyebrow">
              <span class="sso-eyebrow-dot" aria-hidden="true" />
              Enterprise SSO · Site admin · {user.username}
            </div>
            <h1 class="sso-title">
              <span class="sso-title-grad">Single sign-on.</span>
            </h1>
            <p class="sso-sub">
              Configure one site-wide OpenID Connect provider. Users see a
              "Sign in with <code>{cfg?.providerName || "SSO"}</code>" button
              on the login page and land in Gluecron without a password.
            </p>
            <span class={"sso-status-pill " + pillClass}>
              <span class="dot" aria-hidden="true" />
              {status.label}
            </span>
          </div>
        </section>

        {success && (
          <div class="sso-banner is-ok">{decodeURIComponent(success)}</div>
        )}
        {error && (
          <div class="sso-banner is-error">{decodeURIComponent(error)}</div>
        )}

        {/* ─── Redirect URI callout ─── */}
        <section class="sso-section">
          <header class="sso-section-head">
            <div class="sso-section-head-text">
              <h3 class="sso-section-title">Redirect URI</h3>
              <p class="sso-section-sub">
                Paste this into your IdP's "Authorized redirect URIs"
                field — exact match, no trailing slash.
              </p>
            </div>
          </header>
          <div class="sso-section-body">
            <div class="sso-callout">
              <span class="sso-callout-label">Callback</span>
              <code>{redirectUri}</code>
            </div>
          </div>
        </section>

        {/* ─── Provider preset cards ─── */}
        <section class="sso-section">
          <header class="sso-section-head">
            <div class="sso-section-head-text">
              <h3 class="sso-section-title">Provider presets</h3>
              <p class="sso-section-sub">
                Quick-fill the OIDC endpoints below for a common IdP — then
                paste your client ID + secret.
              </p>
            </div>
          </header>
          <div class="sso-section-body">
            <div class="sso-providers">
              <button
                type="button"
                class="sso-provider"
                onclick="window.gluecronSsoPreset('google')"
                aria-label="Use Google Workspace preset"
              >
                <span class="sso-provider-icon" aria-hidden="true">G</span>
                <div>
                  <div class="sso-provider-name">Google</div>
                  <div class="sso-provider-kind">Workspace · OIDC</div>
                </div>
              </button>
              <button
                type="button"
                class="sso-provider"
                onclick="window.gluecronSsoPreset('okta')"
                aria-label="Use Okta preset"
              >
                <span class="sso-provider-icon" aria-hidden="true">O</span>
                <div>
                  <div class="sso-provider-name">Okta</div>
                  <div class="sso-provider-kind">OIDC</div>
                </div>
              </button>
              <button
                type="button"
                class="sso-provider"
                onclick="window.gluecronSsoPreset('auth0')"
                aria-label="Use Auth0 preset"
              >
                <span class="sso-provider-icon" aria-hidden="true">A</span>
                <div>
                  <div class="sso-provider-name">Auth0</div>
                  <div class="sso-provider-kind">OIDC</div>
                </div>
              </button>
              <button
                type="button"
                class="sso-provider"
                onclick="window.gluecronSsoPreset('azure')"
                aria-label="Use Microsoft Entra preset"
              >
                <span class="sso-provider-icon" aria-hidden="true">M</span>
                <div>
                  <div class="sso-provider-name">Microsoft</div>
                  <div class="sso-provider-kind">Entra ID · OIDC</div>
                </div>
              </button>
              <button
                type="button"
                class="sso-provider"
                onclick="window.gluecronSsoPreset('github')"
                aria-label="Use GitHub Enterprise preset"
              >
                <span class="sso-provider-icon" aria-hidden="true">H</span>
                <div>
                  <div class="sso-provider-name">GitHub</div>
                  <div class="sso-provider-kind">Enterprise · OIDC</div>
                </div>
              </button>
              <button
                type="button"
                class="sso-provider"
                onclick="window.gluecronSsoPreset('saml')"
                aria-label="SAML not supported — use OIDC"
                title="SAML is not currently supported. Use the equivalent OIDC endpoint from your IdP."
              >
                <span class="sso-provider-icon" aria-hidden="true">S</span>
                <div>
                  <div class="sso-provider-name">SAML</div>
                  <div class="sso-provider-kind">Use OIDC instead</div>
                </div>
              </button>
            </div>
          </div>
        </section>

        <script
          dangerouslySetInnerHTML={{
            __html: /* js */ `
              window.gluecronSsoPreset = function (provider) {
                var P = {
                  google: {
                    provider_name: 'Google',
                    issuer: 'https://accounts.google.com',
                    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
                    token_endpoint: 'https://oauth2.googleapis.com/token',
                    userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
                    scopes: 'openid email profile',
                  },
                  okta: {
                    provider_name: 'Okta',
                    issuer: 'https://YOUR-TENANT.okta.com',
                    authorization_endpoint: 'https://YOUR-TENANT.okta.com/oauth2/v1/authorize',
                    token_endpoint: 'https://YOUR-TENANT.okta.com/oauth2/v1/token',
                    userinfo_endpoint: 'https://YOUR-TENANT.okta.com/oauth2/v1/userinfo',
                    scopes: 'openid email profile',
                  },
                  auth0: {
                    provider_name: 'Auth0',
                    issuer: 'https://YOUR-TENANT.auth0.com',
                    authorization_endpoint: 'https://YOUR-TENANT.auth0.com/authorize',
                    token_endpoint: 'https://YOUR-TENANT.auth0.com/oauth/token',
                    userinfo_endpoint: 'https://YOUR-TENANT.auth0.com/userinfo',
                    scopes: 'openid email profile',
                  },
                  azure: {
                    provider_name: 'Microsoft',
                    issuer: 'https://login.microsoftonline.com/YOUR-TENANT-ID/v2.0',
                    authorization_endpoint: 'https://login.microsoftonline.com/YOUR-TENANT-ID/oauth2/v2.0/authorize',
                    token_endpoint: 'https://login.microsoftonline.com/YOUR-TENANT-ID/oauth2/v2.0/token',
                    userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo',
                    scopes: 'openid email profile',
                  },
                  github: {
                    provider_name: 'GitHub Enterprise',
                    issuer: 'https://github.example.com',
                    authorization_endpoint: 'https://github.example.com/login/oauth/authorize',
                    token_endpoint: 'https://github.example.com/login/oauth/access_token',
                    userinfo_endpoint: 'https://github.example.com/api/v3/user',
                    scopes: 'openid read:user user:email',
                  },
                  saml: {
                    provider_name: 'SAML',
                    issuer: '',
                    authorization_endpoint: '',
                    token_endpoint: '',
                    userinfo_endpoint: '',
                    scopes: 'openid email profile',
                  },
                };
                var p = P[provider];
                if (!p) return;
                for (var k in p) {
                  var el = document.getElementById(k);
                  if (el) el.value = p[k];
                }
                if (provider === 'saml') {
                  alert('SAML is not supported. Use your IdP\\'s OIDC equivalent — most SAML IdPs (Okta, Auth0, Azure) also expose OIDC endpoints.');
                }
              };
            `,
          }}
        />

        {/* ─── Main config form ─── */}
        <form method="post" action="/admin/sso">
          <section class="sso-section">
            <header class="sso-section-head">
              <div class="sso-section-head-text">
                <h3 class="sso-section-title">OIDC configuration</h3>
                <p class="sso-section-sub">
                  Fill these from your IdP's OIDC discovery document
                  (usually at <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">.well-known/openid-configuration</code>).
                </p>
              </div>
            </header>
            <div class="sso-section-body">
              <div class="sso-toggle-row">
                <input
                  type="checkbox"
                  name="enabled"
                  value="1"
                  checked={!!cfg?.enabled}
                  aria-label="Enable SSO sign-in on /login"
                  id="enabled"
                />
                <span>
                  <strong style="color:var(--text-strong)">Enable SSO sign-in on /login.</strong>
                  {" "}When off, the config is saved but the button doesn't render
                  and the callback endpoint refuses requests.
                </span>
              </div>

              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="provider_name">Button label</label>
                </div>
                <input
                  type="text"
                  id="provider_name"
                  name="provider_name"
                  value={cfg?.providerName || "SSO"}
                  maxLength={120}
                  placeholder="Okta"
                  class="sso-input"
                />
                <div class="sso-hint">
                  Shown on the login page: "Sign in with <code>{cfg?.providerName || "SSO"}</code>".
                </div>
              </div>

              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="issuer">Issuer URL</label>
                </div>
                <input
                  type="text"
                  id="issuer"
                  name="issuer"
                  value={cfg?.issuer || ""}
                  placeholder="https://example.okta.com"
                  class="sso-input"
                />
              </div>

              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="authorization_endpoint">Authorization endpoint</label>
                </div>
                <input
                  type="text"
                  id="authorization_endpoint"
                  name="authorization_endpoint"
                  value={cfg?.authorizationEndpoint || ""}
                  placeholder="https://example.okta.com/oauth2/v1/authorize"
                  class="sso-input"
                />
              </div>

              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="token_endpoint">Token endpoint</label>
                </div>
                <input
                  type="text"
                  id="token_endpoint"
                  name="token_endpoint"
                  value={cfg?.tokenEndpoint || ""}
                  placeholder="https://example.okta.com/oauth2/v1/token"
                  class="sso-input"
                />
              </div>

              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="userinfo_endpoint">Userinfo endpoint</label>
                </div>
                <input
                  type="text"
                  id="userinfo_endpoint"
                  name="userinfo_endpoint"
                  value={cfg?.userinfoEndpoint || ""}
                  placeholder="https://example.okta.com/oauth2/v1/userinfo"
                  class="sso-input"
                />
              </div>
            </div>
          </section>

          <section class="sso-section">
            <header class="sso-section-head">
              <div class="sso-section-head-text">
                <h3 class="sso-section-title">Client credentials</h3>
                <p class="sso-section-sub">
                  Issued by your IdP when you register Gluecron as an
                  application. The secret never leaves the server.
                </p>
              </div>
            </header>
            <div class="sso-section-body">
              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="client_id">Client ID</label>
                </div>
                <input
                  type="text"
                  id="client_id"
                  name="client_id"
                  value={cfg?.clientId || ""}
                  autocomplete="off"
                  class="sso-input"
                />
              </div>

              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="client_secret">Client secret</label>
                  {cfg?.clientSecret && (
                    <span class="sso-status-pill is-on" style="margin-top:0">
                      <span class="dot" aria-hidden="true" />
                      Stored
                    </span>
                  )}
                </div>
                <input
                  type="password"
                  id="client_secret"
                  name="client_secret"
                  value={cfg?.clientSecret || ""}
                  autocomplete="off"
                  placeholder={
                    cfg?.clientSecret ? "(stored — leave blank to keep)" : ""
                  }
                  class="sso-input"
                />
              </div>
            </div>
          </section>

          <section class="sso-section">
            <header class="sso-section-head">
              <div class="sso-section-head-text">
                <h3 class="sso-section-title">Scopes &amp; access control</h3>
                <p class="sso-section-sub">
                  Restrict who can sign in and what happens on first login.
                </p>
              </div>
            </header>
            <div class="sso-section-body">
              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="scopes">OIDC scopes</label>
                </div>
                <input
                  type="text"
                  id="scopes"
                  name="scopes"
                  value={cfg?.scopes || "openid profile email"}
                  class="sso-input"
                />
                <div class="sso-hint">
                  Space-separated. Defaults to <code style="font-family:var(--font-mono);font-size:11.5px;background:var(--bg-tertiary);padding:1px 4px;border-radius:4px">openid profile email</code> — enough for username + display name.
                </div>
              </div>

              <div class="sso-field">
                <div class="sso-field-row">
                  <label for="allowed_email_domains">Allowed email domains</label>
                </div>
                <input
                  type="text"
                  id="allowed_email_domains"
                  name="allowed_email_domains"
                  value={cfg?.allowedEmailDomains || ""}
                  placeholder="example.com, acme.io"
                  class="sso-input"
                />
                <div class="sso-hint">
                  Comma-separated. Empty = any domain accepted. Enforced
                  case-insensitively against the email claim.
                </div>
              </div>

              <div class="sso-toggle-row">
                <input
                  type="checkbox"
                  name="auto_create_users"
                  value="1"
                  checked={cfg ? cfg.autoCreateUsers : true}
                  aria-label="Auto-create users on first SSO sign-in"
                  id="auto_create_users"
                />
                <span>
                  <strong style="color:var(--text-strong)">Auto-create local accounts on first SSO sign-in.</strong>
                  {" "}Turn off to require admins to pre-provision users — first
                  login then fails with "user not found".
                </span>
              </div>
            </div>
            <div class="sso-foot">
              <span class="sso-foot-hint">
                Changes apply immediately. Test from <a href="/login" style="color:var(--accent);text-decoration:none">/login</a>.
              </span>
              <button type="submit" class="sso-btn sso-btn-primary">
                Save SSO settings
              </button>
            </div>
          </section>
        </form>
      </div>
      <style dangerouslySetInnerHTML={{ __html: ssoStyles }} />
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
    const friendly = friendlySsoError(err);
    return c.redirect(`/login?error=${encodeURIComponent(friendly)}`);
  }
});

/**
 * Map the raw OIDC failure shape to a one-sentence message safe to render
 * inside an HTML <div>. We never surface the IdP's response body — those
 * have been Google 404 HTML pages, Azure JSON blobs full of object IDs,
 * etc. The raw `err.message` is logged via console.error above so admins
 * can still diagnose from server logs.
 */
function friendlySsoError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (raw.includes("token_endpoint")) {
    if (/\b40[01]\b/.test(raw)) {
      return "SSO sign-in failed: the identity provider rejected our token request (HTTP 4xx). Check the Token endpoint URL and Client Secret at /admin/sso.";
    }
    if (/\b404\b/.test(raw)) {
      return "SSO sign-in failed: the Token endpoint URL returned 404. Verify the URL at /admin/sso — for Google it's https://oauth2.googleapis.com/token.";
    }
    if (/\b5\d\d\b/.test(raw)) {
      return "SSO sign-in failed: the identity provider returned a server error. Try again, or check the IdP's status page.";
    }
    return "SSO sign-in failed at the token exchange step. Check /admin/sso configuration.";
  }
  if (raw.includes("userinfo_endpoint")) {
    return "SSO sign-in failed while fetching profile info. Verify the Userinfo endpoint URL at /admin/sso.";
  }
  if (raw.includes("state cookie") || raw.includes("nonce")) {
    return "SSO sign-in expired before you returned to the site. Please try again.";
  }
  if (raw.includes("email") && raw.includes("not allowed")) {
    return "SSO sign-in failed: your email domain is not on the allowlist for this site.";
  }
  return "SSO sign-in failed. Check /admin/sso configuration or try again.";
}

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

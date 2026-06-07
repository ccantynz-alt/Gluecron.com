/**
 * Per-org enterprise SSO + SCIM settings.
 *
 *   GET  /orgs/:orgSlug/settings/sso   — SSO config page
 *   POST /orgs/:orgSlug/settings/sso   — save SSO config
 *   POST /orgs/:orgSlug/settings/sso/generate-scim-token — generate a new SCIM token
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import * as crypto from "crypto";
import { db } from "../db";
import {
  orgSsoConfigs,
  scimTokens,
  organizations,
  orgMembers,
} from "../db/schema";
import { Layout } from "../views/layout";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const orgSsoSettings = new Hono<AuthEnv>();
orgSsoSettings.use("*", softAuth);

// ---------------------------------------------------------------------------
// Scoped CSS
// ---------------------------------------------------------------------------

const orgSsoCss = `
  .org-sso-wrap { max-width: 980px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .org-sso-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .org-sso-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .org-sso-title {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 800;
    letter-spacing: -0.025em;
    color: var(--text-strong);
    margin: 0 0 6px;
  }
  .org-sso-sub { font-size: 13.5px; color: var(--text-muted); margin: 0; }

  .org-sso-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .org-sso-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .org-sso-section-title {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
  }
  .org-sso-section-sub { margin: 0; font-size: 12.5px; color: var(--text-muted); }
  .org-sso-section-body { padding: var(--space-4) var(--space-5); }

  .org-sso-field { margin-bottom: var(--space-4); }
  .org-sso-field:last-child { margin-bottom: 0; }
  .org-sso-field label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 5px;
    font-family: var(--font-mono);
  }
  .org-sso-input {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-sizing: border-box;
    font-family: var(--font-mono);
    outline: none;
  }
  .org-sso-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .org-sso-textarea {
    min-height: 120px;
    resize: vertical;
  }
  .org-sso-hint { font-size: 11.5px; color: var(--text-muted); margin-top: 5px; }

  .org-sso-toggle {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: var(--space-4);
  }
  .org-sso-toggle input { margin-top: 2px; flex-shrink: 0; }
  .org-sso-toggle span { font-size: 13px; color: var(--text); line-height: 1.45; }

  .org-sso-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
  }
  .org-sso-foot-hint { font-size: 12.5px; color: var(--text-muted); }

  .org-sso-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    text-decoration: none;
  }
  .org-sso-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
  }
  .org-sso-btn-primary:hover { opacity: 0.9; text-decoration: none; color: #fff; }
  .org-sso-btn-ghost {
    background: transparent;
    border-color: var(--border-strong);
    color: var(--text);
  }
  .org-sso-btn-ghost:hover { background: rgba(140,109,255,0.07); border-color: rgba(140,109,255,0.45); color: var(--text-strong); text-decoration: none; }

  .org-sso-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
  }
  .org-sso-banner.is-ok { border-color: rgba(52,211,153,0.4); background: rgba(52,211,153,0.07); color: #bbf7d0; }
  .org-sso-banner.is-error { border-color: rgba(248,113,113,0.4); background: rgba(248,113,113,0.07); color: #fecaca; }

  .org-sso-callout {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 12px 14px;
    background: rgba(140,109,255,0.05);
    border: 1px dashed rgba(140,109,255,0.30);
    border-radius: 12px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .org-sso-callout-label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); flex-shrink: 0; }
  .org-sso-callout code {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 6px 10px;
    border-radius: 8px;
    word-break: break-all;
  }

  .org-sso-token-box {
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    word-break: break-all;
    margin-top: var(--space-3);
  }
  .org-sso-token-warning {
    font-size: 12px;
    color: #fde68a;
    margin-top: 8px;
  }

  .org-sso-provider-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: var(--space-4);
  }
  .org-sso-tab {
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .org-sso-tab.is-active {
    background: rgba(140,109,255,0.14);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
  }

  .org-sso-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-left: var(--space-3);
  }
  .org-sso-status.is-on { background: rgba(52,211,153,0.12); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32); }
  .org-sso-status.is-off { background: rgba(148,163,184,0.10); color: #cbd5e1; box-shadow: inset 0 0 0 1px rgba(148,163,184,0.28); }
  .org-sso-status .dot { width: 5px; height: 5px; border-radius: 9999px; background: currentColor; }
`;

// ---------------------------------------------------------------------------
// Auth + org-admin gate
// ---------------------------------------------------------------------------

async function requireOrgAdmin(c: any, orgSlug: string) {
  const user = c.get("user");
  if (!user) return null;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1);
  if (!org) return null;

  const [membership] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id)))
    .limit(1);

  // Only owners and admins can configure SSO
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return null;
  }

  return { user, org };
}

// ---------------------------------------------------------------------------
// GET /orgs/:orgSlug/settings/sso
// ---------------------------------------------------------------------------

orgSsoSettings.get("/orgs/:orgSlug/settings/sso", requireAuth, async (c) => {
  const { orgSlug } = c.req.param();
  const ctx = await requireOrgAdmin(c, orgSlug);
  if (!ctx) {
    return c.html(
      <Layout title="Forbidden" user={c.get("user")}>
        <div style="max-width:540px;margin:80px auto;text-align:center;padding:40px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:16px">
          <h2 style="font-size:20px;margin:0 0 8px;color:var(--text-strong)">403 — Access denied</h2>
          <p style="color:var(--text-muted);margin:0">Only org owners and admins can configure SSO.</p>
        </div>
      </Layout>,
      403
    );
  }

  const { user, org } = ctx;
  const success = c.req.query("success");
  const error = c.req.query("error");
  const newToken = c.req.query("token"); // plaintext token shown once after generation

  const [cfg] = await db
    .select()
    .from(orgSsoConfigs)
    .where(eq(orgSsoConfigs.orgId, org.id))
    .limit(1);

  const base = process.env.APP_URL || process.env.BASE_URL || "https://gluecron.com";
  const spMetadataUrl = `${base}/sso/saml/${orgSlug}/metadata`;
  const spAcsUrl = `${base}/sso/saml/${orgSlug}/callback`;
  const oidcCallbackUrl = `${base}/sso/oidc/${orgSlug}/callback`;
  const scimBaseUrl = `${base}/scim/v2/${org.id}`;

  const activeProvider = cfg?.provider || "saml";
  const isEnabled = !!cfg?.enabled;

  return c.html(
    <Layout title={`SSO Settings — ${org.name}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: orgSsoCss }} />
      <div class="org-sso-wrap">
        <div class="org-sso-hero">
          <h1 class="org-sso-title">
            Enterprise SSO
            <span class={`org-sso-status ${isEnabled ? "is-on" : "is-off"}`}>
              <span class="dot" />
              {isEnabled ? "Enabled" : "Disabled"}
            </span>
          </h1>
          <p class="org-sso-sub">
            Configure SAML 2.0 or OIDC single sign-on and SCIM provisioning for <strong>{org.name}</strong>.
            Members from <code style="font-size:12px;background:var(--bg-tertiary);padding:1px 4px;border-radius:4px">{cfg?.domainHint || "your domain"}</code> will be automatically routed to your identity provider.
          </p>
        </div>

        {success && <div class="org-sso-banner is-ok">{decodeURIComponent(success)}</div>}
        {error && <div class="org-sso-banner is-error">{decodeURIComponent(error)}</div>}
        {newToken && (
          <div class="org-sso-banner is-ok">
            SCIM token generated. Copy it now — it won't be shown again.
            <div class="org-sso-token-box">{newToken}</div>
            <div class="org-sso-token-warning">Store this token securely. It grants full SCIM access to your org.</div>
          </div>
        )}

        <form method="post" action={`/orgs/${orgSlug}/settings/sso`}>
          <input type="hidden" name="_csrf" value={(c.get("csrfToken") as string | undefined) ?? ""} />

          {/* Provider tabs */}
          <div class="org-sso-section">
            <header class="org-sso-section-head">
              <h2 class="org-sso-section-title">SSO Provider</h2>
              <p class="org-sso-section-sub">Choose your identity protocol. SAML 2.0 is most common for enterprise IdPs (Okta, Azure AD, PingFederate). OIDC works with Google Workspace, Auth0, and modern Okta.</p>
            </header>
            <div class="org-sso-section-body">
              <div class="org-sso-toggle">
                <input
                  type="checkbox"
                  name="enabled"
                  value="1"
                  checked={isEnabled}
                  id="enabled"
                  aria-label="Enable SSO for this organization"
                />
                <span>
                  <strong style="color:var(--text-strong)">Enable SSO.</strong>
                  {" "}When enabled, users with a matching domain hint are automatically redirected to your IdP instead of the password form.
                </span>
              </div>

              <div class="org-sso-field">
                <label for="provider">Provider protocol</label>
                <select id="provider" name="provider" class="org-sso-input" style="cursor:pointer">
                  <option value="saml" selected={activeProvider === "saml"}>SAML 2.0</option>
                  <option value="oidc" selected={activeProvider === "oidc"}>OIDC / OAuth 2.0</option>
                </select>
              </div>

              <div class="org-sso-field">
                <label for="domain_hint">Domain hint</label>
                <input
                  id="domain_hint"
                  name="domain_hint"
                  type="text"
                  class="org-sso-input"
                  placeholder="acme.com"
                  value={cfg?.domainHint || ""}
                />
                <p class="org-sso-hint">When a user logs in with an email from this domain, they'll be redirected to SSO automatically. Leave blank to require manual SSO initiation.</p>
              </div>
            </div>
          </div>

          {/* SAML config */}
          <div class="org-sso-section">
            <header class="org-sso-section-head">
              <h2 class="org-sso-section-title">SAML 2.0 Configuration</h2>
              <p class="org-sso-section-sub">Provide these SP details to your IdP, then paste the IdP metadata fields below.</p>
            </header>
            <div class="org-sso-section-body">
              <div class="org-sso-callout">
                <span class="org-sso-callout-label">SP Metadata</span>
                <code>{spMetadataUrl}</code>
                <a href={spMetadataUrl} target="_blank" class="org-sso-btn org-sso-btn-ghost" style="padding:6px 12px;font-size:12px">Download</a>
              </div>
              <div class="org-sso-callout">
                <span class="org-sso-callout-label">ACS URL</span>
                <code>{spAcsUrl}</code>
              </div>

              <div class="org-sso-field">
                <label for="idp_entity_id">IdP Entity ID</label>
                <input id="idp_entity_id" name="idp_entity_id" type="text" class="org-sso-input" placeholder="https://idp.example.com/saml/metadata" value={cfg?.idpEntityId || ""} />
              </div>
              <div class="org-sso-field">
                <label for="idp_sso_url">IdP SSO URL</label>
                <input id="idp_sso_url" name="idp_sso_url" type="text" class="org-sso-input" placeholder="https://idp.example.com/saml/sso" value={cfg?.idpSsoUrl || ""} />
                <p class="org-sso-hint">The HTTP-Redirect or HTTP-POST binding URL from your IdP's metadata.</p>
              </div>
              <div class="org-sso-field">
                <label for="idp_certificate">IdP X.509 Certificate (PEM)</label>
                <textarea id="idp_certificate" name="idp_certificate" class="org-sso-input org-sso-textarea" placeholder="-----BEGIN CERTIFICATE-----&#10;MIIC...&#10;-----END CERTIFICATE-----">{cfg?.idpCertificate || ""}</textarea>
                <p class="org-sso-hint">Paste the full PEM-encoded certificate from your IdP. Used to verify SAML assertion signatures.</p>
              </div>
            </div>
          </div>

          {/* OIDC config */}
          <div class="org-sso-section">
            <header class="org-sso-section-head">
              <h2 class="org-sso-section-title">OIDC / OAuth 2.0 Configuration</h2>
              <p class="org-sso-section-sub">Fill these if your provider uses OIDC (OpenID Connect).</p>
            </header>
            <div class="org-sso-section-body">
              <div class="org-sso-callout">
                <span class="org-sso-callout-label">Redirect URI</span>
                <code>{oidcCallbackUrl}</code>
              </div>

              <div class="org-sso-field">
                <label for="oidc_discovery_url">OIDC Discovery / Issuer URL</label>
                <input id="oidc_discovery_url" name="oidc_discovery_url" type="text" class="org-sso-input" placeholder="https://accounts.google.com or https://YOUR-TENANT.okta.com" value={cfg?.oidcDiscoveryUrl || ""} />
                <p class="org-sso-hint">The base issuer URL — we'll append <code>/.well-known/openid-configuration</code> automatically.</p>
              </div>
              <div class="org-sso-field">
                <label for="oidc_client_id">Client ID</label>
                <input id="oidc_client_id" name="oidc_client_id" type="text" class="org-sso-input" autocomplete="off" value={cfg?.oidcClientId || ""} />
              </div>
              <div class="org-sso-field">
                <label for="oidc_client_secret">Client Secret</label>
                <input id="oidc_client_secret" name="oidc_client_secret" type="password" class="org-sso-input" autocomplete="off" placeholder={cfg?.oidcClientSecret ? "(stored — leave blank to keep)" : ""} />
              </div>
            </div>
          </div>

          <div class="org-sso-section">
            <div class="org-sso-foot">
              <span class="org-sso-foot-hint">
                <a href={`/sso/${activeProvider === "saml" ? "saml" : "oidc"}/${orgSlug}/login`} target="_blank" style="color:var(--accent);text-decoration:none">Test SSO</a> after saving.
              </span>
              <button type="submit" class="org-sso-btn org-sso-btn-primary">Save SSO settings</button>
            </div>
          </div>
        </form>

        {/* SCIM section */}
        <div class="org-sso-section">
          <header class="org-sso-section-head">
            <h2 class="org-sso-section-title">SCIM User Provisioning</h2>
            <p class="org-sso-section-sub">
              Connect your IdP (Okta, Azure AD, Google Workspace) to automatically provision and deprovision members of <strong>{org.name}</strong>.
            </p>
          </header>
          <div class="org-sso-section-body">
            <div class="org-sso-callout">
              <span class="org-sso-callout-label">SCIM Base URL</span>
              <code>{scimBaseUrl}</code>
            </div>
            <p class="org-sso-hint" style="margin-bottom:var(--space-4)">
              Configure your IdP with the SCIM base URL above and a bearer token generated below. Set the SCIM version to 2.0 in your IdP.
            </p>
          </div>
          <div class="org-sso-foot">
            <span class="org-sso-foot-hint">Tokens are shown once at creation. Store them securely.</span>
            <form method="post" action={`/orgs/${orgSlug}/settings/sso/generate-scim-token`}>
              <input type="hidden" name="_csrf" value={(c.get("csrfToken") as string | undefined) ?? ""} />
              <button type="submit" class="org-sso-btn org-sso-btn-ghost">Generate SCIM token</button>
            </form>
          </div>
        </div>
      </div>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /orgs/:orgSlug/settings/sso — save config
// ---------------------------------------------------------------------------

orgSsoSettings.post("/orgs/:orgSlug/settings/sso", requireAuth, async (c) => {
  const { orgSlug } = c.req.param();
  const ctx = await requireOrgAdmin(c, orgSlug);
  if (!ctx) return c.redirect(`/orgs/${orgSlug}`);

  const { org } = ctx;
  const body = await c.req.parseBody();

  const enabled = String(body.enabled || "") === "1";
  const provider = String(body.provider || "saml");
  const domainHint = String(body.domain_hint || "").trim() || null;

  // SAML fields
  const idpEntityId = String(body.idp_entity_id || "").trim() || null;
  const idpSsoUrl = String(body.idp_sso_url || "").trim() || null;
  const idpCertificate = String(body.idp_certificate || "").trim() || null;

  // OIDC fields
  const oidcDiscoveryUrl = String(body.oidc_discovery_url || "").trim() || null;
  const oidcClientId = String(body.oidc_client_id || "").trim() || null;

  // Existing config to preserve client_secret if not changed
  const [existing] = await db
    .select()
    .from(orgSsoConfigs)
    .where(eq(orgSsoConfigs.orgId, org.id))
    .limit(1);

  const oidcClientSecretNew = String(body.oidc_client_secret || "").trim();
  const oidcClientSecret =
    oidcClientSecretNew.length > 0 ? oidcClientSecretNew : existing?.oidcClientSecret || null;

  const base = process.env.APP_URL || process.env.BASE_URL || "https://gluecron.com";
  const spEntityId = `${base}/sso/saml/${orgSlug}`;

  if (existing) {
    await db
      .update(orgSsoConfigs)
      .set({
        enabled,
        provider,
        domainHint,
        idpEntityId,
        idpSsoUrl,
        idpCertificate,
        spEntityId,
        oidcDiscoveryUrl,
        oidcClientId,
        oidcClientSecret,
        updatedAt: new Date(),
      })
      .where(eq(orgSsoConfigs.orgId, org.id));
  } else {
    await db.insert(orgSsoConfigs).values({
      orgId: org.id,
      enabled,
      provider,
      domainHint,
      idpEntityId,
      idpSsoUrl,
      idpCertificate,
      spEntityId,
      oidcDiscoveryUrl,
      oidcClientId,
      oidcClientSecret,
    });
  }

  return c.redirect(
    `/orgs/${orgSlug}/settings/sso?success=${encodeURIComponent("SSO settings saved.")}`
  );
});

// ---------------------------------------------------------------------------
// POST /orgs/:orgSlug/settings/sso/generate-scim-token
// ---------------------------------------------------------------------------

orgSsoSettings.post(
  "/orgs/:orgSlug/settings/sso/generate-scim-token",
  requireAuth,
  async (c) => {
    const { orgSlug } = c.req.param();
    const ctx = await requireOrgAdmin(c, orgSlug);
    if (!ctx) return c.redirect(`/orgs/${orgSlug}`);

    const { user, org } = ctx;

    // Generate a random bearer token for SCIM provisioning.
    // Prefix "gscim1_" identifies the token type in logs without embedding a secret.
    const tokenPrefix = "gscim1_";
    const rawToken = tokenPrefix + crypto.randomBytes(30).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    await db.insert(scimTokens).values({
      orgId: org.id,
      tokenHash,
      createdBy: user.id,
    });

    return c.redirect(
      `/orgs/${orgSlug}/settings/sso?token=${encodeURIComponent(rawToken)}&success=${encodeURIComponent("SCIM token generated. Copy it now — it won't be shown again.")}`
    );
  }
);

export default orgSsoSettings;

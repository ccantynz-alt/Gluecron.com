/**
 * Block I10 — Enterprise SSO via OpenID Connect.
 *
 * We chose OIDC over SAML because every modern IdP (Okta, Azure AD, Auth0,
 * Google Workspace, Keycloak, Okta-on-prem) speaks OIDC natively, and OIDC
 * only requires HTTP JSON / redirect flows — no XML signature verification.
 *
 * Flow:
 *   1. User clicks "Sign in with SSO" → GET /login/sso
 *   2. We redirect to the IdP's `authorization_endpoint` with a `state` +
 *      `nonce` cookie-bound to the browser session.
 *   3. IdP sends the user back to /login/sso/callback?code=...&state=...
 *   4. We exchange the code for an access_token + id_token at
 *      `token_endpoint`, then hit `userinfo_endpoint` to fetch the claims.
 *   5. Find (or auto-create, if enabled) a local user by `sub`, create a
 *      session cookie, and redirect home.
 *
 * Admin configures the provider at /admin/sso. There is a single site-wide
 * provider identified by `id = 'default'`; we don't do multi-tenant IdP.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  ssoConfig,
  ssoUserLinks,
  users,
  sessions,
  type SsoConfig,
  type SsoUserLink,
  type User,
} from "../db/schema";
import {
  generateSessionToken,
  sessionExpiry,
} from "./auth";
import { config } from "./config";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SsoConfigInput {
  enabled: boolean;
  providerName: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  allowedEmailDomains: string | null;
  autoCreateUsers: boolean;
}

export interface OidcClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
}

export interface TokenResponse {
  access_token: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

// ----------------------------------------------------------------------------
// Config CRUD
// ----------------------------------------------------------------------------

const SSO_CONFIG_ID = "default";

/** Returns the singleton SSO config, or null if never configured. */
export async function getSsoConfig(): Promise<SsoConfig | null> {
  try {
    const [row] = await db
      .select()
      .from(ssoConfig)
      .where(eq(ssoConfig.id, SSO_CONFIG_ID))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

/** Upsert config. Empty strings become nulls so partial configs are visible. */
export async function upsertSsoConfig(
  input: Partial<SsoConfigInput>
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const now = new Date();
    const values = {
      id: SSO_CONFIG_ID,
      enabled: !!input.enabled,
      providerName: (input.providerName || "SSO").slice(0, 120),
      issuer: emptyToNull(input.issuer),
      authorizationEndpoint: emptyToNull(input.authorizationEndpoint),
      tokenEndpoint: emptyToNull(input.tokenEndpoint),
      userinfoEndpoint: emptyToNull(input.userinfoEndpoint),
      clientId: emptyToNull(input.clientId),
      clientSecret: emptyToNull(input.clientSecret),
      scopes: (input.scopes || "openid profile email").slice(0, 256),
      allowedEmailDomains: emptyToNull(input.allowedEmailDomains),
      autoCreateUsers: input.autoCreateUsers !== false,
      updatedAt: now,
    };
    await db
      .insert(ssoConfig)
      .values(values)
      .onConflictDoUpdate({
        target: ssoConfig.id,
        set: {
          enabled: values.enabled,
          providerName: values.providerName,
          issuer: values.issuer,
          authorizationEndpoint: values.authorizationEndpoint,
          tokenEndpoint: values.tokenEndpoint,
          userinfoEndpoint: values.userinfoEndpoint,
          clientId: values.clientId,
          clientSecret: values.clientSecret,
          scopes: values.scopes,
          allowedEmailDomains: values.allowedEmailDomains,
          autoCreateUsers: values.autoCreateUsers,
          updatedAt: values.updatedAt,
        },
      });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save config",
    };
  }
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

// ----------------------------------------------------------------------------
// OIDC flow helpers (pure, no DB)
// ----------------------------------------------------------------------------

/**
 * Build the authorization-endpoint URL the browser should be redirected to.
 * Adds client_id, redirect_uri, response_type=code, scope, state, nonce.
 */
export function buildAuthorizeUrl(
  cfg: Pick<SsoConfig, "authorizationEndpoint" | "clientId" | "scopes">,
  state: string,
  nonce: string,
  redirectUri: string
): string {
  if (!cfg.authorizationEndpoint || !cfg.clientId) {
    throw new Error("SSO config missing authorization_endpoint or client_id");
  }
  const u = new URL(cfg.authorizationEndpoint);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scopes || "openid profile email");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  return u.toString();
}

/** Crypto-random hex string for state + nonce + link-subject-collision retries. */
export function randomToken(bytes = 16): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Exchange the authorization code for tokens. IdP is trusted; we don't
 * verify the id_token signature here because we immediately turn around
 * and hit userinfo over HTTPS with the access_token, which has the same
 * integrity guarantee.
 */
export async function exchangeCode(
  cfg: Pick<SsoConfig, "tokenEndpoint" | "clientId" | "clientSecret">,
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  if (!cfg.tokenEndpoint || !cfg.clientId || !cfg.clientSecret) {
    throw new Error("SSO config missing token_endpoint or client credentials");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `token_endpoint ${res.status}: ${text.slice(0, 200) || "no body"}`
    );
  }
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) {
    throw new Error("token_endpoint response missing access_token");
  }
  return json;
}

/** Fetch userinfo claims using the access_token. */
export async function fetchUserinfo(
  cfg: Pick<SsoConfig, "userinfoEndpoint">,
  accessToken: string
): Promise<OidcClaims> {
  if (!cfg.userinfoEndpoint) {
    throw new Error("SSO config missing userinfo_endpoint");
  }
  const res = await fetch(cfg.userinfoEndpoint, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `userinfo_endpoint ${res.status}: ${text.slice(0, 200) || "no body"}`
    );
  }
  const claims = (await res.json()) as OidcClaims;
  if (!claims.sub) {
    throw new Error("userinfo response missing sub claim");
  }
  return claims;
}

/**
 * Check whether the given email is allowed by the admin's domain restriction.
 * `allowed` is a comma-separated list of domains (e.g. "example.com,acme.io").
 * null or empty = allow any.
 */
export function emailDomainAllowed(
  email: string | undefined | null,
  allowed: string | null | undefined
): boolean {
  if (!allowed || !allowed.trim()) return true;
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase().trim();
  if (!domain) return false;
  const list = allowed
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(domain);
}

// ----------------------------------------------------------------------------
// User linkage + provisioning
// ----------------------------------------------------------------------------

export async function findSsoLinkBySubject(
  subject: string
): Promise<SsoUserLink | null> {
  try {
    const [row] = await db
      .select()
      .from(ssoUserLinks)
      .where(eq(ssoUserLinks.subject, subject))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Given OIDC claims, find the linked local user, or auto-create one when
 * the admin has enabled `autoCreateUsers`. Returns the User row, or null if
 * no match and auto-creation is off.
 *
 * This also creates an `sso_user_links` row on first sign-in so subsequent
 * logins short-circuit on the `sub` lookup.
 */
export async function findOrCreateUserFromSso(
  claims: OidcClaims,
  cfg: SsoConfig
): Promise<
  | { ok: true; user: User }
  | { ok: false; error: string }
> {
  // 1. Existing link by subject
  const link = await findSsoLinkBySubject(claims.sub);
  if (link) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, link.userId))
      .limit(1);
    if (user) return { ok: true, user };
    // Orphaned link (user deleted) — drop it and fall through.
    await db
      .delete(ssoUserLinks)
      .where(eq(ssoUserLinks.subject, claims.sub))
      .catch(() => {});
  }

  // 2. Domain gate
  if (!emailDomainAllowed(claims.email, cfg.allowedEmailDomains)) {
    return {
      ok: false,
      error: "Your email domain is not permitted for SSO sign-in.",
    };
  }

  // 3. Match by email when present
  if (claims.email) {
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, claims.email))
      .limit(1);
    if (existing) {
      await db
        .insert(ssoUserLinks)
        .values({
          userId: existing.id,
          subject: claims.sub,
          emailAtLink: claims.email,
        })
        .onConflictDoNothing();
      return { ok: true, user: existing };
    }
  }

  // 4. Auto-create
  if (!cfg.autoCreateUsers) {
    return {
      ok: false,
      error:
        "No matching account, and the administrator has disabled SSO account creation.",
    };
  }

  const email = claims.email;
  if (!email) {
    return {
      ok: false,
      error: "SSO provider did not return an email claim.",
    };
  }

  const username = await pickAvailableUsername(
    claims.preferred_username || claims.name || email.split("@")[0] || "user"
  );

  // SSO users don't have a local password — store a random unusable hash.
  // The login form requires a password match against bcrypt so random bytes
  // here mean the account is SSO-only unless they set a password later.
  const fakeHash = "sso-only:" + randomToken(32);

  const [user] = await db
    .insert(users)
    .values({
      username,
      email,
      passwordHash: fakeHash,
    })
    .returning();

  await db
    .insert(ssoUserLinks)
    .values({
      userId: user.id,
      subject: claims.sub,
      emailAtLink: email,
    })
    .onConflictDoNothing();

  return { ok: true, user };
}

/** Normalize an IdP-provided name into a valid gluecron username. */
export function normalizeUsername(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "user";
}

/** Pick a username not already taken. Appends a random suffix on collision. */
async function pickAvailableUsername(raw: string): Promise<string> {
  const base = normalizeUsername(raw);
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${randomToken(3)}`;
    try {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, candidate))
        .limit(1);
      if (!row) return candidate;
    } catch {
      return `${base}-${randomToken(3)}`;
    }
  }
  return `${base}-${randomToken(4)}`;
}

/** Issue a session cookie token for a user. Caller sets the cookie. */
export async function issueSsoSession(userId: string): Promise<string> {
  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId,
    token,
    expiresAt: sessionExpiry(),
  });
  return token;
}

/** Compute the fully-qualified OIDC redirect URI for this deployment. */
export function ssoRedirectUri(): string {
  return `${config.appBaseUrl}/login/sso/callback`;
}

// ----------------------------------------------------------------------------
// Test-only exports
// ----------------------------------------------------------------------------

export const __internal = {
  emptyToNull,
  normalizeUsername,
};

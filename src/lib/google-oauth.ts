/**
 * "Sign in with Google" network helpers.
 *
 * Mirrors the structure of `src/lib/github-oauth.ts`. Google is OIDC-compliant
 * (unlike GitHub's plain OAuth 2.0) but we use it as plain OAuth here for
 * symmetry with the existing GitHub flow. The `userinfo_endpoint` returns
 * a stable subject (`sub`) which we use as the link key.
 *
 * Every function is pure: no database access, no global mutable state.
 * `fetchImpl` is injectable so tests don't hit the real Google API.
 */

import type { SsoConfig } from "../db/schema";

/** Override for tests — defaults to the global fetch. */
export type FetchImpl = typeof fetch;

/** Build the Google authorize URL the browser should be redirected to. */
export function buildGoogleAuthorizeUrl(
  cfg: Pick<SsoConfig, "authorizationEndpoint" | "clientId" | "scopes">,
  state: string,
  redirectUri: string,
  nonce: string
): string {
  if (!cfg.authorizationEndpoint || !cfg.clientId) {
    throw new Error(
      "Google OAuth config missing authorization_endpoint or client_id"
    );
  }
  const u = new URL(cfg.authorizationEndpoint);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scopes || "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  // `access_type=online` — we only need a one-shot sign-in, no offline refresh.
  u.searchParams.set("access_type", "online");
  // `prompt=select_account` — show Google's account picker so users with
  // multiple Google accounts can choose. Without this Google sometimes
  // silently uses the most-recent account, which surprises users.
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

/**
 * Exchange the authorization code for an access_token. Google returns
 * JSON natively, so this is simpler than GitHub's exchange.
 */
export async function exchangeGoogleCode(
  cfg: Pick<SsoConfig, "tokenEndpoint" | "clientId" | "clientSecret">,
  code: string,
  redirectUri: string,
  fetchImpl: FetchImpl = fetch
): Promise<{ accessToken: string; idToken: string | null }> {
  if (!cfg.tokenEndpoint || !cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Google OAuth config missing token_endpoint or client credentials"
    );
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const res = await fetchImpl(cfg.tokenEndpoint, {
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
      `google token endpoint ${res.status}: ${text.slice(0, 200) || "no body"}`
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (json.error) {
    throw new Error(
      `google token endpoint: ${json.error}${json.error_description ? ` — ${json.error_description}` : ""}`
    );
  }
  if (!json.access_token) {
    throw new Error("google token endpoint response missing access_token");
  }
  return {
    accessToken: json.access_token,
    idToken: typeof json.id_token === "string" ? json.id_token : null,
  };
}

/** The minimal subset of Google userinfo we read. */
export interface GoogleUserinfo {
  /** Stable Google account id (the `sub` claim). */
  sub: string;
  /** Verified email address; Google always returns this for `email` scope. */
  email: string | null;
  /** Whether Google considers the email verified. We refuse to auto-create on false. */
  emailVerified: boolean;
  /** Full name from the Google profile. */
  name: string | null;
  /** Avatar URL. */
  picture: string | null;
}

/** Fetch the Google userinfo profile using a Bearer access token. */
export async function fetchGoogleUserinfo(
  cfg: Pick<SsoConfig, "userinfoEndpoint">,
  accessToken: string,
  fetchImpl: FetchImpl = fetch
): Promise<GoogleUserinfo> {
  if (!cfg.userinfoEndpoint) {
    throw new Error("Google OAuth config missing userinfo_endpoint");
  }
  const res = await fetchImpl(cfg.userinfoEndpoint, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `google /userinfo ${res.status}: ${text.slice(0, 200) || "no body"}`
    );
  }
  const raw = (await res.json()) as {
    sub?: string;
    email?: string | null;
    email_verified?: boolean | string;
    name?: string | null;
    picture?: string | null;
  };
  if (typeof raw.sub !== "string" || !raw.sub) {
    throw new Error("google /userinfo response missing sub");
  }
  return {
    sub: raw.sub,
    email: raw.email ?? null,
    // Google sometimes serialises email_verified as a string "true"/"false".
    emailVerified:
      raw.email_verified === true || raw.email_verified === "true",
    name: raw.name ?? null,
    picture: raw.picture ?? null,
  };
}

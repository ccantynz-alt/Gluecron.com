/**
 * Block L6 — "Sign in with GitHub" network helpers.
 *
 * GitHub is OAuth 2.0, not strict OIDC, so these can't reuse the OIDC
 * helpers in `src/lib/sso.ts` directly:
 *   - The token endpoint defaults to `application/x-www-form-urlencoded`
 *     responses. We send `Accept: application/json` to force JSON.
 *   - There is no /userinfo endpoint; we hit `https://api.github.com/user`
 *     with a Bearer access_token instead.
 *   - GitHub does not issue an `id_token`, so we cannot validate a nonce —
 *     we trust the access_token + userinfo round-trip alone.
 *   - When `userinfo.email` is null (user has all emails set private),
 *     we fall back to `/user/emails` and pick the primary + verified one.
 *
 * Every function is pure: no database access, no global mutable state.
 * `fetchImpl` is injectable so tests don't hit the real GitHub API.
 */

import type { SsoConfig } from "../db/schema";

/** Override for tests — defaults to the global fetch. */
export type FetchImpl = typeof fetch;

/** Build the GitHub authorize URL the browser should be redirected to. */
export function buildGithubAuthorizeUrl(
  cfg: Pick<SsoConfig, "authorizationEndpoint" | "clientId" | "scopes">,
  state: string,
  redirectUri: string
): string {
  if (!cfg.authorizationEndpoint || !cfg.clientId) {
    throw new Error(
      "GitHub OAuth config missing authorization_endpoint or client_id"
    );
  }
  const u = new URL(cfg.authorizationEndpoint);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scopes || "read:user user:email");
  u.searchParams.set("state", state);
  // `allow_signup=true` is the GitHub default; explicit makes intent obvious.
  u.searchParams.set("allow_signup", "true");
  return u.toString();
}

/**
 * Exchange the authorization code for an access_token. GitHub returns
 * urlencoded by default — `Accept: application/json` is required for JSON.
 */
export async function exchangeGithubCode(
  cfg: Pick<SsoConfig, "tokenEndpoint" | "clientId" | "clientSecret">,
  code: string,
  redirectUri: string,
  fetchImpl: FetchImpl = fetch
): Promise<{ accessToken: string }> {
  if (!cfg.tokenEndpoint || !cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "GitHub OAuth config missing token_endpoint or client credentials"
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
      `github token endpoint ${res.status}: ${text.slice(0, 200) || "no body"}`
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (json.error) {
    throw new Error(
      `github token endpoint: ${json.error}${json.error_description ? ` — ${json.error_description}` : ""}`
    );
  }
  if (!json.access_token) {
    throw new Error("github token endpoint response missing access_token");
  }
  return { accessToken: json.access_token };
}

/** The minimal subset of `GET /user` we read. */
export interface GithubUserinfo {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/** Fetch the canonical GitHub user profile using a Bearer access token. */
export async function fetchGithubUserinfo(
  accessToken: string,
  fetchImpl: FetchImpl = fetch
): Promise<GithubUserinfo> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "gluecron",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `github /user ${res.status}: ${text.slice(0, 200) || "no body"}`
    );
  }
  const raw = (await res.json()) as {
    id?: number;
    login?: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };
  if (typeof raw.id !== "number" || !raw.login) {
    throw new Error("github /user response missing id or login");
  }
  return {
    id: raw.id,
    login: raw.login,
    name: raw.name ?? null,
    email: raw.email ?? null,
    avatarUrl: raw.avatar_url ?? null,
  };
}

/**
 * Fallback email lookup. GitHub may return `email: null` from /user if the
 * user marked all addresses private. /user/emails (with the `user:email`
 * scope) returns the full list; we want the entry with both
 * `primary: true` and `verified: true`. Anything else is rejected — we
 * never auto-create an account from an unverified email.
 *
 * Returns null on any failure; the caller surfaces a useful error.
 */
export async function fetchGithubPrimaryEmail(
  accessToken: string,
  fetchImpl: FetchImpl = fetch
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.github.com/user/emails", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "gluecron",
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let list: Array<{
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }>;
  try {
    list = (await res.json()) as typeof list;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (entry.primary && entry.verified && entry.email) {
      return entry.email;
    }
  }
  return null;
}

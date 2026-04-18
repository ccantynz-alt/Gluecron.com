/**
 * OAuth 2.0 helpers (Block B6).
 *
 * Stateless utilities for the OAuth provider implemented in
 * `src/routes/oauth.tsx`:
 *
 *   - token / code / secret generation
 *   - constant-time SHA-256 hashing (matches how we store PATs)
 *   - PKCE (RFC 7636) code_challenge verification
 *   - scope parsing + validation
 *   - redirect-URI matching (exact match, no wildcards)
 *
 * All outputs that end up in URLs or Authorization headers are prefix-tagged
 * so they're greppable in logs without leaking the secret portion.
 */

/** Supported OAuth scopes. Add new ones here + document on the consent screen. */
export const SUPPORTED_SCOPES = [
  "read:user",
  "read:repo",
  "write:repo",
  "read:org",
  "write:org",
  "read:issue",
  "write:issue",
  "read:pr",
  "write:pr",
] as const;

export type OauthScope = (typeof SUPPORTED_SCOPES)[number];

/** Default access token TTL (1 hour). */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Refresh token TTL (30 days). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Authorization code TTL (10 min — well within RFC 6749's 10-minute max). */
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

function randomHex(byteLen: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

/** Returns a 20-char client_id like `glc_app_<12 hex>`. */
export function generateClientId(): string {
  return "glc_app_" + randomHex(12);
}

/** Returns a 40-char client secret like `glcs_<32 hex>`. */
export function generateClientSecret(): string {
  return "glcs_" + randomHex(32);
}

export function generateAuthCode(): string {
  return "glca_" + randomHex(24);
}

export function generateAccessToken(): string {
  return "glct_" + randomHex(32);
}

export function generateRefreshToken(): string {
  return "glcr_" + randomHex(32);
}

/** SHA-256 hex digest. Same algorithm as src/routes/tokens.ts. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

/** Base64url (no padding) — used by PKCE. */
export function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * PKCE verification (RFC 7636).
 * For "S256": base64url(SHA-256(verifier)) must equal the challenge.
 * For "plain": the verifier must equal the challenge literally.
 * Returns true when the method is unrecognized but `challenge` is empty —
 * callers should refuse before calling this if PKCE is required.
 */
export async function verifyPkce(opts: {
  challenge: string | null | undefined;
  method: string | null | undefined;
  verifier: string;
}): Promise<boolean> {
  const challenge = (opts.challenge || "").trim();
  if (!challenge) return false;
  const method = (opts.method || "plain").toLowerCase();

  if (method === "s256") {
    const data = new TextEncoder().encode(opts.verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const produced = b64urlFromBytes(new Uint8Array(digest));
    return timingSafeEqual(produced, challenge);
  }
  if (method === "plain") {
    return timingSafeEqual(opts.verifier, challenge);
  }
  return false;
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Parse a scope string (space-separated per RFC 6749 or comma-separated for
 * convenience). Unknown scopes are dropped silently; duplicates collapsed.
 */
export function parseScopes(input: string | null | undefined): OauthScope[] {
  if (!input) return [];
  const parts = input.split(/[\s,]+/).filter(Boolean);
  const seen = new Set<string>();
  const out: OauthScope[] = [];
  for (const p of parts) {
    const s = p.trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    if ((SUPPORTED_SCOPES as readonly string[]).includes(s)) {
      out.push(s as OauthScope);
      seen.add(s);
    }
  }
  return out;
}

/** Serialize scopes back to a space-separated string. */
export function serializeScopes(scopes: readonly OauthScope[]): string {
  return scopes.join(" ");
}

/**
 * Parse an app's stored `redirectUris` column (newline-separated).
 * Empty / whitespace-only lines are ignored.
 */
export function parseRedirectUris(stored: string): string[] {
  return stored
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate a single redirect URI for storage:
 *  - must be absolute http(s):// (http only for localhost)
 *  - no fragment (`#...`)
 *  - no wildcards
 */
export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.protocol === "http:") {
      if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
        return false;
      }
    }
    if (u.hash) return false;
    if (uri.includes("*")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Exact-match check against the app's registered list. */
export function redirectUriAllowed(
  candidate: string,
  registered: readonly string[]
): boolean {
  if (!candidate) return false;
  for (const r of registered) {
    if (timingSafeEqual(candidate, r)) return true;
  }
  return false;
}

export const __test = {
  randomHex,
};

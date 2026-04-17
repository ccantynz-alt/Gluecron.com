/**
 * Block K11 — Cross-product identity.
 *
 * gluecron is the identity provider (IdP) for its sibling products:
 *   * Crontech   — runtime/hosting
 *   * Gatetest   — testing platform
 *
 * A single gluecron credential (session cookie, `glc_` PAT, or `glct_` OAuth
 * access token) can be exchanged at `POST /api/v1/cross-product/token` for a
 * short-lived HS256 JWT bound to a specific audience. The sibling products
 * verify these tokens either by calling `GET /api/v1/cross-product/verify` or
 * by verifying the HMAC signature themselves with the shared secret.
 *
 * This module is the pure crypto + persistence layer. It:
 *   * Mints signed JWTs using HMAC-SHA256 (crypto.subtle, no new deps).
 *   * Records every mint in `cross_product_tokens` for revocation + audit.
 *   * Verifies tokens (signature, exp, and the revocation list).
 *
 * Rules:
 *   * Secret is `process.env.CROSS_PRODUCT_SIGNING_SECRET`. In non-prod we fall
 *     back to a deterministic dev secret so tests run offline; in prod we
 *     refuse to boot.
 *   * Tokens are 15 minutes by default. Callers may NOT extend this.
 *   * Scopes are a fixed allowlist — anything unknown is silently dropped.
 *   * Audiences are a fixed allowlist — signing for an unknown audience throws.
 *   * JTI is a v4 UUID. The `cross_product_tokens` row is the source of truth
 *     for revocation; the JWT itself is not self-revoking.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";

// ---------------------------------------------------------------------------
// Config: audiences, scopes, TTL.
// ---------------------------------------------------------------------------

export type Audience = "crontech" | "gatetest";

export const ALLOWED_AUDIENCES: readonly Audience[] = [
  "crontech",
  "gatetest",
] as const;

/**
 * The universe of scopes gluecron will sign across all sibling products.
 * Keep this tight — unknown scopes get dropped, not rejected, so new sibling
 * products must add their scope here before clients can request it.
 */
export const ALLOWED_SCOPES: readonly string[] = [
  "deploy:read",
  "deploy:write",
  "test:run",
  "test:heal",
  "signals:write",
  "signals:read",
  "identity:read",
] as const;

export const DEFAULT_TTL_SECONDS: number = 15 * 60;

/** Identity claim issuer — sibling products check this. */
export const ISSUER = "gluecron" as const;

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface CrossProductClaims {
  /** Subject — gluecron user id. */
  sub: string;
  /** User's gluecron email (for sibling audit logs). */
  email: string;
  /** Always `"gluecron"`. */
  iss: typeof ISSUER;
  /** `"crontech"` or `"gatetest"`. */
  aud: Audience;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** JWT ID (UUID v4). */
  jti: string;
  /** Filtered to ALLOWED_SCOPES. */
  scopes: string[];
}

export interface SignInput {
  userId: string;
  email: string;
  audience: Audience;
  scopes?: string[];
  ttlSeconds?: number;
}

export interface SignResult {
  token: string;
  jti: string;
  expiresAt: Date;
  scopes: string[];
}

export type VerifyResult =
  | {
      valid: true;
      sub: string;
      email: string;
      audience: Audience;
      scopes: string[];
      jti: string;
      expiresAt: Date;
    }
  | { valid: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | "malformed"
  | "bad_algorithm"
  | "bad_signature"
  | "expired"
  | "unknown_audience"
  | "revoked"
  | "unknown_jti";

export interface ActiveCrossProductToken {
  jti: string;
  userId: string;
  audience: Audience;
  scopes: string[];
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Secret loading.
// ---------------------------------------------------------------------------

const DEV_FALLBACK_SEED = "gluecron-dev-secret-do-not-use-in-prod";

let cachedKey: Promise<CryptoKey> | null = null;

function resolveSecret(): string {
  const envVar = process.env.CROSS_PRODUCT_SIGNING_SECRET;
  if (envVar && envVar.length >= 16) return envVar;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "CROSS_PRODUCT_SIGNING_SECRET must be set (>=16 chars) in production"
    );
  }
  return DEV_FALLBACK_SEED;
}

async function getSigningKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = (async () => {
      const secret = resolveSecret();
      const raw = new TextEncoder().encode(secret);
      return await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
      );
    })();
  }
  return cachedKey;
}

/**
 * Test-only: forget the cached key so a test can rotate the secret mid-run.
 * Not exported from the package root — call via `__test`.
 */
function resetSigningKeyCache(): void {
  cachedKey = null;
}

// ---------------------------------------------------------------------------
// Base64url (JWT-safe).
// ---------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeString(str: string): string {
  return b64urlEncode(new TextEncoder().encode(str));
}

function b64urlDecode(input: string): Uint8Array {
  // Re-pad to a multiple of 4.
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeString(input: string): string {
  return new TextDecoder().decode(b64urlDecode(input));
}

// ---------------------------------------------------------------------------
// UUID v4 (no deps).
// ---------------------------------------------------------------------------

function uuidV4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

export function validateScopes(requested: readonly string[] | undefined): string[] {
  if (!requested || !Array.isArray(requested)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const allow = new Set<string>(ALLOWED_SCOPES);
  for (const raw of requested) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    if (allow.has(s)) {
      out.push(s);
      seen.add(s);
    }
  }
  return out;
}

export function isAllowedAudience(value: unknown): value is Audience {
  return (
    typeof value === "string" &&
    (ALLOWED_AUDIENCES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Sign / verify.
// ---------------------------------------------------------------------------

async function hmacSign(signingInput: string): Promise<string> {
  const key = await getSigningKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );
  return b64urlEncode(new Uint8Array(sig));
}

async function hmacVerify(
  signingInput: string,
  signatureB64: string
): Promise<boolean> {
  const key = await getSigningKey();
  const sig = b64urlDecode(signatureB64);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    sig,
    new TextEncoder().encode(signingInput)
  );
}

/**
 * Mint a cross-product JWT and persist the jti row.
 *
 * Throws on programmer errors (unknown audience, missing user id). Swallows
 * only DB failures on the insert — the token is still returned, but downstream
 * revocation will fail open. Deployed code should monitor the log.
 */
export async function signCrossProductToken(
  input: SignInput
): Promise<SignResult> {
  if (!input.userId || typeof input.userId !== "string") {
    throw new Error("userId is required");
  }
  if (!isAllowedAudience(input.audience)) {
    throw new Error(`unknown audience: ${String(input.audience)}`);
  }
  const ttl = Math.max(
    60,
    Math.min(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS)
  );
  const scopes = validateScopes(input.scopes ?? []);
  const jti = uuidV4();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  const expiresAt = new Date(exp * 1000);

  const header = { alg: "HS256", typ: "JWT" } as const;
  const payload: CrossProductClaims = {
    sub: input.userId,
    email: input.email,
    iss: ISSUER,
    aud: input.audience,
    exp,
    iat,
    jti,
    scopes,
  };

  const headerB = b64urlEncodeString(JSON.stringify(header));
  const payloadB = b64urlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB}.${payloadB}`;
  const sigB = await hmacSign(signingInput);
  const token = `${signingInput}.${sigB}`;

  try {
    await db.execute(sql`
      INSERT INTO cross_product_tokens (jti, user_id, audience, scopes, issued_at, expires_at)
      VALUES (
        ${jti},
        ${input.userId},
        ${input.audience},
        ${JSON.stringify(scopes)},
        to_timestamp(${iat}),
        to_timestamp(${exp})
      )
    `);
  } catch (err) {
    console.error("[cross-product-auth] failed to persist jti:", err);
  }

  return { token, jti, expiresAt, scopes };
}

/**
 * Verify a cross-product JWT.
 *
 *   * Checks the structural shape: 3 base64url parts.
 *   * Rejects anything that isn't `alg: "HS256", typ: "JWT"`.
 *   * Verifies HMAC.
 *   * Checks `exp` vs. now.
 *   * Checks the `cross_product_tokens` row for revocation.
 *
 * If the DB lookup fails (connection error), we fail open on the revocation
 * check — the signature + exp + audience checks have already passed, so
 * callers still get a well-formed identity; we log the DB error for ops.
 */
export async function verifyCrossProductToken(
  token: string
): Promise<VerifyResult> {
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [headerB, payloadB, sigB] = parts;

  let header: { alg?: unknown; typ?: unknown };
  let payload: Partial<CrossProductClaims> & Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecodeString(headerB));
    payload = JSON.parse(b64urlDecodeString(payloadB));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (header.alg !== "HS256" || header.typ !== "JWT") {
    return { valid: false, reason: "bad_algorithm" };
  }

  const signingInput = `${headerB}.${payloadB}`;
  let sigOk = false;
  try {
    sigOk = await hmacVerify(signingInput, sigB);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { valid: false, reason: "bad_signature" };

  if (typeof payload.exp !== "number") {
    return { valid: false, reason: "malformed" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { valid: false, reason: "expired" };

  if (!isAllowedAudience(payload.aud)) {
    return { valid: false, reason: "unknown_audience" };
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    return { valid: false, reason: "malformed" };
  }
  if (typeof payload.jti !== "string" || !payload.jti) {
    return { valid: false, reason: "malformed" };
  }

  // Revocation + jti existence check.
  try {
    const rows = (await db.execute(sql`
      SELECT revoked_at FROM cross_product_tokens
      WHERE jti = ${payload.jti}
      LIMIT 1
    `)) as unknown as Array<{ revoked_at: string | null }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (row && row.revoked_at) {
      return { valid: false, reason: "revoked" };
    }
    // Note: a missing row is not a hard fail; dev/test paths where the insert
    // was swallowed still surface the token. Ops can flip this to strict by
    // setting CROSS_PRODUCT_STRICT_JTI=1.
    if (!row && process.env.CROSS_PRODUCT_STRICT_JTI === "1") {
      return { valid: false, reason: "unknown_jti" };
    }
  } catch (err) {
    console.error("[cross-product-auth] revocation lookup failed:", err);
  }

  const scopes = Array.isArray(payload.scopes)
    ? (payload.scopes as unknown[]).filter(
        (s): s is string => typeof s === "string"
      )
    : [];

  return {
    valid: true,
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : "",
    audience: payload.aud,
    scopes,
    jti: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/**
 * Revoke a previously-minted cross-product token. Only the owning user's id
 * is accepted — callers must enforce this from the session / PAT / OAuth.
 * Returns `true` if a row was updated.
 */
export async function revokeCrossProductToken(
  jti: string,
  userId: string
): Promise<boolean> {
  if (!jti || !userId) return false;
  try {
    const rows = (await db.execute(sql`
      UPDATE cross_product_tokens
      SET revoked_at = now()
      WHERE jti = ${jti}
        AND user_id = ${userId}
        AND revoked_at IS NULL
      RETURNING jti
    `)) as unknown as Array<{ jti: string }>;
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error("[cross-product-auth] revoke failed:", err);
    return false;
  }
}

/**
 * List the user's currently-usable tokens (non-revoked, non-expired).
 * Ordered newest first. Cap at 50 to keep the settings page responsive.
 */
export async function listActiveCrossProductTokens(
  userId: string
): Promise<ActiveCrossProductToken[]> {
  if (!userId) return [];
  try {
    const rows = (await db.execute(sql`
      SELECT jti, user_id, audience, scopes, issued_at, expires_at, revoked_at
      FROM cross_product_tokens
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY issued_at DESC
      LIMIT 50
    `)) as unknown as Array<Record<string, unknown>>;
    return (rows || []).map(rowToActive).filter(
      (r): r is ActiveCrossProductToken => r !== null
    );
  } catch (err) {
    console.error("[cross-product-auth] list failed:", err);
    return [];
  }
}

function rowToActive(row: Record<string, unknown>): ActiveCrossProductToken | null {
  if (!row) return null;
  const jti = row.jti;
  const userId = row.user_id;
  const audience = row.audience;
  if (typeof jti !== "string" || typeof userId !== "string") return null;
  if (!isAllowedAudience(audience)) return null;
  let scopes: string[] = [];
  if (typeof row.scopes === "string") {
    try {
      const parsed = JSON.parse(row.scopes);
      if (Array.isArray(parsed)) {
        scopes = parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      scopes = [];
    }
  }
  const issuedAt = row.issued_at ? new Date(String(row.issued_at)) : new Date();
  const expiresAt = row.expires_at
    ? new Date(String(row.expires_at))
    : new Date();
  const revokedAt = row.revoked_at ? new Date(String(row.revoked_at)) : null;
  return { jti, userId, audience, scopes, issuedAt, expiresAt, revokedAt };
}

// ---------------------------------------------------------------------------
// Test hooks — do not import from production code.
// ---------------------------------------------------------------------------

export const __test = {
  resetSigningKeyCache,
  b64urlEncode,
  b64urlEncodeString,
  b64urlDecode,
  b64urlDecodeString,
  uuidV4,
  resolveSecret,
};

/**
 * Identify the pusher on a git-receive-pack request.
 *
 * Smart-HTTP push doesn't ride the cookie/session middleware (git CLI
 * doesn't keep cookies). It sends `Authorization: Basic <b64(user:secret)>`
 * or `Authorization: Bearer <token>`. We accept two secret shapes:
 *
 *   - `glc_*`  — personal access token (Block C2)
 *   - `glct_*` — OAuth access token  (Block B6)
 *
 * Installation tokens (`ghi_*`, Block H2) are deliberately not handled
 * here yet: app bots are stored in `app_bots` with their own `username`
 * but no link to a `users.id` row, so they can't currently own a push
 * decision in the protected-tag path. Adding bot identities to the auth
 * decision is future work — the resolver returns null for `ghi_*` and the
 * push falls back to anonymous, which is rejected by every protected ref.
 *
 * Best-effort only: returns null (anonymous) on any failure. The caller
 * must decide what anonymous can do (current policy: anonymous can
 * push to non-protected refs; protected refs always require auth).
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, apiTokens, oauthAccessTokens } from "../db/schema";
import { sha256Hex } from "./oauth";

export type ResolvedPusher = {
  userId: string;
  username: string;
  source: "pat" | "oauth";
};

/** Decode a `Basic` auth header → `{user, secret}` or null on malformed. */
export function decodeBasicAuth(
  header: string | null | undefined
): { user: string; secret: string } | null {
  if (!header) return null;
  const m = /^\s*Basic\s+(.+)$/i.exec(header);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1].trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return {
    user: decoded.slice(0, colon),
    secret: decoded.slice(colon + 1),
  };
}

/** Decode a `Bearer` auth header → token string or null. */
export function decodeBearerAuth(
  header: string | null | undefined
): string | null {
  if (!header) return null;
  const m = /^\s*Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const tok = m[1].trim();
  return tok || null;
}

async function resolveByPat(token: string): Promise<ResolvedPusher | null> {
  if (!token.startsWith("glc_")) return null;
  try {
    const hash = await sha256Hex(token);
    const [row] = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;
    const [u] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!u) return null;
    return { userId: u.id, username: u.username, source: "pat" };
  } catch {
    return null;
  }
}

async function resolveByOauth(token: string): Promise<ResolvedPusher | null> {
  if (!token.startsWith("glct_")) return null;
  try {
    const hash = await sha256Hex(token);
    const [row] = await db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.accessTokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (new Date(row.expiresAt) < new Date()) return null;
    const [u] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!u) return null;
    return { userId: u.id, username: u.username, source: "oauth" };
  } catch {
    return null;
  }
}

/**
 * Resolve the pusher from an Authorization header. Tries Bearer (PAT or
 * OAuth) then Basic (where the secret in the password field can also be
 * a PAT or OAuth token — git CLI sends `git config credential.helper`
 * output as username + password).
 */
export async function resolvePusher(
  authHeader: string | null | undefined
): Promise<ResolvedPusher | null> {
  if (!authHeader) return null;

  const bearer = decodeBearerAuth(authHeader);
  if (bearer) {
    return (
      (await resolveByPat(bearer)) ||
      (await resolveByOauth(bearer))
    );
  }

  const basic = decodeBasicAuth(authHeader);
  if (basic) {
    const secret = basic.secret;
    return (
      (await resolveByPat(secret)) ||
      (await resolveByOauth(secret))
    );
  }

  return null;
}

/**
 * Identify the pusher on a git-receive-pack request.
 *
 * Smart-HTTP push doesn't ride the cookie/session middleware (git CLI
 * doesn't keep cookies). It sends `Authorization: Basic <b64(user:secret)>`
 * or `Authorization: Bearer <token>`. We accept three secret shapes:
 *
 *   - `glc_*`  — personal access token (Block C2)
 *   - `glct_*` — OAuth access token  (Block B6)
 *   - `ghi_*`  — installation token for an app-bot (Block H2). The
 *                token resolves to the synthetic users row created by
 *                `createApp(...)` (`<slug>[bot]` username). Legacy bots
 *                created before the synthetic-user back-fill landed
 *                fail soft and resolve as anonymous.
 *
 * Best-effort only: returns null (anonymous) on any failure. The caller
 * must decide what anonymous can do (current policy: anonymous can
 * push to non-protected refs; protected refs always require auth).
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  apiTokens,
  oauthAccessTokens,
  appInstallTokens,
  appInstallations,
  appBots,
} from "../db/schema";
import { sha256Hex } from "./oauth";

export type ResolvedPusher = {
  userId: string;
  username: string;
  source: "pat" | "oauth" | "install_token";
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

async function resolveByInstallToken(
  token: string
): Promise<ResolvedPusher | null> {
  if (!token.startsWith("ghi_")) return null;
  try {
    const hash = await sha256Hex(token);
    // Look up the install token + its installation + the app's bot
    // username in one round-trip via the join shape.
    const [row] = await db
      .select({
        tokenId: appInstallTokens.id,
        revokedAt: appInstallTokens.revokedAt,
        expiresAt: appInstallTokens.expiresAt,
        suspendedAt: appInstallations.suspendedAt,
        uninstalledAt: appInstallations.uninstalledAt,
        botUsername: appBots.username,
      })
      .from(appInstallTokens)
      .innerJoin(
        appInstallations,
        eq(appInstallTokens.installationId, appInstallations.id)
      )
      .innerJoin(appBots, eq(appBots.appId, appInstallations.appId))
      .where(eq(appInstallTokens.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;
    if (row.suspendedAt) return null;
    if (row.uninstalledAt) return null;

    // Find the synthetic users row that createApp inserts for the bot.
    // Legacy bots (created before the back-fill landed) won't have one;
    // those resolve as anonymous, which fails closed on every protected
    // ref but doesn't break public-repo writes.
    const [u] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.username, row.botUsername))
      .limit(1);
    if (!u) return null;
    return { userId: u.id, username: u.username, source: "install_token" };
  } catch {
    return null;
  }
}

/**
 * Resolve the pusher from an Authorization header. Tries Bearer (PAT,
 * OAuth, or install token) then Basic (where the secret in the password
 * field can also be any of the three). git CLI sends
 * `credential.helper` output as username + password; users typically
 * paste the token as the password.
 */
export async function resolvePusher(
  authHeader: string | null | undefined
): Promise<ResolvedPusher | null> {
  if (!authHeader) return null;

  const bearer = decodeBearerAuth(authHeader);
  if (bearer) {
    return (
      (await resolveByPat(bearer)) ||
      (await resolveByOauth(bearer)) ||
      (await resolveByInstallToken(bearer))
    );
  }

  const basic = decodeBasicAuth(authHeader);
  if (basic) {
    const secret = basic.secret;
    return (
      (await resolveByPat(secret)) ||
      (await resolveByOauth(secret)) ||
      (await resolveByInstallToken(secret))
    );
  }

  return null;
}

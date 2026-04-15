/**
 * WebAuthn / passkey helpers (Block B5).
 *
 * Thin wrapper over @simplewebauthn/server that:
 *  - reads RP config from `src/lib/config.ts`
 *  - persists short-lived challenges in `webauthn_challenges`
 *  - converts between base64url (used in the browser) and bytes as needed
 */

import { and, eq, lt } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { db } from "../db";
import { webauthnChallenges, userPasskeys } from "../db/schema";
import { config } from "./config";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function newSessionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function gcExpiredChallenges(): Promise<void> {
  try {
    await db
      .delete(webauthnChallenges)
      .where(lt(webauthnChallenges.expiresAt, new Date()));
  } catch {
    /* best-effort GC */
  }
}

export async function startRegistration(opts: {
  userId: string;
  userName: string;
  userDisplayName?: string;
  excludeCredentialIds?: string[];
}) {
  await gcExpiredChallenges();
  const options = await generateRegistrationOptions({
    rpName: config.webauthnRpName,
    rpID: config.webauthnRpId,
    userName: opts.userName,
    userDisplayName: opts.userDisplayName || opts.userName,
    userID: new TextEncoder().encode(opts.userId),
    attestationType: "none",
    excludeCredentials: (opts.excludeCredentialIds || []).map((id) => ({
      id,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  const sessionKey = newSessionKey();
  await db.insert(webauthnChallenges).values({
    userId: opts.userId,
    sessionKey,
    challenge: options.challenge,
    kind: "register",
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return { options, sessionKey };
}

export async function finishRegistration(opts: {
  sessionKey: string;
  response: RegistrationResponseJSON;
}): Promise<
  | { ok: true; credentialId: string; publicKey: string; counter: number }
  | { ok: false; error: string }
> {
  try {
    const [chal] = await db
      .select()
      .from(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.sessionKey, opts.sessionKey),
          eq(webauthnChallenges.kind, "register")
        )
      )
      .limit(1);
    if (!chal) return { ok: false, error: "Challenge not found or expired" };
    if (new Date(chal.expiresAt) < new Date()) {
      return { ok: false, error: "Challenge expired" };
    }

    const verification = await verifyRegistrationResponse({
      response: opts.response,
      expectedChallenge: chal.challenge,
      expectedOrigin: config.webauthnOrigin,
      expectedRPID: config.webauthnRpId,
      requireUserVerification: false,
    });

    // One-shot: remove the challenge whether verification passed or not.
    await db
      .delete(webauthnChallenges)
      .where(eq(webauthnChallenges.sessionKey, opts.sessionKey));

    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false, error: "Registration did not verify" };
    }

    const { credential } = verification.registrationInfo;
    return {
      ok: true,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
    };
  } catch (err) {
    console.error("[webauthn] finishRegistration:", err);
    return { ok: false, error: "Verification failed" };
  }
}

export async function startAuthentication(opts: {
  userId?: string;
  allowCredentialIds?: string[];
}) {
  await gcExpiredChallenges();
  const options = await generateAuthenticationOptions({
    rpID: config.webauthnRpId,
    allowCredentials: (opts.allowCredentialIds || []).map((id) => ({ id })),
    userVerification: "preferred",
  });

  const sessionKey = newSessionKey();
  await db.insert(webauthnChallenges).values({
    userId: opts.userId || null,
    sessionKey,
    challenge: options.challenge,
    kind: "authenticate",
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return { options, sessionKey };
}

export async function finishAuthentication(opts: {
  sessionKey: string;
  response: AuthenticationResponseJSON;
}): Promise<
  | {
      ok: true;
      userId: string;
      credentialId: string;
      newCounter: number;
    }
  | { ok: false; error: string }
> {
  try {
    const [chal] = await db
      .select()
      .from(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.sessionKey, opts.sessionKey),
          eq(webauthnChallenges.kind, "authenticate")
        )
      )
      .limit(1);
    if (!chal) return { ok: false, error: "Challenge not found or expired" };
    if (new Date(chal.expiresAt) < new Date()) {
      return { ok: false, error: "Challenge expired" };
    }

    const credentialId = opts.response.id;
    const [pk] = await db
      .select()
      .from(userPasskeys)
      .where(eq(userPasskeys.credentialId, credentialId))
      .limit(1);
    if (!pk) {
      return { ok: false, error: "Unknown credential" };
    }

    const verification = await verifyAuthenticationResponse({
      response: opts.response,
      expectedChallenge: chal.challenge,
      expectedOrigin: config.webauthnOrigin,
      expectedRPID: config.webauthnRpId,
      credential: {
        id: pk.credentialId,
        publicKey: new Uint8Array(Buffer.from(pk.publicKey, "base64url")),
        counter: pk.counter,
      },
      requireUserVerification: false,
    });

    await db
      .delete(webauthnChallenges)
      .where(eq(webauthnChallenges.sessionKey, opts.sessionKey));

    if (!verification.verified) {
      return { ok: false, error: "Authentication did not verify" };
    }

    const newCounter = verification.authenticationInfo.newCounter;
    await db
      .update(userPasskeys)
      .set({ counter: newCounter, lastUsedAt: new Date() })
      .where(eq(userPasskeys.id, pk.id));

    return {
      ok: true,
      userId: pk.userId,
      credentialId: pk.credentialId,
      newCounter,
    };
  } catch (err) {
    console.error("[webauthn] finishAuthentication:", err);
    return { ok: false, error: "Verification failed" };
  }
}

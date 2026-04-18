/**
 * Block J3 — Commit signature verification (GPG + SSH).
 *
 * Pragmatic V1 that does identity matching without requiring gpg/ssh-keygen
 * binaries. The flow is:
 *
 *   1. Parse the raw commit object for a `gpgsig` / `gpgsig-sha256` header.
 *   2. Tell whether the armored blob is a PGP signature or an SSH signature.
 *   3. For PGP, decode the base64 body and walk the packet stream for an
 *      "Issuer Fingerprint" (subpacket 33) or "Issuer" (subpacket 16); for
 *      SSH, decode the inner SSHSIG blob for its embedded public key and
 *      fingerprint it with SHA-256.
 *   4. Look the fingerprint up in `signing_keys`. If the registered key's
 *      owner's email matches the commit author email, → `verified=true`.
 *
 * We do NOT run gpg --verify here; cryptographic verification requires the
 * full signed message re-construction + long-term key escrow which is out of
 * scope for V1. The honest "Verified" badge therefore reads as: "signed with
 * a key we've seen registered under this email." Future work (J3+) can shell
 * out to `gpg --verify` / `ssh-keygen -Y verify` when those binaries are
 * available at runtime.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  commitVerifications,
  signingKeys,
  users,
  type SigningKey,
} from "../db/schema";
import { getRawCommitObject } from "../git/repository";

export type VerificationReason =
  | "valid"
  | "unsigned"
  | "unknown_key"
  | "expired"
  | "bad_sig"
  | "email_mismatch";

export interface VerificationResult {
  verified: boolean;
  reason: VerificationReason;
  signatureType: "gpg" | "ssh" | null;
  fingerprint: string | null;
  signerUserId: string | null;
  signerKeyId: string | null;
}

// ----------------------------------------------------------------------------
// Commit-object parsing
// ----------------------------------------------------------------------------

/**
 * Pull out the `gpgsig` block from a raw commit object. Returns the armored
 * signature (lines joined with \n, leading single-space continuation stripped)
 * and the commit headers/body separately. Null when unsigned.
 */
export function extractSignatureFromCommit(
  raw: string
): { signature: string; type: "gpg" | "ssh"; authorEmail: string | null } | null {
  if (!raw) return null;
  const lines = raw.split("\n");
  let sig: string[] = [];
  let inSig = false;
  let author: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === "") break; // headers ended
    if (inSig) {
      if (ln.startsWith(" ")) {
        sig.push(ln.slice(1));
        continue;
      } else {
        inSig = false;
      }
    }
    if (ln.startsWith("gpgsig ") || ln.startsWith("gpgsig-sha256 ")) {
      sig = [ln.replace(/^gpgsig(-sha256)? /, "")];
      inSig = true;
      continue;
    }
    if (ln.startsWith("author ")) {
      const m = ln.match(/<([^>]+)>/);
      if (m) author = m[1];
    }
  }
  if (sig.length === 0) return null;
  const armored = sig.join("\n");
  const type: "gpg" | "ssh" = armored.includes("BEGIN SSH SIGNATURE")
    ? "ssh"
    : "gpg";
  return { signature: armored, type, authorEmail: author };
}

// ----------------------------------------------------------------------------
// PGP signature → issuer fingerprint
// ----------------------------------------------------------------------------

/** Base64 decoder that tolerates armor whitespace + CR. */
function b64decode(s: string): Uint8Array {
  const clean = s.replace(/[\r\n\s]+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Strip PEM-style armor (BEGIN/END lines + optional CRC24 trailer starting
 * with "="). Returns the raw packet stream bytes.
 */
export function unarmorPgp(armored: string): Uint8Array | null {
  const lines = armored.split(/\r?\n/);
  const body: string[] = [];
  let inBody = false;
  let afterBlankLine = false;
  for (const ln of lines) {
    if (ln.startsWith("-----BEGIN")) {
      inBody = true;
      afterBlankLine = false;
      continue;
    }
    if (ln.startsWith("-----END")) break;
    if (!inBody) continue;
    if (!afterBlankLine) {
      if (ln.trim() === "") {
        afterBlankLine = true;
      }
      // Skip armor headers like "Version:" / "Comment:" until the blank line.
      continue;
    }
    if (ln.startsWith("=")) continue; // CRC24 trailer
    body.push(ln);
  }
  const joined = body.join("");
  if (!joined) return null;
  try {
    return b64decode(joined);
  } catch {
    return null;
  }
}

/**
 * Walk the first few packets of a PGP packet stream looking for a signature
 * packet (tag 2) and within it the hashed+unhashed subpacket areas for
 * subpacket 33 (Issuer Fingerprint) or 16 (Issuer Key ID). Returns the
 * fingerprint or key ID as a lowercase hex string, or null.
 *
 * Only supports the OpenPGP v1 (old) and current (new) packet formats; just
 * enough of the grammar to pluck issuer info out of modern GPG sigs.
 */
export function parsePgpIssuerFingerprint(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 2) return null;
  let off = 0;
  while (off < bytes.length) {
    const tagByte = bytes[off++];
    if ((tagByte & 0x80) === 0) return null; // not a valid packet header
    let tag: number;
    let len: number;
    if ((tagByte & 0x40) === 0) {
      // Old-format packet
      tag = (tagByte & 0x3c) >> 2;
      const lenType = tagByte & 0x03;
      if (lenType === 0) {
        len = bytes[off++];
      } else if (lenType === 1) {
        len = (bytes[off++] << 8) | bytes[off++];
      } else if (lenType === 2) {
        len =
          (bytes[off++] << 24) |
          (bytes[off++] << 16) |
          (bytes[off++] << 8) |
          bytes[off++];
      } else {
        return null; // indeterminate length — give up
      }
    } else {
      tag = tagByte & 0x3f;
      const l0 = bytes[off++];
      if (l0 < 192) {
        len = l0;
      } else if (l0 < 224) {
        len = ((l0 - 192) << 8) + bytes[off++] + 192;
      } else if (l0 === 255) {
        len =
          (bytes[off++] << 24) |
          (bytes[off++] << 16) |
          (bytes[off++] << 8) |
          bytes[off++];
      } else {
        return null; // partial length body — skip
      }
    }
    if (tag !== 2) {
      off += len;
      continue;
    }
    // Signature packet.
    const end = off + len;
    const version = bytes[off++];
    if (version !== 4 && version !== 5) {
      off = end;
      continue;
    }
    // Skip: sigType (1) + pubAlgo (1) + hashAlgo (1)
    off += 3;
    // Hashed subpackets
    const hashedLen =
      version === 4
        ? (bytes[off++] << 8) | bytes[off++]
        : (bytes[off++] << 24) |
          (bytes[off++] << 16) |
          (bytes[off++] << 8) |
          bytes[off++];
    const fp = scanSubpackets(bytes, off, off + hashedLen);
    if (fp) return fp;
    off += hashedLen;
    // Unhashed subpackets
    const unhashedLen =
      version === 4
        ? (bytes[off++] << 8) | bytes[off++]
        : (bytes[off++] << 24) |
          (bytes[off++] << 16) |
          (bytes[off++] << 8) |
          bytes[off++];
    const fp2 = scanSubpackets(bytes, off, off + unhashedLen);
    if (fp2) return fp2;
    off = end;
  }
  return null;
}

function scanSubpackets(
  bytes: Uint8Array,
  start: number,
  end: number
): string | null {
  let off = start;
  let keyIdFallback: string | null = null;
  while (off < end) {
    const l0 = bytes[off++];
    let spLen: number;
    if (l0 < 192) {
      spLen = l0;
    } else if (l0 < 255) {
      spLen = ((l0 - 192) << 8) + bytes[off++] + 192;
    } else {
      spLen =
        (bytes[off++] << 24) |
        (bytes[off++] << 16) |
        (bytes[off++] << 8) |
        bytes[off++];
    }
    const spType = bytes[off] & 0x7f;
    const bodyStart = off + 1;
    const bodyEnd = off + spLen;
    if (spType === 33) {
      // [version (1 byte) | fingerprint (20 or 32 bytes)]
      const hex: string[] = [];
      for (let i = bodyStart + 1; i < bodyEnd; i++) {
        hex.push(bytes[i].toString(16).padStart(2, "0"));
      }
      return hex.join("");
    }
    if (spType === 16 && !keyIdFallback) {
      const hex: string[] = [];
      for (let i = bodyStart; i < bodyEnd; i++) {
        hex.push(bytes[i].toString(16).padStart(2, "0"));
      }
      keyIdFallback = hex.join("");
    }
    off = bodyEnd;
  }
  return keyIdFallback;
}

// ----------------------------------------------------------------------------
// SSH signature → pubkey fingerprint
// ----------------------------------------------------------------------------

/**
 * Unarmor an SSH signature (RFC "SSHSIG" format). Returns the inner binary
 * blob that follows the 6-byte "SSHSIG" magic.
 */
export function unarmorSsh(armored: string): Uint8Array | null {
  const lines = armored.split(/\r?\n/);
  const body: string[] = [];
  let inBody = false;
  for (const ln of lines) {
    if (ln.startsWith("-----BEGIN SSH SIGNATURE")) {
      inBody = true;
      continue;
    }
    if (ln.startsWith("-----END SSH SIGNATURE")) break;
    if (inBody && ln.trim() !== "") body.push(ln);
  }
  if (!body.length) return null;
  try {
    return b64decode(body.join(""));
  } catch {
    return null;
  }
}

/**
 * Parse the "publickey" field out of an SSHSIG blob. Returns the public key
 * wire-format bytes (length-prefixed `ssh-...`), or null.
 */
export function parseSshSigPublicKey(blob: Uint8Array): Uint8Array | null {
  if (!blob || blob.length < 10) return null;
  // Magic "SSHSIG"
  const magic = "SSHSIG";
  for (let i = 0; i < magic.length; i++) {
    if (blob[i] !== magic.charCodeAt(i)) return null;
  }
  let off = magic.length;
  // u32 version
  off += 4;
  // string publickey (u32 len + bytes)
  if (off + 4 > blob.length) return null;
  const len =
    (blob[off] << 24) |
    (blob[off + 1] << 16) |
    (blob[off + 2] << 8) |
    blob[off + 3];
  off += 4;
  if (off + len > blob.length) return null;
  return blob.slice(off, off + len);
}

// ----------------------------------------------------------------------------
// Fingerprints
// ----------------------------------------------------------------------------

/**
 * Compute the canonical fingerprint for a registered signing key.
 *   - GPG: the public-key block's issuer fingerprint (we don't parse the
 *     full PGP pubkey — users must paste it with the fingerprint line, which
 *     we strip to lowercase hex).
 *   - SSH: base64 SHA-256 of the wire-format `ssh-...` key body (the second
 *     whitespace-separated token in an authorized_keys line).
 */
export async function fingerprintForPublicKey(
  keyType: "gpg" | "ssh",
  publicKey: string
): Promise<string | null> {
  if (keyType === "ssh") {
    const token = publicKey.trim().split(/\s+/)[1];
    if (!token) return null;
    let bytes: Uint8Array;
    try {
      bytes = b64decode(token);
    } catch {
      return null;
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    // Base64 (unpadded) — mimics `ssh-keygen -l -E sha256`.
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(
      /=+$/,
      ""
    );
    return `SHA256:${b64}`;
  }
  // GPG: extract the first 40-char (or 64-char) hex string we can find.
  const m =
    publicKey.match(/\b([A-Fa-f0-9]{40})\b/) ||
    publicKey.match(/\b([A-Fa-f0-9]{64})\b/);
  if (!m) return null;
  return m[1].toLowerCase();
}

// ----------------------------------------------------------------------------
// End-to-end verify
// ----------------------------------------------------------------------------

/**
 * Verify a commit given the raw commit object. Pure function — no DB access
 * here. Returns the parsed signature info; the matcher step is done in
 * `verifyCommit` below.
 */
export function analyzeRawCommit(
  raw: string
): {
  type: "gpg" | "ssh" | null;
  fingerprint: string | null;
  authorEmail: string | null;
} {
  const sig = extractSignatureFromCommit(raw);
  if (!sig) return { type: null, fingerprint: null, authorEmail: null };
  if (sig.type === "gpg") {
    const packets = unarmorPgp(sig.signature);
    if (!packets) {
      return { type: "gpg", fingerprint: null, authorEmail: sig.authorEmail };
    }
    const fp = parsePgpIssuerFingerprint(packets);
    return {
      type: "gpg",
      fingerprint: fp ? fp.toLowerCase() : null,
      authorEmail: sig.authorEmail,
    };
  }
  // SSH
  const blob = unarmorSsh(sig.signature);
  if (!blob) {
    return { type: "ssh", fingerprint: null, authorEmail: sig.authorEmail };
  }
  const pubkey = parseSshSigPublicKey(blob);
  if (!pubkey) {
    return { type: "ssh", fingerprint: null, authorEmail: sig.authorEmail };
  }
  return {
    type: "ssh",
    fingerprint: null, // filled by caller via SubtleCrypto
    authorEmail: sig.authorEmail,
    ...{
      _sshPublicKey: pubkey,
    },
  } as any;
}

async function fingerprintSshBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(
    /=+$/,
    ""
  );
  return `SHA256:${b64}`;
}

/**
 * Cache lookup → parse → match → write-back. The expensive work (git cat-file
 * + subtle.digest) runs only on cache miss.
 */
export async function verifyCommit(
  repositoryId: string,
  ownerName: string,
  repoName: string,
  sha: string,
  opts: { forceFresh?: boolean } = {}
): Promise<VerificationResult> {
  if (!opts.forceFresh) {
    const [cached] = await db
      .select()
      .from(commitVerifications)
      .where(
        and(
          eq(commitVerifications.repositoryId, repositoryId),
          eq(commitVerifications.commitSha, sha)
        )
      )
      .limit(1);
    if (cached) {
      return {
        verified: cached.verified,
        reason: cached.reason as VerificationReason,
        signatureType: (cached.signatureType as any) ?? null,
        fingerprint: cached.signerFingerprint,
        signerUserId: cached.signerUserId,
        signerKeyId: cached.signerKeyId,
      };
    }
  }

  const raw = await getRawCommitObject(ownerName, repoName, sha);
  const result = await verifyRawCommit(raw);
  await persistVerification(repositoryId, sha, result);
  return result;
}

/** Test-friendly: verify without hitting git or the DB. */
export async function verifyRawCommit(
  raw: string | null
): Promise<VerificationResult> {
  if (!raw)
    return {
      verified: false,
      reason: "unsigned",
      signatureType: null,
      fingerprint: null,
      signerUserId: null,
      signerKeyId: null,
    };
  const sig = extractSignatureFromCommit(raw);
  if (!sig)
    return {
      verified: false,
      reason: "unsigned",
      signatureType: null,
      fingerprint: null,
      signerUserId: null,
      signerKeyId: null,
    };

  let fingerprint: string | null = null;
  if (sig.type === "gpg") {
    const packets = unarmorPgp(sig.signature);
    if (packets) {
      const fp = parsePgpIssuerFingerprint(packets);
      if (fp) fingerprint = fp.toLowerCase();
    }
  } else {
    const blob = unarmorSsh(sig.signature);
    if (blob) {
      const pubkey = parseSshSigPublicKey(blob);
      if (pubkey) fingerprint = await fingerprintSshBytes(pubkey);
    }
  }

  if (!fingerprint) {
    return {
      verified: false,
      reason: "bad_sig",
      signatureType: sig.type,
      fingerprint: null,
      signerUserId: null,
      signerKeyId: null,
    };
  }

  // Match against registered keys — for GPG we match as suffix since the
  // issuer subpacket may carry only the 64-bit key ID (trailing 16 hex chars).
  let signingKey: SigningKey | null = null;
  if (sig.type === "gpg") {
    const all = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.keyType, "gpg"))
      .limit(500);
    const fpLc = fingerprint.toLowerCase();
    signingKey =
      all.find((k) => k.fingerprint.toLowerCase() === fpLc) ??
      all.find((k) => k.fingerprint.toLowerCase().endsWith(fpLc)) ??
      null;
  } else {
    const [row] = await db
      .select()
      .from(signingKeys)
      .where(
        and(
          eq(signingKeys.keyType, "ssh"),
          eq(signingKeys.fingerprint, fingerprint)
        )
      )
      .limit(1);
    signingKey = row ?? null;
  }

  if (!signingKey) {
    return {
      verified: false,
      reason: "unknown_key",
      signatureType: sig.type,
      fingerprint,
      signerUserId: null,
      signerKeyId: null,
    };
  }

  if (signingKey.expiresAt && signingKey.expiresAt < new Date()) {
    return {
      verified: false,
      reason: "expired",
      signatureType: sig.type,
      fingerprint,
      signerUserId: signingKey.userId,
      signerKeyId: signingKey.id,
    };
  }

  // Email match (if declared on the key).
  if (sig.authorEmail && signingKey.email) {
    if (
      signingKey.email.toLowerCase().trim() !==
      sig.authorEmail.toLowerCase().trim()
    ) {
      return {
        verified: false,
        reason: "email_mismatch",
        signatureType: sig.type,
        fingerprint,
        signerUserId: signingKey.userId,
        signerKeyId: signingKey.id,
      };
    }
  }

  return {
    verified: true,
    reason: "valid",
    signatureType: sig.type,
    fingerprint,
    signerUserId: signingKey.userId,
    signerKeyId: signingKey.id,
  };
}

async function persistVerification(
  repositoryId: string,
  sha: string,
  result: VerificationResult
): Promise<void> {
  try {
    await db
      .insert(commitVerifications)
      .values({
        repositoryId,
        commitSha: sha,
        verified: result.verified,
        reason: result.reason,
        signatureType: result.signatureType,
        signerKeyId: result.signerKeyId,
        signerUserId: result.signerUserId,
        signerFingerprint: result.fingerprint,
      })
      .onConflictDoNothing();
  } catch {
    // best effort — rendering should never fail because the cache write blew up
  }
}

// ----------------------------------------------------------------------------
// CRUD for /settings/signing-keys
// ----------------------------------------------------------------------------

export async function listSigningKeysForUser(
  userId: string
): Promise<SigningKey[]> {
  return db
    .select()
    .from(signingKeys)
    .where(eq(signingKeys.userId, userId));
}

export async function listSigningKeysForUsername(
  username: string
): Promise<Array<SigningKey & { username: string }>> {
  return db
    .select({
      id: signingKeys.id,
      userId: signingKeys.userId,
      keyType: signingKeys.keyType,
      title: signingKeys.title,
      fingerprint: signingKeys.fingerprint,
      publicKey: signingKeys.publicKey,
      email: signingKeys.email,
      expiresAt: signingKeys.expiresAt,
      lastUsedAt: signingKeys.lastUsedAt,
      createdAt: signingKeys.createdAt,
      username: users.username,
    })
    .from(signingKeys)
    .innerJoin(users, eq(signingKeys.userId, users.id))
    .where(eq(users.username, username));
}

export async function addSigningKey(params: {
  userId: string;
  keyType: "gpg" | "ssh";
  title: string;
  publicKey: string;
  email?: string | null;
}): Promise<
  | { ok: true; id: string; fingerprint: string }
  | { ok: false; error: string }
> {
  const { userId, keyType, title, publicKey } = params;
  const email = (params.email || "").trim() || null;
  const trimmed = publicKey.trim();
  if (!trimmed) return { ok: false, error: "Public key is required" };
  if (keyType !== "gpg" && keyType !== "ssh") {
    return { ok: false, error: "Unknown key type" };
  }
  if (!title.trim()) return { ok: false, error: "Title is required" };
  const fingerprint = await fingerprintForPublicKey(keyType, trimmed);
  if (!fingerprint) {
    return { ok: false, error: "Could not derive a fingerprint" };
  }
  try {
    const [row] = await db
      .insert(signingKeys)
      .values({
        userId,
        keyType,
        title: title.trim(),
        fingerprint,
        publicKey: trimmed,
        email,
      })
      .returning();
    return { ok: true, id: row.id, fingerprint };
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg.includes("signing_keys_fp_unique") || msg.includes("duplicate")) {
      return { ok: false, error: "That key is already registered" };
    }
    return { ok: false, error: "Could not save key" };
  }
}

export async function deleteSigningKey(
  keyId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .delete(signingKeys)
    .where(and(eq(signingKeys.id, keyId), eq(signingKeys.userId, userId)))
    .returning();
  return rows.length > 0;
}

// Test-only internals.
export const __internal = {
  b64decode,
  scanSubpackets,
  fingerprintSshBytes,
};

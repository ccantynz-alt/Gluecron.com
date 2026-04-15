/**
 * TOTP (RFC 6238) — standalone, no external deps.
 *
 * Used for 2FA (Block B4). Generates + verifies 6-digit codes with a 30-second
 * step. Verification accepts the current step ±1 to tolerate clock skew.
 *
 * Secrets are stored as Base32 strings (the standard QR-code encoding) and
 * converted to bytes on each verify. At rest the secret is further encrypted
 * (see `src/lib/crypto.ts` for the AES-GCM wrapper introduced in this block).
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode random bytes as a Base32 string with no padding (TOTP standard). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Decode a Base32 string back into bytes. Permissive about case + padding. */
export function base32Decode(input: string): Uint8Array {
  const clean = input
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]!);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${clean[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * Generate a cryptographically random TOTP secret. 20 bytes → 32 Base32 chars,
 * the length most auth apps expect and RFC 4226 recommends.
 */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function hmacSha1(
  keyBytes: Uint8Array,
  msgBytes: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes as BufferSource);
  return new Uint8Array(sig);
}

/** Dynamic-truncate the HMAC output into a 6-digit number (RFC 4226). */
function hotpCode(hmac: Uint8Array): string {
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Generate the TOTP code for a given secret + unix time (seconds). */
export async function totpCode(
  secretBase32: string,
  timeSec: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const step = Math.floor(timeSec / 30);
  const msg = new Uint8Array(8);
  // Big-endian 8-byte counter.
  new DataView(msg.buffer).setBigUint64(0, BigInt(step), false);
  const hmac = await hmacSha1(base32Decode(secretBase32), msg);
  return hotpCode(hmac);
}

/**
 * Verify a 6-digit code against a secret with ±1 step tolerance.
 * Constant-time-ish string compare (both sides same length).
 */
export async function verifyTotpCode(
  secretBase32: string,
  code: string,
  timeSec: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const candidates = await Promise.all([
    totpCode(secretBase32, timeSec - 30),
    totpCode(secretBase32, timeSec),
    totpCode(secretBase32, timeSec + 30),
  ]);
  let ok = false;
  for (const c of candidates) {
    // Avoid short-circuit: keep timing close.
    if (constantTimeEqual(c, code)) ok = true;
  }
  return ok;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build an otpauth:// URI suitable for QR codes. Most authenticator apps
 * (Google Authenticator, 1Password, Bitwarden, Authy) accept this format.
 */
export function otpauthUrl(opts: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountName}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Generate N random recovery codes in the format xxxx-xxxx-xxxx (lowercase
 * alphanumeric). Each code is ~70 bits of entropy and single-use.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    for (let j = 0; j < 3; j++) {
      const bytes = crypto.getRandomValues(new Uint8Array(3));
      parts.push(
        Array.from(bytes)
          .map((b) => b.toString(36).padStart(2, "0"))
          .join("")
          .slice(0, 4)
      );
    }
    codes.push(parts.join("-"));
  }
  return codes;
}

/** Hash a recovery code with SHA-256 for storage. */
export async function hashRecoveryCode(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(code.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Server-target crypto primitives (no I/O, no DB).
 *
 * Mirrors `workflow-secrets-crypto.ts` — AES-256-GCM under a 32-byte master
 * key sourced from `SERVER_TARGETS_KEY` (hex). Used for two ciphertext
 * columns:
 *   - `server_targets.encrypted_private_key` (the SSH private key)
 *   - `server_target_env.encrypted_value`    (per-target env var values)
 *
 * Both are addressed through the same primitives because they share the
 * same threat model: an attacker who reads the DB without the master key
 * cannot connect to or impersonate the target.
 *
 * Every fn returns `{ok:true,...}` / `{ok:false,error}` — never throws.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function getMasterKey(): Buffer | null {
  const hex = process.env.SERVER_TARGETS_KEY;
  if (!hex) return null;
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(trimmed, "hex");
  } catch {
    return null;
  }
  if (buf.length !== KEY_LEN) return null;
  return buf;
}

export function encryptValue(
  plaintext: string
): { ok: true; ciphertext: string } | { ok: false; error: string } {
  const key = getMasterKey();
  if (!key) {
    return {
      ok: false,
      error:
        "SERVER_TARGETS_KEY missing or not a 32-byte hex value (64 hex chars)",
    };
  }
  if (typeof plaintext !== "string") {
    return { ok: false, error: "plaintext must be a string" };
  }
  try {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    if (tag.length !== TAG_LEN) {
      return { ok: false, error: "unexpected auth tag length" };
    }
    const blob = Buffer.concat([iv, tag, enc]);
    return { ok: true, ciphertext: blob.toString("base64") };
  } catch (err) {
    return {
      ok: false,
      error: `encrypt failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function decryptValue(
  ciphertext: string
): { ok: true; plaintext: string } | { ok: false; error: string } {
  const key = getMasterKey();
  if (!key) {
    return {
      ok: false,
      error:
        "SERVER_TARGETS_KEY missing or not a 32-byte hex value (64 hex chars)",
    };
  }
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    return { ok: false, error: "ciphertext must be a non-empty string" };
  }
  let blob: Buffer;
  try {
    blob = Buffer.from(ciphertext, "base64");
  } catch {
    return { ok: false, error: "ciphertext is not valid base64" };
  }
  if (blob.length < IV_LEN + TAG_LEN) {
    return { ok: false, error: "ciphertext blob too short" };
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return { ok: true, plaintext: dec.toString("utf8") };
  } catch (err) {
    return {
      ok: false,
      error: `decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Validate an env var name. Same rule as POSIX-ish env: leading
 * letter/underscore, then letters/digits/underscores. We're a little
 * stricter than POSIX in that we require uppercase + digits + underscore
 * so KEY=value lines in the materialised .env file are predictable.
 */
export function isValidEnvName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Z_][A-Z0-9_]*$/.test(name);
}

/**
 * Render an env-vars map as a `.env` file body — `KEY=value\n` lines with
 * values single-quoted and embedded single quotes escaped. This matches the
 * common `set -a; source /path/to/file; set +a` deploy-script pattern and
 * is what `materializeEnv` produces before scp'ing it to the box.
 */
export function renderDotenv(env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  return (
    keys
      .map((k) => {
        const v = env[k] ?? "";
        const quoted = "'" + v.replace(/'/g, "'\\''") + "'";
        return `${k}=${quoted}`;
      })
      .join("\n") + (keys.length ? "\n" : "")
  );
}

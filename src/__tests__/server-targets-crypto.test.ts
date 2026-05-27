/**
 * Pure-function tests for src/lib/server-targets-crypto.ts.
 *
 * Mirror of the workflow-secrets-crypto suite: round-trip, IV randomness,
 * tamper detection, env-name validation, dotenv rendering.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  encryptValue,
  decryptValue,
  getMasterKey,
  isValidEnvName,
  renderDotenv,
} from "../lib/server-targets-crypto";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const original = process.env.SERVER_TARGETS_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.SERVER_TARGETS_KEY;
  else process.env.SERVER_TARGETS_KEY = original;
});

describe("getMasterKey", () => {
  it("returns null when env is unset", () => {
    delete process.env.SERVER_TARGETS_KEY;
    expect(getMasterKey()).toBeNull();
  });

  it("returns null when env is not 32 bytes", () => {
    process.env.SERVER_TARGETS_KEY = "abcd";
    expect(getMasterKey()).toBeNull();
  });

  it("returns 32-byte buffer when env is valid hex", () => {
    process.env.SERVER_TARGETS_KEY = TEST_KEY;
    const key = getMasterKey();
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it("ignores non-hex input", () => {
    process.env.SERVER_TARGETS_KEY = "zzzz".repeat(16);
    expect(getMasterKey()).toBeNull();
  });
});

describe("encrypt/decrypt round-trip", () => {
  it("recovers the original plaintext", () => {
    process.env.SERVER_TARGETS_KEY = TEST_KEY;
    const enc = encryptValue("hello-server-target");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    const dec = decryptValue(enc.ciphertext);
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.plaintext).toBe("hello-server-target");
  });

  it("uses a fresh IV per encryption so identical plaintexts diverge", () => {
    process.env.SERVER_TARGETS_KEY = TEST_KEY;
    const a = encryptValue("same");
    const b = encryptValue("same");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects encrypt when key missing", () => {
    delete process.env.SERVER_TARGETS_KEY;
    const enc = encryptValue("anything");
    expect(enc.ok).toBe(false);
  });

  it("detects tampered ciphertext via GCM auth tag", () => {
    process.env.SERVER_TARGETS_KEY = TEST_KEY;
    const enc = encryptValue("payload");
    if (!enc.ok) throw new Error("setup failed");
    // Flip a byte inside the ciphertext portion (after IV+tag) — base64
    // decode → mutate → re-encode.
    const buf = Buffer.from(enc.ciphertext, "base64");
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString("base64");
    const dec = decryptValue(tampered);
    expect(dec.ok).toBe(false);
  });

  it("rejects too-short blob", () => {
    process.env.SERVER_TARGETS_KEY = TEST_KEY;
    const dec = decryptValue(Buffer.from("short").toString("base64"));
    expect(dec.ok).toBe(false);
  });
});

describe("isValidEnvName", () => {
  it("accepts conventional env names", () => {
    expect(isValidEnvName("FOO")).toBe(true);
    expect(isValidEnvName("FOO_BAR")).toBe(true);
    expect(isValidEnvName("_PRIVATE")).toBe(true);
    expect(isValidEnvName("A1_B2")).toBe(true);
  });

  it("rejects lowercase, dashes, leading digits, empty", () => {
    expect(isValidEnvName("foo")).toBe(false);
    expect(isValidEnvName("FOO-BAR")).toBe(false);
    expect(isValidEnvName("1FOO")).toBe(false);
    expect(isValidEnvName("")).toBe(false);
    expect(isValidEnvName(undefined)).toBe(false);
    expect(isValidEnvName(null)).toBe(false);
  });
});

describe("renderDotenv", () => {
  it("renders alphabetised KEY='value' lines", () => {
    const out = renderDotenv({ BAR: "two", FOO: "one" });
    expect(out).toBe("BAR='two'\nFOO='one'\n");
  });

  it("escapes embedded single quotes", () => {
    const out = renderDotenv({ FOO: "a'b" });
    // a'b → 'a'\''b'  — POSIX single-quote escape.
    expect(out).toBe("FOO='a'\\''b'\n");
  });

  it("returns empty string for empty map", () => {
    expect(renderDotenv({})).toBe("");
  });

  it("never leaves a value unquoted", () => {
    const out = renderDotenv({ KEY: "has spaces and $vars" });
    expect(out).toBe("KEY='has spaces and $vars'\n");
  });
});

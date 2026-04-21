/**
 * Unit tests for src/lib/workflow-secrets-crypto.ts (Agent 2, Sprint 1).
 *
 * Pure-function coverage: crypto roundtrip, IV randomisation, tamper
 * detection, and `${{ secrets.X }}` template substitution rules.
 *
 * Env management: each test may mutate WORKFLOW_SECRETS_KEY, so we snapshot
 * the original value once and restore it in afterEach. The module reads
 * `process.env.WORKFLOW_SECRETS_KEY` at call time (see `getMasterKey`), so
 * no module-cache juggling is required.
 */

import { describe, it, expect, afterEach, afterAll } from "bun:test";
import {
  encryptSecret,
  decryptSecret,
  substituteSecrets,
  getMasterKey,
} from "../lib/workflow-secrets-crypto";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const originalKey = process.env.WORKFLOW_SECRETS_KEY;

function restoreKey() {
  if (originalKey === undefined) delete process.env.WORKFLOW_SECRETS_KEY;
  else process.env.WORKFLOW_SECRETS_KEY = originalKey;
}

afterEach(() => {
  restoreKey();
});

afterAll(() => {
  restoreKey();
});

describe("workflow-secrets-crypto — encryptSecret / decryptSecret", () => {
  it("returns ok:false when WORKFLOW_SECRETS_KEY is unset", () => {
    delete process.env.WORKFLOW_SECRETS_KEY;
    expect(getMasterKey()).toBeNull();
    const r = encryptSecret("hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/WORKFLOW_SECRETS_KEY/);
  });

  it("encrypt -> decrypt roundtrip yields the original plaintext", () => {
    process.env.WORKFLOW_SECRETS_KEY = TEST_KEY;
    const enc = encryptSecret("s3cret-value with spaces & symbols !@#$%");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(typeof enc.ciphertext).toBe("string");
    expect(enc.ciphertext.length).toBeGreaterThan(0);

    const dec = decryptSecret(enc.ciphertext);
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.plaintext).toBe("s3cret-value with spaces & symbols !@#$%");
  });

  it("produces different ciphertexts on repeat encryption (IV randomisation)", () => {
    process.env.WORKFLOW_SECRETS_KEY = TEST_KEY;
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Both must still round-trip to the same plaintext.
    const da = decryptSecret(a.ciphertext);
    const db = decryptSecret(b.ciphertext);
    expect(da.ok && db.ok).toBe(true);
    if (da.ok) expect(da.plaintext).toBe("same-input");
    if (db.ok) expect(db.plaintext).toBe("same-input");
  });

  it("decryptSecret rejects a tampered ciphertext with ok:false", () => {
    process.env.WORKFLOW_SECRETS_KEY = TEST_KEY;
    const enc = encryptSecret("tamper-me");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    // Flip the last character (which lives in the ciphertext body) to
    // invalidate the GCM auth tag / ciphertext pair.
    const ct = enc.ciphertext;
    const flipped = ct.slice(0, -2) + (ct.slice(-2) === "AA" ? "BB" : "AA");
    const dec = decryptSecret(flipped);
    expect(dec.ok).toBe(false);
  });

  it("decryptSecret rejects a truncated blob", () => {
    process.env.WORKFLOW_SECRETS_KEY = TEST_KEY;
    const enc = encryptSecret("xyz");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    // Cut it down to only the first few base64 bytes — well below IV+tag.
    const truncated = enc.ciphertext.slice(0, 4);
    const dec = decryptSecret(truncated);
    expect(dec.ok).toBe(false);
  });
});

describe("workflow-secrets-crypto — substituteSecrets", () => {
  it("replaces a simple ${{ secrets.FOO }} token with the value", () => {
    const out = substituteSecrets("curl -H auth:${{ secrets.TOKEN }}", {
      TOKEN: "abc",
    });
    expect(out).toBe("curl -H auth:abc");
  });

  it("tolerates flexible whitespace inside the token", () => {
    const out1 = substituteSecrets("${{secrets.FOO}}", { FOO: "1" });
    const out2 = substituteSecrets("${{  secrets.FOO  }}", { FOO: "1" });
    const out3 = substituteSecrets("${{\tsecrets.FOO\t}}", { FOO: "1" });
    expect(out1).toBe("1");
    expect(out2).toBe("1");
    expect(out3).toBe("1");
  });

  it("leaves unknown secret names untouched", () => {
    const out = substituteSecrets(
      "have=${{ secrets.KNOWN }} miss=${{ secrets.UNKNOWN }}",
      { KNOWN: "yes" },
    );
    expect(out).toBe("have=yes miss=${{ secrets.UNKNOWN }}");
  });

  it("honours $${{ secrets.X }} as a literal escape", () => {
    const out = substituteSecrets("$${{ secrets.FOO }}", { FOO: "value" });
    expect(out).toBe("${{ secrets.FOO }}");
    // And mixing: one literal + one substituted.
    const mixed = substituteSecrets(
      "lit=$${{ secrets.A }} sub=${{ secrets.A }}",
      { A: "X" },
    );
    expect(mixed).toBe("lit=${{ secrets.A }} sub=X");
  });
});

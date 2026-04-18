/**
 * Block J3 — Signature parsing + verification unit tests.
 *
 * Route tests only assert auth behavior; the full verify path needs a DB and
 * a real repo, which integration covers.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  analyzeRawCommit,
  extractSignatureFromCommit,
  fingerprintForPublicKey,
  parsePgpIssuerFingerprint,
  parseSshSigPublicKey,
  unarmorPgp,
  unarmorSsh,
  verifyRawCommit,
  __internal,
} from "../lib/signatures";

const SAMPLE_GPG_COMMIT = [
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "author Alice Example <alice@example.com> 1700000000 +0000",
  "committer Alice Example <alice@example.com> 1700000000 +0000",
  "gpgsig -----BEGIN PGP SIGNATURE-----",
  " ",
  " iQIzBAABCAAdFiEEABCDEFABCDEFABCDEFABCDEFABCDEFABFAmXXXXXXACgkQ",
  " ABCDEFABCDEF1234567890",
  " =ABCD",
  " -----END PGP SIGNATURE-----",
  "",
  "chore: signed commit",
  "",
].join("\n");

const SAMPLE_SSH_COMMIT = [
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "author Bob Example <bob@example.com> 1700000000 +0000",
  "committer Bob Example <bob@example.com> 1700000000 +0000",
  "gpgsig -----BEGIN SSH SIGNATURE-----",
  " U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgC",
  " -----END SSH SIGNATURE-----",
  "",
  "chore: ssh signed",
].join("\n");

const UNSIGNED_COMMIT = [
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "author Nobody <nobody@example.com> 1700000000 +0000",
  "committer Nobody <nobody@example.com> 1700000000 +0000",
  "",
  "plain commit",
].join("\n");

describe("signatures — extractSignatureFromCommit", () => {
  it("returns null for unsigned commits", () => {
    expect(extractSignatureFromCommit(UNSIGNED_COMMIT)).toBeNull();
  });

  it("detects a PGP signature + author email", () => {
    const sig = extractSignatureFromCommit(SAMPLE_GPG_COMMIT);
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe("gpg");
    expect(sig!.authorEmail).toBe("alice@example.com");
    expect(sig!.signature).toContain("BEGIN PGP SIGNATURE");
  });

  it("detects an SSH signature", () => {
    const sig = extractSignatureFromCommit(SAMPLE_SSH_COMMIT);
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe("ssh");
    expect(sig!.authorEmail).toBe("bob@example.com");
  });

  it("preserves continuation-line body", () => {
    const sig = extractSignatureFromCommit(SAMPLE_GPG_COMMIT);
    expect(sig!.signature.split("\n").length).toBeGreaterThan(2);
  });

  it("handles gpgsig-sha256 variant", () => {
    const raw = SAMPLE_GPG_COMMIT.replace("gpgsig ", "gpgsig-sha256 ");
    const sig = extractSignatureFromCommit(raw);
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe("gpg");
  });

  it("empty input is null", () => {
    expect(extractSignatureFromCommit("")).toBeNull();
  });
});

describe("signatures — unarmorPgp", () => {
  it("decodes a minimal armored block", () => {
    const armored = [
      "-----BEGIN PGP SIGNATURE-----",
      "",
      "AAECAwQFBgcICQ==",
      "=CRC1",
      "-----END PGP SIGNATURE-----",
    ].join("\n");
    const bytes = unarmorPgp(armored);
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("skips armor headers until blank line", () => {
    const armored = [
      "-----BEGIN PGP SIGNATURE-----",
      "Version: GnuPG v2",
      "Comment: https://example.com",
      "",
      "AAECAwQFBgcICQ==",
      "-----END PGP SIGNATURE-----",
    ].join("\n");
    const bytes = unarmorPgp(armored);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(10);
  });

  it("returns null when there's no body", () => {
    expect(
      unarmorPgp("-----BEGIN PGP SIGNATURE-----\n-----END PGP SIGNATURE-----")
    ).toBeNull();
  });
});

describe("signatures — unarmorSsh", () => {
  it("decodes SSH armored bytes", () => {
    const armored = [
      "-----BEGIN SSH SIGNATURE-----",
      "U1NIU0lH",
      "-----END SSH SIGNATURE-----",
    ].join("\n");
    const bytes = unarmorSsh(armored);
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!).slice(0, 6)).toEqual([
      0x53, 0x53, 0x48, 0x53, 0x49, 0x47,
    ]);
  });

  it("returns null on garbage", () => {
    expect(unarmorSsh("")).toBeNull();
  });
});

describe("signatures — parsePgpIssuerFingerprint", () => {
  it("walks an old-format sig packet with subpacket 33", () => {
    // Build a minimal old-format v4 sig packet:
    //   tagByte = 0x88 (old format, tag=2, lenType=0)
    //   len byte
    //   version=4, sigType=0, pubAlgo=1, hashAlgo=8
    //   hashedLen u16 = 23
    //     subpacket: len=22, type=33, version=4, fp (20 bytes 0xAB)
    //   unhashedLen u16 = 0
    const fp = new Uint8Array(20).fill(0xab);
    const hashed: number[] = [];
    hashed.push(22); // subpacket length (1+type+20)
    hashed.push(33); // subpacket type
    hashed.push(4); // fp version
    for (const b of fp) hashed.push(b);
    const body: number[] = [];
    body.push(4, 0, 1, 8);
    body.push((hashed.length >> 8) & 0xff, hashed.length & 0xff);
    for (const b of hashed) body.push(b);
    body.push(0, 0); // empty unhashed
    const bytes = new Uint8Array([0x88, body.length, ...body]);
    const result = parsePgpIssuerFingerprint(bytes);
    expect(result).toBe("ab".repeat(20));
  });

  it("falls back to subpacket 16 (Issuer Key ID)", () => {
    const keyId = new Uint8Array(8).fill(0xcd);
    const hashed: number[] = [];
    hashed.push(9); // len
    hashed.push(16); // type
    for (const b of keyId) hashed.push(b);
    const body: number[] = [];
    body.push(4, 0, 1, 8);
    body.push(0, 0); // empty hashed
    body.push((hashed.length >> 8) & 0xff, hashed.length & 0xff);
    for (const b of hashed) body.push(b);
    const bytes = new Uint8Array([0x88, body.length, ...body]);
    const result = parsePgpIssuerFingerprint(bytes);
    expect(result).toBe("cd".repeat(8));
  });

  it("returns null for non-signature packet streams", () => {
    expect(parsePgpIssuerFingerprint(new Uint8Array(0))).toBeNull();
    expect(parsePgpIssuerFingerprint(new Uint8Array([0, 0, 0]))).toBeNull();
  });
});

describe("signatures — fingerprintForPublicKey", () => {
  it("SHA256-fingerprints an SSH ed25519 pubkey token", async () => {
    // Synthesize an SSH wire-format pubkey: lengths in network order.
    const type = "ssh-ed25519";
    const data = new Uint8Array(32).fill(0xa0);
    const header = new Uint8Array(4 + type.length);
    new DataView(header.buffer).setUint32(0, type.length);
    for (let i = 0; i < type.length; i++) header[4 + i] = type.charCodeAt(i);
    const keyHeader = new Uint8Array(4);
    new DataView(keyHeader.buffer).setUint32(0, data.length);
    const wire = new Uint8Array(header.length + keyHeader.length + data.length);
    wire.set(header, 0);
    wire.set(keyHeader, header.length);
    wire.set(data, header.length + keyHeader.length);
    const b64 = btoa(String.fromCharCode(...wire));
    const authLine = `ssh-ed25519 ${b64} user@host`;
    const fp = await fingerprintForPublicKey("ssh", authLine);
    expect(fp).not.toBeNull();
    expect(fp!.startsWith("SHA256:")).toBe(true);
    expect(fp!.length).toBeGreaterThan(20);
  });

  it("GPG extracts first long fingerprint from armored blob", async () => {
    const pem = [
      "-----BEGIN PGP PUBLIC KEY BLOCK-----",
      "",
      "fingerprint: 1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B",
      "-----END PGP PUBLIC KEY BLOCK-----",
    ].join("\n");
    const fp = await fingerprintForPublicKey("gpg", pem);
    expect(fp).toBe("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b");
  });

  it("returns null when no fingerprint can be derived", async () => {
    expect(await fingerprintForPublicKey("ssh", "")).toBeNull();
    expect(await fingerprintForPublicKey("gpg", "no fingerprint here")).toBeNull();
  });
});

describe("signatures — parseSshSigPublicKey", () => {
  it("extracts the wire-format pubkey from an SSHSIG blob", () => {
    // Magic + u32 version=1 + string pubkey
    const pubkey = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = new Uint8Array(6 + 4 + 4 + pubkey.length);
    blob.set([0x53, 0x53, 0x48, 0x53, 0x49, 0x47], 0);
    const dv = new DataView(blob.buffer);
    dv.setUint32(6, 1); // version
    dv.setUint32(10, pubkey.length); // pubkey length
    blob.set(pubkey, 14);
    const out = parseSshSigPublicKey(blob);
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns null without SSHSIG magic", () => {
    expect(parseSshSigPublicKey(new Uint8Array(0))).toBeNull();
    expect(parseSshSigPublicKey(new Uint8Array(10))).toBeNull();
  });
});

describe("signatures — analyzeRawCommit", () => {
  it("returns nulls for unsigned commit", () => {
    const r = analyzeRawCommit(UNSIGNED_COMMIT);
    expect(r.type).toBeNull();
    expect(r.fingerprint).toBeNull();
    expect(r.authorEmail).toBeNull();
  });

  it("tags type=gpg + author email for a PGP-signed commit", () => {
    const r = analyzeRawCommit(SAMPLE_GPG_COMMIT);
    expect(r.type).toBe("gpg");
    expect(r.authorEmail).toBe("alice@example.com");
  });
});

describe("signatures — verifyRawCommit (DB-free fast paths)", () => {
  it("unsigned → unsigned", async () => {
    const r = await verifyRawCommit(UNSIGNED_COMMIT);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("unsigned");
  });

  it("null commit → unsigned", async () => {
    const r = await verifyRawCommit(null);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("unsigned");
  });

  it("sig present but armor is empty → bad_sig", async () => {
    const emptySig = [
      "tree abc",
      "author X <x@example.com> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " -----END PGP SIGNATURE-----",
      "",
      "msg",
    ].join("\n");
    const r = await verifyRawCommit(emptySig);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("bad_sig");
    expect(r.signatureType).toBe("gpg");
  });
});

describe("signatures — __internal b64decode", () => {
  it("round-trips", () => {
    const s = "hello, world";
    const enc = btoa(s);
    const bytes = __internal.b64decode(enc);
    const decoded = String.fromCharCode(...bytes);
    expect(decoded).toBe(s);
  });

  it("tolerates whitespace in armor", () => {
    const bytes = __internal.b64decode("  a\nGVsbG8=  ");
    expect(String.fromCharCode(...bytes)).toBe("hello");
  });
});

describe("signatures — route auth", () => {
  it("GET /settings/signing-keys requires auth", async () => {
    const res = await app.request("/settings/signing-keys");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /settings/signing-keys requires auth", async () => {
    const res = await app.request("/settings/signing-keys", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /settings/signing-keys/:id/delete requires auth", async () => {
    const res = await app.request(
      "/settings/signing-keys/00000000-0000-0000-0000-000000000000/delete",
      { method: "POST" }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

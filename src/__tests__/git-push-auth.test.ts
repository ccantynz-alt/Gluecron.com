/**
 * Tests for src/lib/git-push-auth.ts.
 *
 * The DB-touching resolveByPat / resolveByOauth paths require a live DB,
 * which we don't set up in unit tests. Instead we cover the pure header
 * decoders (`decodeBasicAuth`, `decodeBearerAuth`) exhaustively and assert
 * that `resolvePusher` returns null for every shape that should fall back
 * to anonymous (no header, garbage header, unknown prefix, empty secret).
 */

import { describe, it, expect } from "bun:test";
import {
  decodeBasicAuth,
  decodeBearerAuth,
  resolvePusher,
} from "../lib/git-push-auth";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

describe("decodeBasicAuth", () => {
  it("decodes a normal user:secret pair", () => {
    const out = decodeBasicAuth(`Basic ${b64("alice:glc_abc123")}`);
    expect(out).toEqual({ user: "alice", secret: "glc_abc123" });
  });

  it("is case-insensitive on the scheme keyword", () => {
    const out = decodeBasicAuth(`basic ${b64("alice:glc_abc")}`);
    expect(out?.user).toBe("alice");
    expect(out?.secret).toBe("glc_abc");
  });

  it("tolerates extra whitespace", () => {
    const out = decodeBasicAuth(`   Basic   ${b64("alice:glc_x")}  `);
    expect(out).not.toBeNull();
    expect(out?.user).toBe("alice");
  });

  it("returns null for empty / missing header", () => {
    expect(decodeBasicAuth(null)).toBeNull();
    expect(decodeBasicAuth(undefined)).toBeNull();
    expect(decodeBasicAuth("")).toBeNull();
  });

  it("returns null when the scheme isn't Basic", () => {
    expect(decodeBasicAuth(`Bearer ${b64("a:b")}`)).toBeNull();
    expect(decodeBasicAuth("Token foobar")).toBeNull();
  });

  it("returns null when the credential lacks a colon separator", () => {
    expect(decodeBasicAuth(`Basic ${b64("nocolonhere")}`)).toBeNull();
  });

  it("preserves a colon inside the secret", () => {
    // Tokens never have colons in practice, but if one did the split must
    // pick the first colon only.
    const out = decodeBasicAuth(`Basic ${b64("user:has:colon")}`);
    expect(out).toEqual({ user: "user", secret: "has:colon" });
  });

  it("allows an empty username", () => {
    // git CLI sometimes sends an empty username + the PAT in the password.
    const out = decodeBasicAuth(`Basic ${b64(":glc_abc")}`);
    expect(out).toEqual({ user: "", secret: "glc_abc" });
  });
});

describe("decodeBearerAuth", () => {
  it("strips the Bearer prefix", () => {
    expect(decodeBearerAuth("Bearer glct_abc")).toBe("glct_abc");
    expect(decodeBearerAuth("bearer glc_xyz")).toBe("glc_xyz");
  });

  it("returns null for non-Bearer schemes", () => {
    expect(decodeBearerAuth("Basic abc")).toBeNull();
    expect(decodeBearerAuth("Token glc_xyz")).toBeNull();
  });

  it("returns null on empty / missing header", () => {
    expect(decodeBearerAuth(null)).toBeNull();
    expect(decodeBearerAuth(undefined)).toBeNull();
    expect(decodeBearerAuth("")).toBeNull();
    expect(decodeBearerAuth("Bearer ")).toBeNull();
  });
});

describe("resolvePusher — anonymous fallbacks", () => {
  it("returns null when there is no auth header", async () => {
    expect(await resolvePusher(null)).toBeNull();
    expect(await resolvePusher(undefined)).toBeNull();
    expect(await resolvePusher("")).toBeNull();
  });

  it("returns null on an unrecognised scheme", async () => {
    expect(await resolvePusher("Unknown abc")).toBeNull();
  });

  it("returns null on a Bearer with an unknown prefix", async () => {
    expect(await resolvePusher("Bearer notatoken")).toBeNull();
  });

  it("returns null on a Basic with an unknown-prefix secret", async () => {
    expect(await resolvePusher(`Basic ${b64("alice:notatoken")}`)).toBeNull();
  });

  it("returns null on a Basic with an empty secret", async () => {
    expect(await resolvePusher(`Basic ${b64("alice:")}`)).toBeNull();
  });

  it("returns null for a ghi_ install token that doesn't exist in DB", async () => {
    // Real install tokens are sha256-hashed in app_install_tokens; an
    // unknown token should fail soft to anonymous, never throw.
    expect(await resolvePusher("Bearer ghi_definitely-not-real")).toBeNull();
    expect(
      await resolvePusher(`Basic ${b64("x-access-token:ghi_definitely-not-real")}`)
    ).toBeNull();
  });
});

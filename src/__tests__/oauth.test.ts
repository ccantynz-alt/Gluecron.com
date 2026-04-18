/**
 * Tests for the OAuth 2.0 provider (Block B6).
 *
 * Covers:
 *   - pure helper functions in src/lib/oauth.ts
 *   - unauthed redirect behaviour for authed OAuth + developer-apps routes
 *   - /oauth/token and /oauth/revoke endpoint surface behaviour
 *
 * These tests intentionally avoid the DB wherever possible so they run fast
 * and don't depend on a live Postgres. Routes that touch the DB accept either
 * the expected auth/validation error or 503 (DB unreachable) since the CI
 * runner may not have a Neon connection.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  generateClientId,
  generateClientSecret,
  generateAuthCode,
  generateAccessToken,
  generateRefreshToken,
  sha256Hex,
  b64urlFromBytes,
  verifyPkce,
  timingSafeEqual,
  parseScopes,
  serializeScopes,
  parseRedirectUris,
  isValidRedirectUri,
  redirectUriAllowed,
  SUPPORTED_SCOPES,
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
} from "../lib/oauth";

describe("oauth helpers (B6)", () => {
  it("generateClientId returns unique values prefixed with 'glc_app_'", () => {
    const a = generateClientId();
    const b = generateClientId();
    expect(a.startsWith("glc_app_")).toBe(true);
    expect(b.startsWith("glc_app_")).toBe(true);
    expect(a).not.toBe(b);
    // The suffix is randomHex(12) → 24 hex chars; prefix is 8 chars → total 32.
    expect(a.length).toBe("glc_app_".length + 24);
  });

  it("generateClientSecret returns unique values prefixed with 'glcs_'", () => {
    const a = generateClientSecret();
    const b = generateClientSecret();
    expect(a.startsWith("glcs_")).toBe(true);
    expect(b.startsWith("glcs_")).toBe(true);
    expect(a).not.toBe(b);
    // The suffix is randomHex(32) → 64 hex chars; prefix is 5 chars → total 69.
    expect(a.length).toBe("glcs_".length + 64);
  });

  it("generateAuthCode returns unique values prefixed with 'glca_'", () => {
    const a = generateAuthCode();
    const b = generateAuthCode();
    expect(a.startsWith("glca_")).toBe(true);
    expect(b.startsWith("glca_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("generateAccessToken and generateRefreshToken produce distinct prefixes", () => {
    const at = generateAccessToken();
    const rt = generateRefreshToken();
    expect(at.startsWith("glct_")).toBe(true);
    expect(rt.startsWith("glcr_")).toBe(true);
    expect(at).not.toBe(rt);
  });

  it("sha256Hex('hello') returns the known SHA-256 hex of 'hello'", async () => {
    const h = await sha256Hex("hello");
    expect(h).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("timingSafeEqual handles equal, different, and mismatched lengths", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("parseScopes strips unknown scopes, deduplicates, handles separators + empty", () => {
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("read:user read:user write:repo")).toEqual([
      "read:user",
      "write:repo",
    ]);
    expect(parseScopes("read:user,write:repo")).toEqual([
      "read:user",
      "write:repo",
    ]);
    expect(parseScopes("nonsense,read:user")).toEqual(["read:user"]);
    expect(parseScopes("   ")).toEqual([]);
  });

  it("serializeScopes round-trips through parseScopes", () => {
    const s = serializeScopes(["read:user", "write:repo"]);
    expect(s).toBe("read:user write:repo");
    expect(parseScopes(s)).toEqual(["read:user", "write:repo"]);
  });

  it("parseRedirectUris splits on newlines, trims, drops empty lines", () => {
    const parsed = parseRedirectUris(
      "https://a.com/cb\n  https://b.com/cb  \n\n\nhttps://c.com/cb\n"
    );
    expect(parsed).toEqual([
      "https://a.com/cb",
      "https://b.com/cb",
      "https://c.com/cb",
    ]);
    expect(parseRedirectUris("")).toEqual([]);
    expect(parseRedirectUris("   \n  \n")).toEqual([]);
  });

  it("isValidRedirectUri accepts valid https and localhost-http URIs", () => {
    expect(isValidRedirectUri("https://example.com/callback")).toBe(true);
    expect(isValidRedirectUri("http://localhost:3000/cb")).toBe(true);
    expect(isValidRedirectUri("http://127.0.0.1/cb")).toBe(true);
  });

  it("isValidRedirectUri rejects invalid URIs", () => {
    expect(isValidRedirectUri("http://example.com/cb")).toBe(false);
    expect(isValidRedirectUri("ftp://example.com/cb")).toBe(false);
    expect(isValidRedirectUri("https://example.com/cb#frag")).toBe(false);
    expect(isValidRedirectUri("https://*.example.com/cb")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
  });

  it("redirectUriAllowed requires exact match against the registered list", () => {
    expect(
      redirectUriAllowed("https://a.com/cb", [
        "https://a.com/cb",
        "https://b.com/cb",
      ])
    ).toBe(true);
    // Trailing slash matters — exact match only.
    expect(redirectUriAllowed("https://a.com/cb/", ["https://a.com/cb"])).toBe(
      false
    );
    expect(redirectUriAllowed("", ["https://a.com/cb"])).toBe(false);
    expect(redirectUriAllowed("https://a.com/cb", [])).toBe(false);
  });

  it("verifyPkce S256 accepts the RFC 7636 §B example", async () => {
    const ok = await verifyPkce({
      method: "S256",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });
    expect(ok).toBe(true);
  });

  it("verifyPkce S256 rejects a mismatched verifier", async () => {
    const ok = await verifyPkce({
      method: "S256",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      verifier: "not-the-right-verifier",
    });
    expect(ok).toBe(false);
  });

  it("verifyPkce plain matches only when verifier === challenge", async () => {
    expect(
      await verifyPkce({ method: "plain", challenge: "abc", verifier: "abc" })
    ).toBe(true);
    expect(
      await verifyPkce({ method: "plain", challenge: "abc", verifier: "abd" })
    ).toBe(false);
  });

  it("verifyPkce returns false when challenge is missing", async () => {
    expect(
      await verifyPkce({ method: "S256", challenge: "", verifier: "x" })
    ).toBe(false);
    expect(
      await verifyPkce({ method: "S256", challenge: null, verifier: "x" })
    ).toBe(false);
    expect(
      await verifyPkce({ method: "plain", challenge: undefined, verifier: "x" })
    ).toBe(false);
  });

  it("b64urlFromBytes produces URL-safe unpadded base64", () => {
    // RFC 4648 test vector: "fooba" → "Zm9vYmE"
    const bytes = new TextEncoder().encode("fooba");
    const out = b64urlFromBytes(bytes);
    expect(out).toBe("Zm9vYmE");
    expect(out).not.toContain("=");
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
  });

  it("SUPPORTED_SCOPES includes at least the core three", () => {
    expect(SUPPORTED_SCOPES).toContain("read:user");
    expect(SUPPORTED_SCOPES).toContain("read:repo");
    expect(SUPPORTED_SCOPES).toContain("write:repo");
  });

  it("TTL constants have sensible magnitudes", () => {
    expect(ACCESS_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
    expect(REFRESH_TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(AUTH_CODE_TTL_MS).toBe(10 * 60 * 1000);
    expect(ACCESS_TOKEN_TTL_MS).toBeLessThan(REFRESH_TOKEN_TTL_MS);
    expect(AUTH_CODE_TTL_MS).toBeLessThan(ACCESS_TOKEN_TTL_MS);
  });
});

describe("oauth routes (B6) — unauthed redirects", () => {
  it("GET /oauth/authorize without session redirects to /login", async () => {
    const res = await app.request("/oauth/authorize");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /oauth/authorize/decision without session redirects to /login", async () => {
    const res = await app.request("/oauth/authorize/decision", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve",
    });
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("GET /settings/authorizations without session redirects to /login", async () => {
    const res = await app.request("/settings/authorizations");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /settings/authorizations/:id/revoke without session redirects to /login", async () => {
    const res = await app.request("/settings/authorizations/some-id/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("GET /settings/applications without session redirects to /login", async () => {
    const res = await app.request("/settings/applications");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /settings/applications/new without session redirects to /login", async () => {
    const res = await app.request("/settings/applications/new", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Test",
    });
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

describe("oauth /token endpoint (B6)", () => {
  it("returns 401 invalid_client when client_id is missing", async () => {
    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });

  it("returns 401 or 503 when client_id is unknown", async () => {
    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:
        "grant_type=authorization_code&client_id=glc_app_nonexistent000000000000",
    });
    // 401 if DB confirms unknown client, 503 if DB unreachable.
    expect([401, 503]).toContain(res.status);
    if (res.status === 401) {
      const body = await res.json();
      expect(body.error).toBe("invalid_client");
    }
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{this is not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("returns 401 or 503 for a bogus client_id + unsupported grant_type", async () => {
    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:
        "grant_type=password&client_id=glc_app_000000000000000000000000",
    });
    // Client lookup runs before grant_type validation. Either the DB says
    // unknown client (401) or the DB is unreachable (503).
    expect([401, 503]).toContain(res.status);
  });
});

describe("oauth /revoke endpoint (B6)", () => {
  it("returns 401 when no client credentials are supplied", async () => {
    const res = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=glct_something",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });
});

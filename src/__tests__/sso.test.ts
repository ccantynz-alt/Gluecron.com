/**
 * Block I10 — Enterprise SSO (OIDC) tests.
 *
 * Covers pure helpers (URL building, domain gating, username normalization)
 * and route authorization smokes. The full OIDC dance against a real IdP is
 * exercised by live integration — we don't mock fetch here.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  buildAuthorizeUrl,
  emailDomainAllowed,
  randomToken,
  ssoRedirectUri,
  __internal,
} from "../lib/sso";

const { emptyToNull, normalizeUsername } = __internal;

describe("sso — buildAuthorizeUrl", () => {
  const cfg = {
    authorizationEndpoint: "https://idp.example.com/authorize",
    clientId: "abc123",
    scopes: "openid profile email",
  };

  it("includes all OIDC required params", () => {
    const url = buildAuthorizeUrl(
      cfg,
      "state-xyz",
      "nonce-abc",
      "https://app.example.com/login/sso/callback"
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://idp.example.com/authorize");
    expect(u.searchParams.get("client_id")).toBe("abc123");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    expect(u.searchParams.get("state")).toBe("state-xyz");
    expect(u.searchParams.get("nonce")).toBe("nonce-abc");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/login/sso/callback"
    );
  });

  it("preserves existing query params on the endpoint", () => {
    const url = buildAuthorizeUrl(
      {
        authorizationEndpoint: "https://idp.example.com/authorize?ext=1",
        clientId: "abc",
        scopes: "openid",
      },
      "s",
      "n",
      "https://app/cb"
    );
    const u = new URL(url);
    expect(u.searchParams.get("ext")).toBe("1");
    expect(u.searchParams.get("client_id")).toBe("abc");
  });

  it("throws when endpoint or client_id is missing", () => {
    expect(() =>
      buildAuthorizeUrl(
        { authorizationEndpoint: null, clientId: "x", scopes: "openid" } as any,
        "s",
        "n",
        "https://app/cb"
      )
    ).toThrow();
    expect(() =>
      buildAuthorizeUrl(
        {
          authorizationEndpoint: "https://i/a",
          clientId: null,
          scopes: "openid",
        } as any,
        "s",
        "n",
        "https://app/cb"
      )
    ).toThrow();
  });

  it("falls back to default scopes when empty", () => {
    const url = buildAuthorizeUrl(
      {
        authorizationEndpoint: "https://idp/a",
        clientId: "c",
        scopes: "" as any,
      },
      "s",
      "n",
      "https://app/cb"
    );
    expect(new URL(url).searchParams.get("scope")).toBe(
      "openid profile email"
    );
  });
});

describe("sso — emailDomainAllowed", () => {
  it("allows any when domains list is null", () => {
    expect(emailDomainAllowed("a@example.com", null)).toBe(true);
  });

  it("allows any when list is empty", () => {
    expect(emailDomainAllowed("a@example.com", "")).toBe(true);
    expect(emailDomainAllowed("a@example.com", "   ")).toBe(true);
  });

  it("accepts matching domain (case-insensitive)", () => {
    expect(emailDomainAllowed("a@EXAMPLE.COM", "example.com")).toBe(true);
    expect(emailDomainAllowed("a@example.com", "acme.io, example.com")).toBe(
      true
    );
  });

  it("rejects unmatched domain", () => {
    expect(emailDomainAllowed("a@evil.com", "example.com")).toBe(false);
  });

  it("rejects missing email when list is set", () => {
    expect(emailDomainAllowed(null, "example.com")).toBe(false);
    expect(emailDomainAllowed("", "example.com")).toBe(false);
  });

  it("rejects malformed email", () => {
    expect(emailDomainAllowed("not-an-email", "example.com")).toBe(false);
  });
});

describe("sso — normalizeUsername", () => {
  it("lowercases and slugifies", () => {
    expect(normalizeUsername("Alice Smith")).toBe("alice-smith");
    expect(normalizeUsername("BOB@acme.IO")).toBe("bob-acme-io");
  });

  it("strips leading/trailing dashes", () => {
    expect(normalizeUsername("---foo---")).toBe("foo");
  });

  it("falls back to 'user' for empty input", () => {
    expect(normalizeUsername("")).toBe("user");
    expect(normalizeUsername("@@@")).toBe("user");
  });

  it("caps at 32 chars", () => {
    const out = normalizeUsername("a".repeat(80));
    expect(out.length).toBeLessThanOrEqual(32);
  });
});

describe("sso — emptyToNull", () => {
  it("returns null for empty or whitespace-only", () => {
    expect(emptyToNull("")).toBeNull();
    expect(emptyToNull("   ")).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
  });

  it("trims and returns non-empty strings", () => {
    expect(emptyToNull("  hello  ")).toBe("hello");
    expect(emptyToNull("x")).toBe("x");
  });
});

describe("sso — randomToken", () => {
  it("returns hex of expected length", () => {
    expect(randomToken(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns distinct values across calls", () => {
    expect(randomToken(16)).not.toBe(randomToken(16));
  });
});

describe("sso — ssoRedirectUri", () => {
  it("ends with /login/sso/callback", () => {
    expect(ssoRedirectUri().endsWith("/login/sso/callback")).toBe(true);
  });
});

describe("sso — route auth", () => {
  it("GET /admin/sso without auth → 302 /login", async () => {
    const res = await app.request("/admin/sso");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /admin/sso without auth → 302 /login", async () => {
    const res = await app.request("/admin/sso", {
      method: "POST",
      body: new URLSearchParams({ provider_name: "x" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /settings/sso/unlink without auth → 302 /login", async () => {
    const res = await app.request("/settings/sso/unlink", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /login/sso when SSO not configured → 302 /login with error", async () => {
    const res = await app.request("/login/sso");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login");
    // Either "not enabled" or "not fully configured" — either proves the
    // route is mounted and SSO guard fires.
    expect(loc).toContain("error=");
  });

  it("GET /login/sso/callback without state cookie → 302 /login", async () => {
    const res = await app.request(
      "/login/sso/callback?code=abc&state=xyz"
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

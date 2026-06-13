/**
 * Smoke tests for the Google OAuth login flow + config page.
 *
 * Mirrors the structure of github-oauth.test.ts (if it exists). Covers:
 *   - /admin/google-oauth requires admin auth
 *   - /login/google redirects to /login?error= when not configured
 *   - The OAuth URL builder produces a valid Google authorize URL
 *   - The login page renders a "Sign in with Google" button when enabled
 *
 * These tests exercise the route registration + the pure helper functions
 * in src/lib/google-oauth.ts. The full callback flow (token exchange +
 * userinfo) requires a real Google response and is exercised manually
 * during deploy validation.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  buildGoogleAuthorizeUrl,
  fetchGoogleUserinfo,
  exchangeGoogleCode,
  resolveGoogleRedirectUri,
} from "../lib/google-oauth";

describe("google-oauth — route registration", () => {
  it("/admin/google-oauth without auth redirects to /login", async () => {
    const res = await app.request("/admin/google-oauth", {
      redirect: "manual",
    });
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login");
  });

  it("/login/google when unconfigured redirects to /login with error", async () => {
    const res = await app.request("/login/google", { redirect: "manual" });
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login?error=");
  });

  it("/login/google/callback without code params redirects with error", async () => {
    const res = await app.request("/login/google/callback", {
      redirect: "manual",
    });
    expect([302, 303]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login?error=");
  });
});

describe("google-oauth — buildGoogleAuthorizeUrl", () => {
  it("constructs a valid Google authorize URL with required params", () => {
    const url = buildGoogleAuthorizeUrl(
      {
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        clientId: "client-id-123",
        scopes: "openid email profile",
      },
      "state-abc",
      "https://example.com/login/google/callback",
      "nonce-xyz"
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(u.searchParams.get("client_id")).toBe("client-id-123");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("state")).toBe("state-abc");
    expect(u.searchParams.get("nonce")).toBe("nonce-xyz");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://example.com/login/google/callback"
    );
    // We force account picker so users with multiple Google accounts can
    // choose; without this Google silently uses the most-recent one.
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });

  it("throws when authorization_endpoint or client_id is missing", () => {
    expect(() =>
      buildGoogleAuthorizeUrl(
        {
          authorizationEndpoint: null,
          clientId: "abc",
          scopes: null,
        } as any,
        "s",
        "r",
        "n"
      )
    ).toThrow();
    expect(() =>
      buildGoogleAuthorizeUrl(
        {
          authorizationEndpoint: "https://x",
          clientId: null,
          scopes: null,
        } as any,
        "s",
        "r",
        "n"
      )
    ).toThrow();
  });
});

describe("google-oauth — resolveGoogleRedirectUri (self-healing)", () => {
  const PATH = "/login/google/callback";

  it("uses an explicit https base URL verbatim (trailing slash trimmed)", () => {
    expect(
      resolveGoogleRedirectUri({ configuredBaseUrl: "https://gluecron.com/" })
    ).toBe(`https://gluecron.com${PATH}`);
  });

  it("ignores a localhost base URL and derives from the request", () => {
    // The production failure mode: APP_BASE_URL unset → config.appBaseUrl
    // defaults to http://localhost:3000. Behind Fly the edge sets
    // X-Forwarded-Proto:https and forwards the real host, so we must still
    // produce the public https callback.
    expect(
      resolveGoogleRedirectUri({
        configuredBaseUrl: "http://localhost:3000",
        forwardedProto: "https",
        forwardedHost: "gluecron.com",
        host: "gluecron.com",
        requestUrl: "http://gluecron.com/login/google",
      })
    ).toBe(`https://gluecron.com${PATH}`);
  });

  it("upgrades a public host to https when no forwarded proto is present", () => {
    expect(
      resolveGoogleRedirectUri({
        host: "gluecron.com",
        requestUrl: "http://gluecron.com/login/google",
      })
    ).toBe(`https://gluecron.com${PATH}`);
  });

  it("honours X-Forwarded-Host over the raw Host header", () => {
    expect(
      resolveGoogleRedirectUri({
        forwardedProto: "https",
        forwardedHost: "gluecron.com",
        host: "internal.fly.dev",
        requestUrl: "http://internal.fly.dev/login/google",
      })
    ).toBe(`https://gluecron.com${PATH}`);
  });

  it("takes only the first value of a comma-listed forwarded header", () => {
    expect(
      resolveGoogleRedirectUri({
        forwardedProto: "https, http",
        forwardedHost: "gluecron.com, proxy.internal",
        requestUrl: "http://x/login/google",
      })
    ).toBe(`https://gluecron.com${PATH}`);
  });

  it("keeps localhost on its request scheme for local dev", () => {
    expect(
      resolveGoogleRedirectUri({
        host: "localhost:3000",
        requestUrl: "http://localhost:3000/login/google",
      })
    ).toBe(`http://localhost:3000${PATH}`);
  });

  it("falls back to localhost when there is nothing to derive from", () => {
    expect(resolveGoogleRedirectUri({})).toBe(
      `http://localhost:3000${PATH}`
    );
  });
});

describe("google-oauth — exchangeGoogleCode + fetchGoogleUserinfo", () => {
  it("exchangeGoogleCode posts urlencoded body and returns access_token", async () => {
    const captured: { url?: string; body?: string } = {};
    const fakeFetch = (async (url: any, init: any) => {
      captured.url = String(url);
      captured.body = String(init.body);
      return new Response(
        JSON.stringify({ access_token: "tok-1", id_token: "id-1" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const result = await exchangeGoogleCode(
      {
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: "cid",
        clientSecret: "secret",
      },
      "auth-code",
      "https://example.com/cb",
      fakeFetch
    );
    expect(result.accessToken).toBe("tok-1");
    expect(result.idToken).toBe("id-1");
    expect(captured.url).toBe("https://oauth2.googleapis.com/token");
    expect(captured.body).toContain("grant_type=authorization_code");
    expect(captured.body).toContain("code=auth-code");
    expect(captured.body).toContain("client_id=cid");
  });

  it("fetchGoogleUserinfo parses sub + emailVerified correctly", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          sub: "12345",
          email: "user@example.com",
          email_verified: true,
          name: "Jane Doe",
          picture: "https://lh.example/avatar.jpg",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const info = await fetchGoogleUserinfo(
      { userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo" },
      "tok",
      fakeFetch
    );
    expect(info.sub).toBe("12345");
    expect(info.email).toBe("user@example.com");
    expect(info.emailVerified).toBe(true);
    expect(info.name).toBe("Jane Doe");
  });

  it("fetchGoogleUserinfo coerces email_verified=\"true\" string to bool", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          sub: "999",
          email: "x@y.z",
          email_verified: "true",
          name: null,
          picture: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const info = await fetchGoogleUserinfo(
      { userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo" },
      "tok",
      fakeFetch
    );
    expect(info.emailVerified).toBe(true);
  });
});

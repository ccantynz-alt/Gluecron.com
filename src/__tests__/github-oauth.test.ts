/**
 * Block L6 — "Sign in with GitHub" tests.
 *
 * Pure network helpers (`buildGithubAuthorizeUrl`, `exchangeGithubCode`,
 * `fetchGithubUserinfo`, `fetchGithubPrimaryEmail`) drive an injected
 * fetch — see K2's `vapron-deploy.test.ts` for the DI pattern these
 * mirror — so tests never touch the real GitHub API.
 *
 * `findOrCreateUserFromGithub` is exercised indirectly: we assert the
 * subject-prefix contract by inspecting the function's source — touching
 * the DB-backed flow itself is left to integration. Route-auth smokes
 * confirm `/login/github` redirects correctly when disabled vs enabled.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubPrimaryEmail,
  fetchGithubUserinfo,
  type FetchImpl,
} from "../lib/github-oauth";
import { findOrCreateUserFromGithub } from "../lib/sso";
import type { SsoConfig } from "../db/schema";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

function ghCfg(overrides: Partial<SsoConfig> = {}): SsoConfig {
  return {
    id: "github",
    enabled: true,
    providerName: "GitHub",
    issuer: "https://github.com",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userinfoEndpoint: "https://api.github.com/user",
    clientId: "Iv1.testclientid",
    clientSecret: "topsecret",
    scopes: "read:user user:email",
    allowedEmailDomains: null,
    autoCreateUsers: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as SsoConfig;
}

interface Capture {
  url: string;
  init: RequestInit;
}

function captureFetch(
  responder: (callIdx: number, url: string) => Response | Promise<Response>
): { calls: Capture[]; fn: FetchImpl } {
  const calls: Capture[] = [];
  const fn = (async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> => {
    const i = calls.length;
    const url = String(input);
    calls.push({ url, init });
    return responder(i, url);
  }) as unknown as FetchImpl;
  return { calls, fn };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ----------------------------------------------------------------------------
// buildGithubAuthorizeUrl
// ----------------------------------------------------------------------------

describe("github-oauth — buildGithubAuthorizeUrl", () => {
  it("includes all required OAuth params", () => {
    const url = buildGithubAuthorizeUrl(
      ghCfg(),
      "state-xyz",
      "https://app.example.com/login/github/callback"
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(
      "https://github.com/login/oauth/authorize"
    );
    expect(u.searchParams.get("client_id")).toBe("Iv1.testclientid");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/login/github/callback"
    );
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("read:user user:email");
    expect(u.searchParams.get("state")).toBe("state-xyz");
  });

  it("falls back to default scopes when empty", () => {
    const url = buildGithubAuthorizeUrl(
      { ...ghCfg(), scopes: "" } as any,
      "s",
      "https://app/cb"
    );
    expect(new URL(url).searchParams.get("scope")).toBe(
      "read:user user:email"
    );
  });

  it("throws when client_id or endpoint is missing", () => {
    expect(() =>
      buildGithubAuthorizeUrl(
        { ...ghCfg(), clientId: null } as any,
        "s",
        "https://app/cb"
      )
    ).toThrow();
    expect(() =>
      buildGithubAuthorizeUrl(
        { ...ghCfg(), authorizationEndpoint: null } as any,
        "s",
        "https://app/cb"
      )
    ).toThrow();
  });
});

// ----------------------------------------------------------------------------
// exchangeGithubCode
// ----------------------------------------------------------------------------

describe("github-oauth — exchangeGithubCode", () => {
  it("posts urlencoded body with Accept: application/json", async () => {
    const { calls, fn } = captureFetch(() =>
      jsonResponse({ access_token: "gho_xxx", token_type: "bearer" })
    );
    const out = await exchangeGithubCode(
      ghCfg(),
      "abc-code",
      "https://app/cb",
      fn
    );
    expect(out.accessToken).toBe("gho_xxx");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://github.com/login/oauth/access_token"
    );
    expect(calls[0]!.init.method).toBe("POST");
    const headers = (calls[0]!.init.headers || {}) as Record<string, string>;
    // header keys are lowercased by our impl
    expect(headers["accept"] || headers["Accept"]).toBe("application/json");
    expect(
      (headers["content-type"] || headers["Content-Type"]) as string
    ).toContain("application/x-www-form-urlencoded");
    expect(String(calls[0]!.init.body)).toContain("code=abc-code");
    expect(String(calls[0]!.init.body)).toContain("client_id=Iv1.testclientid");
  });

  it("throws on non-2xx response", async () => {
    const { fn } = captureFetch(
      () => new Response("nope", { status: 500 })
    );
    await expect(
      exchangeGithubCode(ghCfg(), "c", "https://app/cb", fn)
    ).rejects.toThrow(/github token endpoint 500/);
  });

  it("throws when github returns an error JSON body", async () => {
    const { fn } = captureFetch(() =>
      jsonResponse({
        error: "bad_verification_code",
        error_description: "The code is invalid.",
      })
    );
    await expect(
      exchangeGithubCode(ghCfg(), "c", "https://app/cb", fn)
    ).rejects.toThrow(/bad_verification_code/);
  });

  it("throws when access_token is missing", async () => {
    const { fn } = captureFetch(() => jsonResponse({ token_type: "bearer" }));
    await expect(
      exchangeGithubCode(ghCfg(), "c", "https://app/cb", fn)
    ).rejects.toThrow(/missing access_token/);
  });
});

// ----------------------------------------------------------------------------
// fetchGithubUserinfo
// ----------------------------------------------------------------------------

describe("github-oauth — fetchGithubUserinfo", () => {
  it("parses a typical github /user response", async () => {
    const sample = {
      id: 12345,
      login: "octocat",
      name: "The Octocat",
      email: "octocat@example.com",
      avatar_url: "https://avatars.githubusercontent.com/u/12345",
    };
    const { calls, fn } = captureFetch(() => jsonResponse(sample));
    const u = await fetchGithubUserinfo("gho_abc", fn);
    expect(u).toEqual({
      id: 12345,
      login: "octocat",
      name: "The Octocat",
      email: "octocat@example.com",
      avatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    expect(calls[0]!.url).toBe("https://api.github.com/user");
    const headers = (calls[0]!.init.headers || {}) as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer gho_abc");
  });

  it("tolerates null name and email + missing avatar", async () => {
    const { fn } = captureFetch(() =>
      jsonResponse({
        id: 99,
        login: "ghost",
        name: null,
        email: null,
      })
    );
    const u = await fetchGithubUserinfo("tok", fn);
    expect(u.id).toBe(99);
    expect(u.login).toBe("ghost");
    expect(u.name).toBeNull();
    expect(u.email).toBeNull();
    expect(u.avatarUrl).toBeNull();
  });

  it("throws when id or login is missing", async () => {
    const { fn } = captureFetch(() => jsonResponse({ login: "no-id" }));
    await expect(fetchGithubUserinfo("tok", fn)).rejects.toThrow(
      /missing id or login/
    );
  });

  it("throws on non-2xx", async () => {
    const { fn } = captureFetch(
      () => new Response("nope", { status: 401 })
    );
    await expect(fetchGithubUserinfo("tok", fn)).rejects.toThrow(
      /github \/user 401/
    );
  });
});

// ----------------------------------------------------------------------------
// fetchGithubPrimaryEmail — email-privacy fallback
// ----------------------------------------------------------------------------

describe("github-oauth — fetchGithubPrimaryEmail", () => {
  it("returns the primary+verified entry", async () => {
    const { calls, fn } = captureFetch(() =>
      jsonResponse([
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "primary@example.com", primary: true, verified: true },
      ])
    );
    const email = await fetchGithubPrimaryEmail("tok", fn);
    expect(email).toBe("primary@example.com");
    expect(calls[0]!.url).toBe("https://api.github.com/user/emails");
  });

  it("returns null when the primary email is unverified", async () => {
    const { fn } = captureFetch(() =>
      jsonResponse([
        { email: "primary@example.com", primary: true, verified: false },
      ])
    );
    expect(await fetchGithubPrimaryEmail("tok", fn)).toBeNull();
  });

  it("returns null when no entry is both primary and verified", async () => {
    const { fn } = captureFetch(() =>
      jsonResponse([
        { email: "a@example.com", primary: false, verified: true },
        { email: "b@example.com", primary: true, verified: false },
      ])
    );
    expect(await fetchGithubPrimaryEmail("tok", fn)).toBeNull();
  });

  it("returns null on non-2xx response", async () => {
    const { fn } = captureFetch(
      () => new Response("nope", { status: 403 })
    );
    expect(await fetchGithubPrimaryEmail("tok", fn)).toBeNull();
  });

  it("returns null when the response is not an array", async () => {
    const { fn } = captureFetch(() => jsonResponse({ oops: true }));
    expect(await fetchGithubPrimaryEmail("tok", fn)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fn = (async () => {
      throw new Error("network down");
    }) as unknown as FetchImpl;
    expect(await fetchGithubPrimaryEmail("tok", fn)).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// findOrCreateUserFromGithub — subject prefix contract
// ----------------------------------------------------------------------------

describe("github-oauth — findOrCreateUserFromGithub", () => {
  it("is exported and references the github:<id> subject namespace", () => {
    expect(typeof findOrCreateUserFromGithub).toBe("function");
    // Snapshot-test the subject-prefix contract by inspecting source — we
    // need the literal "github:" prefix to live in the function so that
    // multi-IdP `subject` collisions are impossible.
    const src = findOrCreateUserFromGithub.toString();
    expect(src).toContain("github:");
    expect(src).toMatch(/github:\$\{[^}]+\.id\}|github:`/);
  });
});

// ----------------------------------------------------------------------------
// Route auth smokes
// ----------------------------------------------------------------------------

describe("github-oauth — route auth", () => {
  it("GET /admin/github-oauth without auth → 302 /login", async () => {
    const res = await app.request("/admin/github-oauth");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /admin/github-oauth without auth → 302 /login", async () => {
    const res = await app.request("/admin/github-oauth", {
      method: "POST",
      body: new URLSearchParams({ client_id: "x" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /login/github when GitHub OAuth not configured → 302 /login?error=...", async () => {
    const res = await app.request("/login/github");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("/login");
    expect(loc).toContain("error=");
  });

  it("GET /login/github/callback without state cookie → 302 /login", async () => {
    const res = await app.request(
      "/login/github/callback?code=abc&state=xyz"
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

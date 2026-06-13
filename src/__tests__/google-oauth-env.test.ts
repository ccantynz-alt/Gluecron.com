import { describe, expect, test } from "bun:test";
import {
  googleOauthConfigFromEnv,
  resolveGoogleOauthConfig,
} from "../lib/sso";
import type { SsoConfig } from "../db/schema";

/** Minimal SsoConfig row builder for precedence tests. */
function row(overrides: Partial<SsoConfig>): SsoConfig {
  const now = new Date();
  return {
    id: "google",
    enabled: false,
    providerName: "Google",
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    clientId: null,
    clientSecret: null,
    scopes: "openid email profile",
    allowedEmailDomains: null,
    autoCreateUsers: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as SsoConfig;
}

const ENV_CFG = googleOauthConfigFromEnv({
  GOOGLE_OAUTH_CLIENT_ID: "env-id.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "env-secret",
});

describe("googleOauthConfigFromEnv", () => {
  test("returns null when credentials are absent", () => {
    expect(googleOauthConfigFromEnv({})).toBeNull();
    expect(
      googleOauthConfigFromEnv({ GOOGLE_OAUTH_CLIENT_ID: "id-only" })
    ).toBeNull();
    expect(
      googleOauthConfigFromEnv({ GOOGLE_OAUTH_CLIENT_SECRET: "secret-only" })
    ).toBeNull();
    expect(
      googleOauthConfigFromEnv({
        GOOGLE_OAUTH_CLIENT_ID: "  ",
        GOOGLE_OAUTH_CLIENT_SECRET: "s",
      })
    ).toBeNull();
  });

  test("builds an enabled config from the env pair", () => {
    const cfg = googleOauthConfigFromEnv({
      GOOGLE_OAUTH_CLIENT_ID: "abc.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "shh",
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.id).toBe("google");
    expect(cfg!.clientId).toBe("abc.apps.googleusercontent.com");
    expect(cfg!.clientSecret).toBe("shh");
    expect(cfg!.authorizationEndpoint).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(cfg!.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
    expect(cfg!.userinfoEndpoint).toBe(
      "https://openidconnect.googleapis.com/v1/userinfo"
    );
    expect(cfg!.scopes).toBe("openid email profile");
    expect(cfg!.autoCreateUsers).toBe(true);
    expect(cfg!.allowedEmailDomains).toBeNull();
  });

  test("honours optional knobs", () => {
    const cfg = googleOauthConfigFromEnv({
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_AUTO_CREATE: "0",
      GOOGLE_OAUTH_ALLOWED_DOMAINS: "example.com,corp.example.com",
    });
    expect(cfg!.autoCreateUsers).toBe(false);
    expect(cfg!.allowedEmailDomains).toBe("example.com,corp.example.com");
  });
});

describe("resolveGoogleOauthConfig — precedence", () => {
  test("an enabled, fully-credentialed admin row wins over env", () => {
    const dbRow = row({
      enabled: true,
      clientId: "db-id",
      clientSecret: "db-secret",
    });
    const live = resolveGoogleOauthConfig(dbRow, ENV_CFG);
    expect(live).toBe(dbRow);
    expect(live!.clientId).toBe("db-id");
  });

  test("a DISABLED credentialed row does NOT shadow the env bootstrap", () => {
    // Regression: a half-finished /admin/google-oauth save (creds entered,
    // Enable left off) used to suppress a working GOOGLE_OAUTH_* bootstrap,
    // leaving "Sign in with Google" dark with a misleading "not enabled".
    const dbRow = row({
      enabled: false,
      clientId: "db-id",
      clientSecret: "db-secret",
    });
    const live = resolveGoogleOauthConfig(dbRow, ENV_CFG);
    expect(live).toBe(ENV_CFG);
    expect(live!.enabled).toBe(true);
  });

  test("a credential-less row never shadows the env bootstrap", () => {
    const live = resolveGoogleOauthConfig(row({ enabled: true }), ENV_CFG);
    expect(live).toBe(ENV_CFG);
  });

  test("env bootstrap alone (no DB row) is live", () => {
    expect(resolveGoogleOauthConfig(null, ENV_CFG)).toBe(ENV_CFG);
  });

  test("with no env, a disabled row is returned as-is (caller gates on it)", () => {
    const dbRow = row({
      enabled: false,
      clientId: "db-id",
      clientSecret: "db-secret",
    });
    expect(resolveGoogleOauthConfig(dbRow, null)).toBe(dbRow);
  });

  test("nothing configured anywhere resolves to null", () => {
    expect(resolveGoogleOauthConfig(null, null)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { googleOauthConfigFromEnv } from "../lib/sso";

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

import { join } from "path";

export const config = {
  get port() {
    return Number(process.env.PORT || 3000);
  },
  get databaseUrl() {
    return process.env.DATABASE_URL || "";
  },
  get gitReposPath() {
    return process.env.GIT_REPOS_PATH || join(process.cwd(), "repos");
  },
  get gatetestUrl() {
    return process.env.GATETEST_URL || "https://gatetest.ai/api/scan/run";
  },
  get gatetestApiKey() {
    return process.env.GATETEST_API_KEY || "";
  },
  get crontechDeployUrl() {
    return (
      process.env.CRONTECH_DEPLOY_URL ||
      "https://crontech.ai/api/hooks/gluecron/push"
    );
  },
  /**
   * Bearer token sent on outbound deploy webhook to Crontech's
   * `POST /api/hooks/gluecron/push` endpoint. Default empty → header is
   * omitted and Crontech will reject with 401 (treated as a failed deploy).
   */
  get gluecronWebhookSecret() {
    return process.env.GLUECRON_WEBHOOK_SECRET || "";
  },
  get anthropicApiKey() {
    return process.env.ANTHROPIC_API_KEY || "";
  },
  /** Email provider: "log" (dev, writes to stderr) or "resend" (HTTPS). */
  get emailProvider() {
    const v = (process.env.EMAIL_PROVIDER || "log").toLowerCase();
    return v === "resend" ? "resend" : "log";
  },
  /** "From" address for outbound email. */
  get emailFrom() {
    return process.env.EMAIL_FROM || "gluecron <no-reply@gluecron.local>";
  },
  /** Resend API key (only used when EMAIL_PROVIDER=resend). */
  get resendApiKey() {
    return process.env.RESEND_API_KEY || "";
  },
  /** Canonical base URL for outbound links in emails + webhooks. */
  get appBaseUrl() {
    return (process.env.APP_BASE_URL || "http://localhost:3000").replace(
      /\/+$/,
      ""
    );
  },
  /**
   * WebAuthn relying-party ID (domain only, no scheme/port). Derived from
   * appBaseUrl unless overridden. Passkeys issued for one RP ID can't be
   * replayed against another, so this must be stable.
   */
  get webauthnRpId() {
    if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID;
    try {
      return new URL(this.appBaseUrl).hostname;
    } catch {
      return "localhost";
    }
  },
  /** WebAuthn expected origin (must include scheme + port). */
  get webauthnOrigin() {
    return process.env.WEBAUTHN_ORIGIN || this.appBaseUrl;
  },
  /** Human-facing RP name shown by the browser. */
  get webauthnRpName() {
    return process.env.WEBAUTHN_RP_NAME || "gluecron";
  },
};

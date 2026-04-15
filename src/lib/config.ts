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
      "https://crontech.ai/api/trpc/tenant.deploy"
    );
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
};

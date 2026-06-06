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
    return process.env.GATETEST_URL || "https://gatetest.ai/api/events/push";
  },
  get gatetestApiKey() {
    return process.env.GATETEST_API_KEY || "";
  },
  get crontechDeployUrl() {
    return (
      process.env.CRONTECH_DEPLOY_URL ||
      "https://crontech.ai/api/webhooks/gluecron-push"
    );
  },
  /**
   * BLK-016 — only fire the Crontech deploy webhook for pushes to this
   * `<owner>/<name>`. Every other repo's push is ignored. Override per
   * environment via `CRONTECH_REPO`.
   */
  get crontechRepo() {
    return process.env.CRONTECH_REPO || "ccantynz-alt/crontech";
  },
  /**
   * Shared HMAC secret for the outbound deploy webhook to Crontech's
   * `POST /api/webhooks/gluecron-push` endpoint. Used to compute the
   * `X-Gluecron-Signature: sha256=<hex>` header on every fire. Default
   * empty → header is omitted and Crontech will reject with 401 (treated
   * as a failed deploy).
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
  /** SSH server port. 0 disables SSH (default 2222 in dev, 22 in prod via SSH_PORT). */
  get sshPort() {
    const v = process.env.SSH_PORT;
    if (v === "0") return 0;
    return Number(v || 2222);
  },
  /**
   * PEM-encoded Ed25519 (or RSA) private key for the SSH host.
   * If unset, an ephemeral key is generated on startup (fine for dev,
   * but clients will see "host key changed" warnings on restart —
   * set SSH_HOST_KEY in production).
   *
   * Multi-line keys in env vars: use literal newlines or \\n escapes,
   * both are normalised in ssh-server.ts.
   */
  get sshHostKey() {
    return process.env.SSH_HOST_KEY || "";
  },
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
  /**
   * Redis / Valkey connection URL for cross-instance SSE fan-out.
   * When set, `src/lib/sse.ts` uses Redis pub/sub so SSE events reach all
   * server instances behind the load balancer.  Falls back to in-process
   * delivery when unset.
   */
  get redisUrl() {
    return process.env.REDIS_URL || process.env.VALKEY_URL || "";
  },
};

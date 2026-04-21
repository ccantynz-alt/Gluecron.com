/**
 * Minimal, dependency-free observability layer.
 *
 * - `reportError` NEVER throws. Production paths must not break when a webhook
 *   is misconfigured or unreachable.
 * - Always logs to stderr with a `[error]` prefix.
 * - Optionally fans out to:
 *     - `ERROR_WEBHOOK_URL`  — generic JSON POST (fire-and-forget)
 *     - `SENTRY_DSN`         — Sentry envelope endpoint (fire-and-forget)
 *
 * No SDKs. Only `fetch` (built into Bun).
 */

interface SentryFrame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

function toErr(err: unknown): { message: string; stack?: string; type: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, type: err.name || "Error" };
  }
  try {
    return { message: typeof err === "string" ? err : JSON.stringify(err), type: "NonError" };
  } catch {
    return { message: String(err), type: "NonError" };
  }
}

function parseStack(stack?: string): SentryFrame[] {
  if (!stack) return [];
  const frames: SentryFrame[] = [];
  for (const raw of stack.split("\n").slice(1)) {
    const m = raw.trim().match(/^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    frames.push({
      function: m[1] || undefined,
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
    });
  }
  return frames.reverse();
}

function randomEventId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function parseDsn(dsn: string): { url: string; headers: Record<string, string> } | null {
  try {
    const u = new URL(dsn);
    const key = u.username;
    const projectId = u.pathname.replace(/^\/+/, "");
    if (!key || !projectId) return null;
    return {
      url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=gluecron/1.0`,
      },
    };
  } catch {
    return null;
  }
}

function safeLog(msg: string, e: unknown): void {
  try {
    console.error(msg, e);
  } catch {
    /* ignore */
  }
}

function fireAndForget(
  url: string,
  init: RequestInit,
  label: string
): void {
  try {
    void fetch(url, init).catch((e) => safeLog(`[error] ${label} failed:`, e));
  } catch (e) {
    safeLog(`[error] ${label} threw:`, e);
  }
}

export function reportError(err: unknown, context?: Record<string, unknown>): void {
  const { message, stack, type } = toErr(err);
  const timestamp = new Date().toISOString();

  safeLog("[error]", err);

  const webhookUrl = process.env.ERROR_WEBHOOK_URL;
  if (webhookUrl) {
    fireAndForget(
      webhookUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp, message, stack, context, env: process.env.NODE_ENV }),
      },
      "observability webhook"
    );
  }

  const dsn = process.env.SENTRY_DSN;
  if (dsn) {
    const parsed = parseDsn(dsn);
    if (!parsed) return;
    const eventId = randomEventId();
    const event = {
      event_id: eventId,
      timestamp,
      platform: "node",
      level: "error",
      message,
      exception: {
        values: [{ type, value: message, stacktrace: { frames: parseStack(stack) } }],
      },
      extra: context,
      environment: process.env.NODE_ENV,
    };
    const body =
      `${JSON.stringify({ event_id: eventId, sent_at: timestamp })}\n` +
      `${JSON.stringify({ type: "event" })}\n` +
      `${JSON.stringify(event)}\n`;
    fireAndForget(parsed.url, { method: "POST", headers: parsed.headers, body }, "sentry report");
  }
}

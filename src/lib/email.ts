/**
 * Email sending — provider-pluggable, never-throws.
 *
 * Providers:
 *   log     — writes a formatted message to stderr (default, dev-safe)
 *   resend  — POSTs to api.resend.com using RESEND_API_KEY
 *
 * Configured via:
 *   EMAIL_PROVIDER=log|resend
 *   EMAIL_FROM="gluecron <no-reply@gluecron.app>"
 *   RESEND_API_KEY=...
 *   APP_BASE_URL=https://gluecron.com
 *
 * Contract: sendEmail() must never reject. Failures are logged and swallowed
 * so a downed email provider never breaks the primary request path. Callers
 * await the returned promise to preserve ordering but may ignore the result.
 */

import { config } from "./config";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  ok: boolean;
  provider: "log" | "resend" | "none";
  skipped?: string;
  error?: string;
  id?: string;
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function renderPlainFallback(text: string): string {
  // Minimal HTML fallback when caller didn't supply one.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre style="font-family:ui-monospace,SF-Mono,Menlo,monospace;font-size:13px;white-space:pre-wrap;color:#c9d1d9;background:#0d1117;padding:16px;border-radius:6px">${escaped}</pre>`;
}

async function sendViaResend(msg: EmailMessage): Promise<EmailResult> {
  if (!config.resendApiKey) {
    return { ok: false, provider: "resend", skipped: "RESEND_API_KEY unset" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html || renderPlainFallback(msg.text),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        provider: "resend",
        error: `resend ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, provider: "resend", id: body.id };
  } catch (err) {
    return {
      ok: false,
      provider: "resend",
      error: String((err as Error)?.message || err),
    };
  }
}

function sendViaLog(msg: EmailMessage): EmailResult {
  // Structured, grep-able log. Written to stderr so prod log collectors pick it up.
  console.error(
    `[email:log] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n` +
      msg.text.split("\n").map((l) => "  " + l).join("\n")
  );
  return { ok: true, provider: "log" };
}

/**
 * Send an email. Always resolves — never throws, never rejects.
 * Returns { ok, provider, ... } so callers can surface errors in admin UIs
 * without having to wrap in try/catch.
 */
export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  if (!msg.to || !looksLikeEmail(msg.to)) {
    return { ok: false, provider: "none", skipped: "invalid recipient" };
  }
  if (!msg.subject || !msg.text) {
    return { ok: false, provider: "none", skipped: "missing subject or body" };
  }
  try {
    if (config.emailProvider === "resend") {
      return await sendViaResend(msg);
    }
    return sendViaLog(msg);
  } catch (err) {
    // Defence-in-depth — provider handlers already swallow, but just in case.
    return {
      ok: false,
      provider: config.emailProvider,
      error: String((err as Error)?.message || err),
    };
  }
}

/**
 * Build a fully-qualified URL from a path, using APP_BASE_URL.
 * Safe with relative or absolute inputs.
 */
export function absoluteUrl(pathOrUrl: string | undefined | null): string {
  if (!pathOrUrl) return config.appBaseUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const suffix = pathOrUrl.startsWith("/") ? pathOrUrl : "/" + pathOrUrl;
  return config.appBaseUrl + suffix;
}

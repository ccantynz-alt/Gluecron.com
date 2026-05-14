/**
 * Block P1 — Password reset flow.
 *
 * Public surface:
 *   - generateResetToken()
 *   - createPasswordResetRequest()  → always { ok: true }
 *   - consumeResetToken()
 *   - inspectResetToken()
 *
 * Security:
 *   - Plaintext token NEVER persists; we store only SHA-256(token).
 *   - createPasswordResetRequest never reveals whether the email exists.
 *   - consumeResetToken rotates the password AND drops every session.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, sessions, passwordResetTokens } from "../db/schema";
import { hashPassword } from "./auth";
import { sendEmail, absoluteUrl, type EmailMessage } from "./email";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Test seam — swap the email sender without mock.module.
type EmailSender = (msg: EmailMessage) => Promise<unknown> | unknown;
let _emailSender: EmailSender = sendEmail;
export function __setEmailForTests(fn: EmailSender | null): void {
  _emailSender = fn ?? sendEmail;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

export function generateResetToken(): { plaintext: string; hash: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = toHex(bytes);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(plaintext);
  const hash = hasher.digest("hex");
  return { plaintext, hash };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildResetEmail(opts: { username: string; resetUrl: string }) {
  const subject = "Reset your Gluecron password";
  const text = [
    `Hi ${opts.username},`,
    "",
    "We received a request to reset the password for your Gluecron account.",
    "",
    `Reset your password: ${opts.resetUrl}`,
    "",
    "This link expires in 1 hour. If you didn't request a reset, ignore",
    "this email — your password won't change.",
    "",
    "— gluecron",
  ].join("\n");

  const safeUser = escapeHtml(opts.username);
  const safeUrl = escapeHtml(opts.resetUrl);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#c9d1d9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden">
        <tr><td style="background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);padding:24px 28px">
          <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.01em">gluecron</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:2px">Password reset</div>
        </td></tr>
        <tr><td style="padding:28px">
          <p style="margin:0 0 12px;font-size:15px;color:#e6edf3">Hi ${safeUser},</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#c9d1d9">We received a request to reset the password for your Gluecron account.</p>
          <p style="margin:0 0 24px"><a href="${safeUrl}" style="display:inline-block;background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 22px;border-radius:9999px">Reset password</a></p>
          <p style="margin:0 0 8px;font-size:13px;color:#8b949e">Or copy this link into your browser:</p>
          <p style="margin:0 0 24px;font-size:12px;color:#8b949e;word-break:break-all"><a href="${safeUrl}" style="color:#58a6ff;text-decoration:none">${safeUrl}</a></p>
          <p style="margin:0;font-size:12px;color:#8b949e;line-height:1.55">This link expires in 1 hour. If you didn't request a reset, ignore this email — your password won't change.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #30363d;font-size:11px;color:#6e7681">gluecron — AI-native code intelligence</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

export function buildResetUrl(plaintextToken: string): string {
  const path = `/reset-password?token=${encodeURIComponent(plaintextToken)}&utm_source=password_reset`;
  return absoluteUrl(path);
}

export async function createPasswordResetRequest(
  email: string,
  opts: { requestIp?: string } = {}
): Promise<{ ok: boolean }> {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return { ok: true };

  try {
    const [user] = await db
      .select({ id: users.id, username: users.username, email: users.email })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);

    if (!user) {
      console.error(`[password-reset] no user for email=${JSON.stringify(normalized)} ip=${opts.requestIp || "?"} — generic success returned`);
      return { ok: true };
    }

    const { plaintext, hash } = generateResetToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hash,
      expiresAt,
      requestIp: opts.requestIp || null,
    });

    const resetUrl = buildResetUrl(plaintext);
    const msg = buildResetEmail({ username: user.username, resetUrl });

    // Fire-and-forget — don't block the response on email send.
    Promise.resolve()
      .then(() => _emailSender({ to: user.email, subject: msg.subject, text: msg.text, html: msg.html }))
      .catch((err) => console.error("[password-reset] email send error:", err));

    return { ok: true };
  } catch (err) {
    console.error("[password-reset] createPasswordResetRequest error:", err);
    return { ok: true };
  }
}

export async function consumeResetToken(
  token: string,
  newPassword: string
): Promise<{ ok: boolean; reason?: string }> {
  const plaintext = String(token || "").trim();
  if (!plaintext) return { ok: false, reason: "invalid" };
  if (!newPassword || newPassword.length < 8) return { ok: false, reason: "weak" };

  try {
    const hash = await sha256Hex(plaintext);
    const [row] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hash))
      .limit(1);

    if (!row) return { ok: false, reason: "invalid" };
    if (row.usedAt) return { ok: false, reason: "used" };
    if (new Date(row.expiresAt).getTime() < Date.now()) return { ok: false, reason: "expired" };

    const passwordHash = await hashPassword(newPassword);

    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, row.userId));
    await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id));
    await db.delete(sessions).where(eq(sessions.userId, row.userId));

    return { ok: true };
  } catch (err) {
    console.error("[password-reset] consumeResetToken error:", err);
    return { ok: false, reason: "invalid" };
  }
}

export async function inspectResetToken(token: string): Promise<{ valid: boolean; reason?: string }> {
  const plaintext = String(token || "").trim();
  if (!plaintext) return { valid: false, reason: "invalid" };
  try {
    const hash = await sha256Hex(plaintext);
    const [row] = await db
      .select({ id: passwordResetTokens.id, expiresAt: passwordResetTokens.expiresAt, usedAt: passwordResetTokens.usedAt })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hash))
      .limit(1);
    if (!row) return { valid: false, reason: "invalid" };
    if (row.usedAt) return { valid: false, reason: "used" };
    if (new Date(row.expiresAt).getTime() < Date.now()) return { valid: false, reason: "expired" };
    return { valid: true };
  } catch (err) {
    console.error("[password-reset] inspectResetToken error:", err);
    return { valid: false, reason: "invalid" };
  }
}

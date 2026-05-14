/**
 * Block P2 — email verification + welcome email.
 *
 * Responsibilities:
 *   - Issue verification tokens (plaintext 32-byte hex, sha256-hashed at rest,
 *     24-hour expiry).
 *   - Consume tokens, marking `users.email_verified_at`.
 *   - Fire the welcome email AFTER a successful verification.
 *
 * Contract: every exported function never throws. Email failures degrade
 * silently — the caller's primary code path (registration, etc.) must not
 * be coupled to email-provider liveness.
 *
 * Test seam: a `__setEmailForTests` setter lets unit tests inject a recorder
 * in place of the live `sendEmail` import. Tests must restore the previous
 * sender in `afterAll` to keep the module graph clean.
 */

import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import { users, emailVerificationTokens } from "../db/schema";
import {
  sendEmail as realSendEmail,
  absoluteUrl,
  type EmailMessage,
  type EmailResult,
} from "./email";

// ---------------------------------------------------------------------------
// Test seam — swap the email sender out without touching the module graph.
// ---------------------------------------------------------------------------

type EmailSender = (msg: EmailMessage) => Promise<EmailResult>;
let _sender: EmailSender = realSendEmail;

/**
 * Swap the email sender for the duration of a test. Returns the previous
 * sender so the test can restore it in `afterAll`. Never call from prod.
 */
export function __setEmailForTests(fn: EmailSender): EmailSender {
  const prev = _sender;
  _sender = fn;
  return prev;
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/** Token validity window. Tunable here; the migration enforces nothing. */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Produce a fresh plaintext token + its sha256 hash. Only the hash is
 * persisted; the plaintext is delivered exactly once via email.
 */
export function generateVerificationToken(): {
  plaintext: string;
  hash: string;
} {
  const plaintext = randomBytes(32).toString("hex");
  const hash = hashToken(plaintext);
  return { plaintext, hash };
}

/** Stable hash for lookups. Public so tests can compute the same value. */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// ---------------------------------------------------------------------------
// startEmailVerification
// ---------------------------------------------------------------------------

/**
 * Issue a fresh token for `userId` + `email` and send the verification email.
 * Fire-and-forget safe: never throws, returns `{ok}` so callers can audit
 * failures if they wish.
 */
export async function startEmailVerification(
  userId: string,
  email: string
): Promise<{ ok: boolean }> {
  try {
    const { plaintext, hash } = generateVerificationToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await db.insert(emailVerificationTokens).values({
      userId,
      email,
      tokenHash: hash,
      expiresAt,
    });

    let username = "there";
    try {
      const [u] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (u?.username) username = u.username;
    } catch {
      // username lookup is cosmetic.
    }

    const link = absoluteUrl(`/verify-email?token=${encodeURIComponent(plaintext)}`);
    const { subject, text, html } = renderVerificationEmail({ username, link });
    const result = await _sender({ to: email, subject, text, html });
    return { ok: result.ok };
  } catch (err) {
    console.error("[email-verification] startEmailVerification:", err);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// consumeVerificationToken
// ---------------------------------------------------------------------------

export async function consumeVerificationToken(
  token: string
): Promise<{ ok: boolean; userId?: string; email?: string }> {
  if (!token || typeof token !== "string") return { ok: false };
  try {
    const hash = hashToken(token);
    const now = new Date();
    const [row] = await db
      .select()
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, hash),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.expiresAt, now)
        )
      )
      .limit(1);
    if (!row) return { ok: false };

    await db
      .update(emailVerificationTokens)
      .set({ usedAt: now })
      .where(eq(emailVerificationTokens.id, row.id));

    await db
      .update(users)
      .set({ emailVerifiedAt: now })
      .where(eq(users.id, row.userId));

    return { ok: true, userId: row.userId, email: row.email };
  } catch (err) {
    console.error("[email-verification] consumeVerificationToken:", err);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Welcome email — sent AFTER successful verification.
// ---------------------------------------------------------------------------

export async function sendWelcomeEmail(userId: string): Promise<void> {
  try {
    const [u] = await db
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!u || !u.email) return;
    const { subject, text, html } = renderWelcomeEmail({ username: u.username });
    await _sender({ to: u.email, subject, text, html });
  } catch (err) {
    console.error("[email-verification] sendWelcomeEmail:", err);
  }
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderVerificationEmail(opts: {
  username: string;
  link: string;
}): { subject: string; text: string; html: string } {
  const u = opts.username;
  const link = opts.link;
  const subject = "Confirm your email for Gluecron";

  const text = [
    `Hi ${u},`,
    "",
    "Thanks for signing up for Gluecron — the git host built around Claude.",
    "",
    `Confirm your email: ${link}`,
    "",
    "This link expires in 24 hours. If you didn't sign up, ignore this email.",
  ].join("\n");

  const html = renderHtmlShell({
    title: "Confirm your email",
    heroSubtitle: "Welcome to Gluecron",
    heroLine: `Hi <strong>${escapeHtml(u)}</strong>, thanks for signing up.`,
    body: `
      <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#c9d1d9">
        Gluecron is the git host built around Claude. Confirm your email
        address to finish setting up your account.
      </p>
      <p style="margin:0 0 24px;text-align:center">
        <a href="${escapeHtml(link)}"
           style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">
          Confirm email
        </a>
      </p>
      <p style="margin:0;font-size:12px;color:#8b949e;line-height:1.55">
        Or paste this link into your browser:<br />
        <span style="word-break:break-all">${escapeHtml(link)}</span>
      </p>
      <p style="margin:24px 0 0;font-size:12px;color:#8b949e">
        This link expires in 24 hours. If you didn't sign up for Gluecron,
        you can safely ignore this email.
      </p>
    `,
  });

  return { subject, text, html };
}

export function renderWelcomeEmail(opts: { username: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const u = opts.username;
  const subject = "Welcome to Gluecron \u{1F389}";

  const newRepo = absoluteUrl("/new");
  const importUrl = absoluteUrl("/import");
  const demoUrl = absoluteUrl("/demo");
  const installUrl = absoluteUrl("/install");
  const onboarding = absoluteUrl("/onboarding");
  const docs = absoluteUrl("/docs");
  const help = absoluteUrl("/help");

  const text = [
    `Welcome aboard, ${u}!`,
    "",
    "Your email is verified. Here's what to try first:",
    "",
    `• Create your first repo — ${newRepo}`,
    `• Import from GitHub — ${importUrl}`,
    `• Watch Claude work — ${demoUrl}`,
    `• Install Claude Desktop integration — ${installUrl}`,
    "",
    `Next steps: ${onboarding}`,
    `Docs: ${docs}`,
    `Need help? Reply to this email or visit ${help}.`,
  ].join("\n");

  const html = renderHtmlShell({
    title: "Welcome to Gluecron",
    heroSubtitle: "You're in",
    heroLine: `Welcome aboard, <strong>${escapeHtml(u)}</strong>.`,
    body: `
      <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#c9d1d9">
        Your email is verified. Here's what to try first:
      </p>
      <ul style="margin:0 0 24px;padding-left:18px;font-size:14px;line-height:1.7;color:#c9d1d9">
        <li><strong>Create your first repo</strong> &mdash;
          <a style="color:#79c0ff" href="${escapeHtml(newRepo)}">gluecron.com/new</a></li>
        <li><strong>Import from GitHub</strong> &mdash;
          <a style="color:#79c0ff" href="${escapeHtml(importUrl)}">gluecron.com/import</a></li>
        <li><strong>Watch Claude work</strong> &mdash;
          <a style="color:#79c0ff" href="${escapeHtml(demoUrl)}">gluecron.com/demo</a></li>
        <li><strong>Install Claude Desktop integration</strong> &mdash;
          <a style="color:#79c0ff" href="${escapeHtml(installUrl)}">gluecron.com/install</a></li>
      </ul>
      <p style="margin:0 0 8px;font-size:13px;color:#8b949e">
        New here? Start with the
        <a style="color:#79c0ff" href="${escapeHtml(onboarding)}">onboarding tour</a>
        or skim the <a style="color:#79c0ff" href="${escapeHtml(docs)}">docs</a>.
      </p>
      <p style="margin:0;font-size:13px;color:#8b949e">
        Need help? Reply to this email or visit
        <a style="color:#79c0ff" href="${escapeHtml(help)}">gluecron.com/help</a>.
      </p>
    `,
  });

  return { subject, text, html };
}

function renderHtmlShell(opts: {
  title: string;
  heroSubtitle: string;
  heroLine: string;
  body: string;
}): string {
  return [
    `<!doctype html><html><head><meta charset="utf-8" /><title>${escapeHtml(opts.title)}</title></head>`,
    `<body style="margin:0;padding:24px;background:#0d1117;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#c9d1d9">`,
    `<div style="max-width:560px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden">`,
    `<div style="background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);color:#fff;padding:24px">`,
    `<div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.85">${escapeHtml(opts.heroSubtitle)}</div>`,
    `<h1 style="margin:8px 0 0;font-size:22px;font-weight:600">${opts.heroLine}</h1>`,
    `</div>`,
    `<div style="padding:24px">`,
    opts.body,
    `</div>`,
    `<div style="padding:12px 24px;border-top:1px solid #30363d;background:#0d1117;color:#6e7681;font-size:11px;text-align:center">`,
    `Gluecron — the git host built around Claude.`,
    `</div>`,
    `</div></body></html>`,
  ].join("\n");
}

/**
 * Block Q2 — Magic-link sign-in.
 *
 * Public surface:
 *   - generateMagicLinkToken()
 *   - startMagicLinkSignIn()  → always { ok: true } (no enumeration)
 *   - consumeMagicLinkToken()
 *
 * Structurally identical to P1 (`password-reset.ts`) and P2
 * (`email-verification.ts`): short random token, sha256-hashed at rest,
 * single-use, time-limited. The only meaningful differences are:
 *
 *   - 15-minute TTL (vs P1's 1h reset) — magic-link is a session-issuer,
 *     not a one-shot password rotation, so the blast radius of a stolen
 *     link is higher and we want the window tight.
 *   - `user_id` is nullable. When a not-yet-registered email is entered,
 *     we still mint a token row; consume creates the account on click
 *     (autoCreate=true). The click itself is proof the recipient owns
 *     the address — same trust model as a verification link.
 *
 * Security:
 *   - Plaintext token NEVER persists; we store only SHA-256(token).
 *   - startMagicLinkSignIn never reveals whether the email exists.
 *   - consumeMagicLinkToken invalidates every other unused magic-link
 *     for the same email on success (prevents multi-link abuse).
 *   - Per-email rate limit: at most 3 token mints per hour. The HTTP
 *     surface adds a per-IP rate limit on top of that.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, magicLinkTokens } from "../db/schema";
import { hashPassword } from "./auth";
import { sendEmail, absoluteUrl, type EmailMessage } from "./email";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TOKENS_PER_EMAIL_PER_HOUR = 3;

// ---------------------------------------------------------------------------
// Test seam — swap the email sender without `mock.module`. Mirrors P1.
// ---------------------------------------------------------------------------
type EmailSender = (msg: EmailMessage) => Promise<unknown> | unknown;
let _emailSender: EmailSender = sendEmail;
export function __setEmailForTests(fn: EmailSender | null): void {
  _emailSender = fn ?? sendEmail;
}

// ---------------------------------------------------------------------------
// Token primitives.
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++)
    out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

export function generateMagicLinkToken(): { plaintext: string; hash: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = toHex(bytes);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(plaintext);
  const hash = hasher.digest("hex");
  return { plaintext, hash };
}

// ---------------------------------------------------------------------------
// Email template — reuses the same dark-theme gradient shell as P1.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildMagicLinkEmail(opts: { signInUrl: string }) {
  const subject = "Your Gluecron sign-in link";
  const text = [
    "Hi,",
    "",
    "Click the link below to sign in to Gluecron. This link expires in 15 minutes.",
    "",
    `Sign in: ${opts.signInUrl}`,
    "",
    "If you didn't request this, ignore this email — no one can sign in",
    "without clicking the link.",
    "",
    "— gluecron",
  ].join("\n");

  const safeUrl = escapeHtml(opts.signInUrl);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#c9d1d9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden">
        <tr><td style="background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);padding:24px 28px">
          <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.01em">gluecron</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:2px">Magic sign-in link</div>
        </td></tr>
        <tr><td style="padding:28px">
          <p style="margin:0 0 12px;font-size:15px;color:#e6edf3">Hi,</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#c9d1d9">Click the button below to sign in to Gluecron. This link expires in 15 minutes.</p>
          <p style="margin:0 0 24px"><a href="${safeUrl}" style="display:inline-block;background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 22px;border-radius:9999px">Sign in</a></p>
          <p style="margin:0 0 8px;font-size:13px;color:#8b949e">Or copy this link into your browser:</p>
          <p style="margin:0 0 24px;font-size:12px;color:#8b949e;word-break:break-all"><a href="${safeUrl}" style="color:#58a6ff;text-decoration:none">${safeUrl}</a></p>
          <p style="margin:0;font-size:12px;color:#8b949e;line-height:1.55">If you didn't request this, ignore this email — no one can sign in without clicking the link.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #30363d;font-size:11px;color:#6e7681">gluecron — AI-native code intelligence</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

export function buildMagicLinkUrl(plaintextToken: string): string {
  const path = `/login/magic/callback?token=${encodeURIComponent(plaintextToken)}`;
  return absoluteUrl(path);
}

// ---------------------------------------------------------------------------
// startMagicLinkSignIn — always returns ok, never reveals enumeration.
// ---------------------------------------------------------------------------

export async function startMagicLinkSignIn(
  email: string,
  opts: { requestIp?: string; autoCreate?: boolean } = {}
): Promise<{ ok: boolean }> {
  const autoCreate = opts.autoCreate !== false; // default true
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return { ok: true };

  try {
    // Per-email throttle — prevents enumeration via timing AND volume.
    const recent = await db
      .select({
        id: magicLinkTokens.id,
        createdAt: magicLinkTokens.createdAt,
      })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, normalized))
      .limit(100);
    const cutoff = Date.now() - 60 * 60 * 1000;
    const recentCount = recent.filter(
      (r) => new Date(r.createdAt).getTime() > cutoff
    ).length;
    if (recentCount >= MAX_TOKENS_PER_EMAIL_PER_HOUR) {
      console.error(
        `[magic-link] per-email rate limit hit for ${JSON.stringify(normalized)} ip=${opts.requestIp || "?"} — generic success returned`
      );
      return { ok: true };
    }

    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);

    if (!user && !autoCreate) {
      console.error(
        `[magic-link] no user for email=${JSON.stringify(normalized)} ip=${opts.requestIp || "?"} autoCreate=false — generic success returned`
      );
      return { ok: true };
    }

    const { plaintext, hash } = generateMagicLinkToken();
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

    await db.insert(magicLinkTokens).values({
      email: normalized,
      userId: user?.id ?? null,
      tokenHash: hash,
      expiresAt,
      requestIp: opts.requestIp || null,
    });

    const signInUrl = buildMagicLinkUrl(plaintext);
    const msg = buildMagicLinkEmail({ signInUrl });

    // Fire-and-forget — never block the response on email send.
    Promise.resolve()
      .then(() =>
        _emailSender({
          to: normalized,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        })
      )
      .catch((err) =>
        console.error("[magic-link] email send error:", err)
      );

    return { ok: true };
  } catch (err) {
    console.error("[magic-link] startMagicLinkSignIn error:", err);
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// consumeMagicLinkToken — happy path returns a userId + createdAccount flag.
// ---------------------------------------------------------------------------

export async function consumeMagicLinkToken(
  token: string,
  opts: { autoCreate?: boolean; requestIp?: string } = {}
): Promise<{
  ok: boolean;
  userId?: string;
  createdAccount?: boolean;
  reason?: string;
}> {
  const autoCreate = opts.autoCreate !== false; // default true
  const plaintext = String(token || "").trim();
  if (!plaintext) return { ok: false, reason: "invalid" };

  try {
    const hash = await sha256Hex(plaintext);
    const [row] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.tokenHash, hash))
      .limit(1);

    if (!row) return { ok: false, reason: "invalid" };
    if (row.usedAt) return { ok: false, reason: "used" };
    if (new Date(row.expiresAt).getTime() < Date.now())
      return { ok: false, reason: "expired" };

    let userId = row.userId ?? undefined;
    let createdAccount = false;

    if (!userId) {
      if (!autoCreate) return { ok: false, reason: "no-account" };
      // Mint a fresh account. The click is proof of email ownership, so
      // we set emailVerifiedAt immediately. The password hash is a non-
      // matchable placeholder — the user can set a real password later
      // via /settings, or just keep using magic links forever.
      // We mint the UUID client-side so we don't need .returning() on the
      // insert (keeps the surface minimal + cheap to stub in tests).
      const username = await pickFreshUsername(row.email);
      const placeholderPw = await hashPassword(generateRandomString(32));
      const newUserId = crypto.randomUUID();
      await db.insert(users).values({
        id: newUserId,
        username,
        email: row.email,
        passwordHash: placeholderPw,
        emailVerifiedAt: new Date(),
      });
      userId = newUserId;
      createdAccount = true;
    }

    const now = new Date();

    // Mark the current token used.
    await db
      .update(magicLinkTokens)
      .set({ usedAt: now })
      .where(eq(magicLinkTokens.id, row.id));

    // Invalidate every other unused magic-link for this email. We use a
    // broad eq(email) — already-used rows already have usedAt set, so
    // this is a no-op for them; what matters is unused rows being
    // burned so a second link mailed within the 15-min window can't be
    // replayed.
    await db
      .update(magicLinkTokens)
      .set({ usedAt: now })
      .where(eq(magicLinkTokens.email, row.email));

    return { ok: true, userId, createdAccount };
  } catch (err) {
    console.error("[magic-link] consumeMagicLinkToken error:", err);
    return { ok: false, reason: "invalid" };
  }
}

// ---------------------------------------------------------------------------
// Auto-create helpers.
// ---------------------------------------------------------------------------

function generateRandomString(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return toHex(bytes);
}

/** 8 url-safe lowercase chars derived from random bytes. */
function shortSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/**
 * Pick a free `user-XXXXXXXX` username. Retries a handful of times on
 * collision. Pure name minting — no DB writes here.
 */
async function pickFreshUsername(_emailHint: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `user-${shortSuffix()}`;
    const [clash] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1);
    if (!clash) return candidate;
  }
  // 8 random 8-char rolls all colliding is astronomically unlikely; if it
  // happens we fall back to a longer suffix that's effectively unique.
  return `user-${shortSuffix()}${shortSuffix()}`;
}

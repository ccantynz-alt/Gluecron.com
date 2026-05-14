/**
 * Block P2 — email verification routes.
 *
 *   GET  /verify-email?token=…    Consume a token. On success: 302 to
 *                                  /dashboard?verified=1 and fire-and-forget
 *                                  the welcome email. On failure: render a
 *                                  "link expired" page.
 *   POST /verify-email/resend     requireAuth. Issues a fresh verification
 *                                  token. Rate-limited per user (3/hour).
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  consumeVerificationToken,
  startEmailVerification,
  sendWelcomeEmail,
} from "../lib/email-verification";

const verify = new Hono<AuthEnv>();

const RESEND_LIMIT = 3;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const _resendLog: Map<string, number[]> = new Map();

function checkResendRate(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const cutoff = now - RESEND_WINDOW_MS;
  const recent = (_resendLog.get(userId) || []).filter((t) => t > cutoff);
  if (recent.length >= RESEND_LIMIT) {
    _resendLog.set(userId, recent);
    return { allowed: false, remaining: 0 };
  }
  recent.push(now);
  _resendLog.set(userId, recent);
  return { allowed: true, remaining: RESEND_LIMIT - recent.length };
}

/** Test-only: wipe the in-memory rate-limit counters. */
export function __resetResendRateLimitForTests(): void {
  _resendLog.clear();
}

verify.get("/verify-email", softAuth, async (c) => {
  const token = c.req.query("token") || "";
  const user = c.get("user") || null;
  const result = await consumeVerificationToken(token);

  if (result.ok && result.userId) {
    void sendWelcomeEmail(result.userId);
    return c.redirect("/dashboard?verified=1");
  }

  return c.html(
    <Layout title="Verification link expired" user={user}>
      <div class="auth-container">
        <h2>Link expired</h2>
        <p style="color:var(--text-muted);font-size:14px;line-height:1.55">
          That verification link is no longer valid. Links expire after 24
          hours and can only be used once. Sign in and request a fresh link
          from your dashboard.
        </p>
        <p class="auth-switch" style="margin-top:24px">
          <a href="/login">Sign in</a>
        </p>
      </div>
    </Layout>
  );
});

verify.post("/verify-email/resend", requireAuth, async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login");

  let email = user.email;
  let verifiedAt: Date | null = (user as any).emailVerifiedAt
    ? new Date((user as any).emailVerifiedAt as string | Date)
    : null;
  try {
    const [fresh] = await db
      .select({
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (fresh) {
      email = fresh.email;
      verifiedAt = fresh.emailVerifiedAt
        ? new Date(fresh.emailVerifiedAt as unknown as string | Date)
        : null;
    }
  } catch {
    // best effort
  }

  if (verifiedAt) {
    return c.redirect("/dashboard?verified=1");
  }

  const rate = checkResendRate(user.id);
  if (!rate.allowed) {
    return c.redirect("/dashboard?verify=rate_limited");
  }

  void startEmailVerification(user.id, email);
  return c.redirect("/dashboard?verify=sent");
});

export default verify;

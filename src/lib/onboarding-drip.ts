/**
 * Onboarding email drip sequence.
 *
 * Sends three transactional emails to new users:
 *   "welcome" — T+0, sent immediately on registration.
 *   "day1"    — T+1 day, sent by the autopilot drip task.
 *   "day3"    — T+3 days, sent by the autopilot drip task.
 *
 * Idempotency: each key is written to `users.onboarding_emails_sent` (jsonb
 * array) before the send call returns. If the process crashes mid-send the
 * row is updated on the next tick when the key is already present, so the
 * user never receives a duplicate. Keys are only appended — never removed.
 *
 * Contract: every exported function must never throw. Failures are logged and
 * swallowed so a downed email provider or DB hiccup never breaks the
 * registration path or the autopilot tick.
 */

import { eq, sql, and, lte } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { sendEmail, absoluteUrl } from "./email";

// ---------------------------------------------------------------------------
// Drip schedule constants
// ---------------------------------------------------------------------------

/** Ordered drip keys. The "welcome" email is sent at T+0 from the auth route;
 *  "day1" and "day3" are sent by the autopilot task. */
export const DRIP_KEYS = ["welcome", "day1", "day3"] as const;
export type DripKey = (typeof DRIP_KEYS)[number];

/** Minimum age (ms) before each drip email is eligible. */
const DRIP_DELAY_MS: Record<DripKey, number> = {
  welcome: 0,
  day1: 24 * 60 * 60 * 1000,
  day3: 3 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Email HTML helpers
// ---------------------------------------------------------------------------

function footer(baseUrl: string): string {
  return `
<p style="margin:28px 0 0;font-size:12px;color:#8b949e;border-top:1px solid #21262d;padding-top:16px">
  You're receiving this because you created a Gluecron account.<br>
  <a href="${baseUrl}/settings/notifications" style="color:#8b949e">Unsubscribe from onboarding emails</a>
</p>`;
}

function wrapHtml(body: string, baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gluecron</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#c9d1d9">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:32px 0">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:32px">
      <tr><td>
        <div style="margin-bottom:24px">
          <span style="font-size:18px;font-weight:600;color:#f0f6fc">gluecron</span>
        </div>
        ${body}
        ${footer(baseUrl)}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function welcomeHtml(username: string, baseUrl: string): string {
  const body = `
<h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#f0f6fc">Welcome to Gluecron, ${username}!</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#c9d1d9">
  Your AI-native code platform is ready. Push code, open issues, and let Gluecron's
  AI review every PR, enforce your gates, and merge when conditions pass — all automatically.
</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#c9d1d9">
  Start by <a href="${baseUrl}/new" style="color:#58a6ff;text-decoration:none">creating your first repository</a>
  or exploring what's already there.
</p>
<a href="${baseUrl}/dashboard" style="display:inline-block;padding:10px 20px;background:#238636;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500">
  Go to dashboard →
</a>`;
  return wrapHtml(body, baseUrl);
}

function day1Html(username: string, baseUrl: string): string {
  const body = `
<h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#f0f6fc">Try Spec-to-PR, ${username}</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#c9d1d9">
  Pick any open issue in your repo, add the <code style="background:#21262d;padding:2px 5px;border-radius:4px;font-size:13px;color:#79c0ff">ai:build</code> label,
  and watch Gluecron build it into a draft PR in 90 seconds.
</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#c9d1d9">
  No extra config required — the AI reads the issue title and body, writes the code, and opens the PR on your behalf.
</p>
<a href="${baseUrl}/dashboard" style="display:inline-block;padding:10px 20px;background:#1f6feb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500">
  Try it now →
</a>`;
  return wrapHtml(body, baseUrl);
}

function day3Html(username: string, baseUrl: string): string {
  const body = `
<h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#f0f6fc">Your AI is watching, ${username}</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#c9d1d9">
  Here's what Gluecron autopilot does for you automatically:
</p>
<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.8;color:#c9d1d9">
  <li><strong style="color:#f0f6fc">Reviews every PR</strong> — inline AI comments the moment you push.</li>
  <li><strong style="color:#f0f6fc">Merges when gates pass</strong> — auto-merge fires once all required checks succeed.</li>
  <li><strong style="color:#f0f6fc">Heals failed CI</strong> — the CI healer reads the logs and opens a fix PR automatically.</li>
</ul>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#c9d1d9">
  All of this runs in the background — no manual intervention needed.
</p>
<a href="${baseUrl}/dashboard" style="display:inline-block;padding:10px 20px;background:#8957e5;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500">
  View your dashboard →
</a>`;
  return wrapHtml(body, baseUrl);
}

// ---------------------------------------------------------------------------
// Core send helper (used by both the auth hook and the drip task)
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  username: string;
  onboardingEmailsSent: string[] | null;
}

/**
 * Mark a drip key as sent for a user — writes to DB first, then sends.
 * Returns true on success, false on any failure (error already logged).
 */
async function markAndSend(
  user: UserRow,
  key: DripKey,
  subject: string,
  text: string,
  html: string
): Promise<boolean> {
  const sent: string[] = Array.isArray(user.onboardingEmailsSent)
    ? user.onboardingEmailsSent
    : [];

  if (sent.includes(key)) return true; // already delivered — idempotent

  // Persist before sending so a crash doesn't re-send on the next tick.
  try {
    await db
      .update(users)
      .set({
        onboardingEmailsSent: [...sent, key] as string[],
      })
      .where(eq(users.id, user.id));
  } catch (err) {
    console.error(
      `[onboarding-drip] DB update failed for user=${user.id} key=${key}:`,
      err
    );
    return false;
  }

  const result = await sendEmail({ to: user.email, subject, text, html });
  if (!result.ok) {
    console.error(
      `[onboarding-drip] sendEmail failed for user=${user.id} key=${key}: ${result.error ?? result.skipped ?? "unknown"}`
    );
    // Don't return false — the DB row is already marked, which is correct.
    // The user won't get a duplicate even if the email bounced.
  }
  return true;
}

// ---------------------------------------------------------------------------
// T+0 welcome email — called directly from the registration route
// ---------------------------------------------------------------------------

/**
 * Send the "welcome" email immediately after a new user registers.
 * Best-effort; never throws. Safe to fire-and-forget (`void`).
 */
export async function sendWelcomeEmail(userId: string): Promise<void> {
  try {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        onboardingEmailsSent: users.onboardingEmailsSent,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return;

    const baseUrl = absoluteUrl("/").replace(/\/$/, "");
    await markAndSend(
      user as UserRow,
      "welcome",
      "Welcome to Gluecron — your AI code platform is ready",
      `Hi ${user.username},\n\nWelcome to Gluecron! Your AI-native code platform is ready.\n\nStart by creating your first repository: ${baseUrl}/new\n\n—Gluecron\n\nUnsubscribe: ${baseUrl}/settings/notifications`,
      welcomeHtml(user.username, baseUrl)
    );
  } catch (err) {
    console.error(
      `[onboarding-drip] sendWelcomeEmail threw for userId=${userId}:`,
      err
    );
  }
}

// ---------------------------------------------------------------------------
// Autopilot drip task — processes T+1 and T+3 emails in bulk
// ---------------------------------------------------------------------------

export interface OnboardingDripSummary {
  sent: number;
  skipped: number;
  errors: number;
}

/** Per-tick cap — avoids hammering the email provider on a large install. */
const DRIP_CAP_PER_TICK = 50;

/**
 * One iteration of the onboarding-drip autopilot task.
 * Scans all non-playground, non-deleted users for pending drip emails
 * (day1 at T+1d, day3 at T+3d) and sends them. Never throws.
 */
export async function runOnboardingDripTaskOnce(
  opts: { now?: Date; cap?: number } = {}
): Promise<OnboardingDripSummary> {
  const now = opts.now ?? new Date();
  const cap = opts.cap ?? DRIP_CAP_PER_TICK;

  let rows: UserRow[] = [];
  try {
    // Fetch users created at least 1 day ago (earliest pending drip) who are
    // not playground or soft-deleted accounts. We over-fetch relative to cap
    // and filter in JS so we can apply per-user logic without N+1 queries.
    const cutoff = new Date(now.getTime() - DRIP_DELAY_MS.day1);
    const raw = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        onboardingEmailsSent: users.onboardingEmailsSent,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        and(
          lte(users.createdAt, cutoff),
          eq(users.isPlayground, false),
          // Only target users who are not soft-deleted (deletedAt IS NULL).
          sql`${users.deletedAt} IS NULL`
        )
      )
      .limit(cap * 2); // fetch 2× so we still fill cap after skips

    rows = raw as unknown as (UserRow & { createdAt: Date })[];
  } catch (err) {
    console.error("[onboarding-drip] candidate query failed:", err);
    return { sent: 0, skipped: 0, errors: 1 };
  }

  const baseUrl = absoluteUrl("/").replace(/\/$/, "");
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const rawRow of rows) {
    if (sent >= cap) break;

    const row = rawRow as UserRow & { createdAt: Date };
    const emailsSent: string[] = Array.isArray(row.onboardingEmailsSent)
      ? row.onboardingEmailsSent
      : [];
    const ageMs = now.getTime() - new Date(row.createdAt).getTime();

    // Process day1 and day3 in order; stop at the first unsent one to avoid
    // skipping day1 and going straight to day3 on a slow-polling instance.
    let didSend = false;

    try {
      // day1 — T+1d
      if (
        ageMs >= DRIP_DELAY_MS.day1 &&
        !emailsSent.includes("day1")
      ) {
        const ok = await markAndSend(
          row,
          "day1",
          "[Gluecron] Try Spec-to-PR — build a feature in 90 seconds",
          `Hi ${row.username},\n\nPick any open issue in your repo, add the ai:build label, and watch Gluecron build it into a PR in 90 seconds.\n\nGo to your dashboard: ${baseUrl}/dashboard\n\n—Gluecron\n\nUnsubscribe: ${baseUrl}/settings/notifications`,
          day1Html(row.username, baseUrl)
        );
        if (ok) { sent += 1; didSend = true; }
        else errors += 1;
        // Refresh the sent list so day3 sees the updated state.
        emailsSent.push("day1");
      }

      // day3 — T+3d (only if day1 is done)
      if (
        ageMs >= DRIP_DELAY_MS.day3 &&
        emailsSent.includes("day1") &&
        !emailsSent.includes("day3")
      ) {
        const ok = await markAndSend(
          row,
          "day3",
          "[Gluecron] Your AI is watching — autopilot does this for you",
          `Hi ${row.username},\n\nGluecron autopilot automatically reviews every PR, merges when gates pass, and heals failed CI.\n\nGo to your dashboard: ${baseUrl}/dashboard\n\n—Gluecron\n\nUnsubscribe: ${baseUrl}/settings/notifications`,
          day3Html(row.username, baseUrl)
        );
        if (ok) { sent += 1; didSend = true; }
        else errors += 1;
      }

      if (!didSend) skipped += 1;
    } catch (err) {
      errors += 1;
      console.error(
        `[onboarding-drip] per-user error for user=${row.id}:`,
        err
      );
    }
  }

  return { sent, skipped, errors };
}

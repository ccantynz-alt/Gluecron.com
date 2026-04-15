/**
 * Block I7 — Weekly email digest.
 *
 * Composes a per-user digest of activity over the last 7 days (or a custom
 * window) and sends it via the shared email module. Run from a cron or
 * manually via `POST /admin/digests/run`.
 *
 * Data sources:
 *   - notifications    (unread + read-last-7d)
 *   - gate_runs        (failed / repaired)
 *   - pull_requests    (merged by the user's repos)
 *
 * Never throws — the caller can fire-and-forget.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./../db";
import {
  gateRuns,
  notifications,
  pullRequests,
  repositories,
  users,
} from "./../db/schema";
import { sendEmail, type EmailResult } from "./email";
import { config } from "./config";

export interface DigestInput {
  userId: string;
  since?: Date;
  /** When false, skip `sendEmail` and just compose. Used for preview. */
  send?: boolean;
}

export interface DigestBody {
  subject: string;
  text: string;
  html: string;
  counts: {
    notifications: number;
    failedGates: number;
    repairedGates: number;
    mergedPrs: number;
  };
}

function fmtRange(from: Date, to: Date): string {
  const f = from.toISOString().slice(0, 10);
  const t = to.toISOString().slice(0, 10);
  return f === t ? f : `${f} \u2192 ${t}`;
}

export async function composeDigest(
  userId: string,
  since?: Date
): Promise<DigestBody | null> {
  const now = new Date();
  const from = since || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return null;

    // Pull notifications
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          gte(notifications.createdAt, from)
        )
      )
      .orderBy(desc(notifications.createdAt))
      .limit(25);

    // User's repos (owner only — org-aware digest can come later)
    const ownedRepos = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(eq(repositories.ownerId, userId));
    const repoIds = ownedRepos.map((r) => r.id);

    let failedGates: Array<{ repoName: string; gateName: string; sha: string }> = [];
    let repairedGates: Array<{ repoName: string; gateName: string; sha: string }> = [];
    let mergedPrs: Array<{ repoName: string; title: string }> = [];

    if (repoIds.length > 0) {
      const gates = await db
        .select()
        .from(gateRuns)
        .where(
          and(
            inArray(gateRuns.repositoryId, repoIds),
            gte(gateRuns.createdAt, from)
          )
        )
        .orderBy(desc(gateRuns.createdAt))
        .limit(50);
      const byId = new Map(ownedRepos.map((r) => [r.id, r.name]));
      for (const g of gates) {
        const repoName = byId.get(g.repositoryId) || "?";
        if (g.status === "failed") {
          failedGates.push({
            repoName,
            gateName: g.gateName,
            sha: g.commitSha.slice(0, 7),
          });
        } else if (g.status === "repaired") {
          repairedGates.push({
            repoName,
            gateName: g.gateName,
            sha: g.commitSha.slice(0, 7),
          });
        }
      }

      const merged = await db
        .select()
        .from(pullRequests)
        .where(
          and(
            inArray(pullRequests.repositoryId, repoIds),
            eq(pullRequests.state, "merged"),
            gte(pullRequests.updatedAt, from)
          )
        )
        .limit(25);
      for (const pr of merged) {
        mergedPrs.push({
          repoName: byId.get(pr.repositoryId) || "?",
          title: pr.title,
        });
      }
    }

    const counts = {
      notifications: notifs.length,
      failedGates: failedGates.length,
      repairedGates: repairedGates.length,
      mergedPrs: mergedPrs.length,
    };

    const base = config.appBaseUrl || "https://gluecron.com";
    const subject = `Your Gluecron digest (${fmtRange(from, now)})`;
    const lines: string[] = [];
    lines.push(`Hi ${user.username},`);
    lines.push("");
    lines.push(`Here's what happened across your repos this week.`);
    lines.push("");
    lines.push(
      `Notifications: ${counts.notifications}  ·  Failed gates: ${counts.failedGates}  ·  Auto-repaired: ${counts.repairedGates}  ·  PRs merged: ${counts.mergedPrs}`
    );
    lines.push("");

    if (notifs.length > 0) {
      lines.push("## Notifications");
      for (const n of notifs.slice(0, 10)) {
        const when = new Date(n.createdAt).toLocaleDateString();
        lines.push(`- [${n.kind}] ${n.title || "(untitled)"} — ${when}`);
      }
      lines.push("");
    }

    if (failedGates.length > 0) {
      lines.push("## Failed gates");
      for (const g of failedGates.slice(0, 10)) {
        lines.push(`- ${g.repoName} — ${g.gateName} (${g.sha})`);
      }
      lines.push("");
    }

    if (repairedGates.length > 0) {
      lines.push("## Auto-repairs");
      for (const g of repairedGates.slice(0, 10)) {
        lines.push(`- ${g.repoName} — ${g.gateName} (${g.sha})`);
      }
      lines.push("");
    }

    if (mergedPrs.length > 0) {
      lines.push("## Merged PRs");
      for (const pr of mergedPrs.slice(0, 10)) {
        lines.push(`- ${pr.repoName} — ${pr.title}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push(
      `You're receiving this because you opted into weekly digests. Manage at ${base}/settings.`
    );

    const text = lines.join("\n");
    const html = textToHtml(text, base);
    return { subject, text, html, counts };
  } catch (err) {
    console.error("[digest] composeDigest error:", err);
    return null;
  }
}

function textToHtml(text: string, base: string): string {
  const lines = text.split("\n");
  const out: string[] = [
    `<html><body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111">`,
  ];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      out.push(
        `<h3 style="border-bottom:1px solid #eee;padding-bottom:4px;margin-top:24px">${escapeHtml(line.slice(3))}</h3>`
      );
    } else if (line.startsWith("- ")) {
      out.push(`<li>${escapeHtml(line.slice(2))}</li>`);
    } else if (line === "---") {
      out.push(`<hr style="border:none;border-top:1px solid #eee;margin:24px 0" />`);
    } else if (line.trim() === "") {
      out.push("<br>");
    } else {
      out.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  out.push(
    `<p style="font-size:12px;color:#777"><a href="${escapeHtml(base)}">${escapeHtml(base)}</a></p>`
  );
  out.push("</body></html>");
  return out.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Compose + send for a single user. Records `last_digest_sent_at` on success. */
export async function sendDigestForUser(
  userId: string
): Promise<EmailResult | { ok: false; provider: "none"; skipped: string }> {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return { ok: false, provider: "none", skipped: "user not found" };
    if (!user.notifyEmailDigestWeekly) {
      return { ok: false, provider: "none", skipped: "opted out" };
    }
    const body = await composeDigest(userId);
    if (!body) {
      return { ok: false, provider: "none", skipped: "compose failed" };
    }
    const result = await sendEmail({
      to: user.email,
      subject: body.subject,
      text: body.text,
      html: body.html,
    });
    if (result.ok) {
      await db
        .update(users)
        .set({ lastDigestSentAt: new Date() })
        .where(eq(users.id, userId));
    }
    return result;
  } catch (err) {
    console.error("[digest] sendDigestForUser error:", err);
    return { ok: false, provider: "none", skipped: "error" };
  }
}

/** Iterates all opted-in users. Returns per-user results for logging. */
export async function sendDigestsToAll(): Promise<
  Array<{ userId: string; username: string; ok: boolean; skipped?: string }>
> {
  const results: Array<{
    userId: string;
    username: string;
    ok: boolean;
    skipped?: string;
  }> = [];
  try {
    const opted = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.notifyEmailDigestWeekly, true));
    for (const u of opted) {
      const r = await sendDigestForUser(u.id);
      results.push({
        userId: u.id,
        username: u.username,
        ok: r.ok,
        skipped: "skipped" in r ? r.skipped : undefined,
      });
    }
  } catch (err) {
    console.error("[digest] sendDigestsToAll error:", err);
  }
  return results;
}

/** Pure helper exported for tests. */
export const __internal = { textToHtml, escapeHtml, fmtRange };

// Keep sql unused-import warnings silent
void sql;

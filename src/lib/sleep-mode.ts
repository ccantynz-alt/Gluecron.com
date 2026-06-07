/**
 * Block L1 — Sleep Mode.
 *
 * Pitch: "Toggle Sleep Mode. Walk away. Wake up to a digest of what Claude
 * shipped overnight."
 *
 * Sleep Mode is a per-user toggle (`users.sleep_mode_enabled`) that, when on:
 *   1. Bumps the email digest cadence from weekly → daily.
 *   2. Reframes the digest as "what AI did in the last 24h" — PRs auto-merged
 *      by the K3 autopilot, issues built from `ai:build` labels, AI reviews
 *      posted, AI security scans, and gate failures that auto-repair fixed.
 *   3. Fires at the user-configured UTC hour (`sleep_mode_digest_hour_utc`,
 *      default 9).
 *
 * Re-uses `sendEmail` from `src/lib/email.ts` and the locked `escapeHtml`
 * helper from `src/lib/email-digest.ts`. Does NOT modify either module —
 * Block L1 is strictly additive.
 *
 * Contract: every exported function NEVER throws. Failures are logged and
 * surface as either zero-valued reports or `{ok:false, reason}` results.
 */

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  gateRuns,
  issueComments,
  issues,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { sendEmail, type EmailResult } from "./email";
import { config } from "./config";
import { __internal as digestInternals } from "./email-digest";
import { AI_BUILD_MARKER } from "./ai-build-tasks";
import { computeHoursSaved } from "./ai-hours-saved";

const { escapeHtml } = digestInternals;

/** Default look-back window. Sleep Mode is a daily digest. */
const DEFAULT_WINDOW_HOURS = 24;
/** Per-tick cap on users we'll email — runaway protection. */
export const SLEEP_MODE_USER_CAP_PER_TICK = 100;
/** Cooldown anchored to `users.last_digest_sent_at`. */
export const SLEEP_MODE_COOLDOWN_HOURS = 23;

export type SleepModeReport = {
  windowHours: number;
  prsAutoMerged: { number: number; title: string; repo: string }[];
  issuesBuiltByAi: { number: number; title: string; repo: string; prNumber?: number }[];
  aiReviewsPosted: number;
  securityIssuesAutoFixed: number;
  gateFailuresAutoRepaired: number;
  /** Derived. Rounded to one decimal. See heuristic constants above. */
  hoursSaved: number;
};


/**
 * Compose a Sleep Mode report for one user. Pulls from:
 *   - audit_log `auto_merge.merged`   → prsAutoMerged
 *   - issue_comments matching `AI_BUILD_MARKER` on this user's repos → issuesBuiltByAi
 *   - pr_comments where is_ai_review=true on this user's repos → aiReviewsPosted
 *   - gate_runs status='repaired' AND gate_name LIKE '%Secret%' → securityIssuesAutoFixed
 *   - gate_runs status='repaired' (others) → gateFailuresAutoRepaired
 *
 * Never throws. On DB error, returns a zero-valued report.
 */
export async function composeSleepModeReport(
  userId: string,
  opts?: { sinceHoursAgo?: number; now?: Date }
): Promise<SleepModeReport> {
  const windowHours = opts?.sinceHoursAgo ?? DEFAULT_WINDOW_HOURS;
  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const empty: SleepModeReport = {
    windowHours,
    prsAutoMerged: [],
    issuesBuiltByAi: [],
    aiReviewsPosted: 0,
    securityIssuesAutoFixed: 0,
    gateFailuresAutoRepaired: 0,
    hoursSaved: 0,
  };

  try {
    // Resolve the user's repos (owner only — orgs aren't user-toggled).
    const ownedRepos = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(eq(repositories.ownerId, userId));
    if (ownedRepos.length === 0) return empty;

    const repoIds = ownedRepos.map((r) => r.id);
    const repoNameById = new Map(ownedRepos.map((r) => [r.id, r.name]));

    // -----------------------------------------------------------------
    // PRs auto-merged: audit_log `auto_merge.merged` in window.
    // Join PR for title+number.
    // -----------------------------------------------------------------
    let prsAutoMerged: SleepModeReport["prsAutoMerged"] = [];
    try {
      const rows = await db
        .select({
          targetId: auditLog.targetId,
          repositoryId: auditLog.repositoryId,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "auto_merge.merged"),
            inArray(auditLog.repositoryId, repoIds),
            gte(auditLog.createdAt, since)
          )
        )
        .limit(50);
      const prIds = rows
        .map((r) => r.targetId)
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      if (prIds.length > 0) {
        const prRows = await db
          .select({
            id: pullRequests.id,
            number: pullRequests.number,
            title: pullRequests.title,
            repositoryId: pullRequests.repositoryId,
          })
          .from(pullRequests)
          .where(inArray(pullRequests.id, prIds));
        prsAutoMerged = prRows.map((p) => ({
          number: p.number,
          title: p.title,
          repo: repoNameById.get(p.repositoryId) || "?",
        }));
      }
    } catch (err) {
      console.error("[sleep-mode] prsAutoMerged query failed:", err);
    }

    // -----------------------------------------------------------------
    // Issues built by AI: issue_comments whose body includes the
    // K3 AI-build marker, within the window, on repos this user owns.
    // -----------------------------------------------------------------
    let issuesBuiltByAi: SleepModeReport["issuesBuiltByAi"] = [];
    try {
      const rows = await db
        .select({
          issueId: issueComments.issueId,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .innerJoin(issues, eq(issues.id, issueComments.issueId))
        .where(
          and(
            inArray(issues.repositoryId, repoIds),
            gte(issueComments.createdAt, since),
            sql`${issueComments.body} LIKE ${"%" + AI_BUILD_MARKER + "%"}`
          )
        )
        .limit(50);
      const issueIds = Array.from(new Set(rows.map((r) => r.issueId)));
      if (issueIds.length > 0) {
        const issueRows = await db
          .select({
            id: issues.id,
            number: issues.number,
            title: issues.title,
            repositoryId: issues.repositoryId,
          })
          .from(issues)
          .where(inArray(issues.id, issueIds));
        issuesBuiltByAi = issueRows.map((i) => ({
          number: i.number,
          title: i.title,
          repo: repoNameById.get(i.repositoryId) || "?",
        }));
      }
    } catch (err) {
      console.error("[sleep-mode] issuesBuiltByAi query failed:", err);
    }

    // -----------------------------------------------------------------
    // AI reviews posted on this user's repos in the window.
    // pr_comments.is_ai_review=true, joined to pullRequests for repo
    // filter. We count, we don't list — the digest just reports the
    // total. (Per-PR list would balloon the email.)
    // -----------------------------------------------------------------
    let aiReviewsPosted = 0;
    try {
      const rows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(prComments)
        .innerJoin(
          pullRequests,
          eq(pullRequests.id, prComments.pullRequestId)
        )
        .where(
          and(
            eq(prComments.isAiReview, true),
            inArray(pullRequests.repositoryId, repoIds),
            gte(prComments.createdAt, since)
          )
        );
      aiReviewsPosted = Number(rows[0]?.c ?? 0);
    } catch (err) {
      console.error("[sleep-mode] aiReviewsPosted query failed:", err);
    }

    // -----------------------------------------------------------------
    // Gate auto-repairs in window. Split into "security" (secret-scan
    // gates) and "everything else" (test repair, etc).
    // -----------------------------------------------------------------
    let securityIssuesAutoFixed = 0;
    let gateFailuresAutoRepaired = 0;
    try {
      const rows = await db
        .select({
          gateName: gateRuns.gateName,
        })
        .from(gateRuns)
        .where(
          and(
            inArray(gateRuns.repositoryId, repoIds),
            eq(gateRuns.status, "repaired"),
            gte(gateRuns.createdAt, since)
          )
        )
        .limit(500);
      for (const r of rows) {
        const lower = (r.gateName || "").toLowerCase();
        if (lower.includes("secret") || lower.includes("security")) {
          securityIssuesAutoFixed += 1;
        } else {
          gateFailuresAutoRepaired += 1;
        }
      }
    } catch (err) {
      console.error("[sleep-mode] gate-runs query failed:", err);
    }

    const hoursSaved = computeHoursSaved({
      prsAutoMerged: prsAutoMerged.length,
      issuesBuiltByAi: issuesBuiltByAi.length,
      aiReviewsPosted,
      aiTriagesPosted: 0,
      aiCommitMsgs: 0,
      secretsAutoRepaired: securityIssuesAutoFixed,
      gateAutoRepairs: gateFailuresAutoRepaired,
    });

    return {
      windowHours,
      prsAutoMerged,
      issuesBuiltByAi,
      aiReviewsPosted,
      securityIssuesAutoFixed,
      gateFailuresAutoRepaired,
      hoursSaved,
    };
  } catch (err) {
    console.error("[sleep-mode] composeSleepModeReport error:", err);
    return empty;
  }
}

/**
 * Render a Sleep Mode digest. Returns `{subject, text, html}` ready to hand
 * off to `sendEmail`. Pure — no DB, no env, no I/O.
 *
 * HTML escaping is handled here for every user-controlled value so a
 * crafted PR/issue title cannot break out and inject script. The plaintext
 * branch is plaintext by definition (consumers display as-is).
 */
export function renderSleepModeDigest(
  report: SleepModeReport,
  opts: { username: string }
): { subject: string; text: string; html: string } {
  const username = opts.username;
  const base = config.appBaseUrl || "https://gluecron.com";
  const total =
    report.prsAutoMerged.length +
    report.issuesBuiltByAi.length +
    report.aiReviewsPosted +
    report.securityIssuesAutoFixed +
    report.gateFailuresAutoRepaired;

  const subject =
    total === 0
      ? `Sleep Mode: a quiet night on Gluecron`
      : `Sleep Mode: while you slept, Claude shipped ${total} thing${total === 1 ? "" : "s"}`;

  // ---- Plaintext ----
  const textLines: string[] = [];
  textLines.push(`Hi ${username},`);
  textLines.push("");
  if (total === 0) {
    textLines.push(
      `Nothing fired in the last ${report.windowHours} hours. Quiet night.`
    );
  } else {
    textLines.push(
      `While you slept, Claude opened/merged ${report.prsAutoMerged.length} PR${report.prsAutoMerged.length === 1 ? "" : "s"}, built ${report.issuesBuiltByAi.length} issue${report.issuesBuiltByAi.length === 1 ? "" : "s"}, posted ${report.aiReviewsPosted} AI review${report.aiReviewsPosted === 1 ? "" : "s"}, fixed ${report.securityIssuesAutoFixed} security issue${report.securityIssuesAutoFixed === 1 ? "" : "s"}, and auto-repaired ${report.gateFailuresAutoRepaired} gate failure${report.gateFailuresAutoRepaired === 1 ? "" : "s"}.`
    );
    textLines.push("");
    textLines.push(`Estimated time saved: ${report.hoursSaved} hours.`);
  }
  textLines.push("");

  if (report.prsAutoMerged.length > 0) {
    textLines.push("## PRs auto-merged");
    for (const pr of report.prsAutoMerged.slice(0, 10)) {
      textLines.push(`- ${pr.repo} #${pr.number} ${pr.title}`);
    }
    textLines.push("");
  }
  if (report.issuesBuiltByAi.length > 0) {
    textLines.push("## Issues built by AI");
    for (const it of report.issuesBuiltByAi.slice(0, 10)) {
      const tail = it.prNumber ? ` -> PR #${it.prNumber}` : "";
      textLines.push(`- ${it.repo} #${it.number} ${it.title}${tail}`);
    }
    textLines.push("");
  }
  if (
    report.aiReviewsPosted +
      report.securityIssuesAutoFixed +
      report.gateFailuresAutoRepaired >
    0
  ) {
    textLines.push("## Automated guardrails");
    textLines.push(`- AI reviews posted: ${report.aiReviewsPosted}`);
    textLines.push(
      `- Security issues auto-fixed: ${report.securityIssuesAutoFixed}`
    );
    textLines.push(
      `- Gate failures auto-repaired: ${report.gateFailuresAutoRepaired}`
    );
    textLines.push("");
  }

  textLines.push("---");
  textLines.push(
    `Sleep Mode delivers this daily. Toggle off at ${base}/settings.`
  );
  const text = textLines.join("\n");

  // ---- HTML ----
  // We do NOT route through email-digest's textToHtml because the Sleep
  // Mode digest has a custom hero block + bespoke styling. We DO use the
  // shared `escapeHtml` for every user-supplied string.
  const html = renderHtml(report, { username, base, total });

  return { subject, text, html };
}

function renderHtml(
  report: SleepModeReport,
  ctx: { username: string; base: string; total: number }
): string {
  const u = escapeHtml(ctx.username);
  const heroLine =
    ctx.total === 0
      ? `Nothing fired in the last ${report.windowHours} hours. Quiet night.`
      : `While you slept, Claude opened/merged <strong>${report.prsAutoMerged.length}</strong> PRs, built <strong>${report.issuesBuiltByAi.length}</strong> issues, posted <strong>${report.aiReviewsPosted}</strong> AI reviews, fixed <strong>${report.securityIssuesAutoFixed}</strong> security issues, and auto-repaired <strong>${report.gateFailuresAutoRepaired}</strong> gate failures.`;

  const parts: string[] = [];
  parts.push(
    `<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#0f1019;background:#fff">`
  );
  parts.push(
    `<div style="background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);color:#fff;padding:24px;border-radius:12px;margin-bottom:24px">` +
      `<div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.85">Sleep Mode</div>` +
      `<h1 style="margin:8px 0 0;font-size:22px;font-weight:600">Good morning, ${u}.</h1>` +
      `<p style="margin:12px 0 0;font-size:14px;line-height:1.5;opacity:0.95">${heroLine}</p>` +
      (ctx.total > 0
        ? `<p style="margin:12px 0 0;font-size:14px;font-weight:600">Estimated time saved: ${report.hoursSaved} hours</p>`
        : "") +
      `</div>`
  );

  if (report.prsAutoMerged.length > 0) {
    parts.push(
      `<h3 style="border-bottom:1px solid #eee;padding-bottom:4px;margin-top:24px;font-size:14px">PRs auto-merged</h3>`
    );
    parts.push(`<ul style="padding-left:18px;margin:8px 0">`);
    for (const pr of report.prsAutoMerged.slice(0, 10)) {
      parts.push(
        `<li><strong>${escapeHtml(pr.repo)}</strong> #${pr.number} ${escapeHtml(pr.title)}</li>`
      );
    }
    parts.push(`</ul>`);
  }
  if (report.issuesBuiltByAi.length > 0) {
    parts.push(
      `<h3 style="border-bottom:1px solid #eee;padding-bottom:4px;margin-top:24px;font-size:14px">Issues built by AI</h3>`
    );
    parts.push(`<ul style="padding-left:18px;margin:8px 0">`);
    for (const it of report.issuesBuiltByAi.slice(0, 10)) {
      const tail = it.prNumber ? ` &rarr; PR #${it.prNumber}` : "";
      parts.push(
        `<li><strong>${escapeHtml(it.repo)}</strong> #${it.number} ${escapeHtml(it.title)}${tail}</li>`
      );
    }
    parts.push(`</ul>`);
  }
  if (
    report.aiReviewsPosted +
      report.securityIssuesAutoFixed +
      report.gateFailuresAutoRepaired >
    0
  ) {
    parts.push(
      `<h3 style="border-bottom:1px solid #eee;padding-bottom:4px;margin-top:24px;font-size:14px">Automated guardrails</h3>`
    );
    parts.push(`<ul style="padding-left:18px;margin:8px 0">`);
    parts.push(`<li>AI reviews posted: ${report.aiReviewsPosted}</li>`);
    parts.push(
      `<li>Security issues auto-fixed: ${report.securityIssuesAutoFixed}</li>`
    );
    parts.push(
      `<li>Gate failures auto-repaired: ${report.gateFailuresAutoRepaired}</li>`
    );
    parts.push(`</ul>`);
  }

  parts.push(
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0" />`
  );
  parts.push(
    `<p style="font-size:12px;color:#777">Sleep Mode delivers this daily. Toggle off at <a href="${escapeHtml(ctx.base)}/settings">${escapeHtml(ctx.base)}/settings</a>.</p>`
  );
  parts.push(`</body></html>`);
  return parts.join("\n");
}

/**
 * Compose + send a Sleep Mode digest for one user. Stamps
 * `users.last_digest_sent_at` on success so the autopilot cooldown holds
 * for 23h. Never throws.
 *
 * Skips (returns `{ok:false, reason}`) when:
 *   - user not found
 *   - user.sleepModeEnabled is false
 *   - composer returns the zero report AND owner has no repos (graceful)
 *     -> we DO still send if they have repos but a quiet window.
 */
export async function sendSleepModeDigestForUser(
  userId: string
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return { ok: false, reason: "user not found" };
    if (!user.sleepModeEnabled) return { ok: false, reason: "sleep mode off" };

    const report = await composeSleepModeReport(userId);
    const { subject, text, html } = renderSleepModeDigest(report, {
      username: user.username,
    });

    const result: EmailResult = await sendEmail({
      to: user.email,
      subject,
      text,
      html,
    });
    if (result.ok) {
      try {
        await db
          .update(users)
          .set({ lastSleepDigestSentAt: new Date() })
          .where(eq(users.id, userId));
      } catch (err) {
        console.error("[sleep-mode] lastSleepDigestSentAt update failed:", err);
      }
      return { ok: true };
    }
    return {
      ok: false,
      reason: result.skipped || result.error || "send failed",
    };
  } catch (err) {
    console.error("[sleep-mode] sendSleepModeDigestForUser error:", err);
    return { ok: false, reason: "error" };
  }
}

/** Test-only surface. */
export const __test = {
  DEFAULT_WINDOW_HOURS,
  renderHtml,
};

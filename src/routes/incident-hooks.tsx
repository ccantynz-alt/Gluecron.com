/**
 * Production Incident Auto-Fix
 *
 * Receives inbound webhooks from PagerDuty, Datadog, Opsgenie, or a generic
 * monitoring source. For each new incident:
 *
 *  1. Validate the secret in ?secret=<token> against stored SHA-256 hash.
 *  2. Normalise the provider payload to { title, description, severity }.
 *  3. Resolve the target repo (via incident_hook_configs mapping or fallback).
 *  4. Call analyzeIncident() — git blame + recent commits + Claude AI.
 *  5. Open an issue tagged `incident`.
 *  6. If AI returned a fix, create a branch + commit a fix file + open a draft PR.
 *  7. Notify repo owner + collaborators.
 *
 * GET /settings/incident-hooks — config page (auth required).
 * POST /hooks/pagerduty
 * POST /hooks/datadog
 * POST /hooks/opsgenie
 * POST /hooks/incident  (generic)
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import {
  incidentHookConfigs,
  issues,
  issueLabels,
  labels,
  pullRequests,
  repoCollaborators,
  repositories,
  users,
} from "../db/schema";
import { analyzeIncident } from "../lib/incident-analyzer";
import { notify } from "../lib/notify";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";
import {
  createOrUpdateFileOnBranch,
  getDefaultBranch,
  getRepoPath,
} from "../git/repository";

const incidentHookRoutes = new Hono<AuthEnv>();

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Timing-safe comparison of two hex strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload normalisation
// ─────────────────────────────────────────────────────────────────────────────

interface NormalisedIncident {
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  /** provider-supplied repo hint (owner/repo), if any */
  repoHint?: string;
  /** set to 'resolve' to skip issue creation */
  action?: "trigger" | "resolve";
}

function normalisePagerDuty(body: unknown): NormalisedIncident | null {
  try {
    const pd = body as {
      messages?: Array<{
        event?: string;
        payload?: {
          summary?: string;
          severity?: string;
          source?: string;
          custom_details?: Record<string, string>;
        };
        links?: Array<{ href: string; text: string }>;
      }>;
    };
    const msg = pd?.messages?.[0];
    if (!msg) return null;
    const event = msg.event || "";
    const payload = msg.payload || {};
    const sev = payload.severity || "error";
    const severityMap: Record<string, NormalisedIncident["severity"]> = {
      critical: "critical",
      error: "high",
      warning: "medium",
      info: "low",
    };
    const details = payload.custom_details || {};
    const descLines = [
      `**Source:** ${payload.source || "(unknown)"}`,
      "",
      ...Object.entries(details).map(([k, v]) => `**${k}:** ${v}`),
      ...(msg.links?.length
        ? [
            "",
            "**Links:**",
            ...msg.links.map((l) => `- [${l.text}](${l.href})`),
          ]
        : []),
    ];
    return {
      title: payload.summary || "PagerDuty incident",
      description: descLines.join("\n"),
      severity: severityMap[sev] ?? "high",
      repoHint: details["repo"] || details["repository"],
      action: event.includes("resolve") ? "resolve" : "trigger",
    };
  } catch {
    return null;
  }
}

function normaliseDatadog(body: unknown): NormalisedIncident | null {
  try {
    const dd = body as {
      title?: string;
      text?: string;
      priority?: string;
      tags?: string[];
      alert_type?: string;
    };
    const alertType = dd?.alert_type || "error";
    const sevMap: Record<string, NormalisedIncident["severity"]> = {
      error: "high",
      warning: "medium",
      info: "low",
      success: "low",
    };
    const tags = dd?.tags || [];
    const repoTag = tags.find(
      (t) => t.startsWith("repo:") || t.startsWith("repository:")
    );
    const repoHint = repoTag ? repoTag.split(":")[1] : undefined;
    return {
      title: dd?.title || "Datadog alert",
      description: [
        dd?.text || "",
        "",
        tags.length ? `**Tags:** ${tags.join(", ")}` : "",
      ]
        .join("\n")
        .trim(),
      severity: sevMap[alertType] ?? "high",
      repoHint,
      action: alertType === "success" ? "resolve" : "trigger",
    };
  } catch {
    return null;
  }
}

function normaliseOpsgenie(body: unknown): NormalisedIncident | null {
  try {
    const og = body as {
      alert?: {
        message?: string;
        description?: string;
        priority?: string;
        tags?: string[];
        details?: Record<string, string>;
      };
      action?: string;
    };
    const alert = og?.alert || {};
    const priMap: Record<string, NormalisedIncident["severity"]> = {
      P1: "critical",
      P2: "high",
      P3: "medium",
      P4: "low",
      P5: "low",
    };
    const details = alert.details || {};
    const repoHint = details["repo"] || details["repository"];
    return {
      title: alert.message || "Opsgenie alert",
      description: [
        alert.description || "",
        ...(alert.tags?.length ? [`**Tags:** ${alert.tags.join(", ")}`] : []),
        ...Object.entries(details).map(([k, v]) => `**${k}:** ${v}`),
      ]
        .join("\n")
        .trim(),
      severity: priMap[alert.priority ?? "P3"] ?? "high",
      repoHint,
      action: (og?.action || "").toLowerCase().includes("close")
        ? "resolve"
        : "trigger",
    };
  } catch {
    return null;
  }
}

function normaliseGeneric(body: unknown): NormalisedIncident | null {
  try {
    const g = body as {
      title?: string;
      description?: string;
      severity?: string;
      source?: string;
      repo?: string;
      tags?: string[];
    };
    const sevMap: Record<string, NormalisedIncident["severity"]> = {
      critical: "critical",
      high: "high",
      medium: "medium",
      low: "low",
    };
    return {
      title: g?.title || "Incident alert",
      description: [
        g?.description || "",
        g?.source ? `**Source:** ${g.source}` : "",
        g?.tags?.length ? `**Tags:** ${g.tags.join(", ")}` : "",
      ]
        .join("\n")
        .trim(),
      severity: sevMap[g?.severity ?? "high"] ?? "high",
      repoHint: g?.repo,
      action: "trigger",
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve the target repo for an incident
// ─────────────────────────────────────────────────────────────────────────────

type RepoRow = typeof repositories.$inferSelect;
type UserRow = typeof users.$inferSelect;

async function resolveTargetRepo(
  provider: string,
  secret: string,
  repoHint?: string
): Promise<{
  repo: RepoRow;
  owner: UserRow;
  config: typeof incidentHookConfigs.$inferSelect;
} | null> {
  // Find the config row(s) matching this provider + secret
  const configs = await db
    .select()
    .from(incidentHookConfigs)
    .where(eq(incidentHookConfigs.provider, provider));

  const secretHashInput = await sha256Hex(secret);

  for (const cfg of configs) {
    if (!safeEqual(cfg.secretHash, secretHashInput)) continue;

    // Try repo hint first (if provider gave us owner/repo)
    if (repoHint) {
      const parts = repoHint.split("/");
      if (parts.length === 2) {
        const [ownerName, repoName] = parts;
        const rows = await db
          .select()
          .from(repositories)
          .innerJoin(users, eq(repositories.ownerId, users.id))
          .where(
            and(
              eq(users.username, ownerName),
              eq(repositories.name, repoName)
            )
          )
          .limit(1);
        if (rows[0]) {
          return {
            repo: rows[0].repositories,
            owner: rows[0].users,
            config: cfg,
          };
        }
      }
    }

    // Use the configured repo
    const rows = await db
      .select()
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.id, cfg.repoId))
      .limit(1);
    if (rows[0]) {
      return {
        repo: rows[0].repositories,
        owner: rows[0].users,
        config: cfg,
      };
    }
  }

  // Fallback: no config found — cannot target a repo without one.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core incident processing
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
};

async function processIncident(
  provider: string,
  incident: NormalisedIncident,
  secret: string
): Promise<{ ok: boolean; message: string }> {
  if (incident.action === "resolve") {
    return { ok: true, message: "resolve event acknowledged — no issue opened" };
  }

  // 1. Resolve repo
  const target = await resolveTargetRepo(
    provider,
    secret,
    incident.repoHint
  );
  if (!target) {
    return { ok: false, message: "no matching incident_hook_config for this secret" };
  }
  const { repo, owner } = target;

  // 2. AI analysis
  let analysis;
  try {
    analysis = await analyzeIncident({
      title: incident.title,
      description: incident.description,
      owner: owner.username,
      repo: repo.name,
      repoId: repo.id,
    });
  } catch (err) {
    console.error("[incident-hooks] analyzeIncident failed:", err);
    // Produce minimal fallback
    analysis = {
      likelyFiles: [],
      suggestedFix: "",
      issueTitle: `Incident: ${incident.title}`,
      issueBody: incident.description,
      branchName: `fix/incident-${Date.now()}`,
    };
  }

  const emoji = SEVERITY_EMOJI[incident.severity] ?? "🚨";

  // 3. Ensure "incident" label exists
  let incidentLabelId: string | null = null;
  try {
    const existing = await db
      .select()
      .from(labels)
      .where(and(eq(labels.repositoryId, repo.id), eq(labels.name, "incident")))
      .limit(1);
    if (existing[0]) {
      incidentLabelId = existing[0].id;
    } else {
      const [created] = await db
        .insert(labels)
        .values({ repositoryId: repo.id, name: "incident", color: "#e11d48" })
        .returning();
      incidentLabelId = created?.id ?? null;
    }
  } catch {
    /* best-effort */
  }

  // 4. Insert issue
  const issueTitle = `${emoji} [INCIDENT] ${analysis.issueTitle || incident.title}`;
  const issueBodyMd = [
    analysis.issueBody || incident.description,
    "",
    "---",
    "*Opened automatically by Gluecron Incident Monitor*",
  ].join("\n");

  let issueRow: typeof issues.$inferSelect | null = null;
  try {
    const [inserted] = await db
      .insert(issues)
      .values({
        repositoryId: repo.id,
        authorId: owner.id,
        title: issueTitle.slice(0, 255),
        body: issueBodyMd,
        state: "open",
      })
      .returning();
    issueRow = inserted ?? null;

    if (issueRow?.id && incidentLabelId) {
      await db
        .insert(issueLabels)
        .values({ issueId: issueRow.id, labelId: incidentLabelId })
        .catch(() => {});
    }

    // Bump issue count
    await db
      .update(repositories)
      .set({ issueCount: (repo.issueCount || 0) + 1 })
      .where(eq(repositories.id, repo.id))
      .catch(() => {});
  } catch (err) {
    console.error("[incident-hooks] issue insert failed:", err);
    return { ok: false, message: "issue insert failed" };
  }

  // 5. If AI produced a fix, create branch + fix file + draft PR
  let prNumber: number | null = null;
  if (analysis.suggestedFix && analysis.branchName) {
    try {
      const timestamp = Date.now();
      const fixFileName = `INCIDENT_FIX_${timestamp}.md`;
      const fixFileContent = [
        `# Incident Fix — ${incident.title}`,
        "",
        `**Severity:** ${incident.severity}`,
        `**Opened:** ${new Date().toISOString()}`,
        "",
        "## Description",
        incident.description,
        "",
        "## AI-Suggested Fix",
        analysis.suggestedFix,
        "",
        analysis.likelyFiles.length > 0
          ? [
              "## Likely Affected Files",
              ...analysis.likelyFiles.map(
                (f) => `- \`${f.path}\` — ${f.reason}`
              ),
            ].join("\n")
          : "",
      ]
        .join("\n")
        .trim();

      const bytes = new TextEncoder().encode(fixFileContent);
      const result = await createOrUpdateFileOnBranch({
        owner: owner.username,
        name: repo.name,
        branch: analysis.branchName,
        filePath: fixFileName,
        bytes,
        message: `fix: incident response for ${incident.title.slice(0, 72)}`,
        authorName: "Gluecron Incident Bot",
        authorEmail: "incident-bot@gluecron.local",
      });

      if (!("error" in result)) {
        const defaultBranch =
          (await getDefaultBranch(owner.username, repo.name).catch(
            () => null
          )) ||
          repo.defaultBranch ||
          "main";

        const prBody = [
          `Resolves #${issueRow?.number ?? "?"}`,
          "",
          `## Summary`,
          `Auto-generated draft PR for incident: **${incident.title}**`,
          "",
          analysis.suggestedFix,
          "",
          "---",
          "_This PR was opened automatically by Gluecron Incident Monitor. Review before merging._",
        ].join("\n");

        const [insertedPr] = await db
          .insert(pullRequests)
          .values({
            repositoryId: repo.id,
            authorId: owner.id,
            title: `fix: ${incident.title.slice(0, 120)}`,
            body: prBody,
            state: "open",
            baseBranch: defaultBranch,
            headBranch: analysis.branchName,
            isDraft: true,
          })
          .returning();
        prNumber = insertedPr?.number ?? null;
      }
    } catch (err) {
      console.error("[incident-hooks] draft PR creation failed:", err);
      // non-fatal — issue was already opened
    }
  }

  // 6. Notify repo owner + collaborators
  const notifyTitle = issueTitle.slice(0, 180);
  const notifyBody = prNumber
    ? `Issue #${issueRow?.number} opened. Draft PR #${prNumber} ready for review.`
    : `Issue #${issueRow?.number} opened.`;
  const notifyUrl = `/${owner.username}/${repo.name}/issues/${issueRow?.number}`;

  // Always notify owner
  try {
    await notify(owner.id, {
      kind: "security_alert",
      title: notifyTitle,
      body: notifyBody,
      url: notifyUrl,
      repositoryId: repo.id,
    });
  } catch {
    /* best-effort */
  }

  // Notify collaborators
  try {
    const collabs = await db
      .select({ userId: repoCollaborators.userId })
      .from(repoCollaborators)
      .where(
        and(
          eq(repoCollaborators.repositoryId, repo.id),
          isNotNull(repoCollaborators.acceptedAt)
        )
      );
    for (const c of collabs) {
      if (c.userId === owner.id) continue;
      await notify(c.userId, {
        kind: "security_alert",
        title: notifyTitle,
        body: notifyBody,
        url: notifyUrl,
        repositoryId: repo.id,
      }).catch(() => {});
    }
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    message: [
      `issue #${issueRow?.number ?? "?"} opened`,
      prNumber ? `draft PR #${prNumber} created` : "no PR (AI fix unavailable)",
    ].join(", "),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook endpoint factory
// ─────────────────────────────────────────────────────────────────────────────

function makeWebhookHandler(
  provider: string,
  normalise: (body: unknown) => NormalisedIncident | null
) {
  return async (c: Context<AuthEnv>) => {
    const secret = c.req.query("secret") || "";
    if (!secret) {
      return c.json({ error: "missing ?secret= query param" }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const incident = normalise(body);
    if (!incident) {
      return c.json({ error: "could not parse provider payload" }, 400);
    }

    // Fire async so the webhook caller gets a fast 200 ACK
    void processIncident(provider, incident, secret).then((r) => {
      console.log(
        `[incident-hooks] ${provider}: ${r.ok ? "ok" : "err"} — ${r.message}`
      );
    });

    return c.json({ received: true }, 200);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────────────

incidentHookRoutes.post(
  "/hooks/pagerduty",
  makeWebhookHandler("pagerduty", normalisePagerDuty)
);

incidentHookRoutes.post(
  "/hooks/datadog",
  makeWebhookHandler("datadog", normaliseDatadog)
);

incidentHookRoutes.post(
  "/hooks/opsgenie",
  makeWebhookHandler("opsgenie", normaliseOpsgenie)
);

incidentHookRoutes.post(
  "/hooks/incident",
  makeWebhookHandler("generic", normaliseGeneric)
);

// ─────────────────────────────────────────────────────────────────────────────
// Config page styles
// ─────────────────────────────────────────────────────────────────────────────

const ihStyles = `
  .ih-wrap { max-width: 1040px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .ih-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ih-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f43f5e 30%, #fb923c 70%, transparent 100%);
    opacity: 0.75;
  }
  .ih-hero-orb {
    position: absolute;
    inset: -30% -5% auto auto;
    width: 400px; height: 400px;
    background: radial-gradient(circle, rgba(244,63,94,0.14), rgba(251,146,60,0.08) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.6;
    pointer-events: none;
  }
  .ih-hero-inner { position: relative; z-index: 1; }
  .ih-eyebrow {
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #fb923c;
    margin-bottom: var(--space-2);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ih-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 800;
    letter-spacing: -0.024em;
    line-height: 1.1;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .ih-title-grad {
    background: linear-gradient(135deg, #f43f5e 0%, #fb923c 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ih-sub {
    font-size: 14px;
    color: var(--text-muted);
    max-width: 600px;
    line-height: 1.55;
    margin: 0;
  }

  /* timeline */
  .ih-timeline {
    display: flex;
    gap: 0;
    margin: var(--space-4) 0 0;
    flex-wrap: wrap;
    row-gap: var(--space-2);
  }
  .ih-step {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .ih-step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px; height: 20px;
    border-radius: 9999px;
    background: rgba(244,63,94,0.15);
    color: #f43f5e;
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .ih-step-arrow {
    color: var(--text-muted);
    margin: 0 6px;
    font-size: 11px;
  }

  .ih-section {
    margin-bottom: var(--space-5);
  }
  .ih-section-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 var(--space-3);
    letter-spacing: -0.015em;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* provider cards */
  .ih-providers {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .ih-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    transition: border-color 140ms ease;
  }
  .ih-card:hover { border-color: var(--border-strong); }
  .ih-card-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: var(--space-3);
  }
  .ih-provider-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px; height: 32px;
    border-radius: 8px;
    background: rgba(244,63,94,0.10);
    color: #f43f5e;
    font-size: 17px;
    flex-shrink: 0;
    box-shadow: inset 0 0 0 1px rgba(244,63,94,0.22);
  }
  .ih-card-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    color: var(--text-strong);
    letter-spacing: -0.015em;
  }
  .ih-card-desc {
    font-size: 12.5px;
    color: var(--text-muted);
    margin: 0 0 var(--space-3);
    line-height: 1.5;
  }
  .ih-url-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
    font-weight: 600;
  }
  .ih-url-box {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 7px 10px;
    color: var(--text);
    word-break: break-all;
    line-height: 1.45;
  }
  .ih-url-note {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .ih-url-note code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    background: var(--bg-tertiary);
    padding: 1px 4px;
    border-radius: 4px;
  }

  /* form card */
  .ih-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .ih-form-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ih-form-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.015em;
    margin: 0;
  }
  .ih-form-body { padding: var(--space-4) var(--space-5); }
  .ih-field { margin-bottom: var(--space-4); }
  .ih-field:last-of-type { margin-bottom: 0; }
  .ih-label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .ih-input, .ih-select {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .ih-select { font-family: inherit; }
  .ih-input:focus, .ih-select:focus {
    border-color: #f43f5e;
    box-shadow: 0 0 0 3px rgba(244,63,94,0.15);
  }
  .ih-hint {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 5px;
    line-height: 1.45;
  }
  .ih-form-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
  }
  .ih-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
    border: 1px solid transparent;
    transition: background 120ms ease, transform 120ms ease;
  }
  .ih-btn-primary {
    background: linear-gradient(135deg, #f43f5e 0%, #e11d48 100%);
    color: #fff;
    border-color: rgba(244,63,94,0.55);
    box-shadow: 0 6px 18px -6px rgba(244,63,94,0.45);
  }
  .ih-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(244,63,94,0.55);
  }
  .ih-btn-danger {
    background: rgba(248,113,113,0.08);
    border-color: rgba(248,113,113,0.30);
    color: #fca5a5;
  }
  .ih-btn-danger:hover { background: rgba(248,113,113,0.14); }

  /* existing configs table */
  .ih-configs-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
  }
  .ih-config-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    flex-wrap: wrap;
  }
  .ih-config-provider {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(244,63,94,0.12);
    color: #f43f5e;
  }
  .ih-config-repo {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    flex: 1;
    min-width: 160px;
  }
  .ih-config-actions { margin-left: auto; }

  /* banner */
  .ih-banner {
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid;
    margin-bottom: var(--space-4);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ih-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .ih-banner.is-error { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Settings page: GET /settings/incident-hooks
// ─────────────────────────────────────────────────────────────────────────────

incidentHookRoutes.use("/settings/incident-hooks", softAuth, requireAuth);

incidentHookRoutes.get("/settings/incident-hooks", async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");
  const baseUrl = process.env.APP_BASE_URL || "https://gluecron.com";

  // Load all configs for this user + their associated repos
  const rows = await db
    .select({
      config: incidentHookConfigs,
      repo: repositories,
    })
    .from(incidentHookConfigs)
    .innerJoin(repositories, eq(incidentHookConfigs.repoId, repositories.id))
    .where(eq(incidentHookConfigs.userId, user.id))
    .orderBy(desc(incidentHookConfigs.createdAt));

  // Load user's repos for the form selector
  const userRepos = await db
    .select({ id: repositories.id, name: repositories.name })
    .from(repositories)
    .where(eq(repositories.ownerId, user.id))
    .orderBy(repositories.name);

  const providers = [
    {
      id: "pagerduty",
      name: "PagerDuty",
      icon: "🚨",
      desc: "PagerDuty V2 webhooks. Point 'Extensions → Webhooks V2' at this URL.",
      endpoint: "/hooks/pagerduty",
    },
    {
      id: "datadog",
      name: "Datadog",
      icon: "📊",
      desc: "Datadog event webhooks. Add a webhook integration in your Datadog account.",
      endpoint: "/hooks/datadog",
    },
    {
      id: "opsgenie",
      name: "Opsgenie",
      icon: "🔔",
      desc: "Opsgenie webhook integration. Configure under Integrations → Webhook.",
      endpoint: "/hooks/opsgenie",
    },
    {
      id: "generic",
      name: "Generic",
      icon: "⚡",
      desc: "Custom monitoring tools. POST the generic JSON payload to this URL.",
      endpoint: "/hooks/incident",
    },
  ];

  return c.html(
    <Layout title="Incident Auto-Fix — Settings" user={user}>
      <div class="ih-wrap">
        <div class="ih-hero">
          <div class="ih-hero-orb" aria-hidden="true" />
          <div class="ih-hero-inner">
            <div class="ih-eyebrow">
              <span>⚡</span> Incident Response
            </div>
            <h1 class="ih-title">
              Alert fires. <span class="ih-title-grad">Fix PR appears.</span>
            </h1>
            <p class="ih-sub">
              Connect PagerDuty, Datadog, or Opsgenie and Gluecron will
              automatically open an issue and a draft fix PR within ~30 seconds
              of an alert firing — before you've even picked up the phone.
            </p>
            <div class="ih-timeline">
              {[
                "Alert fires",
                "Webhook received",
                "AI analyses commits",
                "Issue opened",
                "Draft PR created",
                "You're paged",
              ].map((step, i, arr) => (
                <>
                  <div class="ih-step">
                    <span class="ih-step-num">{i + 1}</span>
                    {step}
                  </div>
                  {i < arr.length - 1 && (
                    <span class="ih-step-arrow" aria-hidden="true">→</span>
                  )}
                </>
              ))}
            </div>
          </div>
        </div>

        {success && (
          <div class="ih-banner is-ok" role="status">
            ✓ {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="ih-banner is-error" role="alert">
            ✕ {decodeURIComponent(error)}
          </div>
        )}

        {/* Webhook URLs */}
        <div class="ih-section">
          <h2 class="ih-section-title">
            <span>🔗</span> Webhook URLs
          </h2>
          <div class="ih-providers">
            {providers.map((p) => (
              <div class="ih-card">
                <div class="ih-card-head">
                  <span class="ih-provider-icon" aria-hidden="true">
                    {p.icon}
                  </span>
                  <span class="ih-card-name">{p.name}</span>
                </div>
                <p class="ih-card-desc">{p.desc}</p>
                <div class="ih-url-label">Webhook URL</div>
                <div class="ih-url-box">
                  {baseUrl}{p.endpoint}?secret=YOUR_SECRET
                </div>
                <p class="ih-url-note">
                  Replace <code>YOUR_SECRET</code> with the secret you enter
                  below. Use the same secret in your monitoring provider's
                  webhook settings.
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Existing configs */}
        {rows.length > 0 && (
          <div class="ih-section">
            <h2 class="ih-section-title">
              <span>⚙️</span> Active Configurations
            </h2>
            <div class="ih-configs-list">
              {rows.map(({ config, repo }) => (
                <div class="ih-config-row">
                  <span class="ih-config-provider">{config.provider}</span>
                  <span class="ih-config-repo">
                    {user.username}/{repo.name}
                  </span>
                  <div class="ih-config-actions">
                    <form
                      method="post"
                      action="/settings/incident-hooks/delete"
                    >
                      <input type="hidden" name="id" value={config.id} />
                      <button type="submit" class="ih-btn ih-btn-danger">
                        Remove
                      </button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add new config */}
        <div class="ih-section">
          <div class="ih-form-card">
            <header class="ih-form-head">
              <h2 class="ih-form-title">Map a provider to a repo</h2>
            </header>
            <form method="post" action="/settings/incident-hooks">
              <div class="ih-form-body">
                <div class="ih-field">
                  <label class="ih-label" for="ih-provider">
                    Monitoring provider
                  </label>
                  <select id="ih-provider" class="ih-select" name="provider" required>
                    {providers.map((p) => (
                      <option value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div class="ih-field">
                  <label class="ih-label" for="ih-repo">
                    Target repository
                  </label>
                  <select id="ih-repo" class="ih-select" name="repoId" required>
                    <option value="">— choose a repo —</option>
                    {userRepos.map((r) => (
                      <option value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <p class="ih-hint">
                    Incidents from this provider will open issues + PRs in the
                    selected repo.
                  </p>
                </div>
                <div class="ih-field">
                  <label class="ih-label" for="ih-secret">
                    Webhook secret
                  </label>
                  <input
                    id="ih-secret"
                    class="ih-input"
                    type="text"
                    name="secret"
                    required
                    placeholder="your-secret-token"
                    autocomplete="off"
                    spellcheck={false}
                  />
                  <p class="ih-hint">
                    Use this same value in the <code>?secret=</code> query
                    parameter when configuring your monitoring provider. It's
                    stored as a SHA-256 hash — never in plain text.
                  </p>
                </div>
              </div>
              <div class="ih-form-foot">
                <button type="submit" class="ih-btn ih-btn-primary">
                  Save configuration
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: ihStyles }} />
    </Layout>
  );
});

// POST /settings/incident-hooks — create config
incidentHookRoutes.post(
  "/settings/incident-hooks",
  softAuth,
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const provider = String(body.provider || "").trim();
    const repoId = String(body.repoId || "").trim();
    const secret = String(body.secret || "").trim();

    if (!provider || !repoId || !secret) {
      return c.redirect(
        "/settings/incident-hooks?error=All+fields+are+required"
      );
    }

    // Verify the user owns this repo
    const [repo] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.ownerId, user.id)))
      .limit(1);
    if (!repo) {
      return c.redirect(
        "/settings/incident-hooks?error=Repository+not+found+or+not+owned+by+you"
      );
    }

    const secretHash = await sha256Hex(secret);

    await db
      .insert(incidentHookConfigs)
      .values({
        userId: user.id,
        repoId,
        provider,
        secretHash,
      })
      .onConflictDoUpdate({
        target: [incidentHookConfigs.repoId, incidentHookConfigs.provider],
        set: { secretHash, userId: user.id },
      });

    return c.redirect(
      `/settings/incident-hooks?success=${encodeURIComponent(
        `${provider} → ${repo.name} configured`
      )}`
    );
  }
);

// POST /settings/incident-hooks/delete — remove config
incidentHookRoutes.post(
  "/settings/incident-hooks/delete",
  softAuth,
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const id = String(body.id || "").trim();
    if (!id) {
      return c.redirect("/settings/incident-hooks?error=Missing+id");
    }
    await db
      .delete(incidentHookConfigs)
      .where(
        and(
          eq(incidentHookConfigs.id, id),
          eq(incidentHookConfigs.userId, user.id)
        )
      );
    return c.redirect(
      "/settings/incident-hooks?success=Configuration+removed"
    );
  }
);

export default incidentHookRoutes;

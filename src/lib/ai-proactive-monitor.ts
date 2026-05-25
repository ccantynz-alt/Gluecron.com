/**
 * AI Proactive Monitor — hourly platform-health surveillance.
 *
 * Pulls the last 24 hours of platform telemetry (audit log, platform
 * deploys, workflow runs) and asks Claude to spot anomalies — degraded
 * deploy times, recurring failures, suspicious audit patterns, etc.
 *
 * For each finding above `severity=info` it opens an issue on the
 * platform self-host repo (`SELF_HOST_REPO` env, defaults to
 * `ccantynz-alt/Gluecron.com`) tagged with the `ai:proactive-finding`
 * label. A deterministic dedupe key (sha256 of the title) is embedded
 * in the issue body as an HTML marker so the same alert never fires
 * twice in a 24h window — even across process restarts.
 *
 * Every finding is also written to `audit_log` under action
 * `ai.proactive.finding` so operators have a queryable trail of what
 * Claude noticed and when.
 *
 * Hooks into autopilot via `aiProactiveMonitorTick()` — wrapped in
 * try/catch in the registration so a single failure cannot wedge the
 * surrounding tick. Skips cleanly when:
 *   - `ANTHROPIC_API_KEY` is unset (graceful no-op).
 *   - `AUTOPILOT_DISABLED=1` (the surrounding loop never invokes us).
 *
 * Same dependency-injection seam pattern as `runAutoMergeSweep` /
 * `runAiBuildTaskOnce` — every DB / Claude / clock interaction is
 * overridable so tests don't need the DB or the AI client.
 */

import { createHash } from "crypto";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  issueLabels,
  issues,
  labels,
  repositories,
  users,
} from "../db/schema";
import { platformDeploys } from "../db/schema-deploys";
import { workflowRuns } from "../db/schema";
import {
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
  parseJsonResponse,
} from "./ai-client";
import { audit } from "./notify";

/** Default self-host repo when SELF_HOST_REPO is not configured. */
export const DEFAULT_SELF_HOST_REPO = "ccantynz-alt/Gluecron.com";

/** Label attached to every issue opened by this monitor. */
export const PROACTIVE_LABEL_NAME = "ai:proactive-finding";

/** Stable marker embedded in issue bodies for dedupe lookups. */
export const PROACTIVE_DEDUPE_MARKER_PREFIX =
  "<!-- gluecron:ai-proactive:dedupe=";
export const PROACTIVE_DEDUPE_MARKER_SUFFIX = " -->";

/** Lookback window we feed Claude — and also the dedupe horizon. */
export const PROACTIVE_LOOKBACK_HOURS = 24;

/** Hard cap on rows pulled per table so the prompt stays bounded. */
const MAX_AUDIT_ROWS = 200;
const MAX_DEPLOY_ROWS = 50;
const MAX_WORKFLOW_RUN_ROWS = 200;

/** Hard cap on issues we'll open in a single tick (runaway protection). */
const MAX_FINDINGS_PER_TICK = 5;

export type ProactiveSeverity = "info" | "warning" | "critical";

export interface ProactiveFinding {
  title: string;
  severity: ProactiveSeverity;
  body_markdown: string;
  target_url?: string | null;
}

export interface ProactiveTelemetry {
  auditLog: Array<{
    action: string;
    targetType: string | null;
    targetId: string | null;
    userId: string | null;
    repositoryId: string | null;
    createdAt: Date;
  }>;
  platformDeploys: Array<{
    runId: string;
    sha: string;
    status: string;
    durationMs: number | null;
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }>;
  workflowRuns: Array<{
    id: string;
    status: string;
    conclusion: string | null;
    event: string;
    queuedAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
  }>;
}

export interface ProactiveMonitorDeps {
  /** Override telemetry loader (DI for tests). */
  loadTelemetry?: (lookbackHours: number) => Promise<ProactiveTelemetry>;
  /** Override Claude call — returns the parsed findings array. */
  askClaude?: (
    telemetry: ProactiveTelemetry
  ) => Promise<ProactiveFinding[]>;
  /** Override the self-host repo resolver (returns null when missing). */
  resolveSelfHostRepo?: () => Promise<{
    repositoryId: string;
    ownerId: string;
  } | null>;
  /** Override dedupe lookup. Returns true if a finding with this key already exists in the lookback window. */
  isDuplicate?: (
    repositoryId: string,
    dedupeKey: string,
    lookbackHours: number
  ) => Promise<boolean>;
  /** Override the issue + label writer. Returns the new issue number. */
  createFindingIssue?: (args: {
    repositoryId: string;
    authorId: string;
    title: string;
    body: string;
  }) => Promise<number | null>;
  /** Override the audit writer (DI for tests). */
  recordAudit?: (
    finding: ProactiveFinding,
    repositoryId: string | null,
    issueNumber: number | null,
    dedupeKey: string
  ) => Promise<void>;
  /** Override clock for deterministic windows in tests. */
  now?: () => Date;
  /** Override AI-key check (lets tests run the full pipeline). */
  aiAvailable?: () => boolean;
  /** Override the per-tick cap. */
  maxFindings?: number;
}

export interface ProactiveMonitorSummary {
  considered: number;
  opened: number;
  skippedDedupe: number;
  skippedSeverity: number;
  errors: number;
}

/**
 * sha256 of the title, used as the deterministic dedupe key. Same
 * title => same key, so we can detect "already filed this in the last
 * 24h" with a single LIKE query on issue body.
 */
export function dedupeKeyForTitle(title: string): string {
  return createHash("sha256")
    .update(title.trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

function dedupeMarker(key: string): string {
  return `${PROACTIVE_DEDUPE_MARKER_PREFIX}${key}${PROACTIVE_DEDUPE_MARKER_SUFFIX}`;
}

/** Compact telemetry summary embedded in the prompt — keeps tokens bounded. */
function summariseTelemetryForPrompt(t: ProactiveTelemetry): string {
  const auditByAction = new Map<string, number>();
  for (const row of t.auditLog) {
    auditByAction.set(row.action, (auditByAction.get(row.action) || 0) + 1);
  }
  const auditLines = Array.from(auditByAction.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([action, count]) => `- ${action}: ${count}`)
    .join("\n");

  const deployLines = t.platformDeploys
    .slice(0, 30)
    .map((d) => {
      const dur = d.durationMs !== null ? `${d.durationMs}ms` : "n/a";
      const err = d.error ? ` error="${d.error.slice(0, 120)}"` : "";
      return `- run=${d.runId} sha=${d.sha.slice(0, 7)} status=${d.status} dur=${dur}${err}`;
    })
    .join("\n");

  const wfStatusCounts = new Map<string, number>();
  let durSum = 0;
  let durCount = 0;
  for (const r of t.workflowRuns) {
    const key = `${r.status}/${r.conclusion ?? "n/a"}`;
    wfStatusCounts.set(key, (wfStatusCounts.get(key) || 0) + 1);
    if (r.startedAt && r.finishedAt) {
      durSum += r.finishedAt.getTime() - r.startedAt.getTime();
      durCount += 1;
    }
  }
  const wfLines = Array.from(wfStatusCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const avgWfDuration =
    durCount > 0 ? `${Math.round(durSum / durCount)}ms (n=${durCount})` : "n/a";

  return [
    `## Audit log (${t.auditLog.length} rows, top actions)`,
    auditLines || "(none)",
    "",
    `## Platform deploys (${t.platformDeploys.length} rows, most recent first)`,
    deployLines || "(none)",
    "",
    `## Workflow runs (${t.workflowRuns.length} rows, avg duration ${avgWfDuration})`,
    wfLines || "(none)",
  ].join("\n");
}

async function defaultLoadTelemetry(
  lookbackHours: number
): Promise<ProactiveTelemetry> {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const empty: ProactiveTelemetry = {
    auditLog: [],
    platformDeploys: [],
    workflowRuns: [],
  };
  try {
    const [audits, deploys, runs] = await Promise.all([
      db
        .select({
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          userId: auditLog.userId,
          repositoryId: auditLog.repositoryId,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(gte(auditLog.createdAt, cutoff))
        .orderBy(desc(auditLog.createdAt))
        .limit(MAX_AUDIT_ROWS)
        .catch(() => [] as ProactiveTelemetry["auditLog"]),
      db
        .select({
          runId: platformDeploys.runId,
          sha: platformDeploys.sha,
          status: platformDeploys.status,
          durationMs: platformDeploys.durationMs,
          error: platformDeploys.error,
          startedAt: platformDeploys.startedAt,
          finishedAt: platformDeploys.finishedAt,
        })
        .from(platformDeploys)
        .where(gte(platformDeploys.startedAt, cutoff))
        .orderBy(desc(platformDeploys.startedAt))
        .limit(MAX_DEPLOY_ROWS)
        .catch(() => [] as ProactiveTelemetry["platformDeploys"]),
      db
        .select({
          id: workflowRuns.id,
          status: workflowRuns.status,
          conclusion: workflowRuns.conclusion,
          event: workflowRuns.event,
          queuedAt: workflowRuns.queuedAt,
          startedAt: workflowRuns.startedAt,
          finishedAt: workflowRuns.finishedAt,
        })
        .from(workflowRuns)
        .where(gte(workflowRuns.queuedAt, cutoff))
        .orderBy(desc(workflowRuns.queuedAt))
        .limit(MAX_WORKFLOW_RUN_ROWS)
        .catch(() => [] as ProactiveTelemetry["workflowRuns"]),
    ]);
    return { auditLog: audits, platformDeploys: deploys, workflowRuns: runs };
  } catch (err) {
    console.error("[ai-proactive] telemetry load failed:", err);
    return empty;
  }
}

async function defaultAskClaude(
  telemetry: ProactiveTelemetry
): Promise<ProactiveFinding[]> {
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `You are monitoring Gluecron's own platform health. Here is the last ${PROACTIVE_LOOKBACK_HOURS}h of telemetry. Spot anomalies — degraded deploy times, recurring failures, suspicious audit patterns, memory-leak suspects in long-running workers, abnormal workflow run durations, repeated permission denials, etc.

For each finding, return an entry in a JSON array of the form:

{"findings": [
  {
    "title": "<one-line problem summary, prefixed with the affected subsystem>",
    "severity": "info" | "warning" | "critical",
    "body_markdown": "<2-6 paragraphs of markdown: what you saw, why it might matter, suggested next step>",
    "target_url": "<optional admin URL the operator should visit, or null>"
  }
]}

Return ONLY the JSON. If nothing looks anomalous, return {"findings": []}. Do not invent findings — silence is the correct answer for a healthy platform.

Telemetry follows:

${summariseTelemetryForPrompt(telemetry)}`,
        },
      ],
    });
    try {
      const { recordAiCost, extractUsage } = await import("./ai-cost-tracker");
      const usage = extractUsage(message);
      await recordAiCost({
        model: MODEL_SONNET,
        inputTokens: usage.input,
        outputTokens: usage.output,
        category: "other",
        sourceKind: "proactive_monitor",
      });
    } catch {
      /* swallow — best-effort */
    }
    const parsed = parseJsonResponse<{ findings: ProactiveFinding[] }>(
      extractText(message)
    );
    if (!parsed || !Array.isArray(parsed.findings)) return [];
    return parsed.findings.filter(
      (f) =>
        typeof f.title === "string" &&
        f.title.trim().length > 0 &&
        typeof f.body_markdown === "string" &&
        (f.severity === "info" ||
          f.severity === "warning" ||
          f.severity === "critical")
    );
  } catch (err) {
    console.error("[ai-proactive] Claude call failed:", err);
    return [];
  }
}

async function defaultResolveSelfHostRepo(): Promise<{
  repositoryId: string;
  ownerId: string;
} | null> {
  const fullName = process.env.SELF_HOST_REPO || DEFAULT_SELF_HOST_REPO;
  const [ownerName, repoName] = fullName.includes("/")
    ? fullName.split("/")
    : [fullName, "Gluecron.com"];
  try {
    const [row] = await db
      .select({
        repositoryId: repositories.id,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[ai-proactive] self-host repo resolve failed:", err);
    return null;
  }
}

async function defaultIsDuplicate(
  repositoryId: string,
  dedupeKey: string,
  lookbackHours: number
): Promise<boolean> {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  try {
    const [row] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, repositoryId),
          gte(issues.createdAt, cutoff),
          like(issues.body, `%${dedupeMarker(dedupeKey)}%`)
        )
      )
      .limit(1);
    return !!row;
  } catch (err) {
    console.error("[ai-proactive] dedupe lookup failed:", err);
    // Fail-closed on dedupe: pretend it's a duplicate so we don't double-fire.
    return true;
  }
}

/** Best-effort label upsert — returns the label id or null. */
async function ensureProactiveLabel(
  repositoryId: string
): Promise<string | null> {
  try {
    const [existing] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          eq(labels.repositoryId, repositoryId),
          eq(labels.name, PROACTIVE_LABEL_NAME)
        )
      )
      .limit(1);
    if (existing) return existing.id;
    const [inserted] = await db
      .insert(labels)
      .values({
        repositoryId,
        name: PROACTIVE_LABEL_NAME,
        color: "#a371f7",
        description: "Auto-filed by the AI proactive monitor.",
      })
      .returning({ id: labels.id });
    return inserted?.id ?? null;
  } catch (err) {
    console.error("[ai-proactive] label ensure failed:", err);
    return null;
  }
}

async function defaultCreateFindingIssue(args: {
  repositoryId: string;
  authorId: string;
  title: string;
  body: string;
}): Promise<number | null> {
  try {
    const [inserted] = await db
      .insert(issues)
      .values({
        repositoryId: args.repositoryId,
        authorId: args.authorId,
        title: args.title,
        body: args.body,
        state: "open",
      })
      .returning({ id: issues.id, number: issues.number });
    if (!inserted) return null;
    const labelId = await ensureProactiveLabel(args.repositoryId);
    if (labelId) {
      await db
        .insert(issueLabels)
        .values({ issueId: inserted.id, labelId })
        .catch(() => {
          /* duplicate label link — ignore */
        });
    }
    return inserted.number ?? null;
  } catch (err) {
    console.error("[ai-proactive] issue insert failed:", err);
    return null;
  }
}

async function defaultRecordAudit(
  finding: ProactiveFinding,
  repositoryId: string | null,
  issueNumber: number | null,
  dedupeKey: string
): Promise<void> {
  await audit({
    repositoryId: repositoryId ?? undefined,
    action: "ai.proactive.finding",
    targetType: issueNumber !== null ? "issue" : undefined,
    targetId: issueNumber !== null ? String(issueNumber) : undefined,
    metadata: {
      title: finding.title,
      severity: finding.severity,
      dedupeKey,
      targetUrl: finding.target_url ?? null,
    },
  });
}

/**
 * One iteration of the proactive monitor. Never throws. Returns a
 * summary suitable for the autopilot tick log.
 *
 * Pipeline:
 *   1. Skip if AI is unavailable (no ANTHROPIC_API_KEY).
 *   2. Resolve the self-host repo (env override + sensible default).
 *   3. Load 24h of telemetry (audit + platform deploys + workflow runs).
 *   4. Ask Claude for findings as structured JSON.
 *   5. For each finding above severity=info:
 *        - Skip if a duplicate (sha256 of title) was filed in the last 24h.
 *        - Open an issue tagged `ai:proactive-finding` with the dedupe marker.
 *        - Record an `ai.proactive.finding` audit row.
 */
export async function aiProactiveMonitorTick(
  deps: ProactiveMonitorDeps = {}
): Promise<ProactiveMonitorSummary> {
  const aiAvailable = deps.aiAvailable ?? isAiAvailable;
  const summary: ProactiveMonitorSummary = {
    considered: 0,
    opened: 0,
    skippedDedupe: 0,
    skippedSeverity: 0,
    errors: 0,
  };

  if (!aiAvailable()) {
    return summary;
  }

  const loadTelemetry = deps.loadTelemetry ?? defaultLoadTelemetry;
  const askClaude = deps.askClaude ?? defaultAskClaude;
  const resolveSelfHostRepo =
    deps.resolveSelfHostRepo ?? defaultResolveSelfHostRepo;
  const isDuplicate = deps.isDuplicate ?? defaultIsDuplicate;
  const createFindingIssue =
    deps.createFindingIssue ?? defaultCreateFindingIssue;
  const recordAudit = deps.recordAudit ?? defaultRecordAudit;
  const maxFindings = deps.maxFindings ?? MAX_FINDINGS_PER_TICK;

  let repo: { repositoryId: string; ownerId: string } | null = null;
  try {
    repo = await resolveSelfHostRepo();
  } catch (err) {
    console.error("[ai-proactive] resolveSelfHostRepo threw:", err);
    summary.errors += 1;
    return summary;
  }
  if (!repo) {
    console.warn(
      "[ai-proactive] self-host repo not found; skipping tick (set SELF_HOST_REPO to the owner/name of the platform repo)"
    );
    return summary;
  }

  let telemetry: ProactiveTelemetry;
  try {
    telemetry = await loadTelemetry(PROACTIVE_LOOKBACK_HOURS);
  } catch (err) {
    console.error("[ai-proactive] loadTelemetry threw:", err);
    summary.errors += 1;
    return summary;
  }

  let findings: ProactiveFinding[] = [];
  try {
    findings = await askClaude(telemetry);
  } catch (err) {
    console.error("[ai-proactive] askClaude threw:", err);
    summary.errors += 1;
    return summary;
  }

  for (const finding of findings.slice(0, maxFindings)) {
    summary.considered += 1;
    try {
      if (finding.severity === "info") {
        summary.skippedSeverity += 1;
        continue;
      }
      const dedupeKey = dedupeKeyForTitle(finding.title);
      const dup = await isDuplicate(
        repo.repositoryId,
        dedupeKey,
        PROACTIVE_LOOKBACK_HOURS
      );
      if (dup) {
        summary.skippedDedupe += 1;
        continue;
      }
      const body = renderFindingBody(finding, dedupeKey);
      const issueNumber = await createFindingIssue({
        repositoryId: repo.repositoryId,
        authorId: repo.ownerId,
        title: finding.title.slice(0, 200),
        body,
      });
      if (issueNumber !== null) {
        summary.opened += 1;
      } else {
        summary.errors += 1;
      }
      // Audit fires regardless of issue-insert success so we still have a
      // trail of what Claude flagged.
      await recordAudit(finding, repo.repositoryId, issueNumber, dedupeKey);
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[ai-proactive] per-finding failure for "${finding.title}":`,
        err
      );
    }
  }

  if (findings.length > maxFindings) {
    // Count the overflow under `skippedSeverity` since we never even
    // looked at them — keeps the summary surface flat (no need for a
    // separate "overflow" counter for an autopilot log line).
    summary.skippedSeverity += findings.length - maxFindings;
  }

  console.log(
    `[ai-proactive] tick considered=${summary.considered} opened=${summary.opened} dedup=${summary.skippedDedupe} skipped=${summary.skippedSeverity} errors=${summary.errors}`
  );
  return summary;
}

/**
 * Pure helper — renders the issue body markdown for a single finding,
 * including the dedupe marker. Exported so tests can pin the format
 * without an Anthropic call.
 */
export function renderFindingBody(
  finding: ProactiveFinding,
  dedupeKey: string
): string {
  const sevBadge =
    finding.severity === "critical"
      ? "**Severity:** :rotating_light: critical"
      : finding.severity === "warning"
        ? "**Severity:** :warning: warning"
        : "**Severity:** :information_source: info";
  const target = finding.target_url
    ? `**Suggested admin URL:** ${finding.target_url}`
    : "";
  return [
    dedupeMarker(dedupeKey),
    "_Filed automatically by the GlueCron AI proactive monitor._",
    "",
    sevBadge,
    target,
    "",
    finding.body_markdown.trim(),
    "",
    "---",
    `_Dedupe key: \`${dedupeKey}\`. The same finding will not be re-filed for ${PROACTIVE_LOOKBACK_HOURS}h._`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Test-only export of internals. */
export const __test = {
  summariseTelemetryForPrompt,
  defaultLoadTelemetry,
  defaultResolveSelfHostRepo,
  defaultIsDuplicate,
  defaultCreateFindingIssue,
  defaultRecordAudit,
  dedupeMarker,
  ensureProactiveLabel,
  MAX_FINDINGS_PER_TICK,
};

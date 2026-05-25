/**
 * Advancement Scanner — weekly Claude-driven scan for "what we should
 * ship next".
 *
 * Four independent best-effort probes:
 *
 *   1. **Model releases** — pull a small curated list of currently-known
 *      Claude models (kept in code; cheap and offline), compare against
 *      the model the platform is wired to (`MODEL_SONNET` / `MODEL_HAIKU`
 *      in `ai-client.ts`). Newer/cheaper alternatives become a finding.
 *
 *   2. **Stack version scan** — read `package.json` from disk, fetch
 *      each major dependency's latest npm version, flag anything >1
 *      major behind. Dependencies that look like a trivial bump are
 *      handed straight to `proposeMajorMigration` for an auto-PR; the
 *      rest become advisory findings.
 *
 *   3. **Self-improvement opportunities** — feed the last 7 days of
 *      `audit_log` + `platform_deploys` summaries to Claude and ask
 *      "what slow/broken/painful patterns recur?". Claude returns a
 *      JSON array of suggested improvements.
 *
 *   4. **Trending features** — a curated in-code list of "what
 *      competitors shipped this week" is summarised through Claude with
 *      "which of these should Gluecron prioritize?".
 *
 * Each finding is persisted in two ways:
 *   - As an `audit_log` row under `ai.advancement.finding` (always).
 *   - As an issue on the self-host repo under the `ai:advancement`
 *     label (when `openIssue` returns a number).
 *
 * Dedupe is by sha256(title) within a 30-day window. Stable marker
 * `<!-- gluecron:advancement:dedupe=... -->` is embedded in the issue
 * body so a single LIKE query catches repeats.
 *
 * Wired into autopilot as the `advancement-scanner` task (cadence-gated
 * to once a week, default Monday 08:00 UTC).
 */

import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
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
import {
  MODEL_HAIKU,
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
  parseJsonResponse,
} from "./ai-client";
import { audit } from "./notify";
import { parseManifest } from "./dep-updater";
import {
  proposeMajorMigration,
  recentlyProposed,
  detectMajorBump,
} from "./migration-assistant";
import { resolveRef } from "../git/repository";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ADVANCEMENT_AUDIT_ACTION = "ai.advancement.finding";
export const ADVANCEMENT_SCAN_COMPLETE_ACTION = "ai.advancement.scan_complete";
export const ADVANCEMENT_LABEL_NAME = "ai:advancement";
export const ADVANCEMENT_DEDUPE_MARKER_PREFIX =
  "<!-- gluecron:advancement:dedupe=";
export const ADVANCEMENT_DEDUPE_MARKER_SUFFIX = " -->";

/** Dedupe horizon — same title (sha256) won't be re-proposed for 30 days. */
export const ADVANCEMENT_DEDUPE_DAYS = 30;

/** Hard cap on findings persisted per scan (runaway protection). */
export const MAX_ADVANCEMENT_FINDINGS_PER_SCAN = 12;

/** Default self-host repo when SELF_HOST_REPO is not configured. */
export const ADVANCEMENT_DEFAULT_SELF_HOST_REPO = "ccantynz-alt/Gluecron.com";

/** Lookback for the self-improvement signal — last 7 days. */
export const ADVANCEMENT_SELF_IMPROVE_LOOKBACK_DAYS = 7;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AdvancementKind =
  | "model_release"
  | "stack_bump"
  | "self_improvement"
  | "trending_feature";

export type AdvancementUrgency = "low" | "medium" | "high";

export interface AdvancementFinding {
  kind: AdvancementKind;
  title: string;
  urgency: AdvancementUrgency;
  suggested_action: string;
  /** Optional rich body (markdown). When absent we synthesize from action. */
  body_markdown?: string;
  /** When a stack_bump finding can be auto-PR'd, this carries the dep+target. */
  bump?: {
    dependency: string;
    fromVersion: string;
    toVersion: string;
  } | null;
}

export interface AdvancementScanResult {
  findings: AdvancementFinding[];
  /** Issues we actually opened on the self-host repo. */
  openedIssues: number;
  /** Stack-bump PRs the migration assistant kicked off. */
  openedPrs: number;
  /** Findings skipped because they were filed in the dedupe window. */
  skippedDedupe: number;
  /** Per-probe failure count — bookkeeping for autopilot summary lines. */
  errors: number;
}

// ---------------------------------------------------------------------------
// Curated reference data — kept in code so we have a deterministic baseline
// even when the upstream sources are flaky / offline.
// ---------------------------------------------------------------------------

/**
 * Known Claude models with their cost + capability hints. Update this
 * list as Anthropic ships new models — the scanner compares against the
 * currently-wired model in `ai-client.ts` to suggest upgrades.
 *
 * Cost units are arbitrary "relative dollars per million tokens" — only
 * the ordering matters for the comparison. Capability is also a relative
 * score; higher = stronger.
 */
export interface ClaudeModelEntry {
  id: string;
  family: "sonnet" | "haiku" | "opus";
  generation: number;
  /** Higher = better/newer. Used to detect "newer than configured". */
  capability: number;
  /** Lower = cheaper. Used to detect "cheaper than configured". */
  cost: number;
  /** Human-friendly label for the finding body. */
  label: string;
}

/**
 * Default curated list. Centralised so tests can pin a copy or override
 * via the `models` dep. The capability/cost numbers are tuned so the
 * scanner's logic is deterministic but they're not a fact-table — when
 * a new model ships, bump this list.
 */
export const KNOWN_CLAUDE_MODELS: ClaudeModelEntry[] = [
  // Sonnet 4 family
  { id: "claude-sonnet-4-20250514", family: "sonnet", generation: 4, capability: 80, cost: 30, label: "Claude Sonnet 4 (May 2025)" },
  { id: "claude-sonnet-4-5", family: "sonnet", generation: 4.5, capability: 86, cost: 30, label: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4-6", family: "sonnet", generation: 4.6, capability: 90, cost: 30, label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-7", family: "sonnet", generation: 4.7, capability: 92, cost: 30, label: "Claude Sonnet 4.7" },
  // Haiku 4 family
  { id: "claude-haiku-4-5-20251001", family: "haiku", generation: 4.5, capability: 60, cost: 10, label: "Claude Haiku 4.5 (Oct 2025)" },
  { id: "claude-haiku-4-7", family: "haiku", generation: 4.7, capability: 70, cost: 8, label: "Claude Haiku 4.7" },
  // Opus 4 family
  { id: "claude-opus-4-7", family: "opus", generation: 4.7, capability: 100, cost: 60, label: "Claude Opus 4.7" },
];

/**
 * Curated competitor-features list. Update as you spot relevant launches.
 * The point of this list is to be the prompt context that lets Claude
 * pick the few worth prioritising. Keep entries short + factual.
 */
export const TRENDING_FEATURE_CATALOGUE: Array<{ source: string; feature: string }> = [
  { source: "GitHub", feature: "Repo-level AI custom instructions for Copilot reviewers." },
  { source: "GitLab", feature: "Per-MR auto-summary that updates as new commits land." },
  { source: "Linear", feature: "Cycle-end AI velocity reports posted into Slack." },
  { source: "Gitea", feature: "Built-in OIDC issuer for CI runners; remove static PATs." },
  { source: "Sentry", feature: "Auto-resolve issues when the suspect commit is reverted." },
  { source: "Vercel", feature: "Preview deploys carry per-PR observability dashboards." },
  { source: "Fly.io", feature: "Built-in rolling restart with health-gate per machine." },
  { source: "Render", feature: "Auto-rollback when post-deploy synthetic check goes red." },
];

// ---------------------------------------------------------------------------
// Helpers — pure
// ---------------------------------------------------------------------------

/** sha256 of the title — deterministic dedupe key. */
export function advancementDedupeKey(title: string): string {
  return createHash("sha256")
    .update(title.trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

function dedupeMarker(key: string): string {
  return `${ADVANCEMENT_DEDUPE_MARKER_PREFIX}${key}${ADVANCEMENT_DEDUPE_MARKER_SUFFIX}`;
}

/**
 * Render the issue body markdown for an advancement finding. Pure helper
 * — exported so tests can pin the format.
 */
export function renderAdvancementBody(
  finding: AdvancementFinding,
  dedupeKey: string
): string {
  const urgencyBadge =
    finding.urgency === "high"
      ? "**Urgency:** :red_circle: high"
      : finding.urgency === "medium"
        ? "**Urgency:** :large_orange_diamond: medium"
        : "**Urgency:** :white_circle: low";
  const kindLabel =
    finding.kind === "model_release"
      ? "Model release"
      : finding.kind === "stack_bump"
        ? "Stack version bump"
        : finding.kind === "self_improvement"
          ? "Self-improvement opportunity"
          : "Trending feature";
  const body =
    finding.body_markdown?.trim() || finding.suggested_action.trim();
  return [
    dedupeMarker(dedupeKey),
    "_Filed automatically by the Gluecron AI advancement scanner._",
    "",
    `**Kind:** ${kindLabel}`,
    urgencyBadge,
    "",
    "### Suggested action",
    finding.suggested_action.trim(),
    "",
    "### Details",
    body,
    "",
    "---",
    `_Dedupe key: \`${dedupeKey}\`. The same advancement will not be re-filed for ${ADVANCEMENT_DEDUPE_DAYS} days._`,
  ].join("\n");
}

/**
 * Compare a configured model id against the curated list and return up to
 * two suggestions: a strict upgrade (more capable, same/lower cost) and a
 * cheaper-better alternative (more capable AND cheaper) if available.
 * Pure — no I/O.
 */
export function suggestModelUpgrades(
  configuredId: string,
  catalogue: ClaudeModelEntry[] = KNOWN_CLAUDE_MODELS
): AdvancementFinding[] {
  const current = catalogue.find((m) => m.id === configuredId);
  if (!current) {
    // Configured model isn't in our catalogue → it might be a retired ID.
    // Suggest the strongest in the same family if we can guess it.
    const familyGuess: ClaudeModelEntry["family"] | null = configuredId.includes("opus")
      ? "opus"
      : configuredId.includes("haiku")
        ? "haiku"
        : configuredId.includes("sonnet")
          ? "sonnet"
          : null;
    if (!familyGuess) return [];
    const best = catalogue
      .filter((m) => m.family === familyGuess)
      .sort((a, b) => b.capability - a.capability)[0];
    if (!best || best.id === configuredId) return [];
    return [
      {
        kind: "model_release",
        title: `Upgrade configured Claude model to ${best.label}`,
        urgency: "medium",
        suggested_action: `Replace \`${configuredId}\` with \`${best.id}\` in ai-client.ts (and any pinned references). Catalogue entry: ${best.label}.`,
      },
    ];
  }

  const findings: AdvancementFinding[] = [];
  const sameFamilyBetter = catalogue
    .filter((m) => m.family === current.family && m.capability > current.capability)
    .sort((a, b) => b.capability - a.capability);
  if (sameFamilyBetter[0]) {
    const target = sameFamilyBetter[0];
    findings.push({
      kind: "model_release",
      title: `Upgrade ${current.label} → ${target.label}`,
      urgency: "medium",
      suggested_action: `Bump \`${current.id}\` to \`${target.id}\` in ai-client.ts. ${target.label} is the latest in the ${current.family} family and is +${target.capability - current.capability} capability over the currently-configured model.`,
    });
  }

  const cheaperBetter = catalogue
    .filter(
      (m) =>
        m.family === current.family &&
        m.capability >= current.capability &&
        m.cost < current.cost &&
        m.id !== current.id
    )
    .sort((a, b) => a.cost - b.cost);
  if (cheaperBetter[0]) {
    const target = cheaperBetter[0];
    findings.push({
      kind: "model_release",
      title: `Save cost by moving to ${target.label}`,
      urgency: "low",
      suggested_action: `Consider \`${target.id}\` — same/better capability at lower cost (${target.cost} vs ${current.cost} relative units).`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Helpers — I/O
// ---------------------------------------------------------------------------

/** Read this repo's own package.json from disk. Returns null on failure. */
export async function readLocalPackageJson(): Promise<string | null> {
  try {
    const path = join(process.cwd(), "package.json");
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Fetch the latest version of a package from npm. Best-effort with 5s
 * timeout — never throws.
 */
export async function fetchNpmLatest(pkg: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const safe = encodeURIComponent(pkg).replace(/%40/g, "@");
      const res = await fetch(`https://registry.npmjs.org/${safe}/latest`, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: unknown };
      return typeof data.version === "string" ? data.version : null;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dependency injection seam
// ---------------------------------------------------------------------------

export interface AdvancementScanDeps {
  /** Override AI key check (DI for tests). */
  aiAvailable?: () => boolean;
  /** Override the package.json reader. */
  loadPackageJson?: () => Promise<string | null>;
  /** Override the npm-latest lookup. */
  fetchLatestVersion?: (name: string) => Promise<string | null>;
  /** Override the curated model catalogue. */
  modelCatalogue?: ClaudeModelEntry[];
  /** Override the configured-models reader (returns the ids we'd compare). */
  configuredModels?: () => string[];
  /** Override the self-improvement Claude call. */
  askSelfImprovement?: (
    summary: string
  ) => Promise<AdvancementFinding[]>;
  /** Override the trending-features Claude call. */
  askTrending?: (
    catalogue: typeof TRENDING_FEATURE_CATALOGUE
  ) => Promise<AdvancementFinding[]>;
  /** Override the self-host repo resolver. */
  resolveSelfHostRepo?: () => Promise<{
    repositoryId: string;
    ownerId: string;
    ownerName: string;
    repoName: string;
    defaultBranch: string | null;
  } | null>;
  /** Override dedupe lookup. */
  isDuplicate?: (
    repositoryId: string,
    dedupeKey: string,
    days: number
  ) => Promise<boolean>;
  /** Override issue creation. */
  openIssue?: (args: {
    repositoryId: string;
    authorId: string;
    title: string;
    body: string;
  }) => Promise<number | null>;
  /** Override audit writer. */
  recordAudit?: (
    finding: AdvancementFinding,
    repositoryId: string | null,
    issueNumber: number | null,
    dedupeKey: string
  ) => Promise<void>;
  /** Override the migration-assistant kickoff for stack bumps. */
  proposeBumpPr?: (args: {
    repositoryId: string;
    dependency: string;
    fromVersion: string;
    toVersion: string;
    baseSha: string;
  }) => Promise<{ branch: string; prNumber: number } | null>;
  /**
   * Override the base-sha resolver for stack bumps. Tests pass a fixed
   * value to avoid spawning git. Default reads the default branch HEAD.
   */
  resolveBaseSha?: (
    ownerName: string,
    repoName: string,
    branch: string
  ) => Promise<string | null>;
  /** Override the per-scan cap. */
  maxFindings?: number;
  /** Override the audit-trail "scan complete" writer. */
  recordScanComplete?: (result: AdvancementScanResult) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default implementations of the DI seams
// ---------------------------------------------------------------------------

function defaultConfiguredModels(): string[] {
  return [MODEL_SONNET, MODEL_HAIKU];
}

async function defaultAskSelfImprovement(
  summary: string
): Promise<AdvancementFinding[]> {
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `You are reviewing Gluecron's last ${ADVANCEMENT_SELF_IMPROVE_LOOKBACK_DAYS} days of platform telemetry. Identify recurring slow / broken / painful patterns and suggest concrete improvements.

Respond ONLY with JSON of the form:

{"findings": [
  {
    "title": "<one-line summary, leading verb>",
    "urgency": "low" | "medium" | "high",
    "suggested_action": "<single concrete next step the team can take>",
    "body_markdown": "<optional 1-3 paragraphs of context>"
  }
]}

Limit to the top 3 highest-leverage improvements. Return {"findings": []} if nothing stands out — silence is correct for a healthy platform.

Telemetry summary:

${summary}`,
        },
      ],
    });
    const parsed = parseJsonResponse<{ findings: AdvancementFinding[] }>(
      extractText(message)
    );
    if (!parsed || !Array.isArray(parsed.findings)) return [];
    return parsed.findings
      .filter(isPlausibleClaudeFinding)
      .map((f) => ({ ...f, kind: "self_improvement" as const }));
  } catch (err) {
    console.warn(
      "[advancement-scanner] self-improvement Claude call failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

async function defaultAskTrending(
  catalogue: typeof TRENDING_FEATURE_CATALOGUE
): Promise<AdvancementFinding[]> {
  try {
    const client = getAnthropic();
    const list = catalogue
      .map((c, i) => `${i + 1}. [${c.source}] ${c.feature}`)
      .join("\n");
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: `Below is a curated list of features competitors in the dev-platform space shipped recently. Which 0-3 of these should Gluecron (an AI-native, self-hostable git platform) prioritize next?

Respond ONLY with JSON:

{"findings": [
  {
    "title": "<verb-leading one-line proposal>",
    "urgency": "low" | "medium" | "high",
    "suggested_action": "<concrete first step>",
    "body_markdown": "<1-2 paragraphs of rationale>"
  }
]}

Return {"findings": []} if none of them are a good fit.

Catalogue:
${list}`,
        },
      ],
    });
    const parsed = parseJsonResponse<{ findings: AdvancementFinding[] }>(
      extractText(message)
    );
    if (!parsed || !Array.isArray(parsed.findings)) return [];
    return parsed.findings
      .filter(isPlausibleClaudeFinding)
      .map((f) => ({ ...f, kind: "trending_feature" as const }));
  } catch (err) {
    console.warn(
      "[advancement-scanner] trending Claude call failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/** Validate Claude's per-finding shape — drop garbage rows quietly. */
function isPlausibleClaudeFinding(f: unknown): f is AdvancementFinding {
  if (!f || typeof f !== "object") return false;
  const x = f as Record<string, unknown>;
  if (typeof x.title !== "string" || x.title.trim().length === 0) return false;
  if (typeof x.suggested_action !== "string") return false;
  if (
    x.urgency !== "low" &&
    x.urgency !== "medium" &&
    x.urgency !== "high"
  ) {
    return false;
  }
  return true;
}

async function defaultResolveSelfHostRepo(): Promise<{
  repositoryId: string;
  ownerId: string;
  ownerName: string;
  repoName: string;
  defaultBranch: string | null;
} | null> {
  const fullName =
    process.env.SELF_HOST_REPO || ADVANCEMENT_DEFAULT_SELF_HOST_REPO;
  const [ownerName, repoName] = fullName.includes("/")
    ? fullName.split("/")
    : [fullName, "Gluecron.com"];
  try {
    const [row] = await db
      .select({
        repositoryId: repositories.id,
        ownerId: repositories.ownerId,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);
    if (!row) return null;
    return {
      repositoryId: row.repositoryId,
      ownerId: row.ownerId,
      ownerName,
      repoName,
      defaultBranch: row.defaultBranch ?? null,
    };
  } catch (err) {
    console.warn(
      "[advancement-scanner] self-host repo resolve failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function defaultIsDuplicate(
  repositoryId: string,
  dedupeKey: string,
  days: number
): Promise<boolean> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
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
    console.warn(
      "[advancement-scanner] dedupe lookup failed:",
      err instanceof Error ? err.message : err
    );
    // Fail-closed: treat as duplicate so we don't double-file on a flaky DB.
    return true;
  }
}

async function ensureAdvancementLabel(
  repositoryId: string
): Promise<string | null> {
  try {
    const [existing] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          eq(labels.repositoryId, repositoryId),
          eq(labels.name, ADVANCEMENT_LABEL_NAME)
        )
      )
      .limit(1);
    if (existing) return existing.id;
    const [inserted] = await db
      .insert(labels)
      .values({
        repositoryId,
        name: ADVANCEMENT_LABEL_NAME,
        color: "#36c5d6",
        description: "Auto-filed by the AI advancement scanner.",
      })
      .returning({ id: labels.id });
    return inserted?.id ?? null;
  } catch (err) {
    console.warn(
      "[advancement-scanner] label ensure failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function defaultOpenIssue(args: {
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
    const labelId = await ensureAdvancementLabel(args.repositoryId);
    if (labelId) {
      await db
        .insert(issueLabels)
        .values({ issueId: inserted.id, labelId })
        .catch(() => {});
    }
    return inserted.number ?? null;
  } catch (err) {
    console.warn(
      "[advancement-scanner] issue insert failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function defaultRecordAudit(
  finding: AdvancementFinding,
  repositoryId: string | null,
  issueNumber: number | null,
  dedupeKey: string
): Promise<void> {
  await audit({
    repositoryId: repositoryId ?? undefined,
    action: ADVANCEMENT_AUDIT_ACTION,
    targetType: issueNumber !== null ? "issue" : undefined,
    targetId: issueNumber !== null ? String(issueNumber) : undefined,
    metadata: {
      kind: finding.kind,
      title: finding.title,
      urgency: finding.urgency,
      dedupeKey,
      bump: finding.bump ?? null,
    },
  });
}

async function defaultRecordScanComplete(
  result: AdvancementScanResult
): Promise<void> {
  await audit({
    action: ADVANCEMENT_SCAN_COMPLETE_ACTION,
    metadata: {
      totalFindings: result.findings.length,
      openedIssues: result.openedIssues,
      openedPrs: result.openedPrs,
      skippedDedupe: result.skippedDedupe,
      errors: result.errors,
      byKind: countByKind(result.findings),
    },
  });
}

function countByKind(
  findings: AdvancementFinding[]
): Record<AdvancementKind, number> {
  const out: Record<AdvancementKind, number> = {
    model_release: 0,
    stack_bump: 0,
    self_improvement: 0,
    trending_feature: 0,
  };
  for (const f of findings) out[f.kind] += 1;
  return out;
}

async function defaultProposeBumpPr(args: {
  repositoryId: string;
  dependency: string;
  fromVersion: string;
  toVersion: string;
  baseSha: string;
}): Promise<{ branch: string; prNumber: number } | null> {
  try {
    return await proposeMajorMigration({
      repositoryId: args.repositoryId,
      dependency: args.dependency,
      fromVersion: args.fromVersion,
      toVersion: args.toVersion,
      baseSha: args.baseSha,
    });
  } catch (err) {
    console.warn(
      "[advancement-scanner] proposeBumpPr failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Telemetry summarisation for the self-improvement probe
// ---------------------------------------------------------------------------

async function loadSelfImprovementSummary(): Promise<string> {
  const cutoff = new Date(
    Date.now() - ADVANCEMENT_SELF_IMPROVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );
  let auditRows: Array<{ action: string }> = [];
  let deployRows: Array<{
    status: string;
    durationMs: number | null;
    error: string | null;
  }> = [];
  try {
    auditRows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(gte(auditLog.createdAt, cutoff))
      .orderBy(desc(auditLog.createdAt))
      .limit(500);
  } catch (err) {
    console.warn(
      "[advancement-scanner] audit summary load failed:",
      err instanceof Error ? err.message : err
    );
  }
  try {
    deployRows = await db
      .select({
        status: platformDeploys.status,
        durationMs: platformDeploys.durationMs,
        error: platformDeploys.error,
      })
      .from(platformDeploys)
      .where(gte(platformDeploys.startedAt, cutoff))
      .orderBy(desc(platformDeploys.startedAt))
      .limit(100);
  } catch (err) {
    console.warn(
      "[advancement-scanner] deploy summary load failed:",
      err instanceof Error ? err.message : err
    );
  }
  const byAction = new Map<string, number>();
  for (const r of auditRows) {
    byAction.set(r.action, (byAction.get(r.action) || 0) + 1);
  }
  const auditLines = Array.from(byAction.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const failed = deployRows.filter((d) => d.status === "failed");
  const durs = deployRows
    .map((d) => d.durationMs)
    .filter((d): d is number => typeof d === "number");
  const avgDur =
    durs.length > 0
      ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length)
      : null;
  const recentErrors = failed
    .slice(0, 8)
    .map((d) => `- ${d.error?.slice(0, 140) ?? "(no message)"}`)
    .join("\n");
  return [
    `## Audit log (${auditRows.length} rows in last ${ADVANCEMENT_SELF_IMPROVE_LOOKBACK_DAYS}d, top actions)`,
    auditLines || "(none)",
    "",
    `## Platform deploys (${deployRows.length} rows; ${failed.length} failed; avg duration ${avgDur ?? "n/a"}ms)`,
    recentErrors || "(no failures)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Stack bump probe
// ---------------------------------------------------------------------------

/**
 * The keystone framework dependencies we care about for "major behind"
 * detection. Everything else is left to the dep-updater watcher.
 */
export const STACK_KEYSTONE_DEPS = [
  "hono",
  "drizzle-orm",
  "drizzle-kit",
  "@anthropic-ai/sdk",
  "postgres",
  "@neondatabase/serverless",
  "marked",
  "highlight.js",
];

async function scanStackBumps(
  loadPackageJson: () => Promise<string | null>,
  fetchLatestVersion: (name: string) => Promise<string | null>
): Promise<AdvancementFinding[]> {
  const text = await loadPackageJson();
  if (!text) return [];
  const manifest = parseManifest(text);
  const all: Record<string, string> = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  const findings: AdvancementFinding[] = [];
  for (const dep of STACK_KEYSTONE_DEPS) {
    const range = all[dep];
    if (!range) continue;
    const latest = await fetchLatestVersion(dep);
    if (!latest) continue;
    const bump = detectMajorBump(range, latest);
    if (!bump) continue;
    findings.push({
      kind: "stack_bump",
      title: `Bump ${dep} ${bump.from} → ${bump.to}`,
      urgency: "medium",
      suggested_action: `Bump \`${dep}\` from \`${bump.from}\` to \`${bump.to}\` in package.json. Major-version migration assistant should handle the call-site updates.`,
      bump: { dependency: dep, fromVersion: bump.from, toVersion: bump.to },
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run one advancement scan. Always returns a result object — never
 * throws. When AI is unavailable, the model/stack probes still run
 * (they're offline-capable) but the Claude-driven probes return empty
 * findings.
 */
export async function runAdvancementScan(
  deps: AdvancementScanDeps = {}
): Promise<AdvancementScanResult> {
  const aiAvailable = deps.aiAvailable ?? isAiAvailable;
  const loadPackageJson = deps.loadPackageJson ?? readLocalPackageJson;
  const fetchLatestVersion = deps.fetchLatestVersion ?? fetchNpmLatest;
  const modelCatalogue = deps.modelCatalogue ?? KNOWN_CLAUDE_MODELS;
  const configuredModels = deps.configuredModels ?? defaultConfiguredModels;
  const askSelfImprovement = deps.askSelfImprovement ?? defaultAskSelfImprovement;
  const askTrending = deps.askTrending ?? defaultAskTrending;
  const resolveSelfHostRepo =
    deps.resolveSelfHostRepo ?? defaultResolveSelfHostRepo;
  const isDuplicate = deps.isDuplicate ?? defaultIsDuplicate;
  const openIssue = deps.openIssue ?? defaultOpenIssue;
  const recordAudit = deps.recordAudit ?? defaultRecordAudit;
  const recordScanComplete =
    deps.recordScanComplete ?? defaultRecordScanComplete;
  const proposeBumpPr = deps.proposeBumpPr ?? defaultProposeBumpPr;
  const resolveBaseSha = deps.resolveBaseSha ?? resolveRef;
  const maxFindings =
    deps.maxFindings ?? MAX_ADVANCEMENT_FINDINGS_PER_SCAN;

  const result: AdvancementScanResult = {
    findings: [],
    openedIssues: 0,
    openedPrs: 0,
    skippedDedupe: 0,
    errors: 0,
  };

  // 1. Model-release probe (offline, always runs)
  try {
    for (const id of configuredModels()) {
      result.findings.push(...suggestModelUpgrades(id, modelCatalogue));
    }
  } catch (err) {
    result.errors += 1;
    console.warn("[advancement-scanner] model probe threw:", err);
  }

  // 2. Stack bump probe (network — best-effort)
  try {
    const bumps = await scanStackBumps(loadPackageJson, fetchLatestVersion);
    result.findings.push(...bumps);
  } catch (err) {
    result.errors += 1;
    console.warn("[advancement-scanner] stack probe threw:", err);
  }

  // 3 + 4 — Claude-driven probes. Only run when AI is wired.
  if (aiAvailable()) {
    try {
      const summary = await loadSelfImprovementSummary();
      const findings = await askSelfImprovement(summary);
      result.findings.push(...findings);
    } catch (err) {
      result.errors += 1;
      console.warn("[advancement-scanner] self-improvement probe threw:", err);
    }
    try {
      const findings = await askTrending(TRENDING_FEATURE_CATALOGUE);
      result.findings.push(...findings);
    } catch (err) {
      result.errors += 1;
      console.warn("[advancement-scanner] trending probe threw:", err);
    }
  }

  // Cap total findings so a hallucinating Claude can't blow the
  // self-host repo's issue feed.
  if (result.findings.length > maxFindings) {
    result.findings = result.findings.slice(0, maxFindings);
  }

  // Resolve self-host repo + persist each finding (issue / PR / audit).
  let repo: Awaited<ReturnType<typeof defaultResolveSelfHostRepo>> = null;
  try {
    repo = await resolveSelfHostRepo();
  } catch (err) {
    result.errors += 1;
    console.warn("[advancement-scanner] resolveSelfHostRepo threw:", err);
  }

  // Cache the base sha for stack-bump PR proposals — one lookup per scan.
  let baseSha: string | null = null;
  if (repo) {
    try {
      baseSha = await resolveBaseSha(
        repo.ownerName,
        repo.repoName,
        repo.defaultBranch || "main"
      );
    } catch (err) {
      console.warn(
        "[advancement-scanner] base sha resolve failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  for (const finding of result.findings) {
    try {
      const dedupeKey = advancementDedupeKey(finding.title);
      // 7-day per-{dep,version} migration throttle preempts any per-finding
      // dedupe — if the assistant already opened a PR this week, we skip.
      if (
        repo &&
        finding.kind === "stack_bump" &&
        finding.bump &&
        (await recentlyProposed(
          repo.repositoryId,
          finding.bump.dependency,
          finding.bump.toVersion
        ))
      ) {
        result.skippedDedupe += 1;
        continue;
      }
      // Per-finding (issue-body) dedupe — 30-day window.
      if (
        repo &&
        (await isDuplicate(repo.repositoryId, dedupeKey, ADVANCEMENT_DEDUPE_DAYS))
      ) {
        result.skippedDedupe += 1;
        continue;
      }

      // Stack-bump findings with a concrete bump payload get the
      // migration assistant kickoff. The assistant itself opens the PR.
      let issueNumber: number | null = null;
      if (
        finding.kind === "stack_bump" &&
        finding.bump &&
        repo &&
        baseSha
      ) {
        const prResult = await proposeBumpPr({
          repositoryId: repo.repositoryId,
          dependency: finding.bump.dependency,
          fromVersion: finding.bump.fromVersion,
          toVersion: finding.bump.toVersion,
          baseSha,
        });
        if (prResult) {
          result.openedPrs += 1;
        } else if (repo) {
          // Migration assistant declined (no AI / no usages / etc.) — fall
          // back to opening an advisory issue so the operator still sees it.
          const body = renderAdvancementBody(finding, dedupeKey);
          issueNumber = await openIssue({
            repositoryId: repo.repositoryId,
            authorId: repo.ownerId,
            title: finding.title.slice(0, 200),
            body,
          });
          if (issueNumber !== null) result.openedIssues += 1;
        }
      } else if (repo) {
        const body = renderAdvancementBody(finding, dedupeKey);
        issueNumber = await openIssue({
          repositoryId: repo.repositoryId,
          authorId: repo.ownerId,
          title: finding.title.slice(0, 200),
          body,
        });
        if (issueNumber !== null) result.openedIssues += 1;
      }

      await recordAudit(
        finding,
        repo?.repositoryId ?? null,
        issueNumber,
        dedupeKey
      );
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[advancement-scanner] per-finding failure for "${finding.title}":`,
        err
      );
    }
  }

  try {
    await recordScanComplete(result);
  } catch (err) {
    console.warn(
      "[advancement-scanner] recordScanComplete threw:",
      err instanceof Error ? err.message : err
    );
  }

  console.log(
    `[advancement-scanner] complete findings=${result.findings.length} issues=${result.openedIssues} prs=${result.openedPrs} dedup=${result.skippedDedupe} errors=${result.errors}`
  );

  return result;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test = {
  defaultConfiguredModels,
  defaultAskSelfImprovement,
  defaultAskTrending,
  defaultResolveSelfHostRepo,
  defaultIsDuplicate,
  defaultOpenIssue,
  defaultRecordAudit,
  defaultRecordScanComplete,
  defaultProposeBumpPr,
  ensureAdvancementLabel,
  loadSelfImprovementSummary,
  scanStackBumps,
  dedupeMarker,
  isPlausibleClaudeFinding,
  countByKind,
};

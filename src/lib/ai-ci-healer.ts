/**
 * AI CI Healer — autonomous failure → root-cause → patch PR loop.
 *
 * When a `workflow_runs` row lands in status="failure", this module:
 *   1. Pulls the run + all its `workflow_jobs` (especially the failed ones'
 *      `logs` column).
 *   2. Asks Claude to identify the root cause + whether it's fixable from
 *      inside this repo.
 *   3. If patchable, hands the suggested fixes off to the existing
 *      `generatePatchForGateTestFinding` (the finding-shape maps cleanly
 *      onto its `GateTestFinding[]` API — both surfaces want
 *      `{ path, description, severity }`).
 *   4. Records an `ai.ci.healed` or `ai.ci.gave_up` audit row keyed on the
 *      run id so the autopilot poller doesn't re-process the same failure
 *      every 5 minutes.
 *
 * Degrades silently when ANTHROPIC_API_KEY is unset (autopilot also gates
 * on the env var, but the lib double-checks so it's safe to call directly).
 * Everything is wrapped in try/catch — `analyzeFailedWorkflowRun` returns
 * `null` rather than throwing on any failure.
 *
 * Marker convention:
 *   - Successful patch open  → audit action `ai.ci.healed`, targetId = runId.
 *   - Claude says unfixable  → audit action `ai.ci.gave_up`, targetId = runId.
 * The autopilot poller skips any run that already has either marker, so we
 * never retry forever.
 */

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import {
  auditLog,
  repositories,
  workflowJobs,
  workflowRuns,
  workflows,
} from "../db/schema";
import {
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
  parseJsonResponse,
} from "./ai-client";
import { audit } from "./notify";
import {
  generatePatchForGateTestFinding,
  type GateTestFinding,
} from "./ai-patch-generator";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Cap per-job log slice we ship to Claude — protect the prompt budget. */
const LOG_SNIPPET_BYTES = 8 * 1024;

/** Hard cap on runs processed per autopilot tick — runaway protection. */
const HEAL_CAP_PER_TICK = 5;

/** Only consider runs that finished at least this long ago. Gives the
 *  workflow runner time to flush logs + final job rows before we sample. */
const HEAL_MIN_AGE_MS = 60 * 1_000;

/** Don't bother healing ancient failures — older than this and we assume
 *  the human has already triaged or the SHA has been rewritten. */
const HEAL_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface SuggestedFix {
  /** Relative path inside the repo that the AI thinks needs touching. */
  path: string;
  /** What's wrong / what the fix should look like (one-liner). */
  description: string;
  /** Severity inherited from the AI's confidence call. */
  severity?: "low" | "medium" | "high" | "critical";
}

export interface CiHealAnalysis {
  /** Plain-English root cause, 1-3 sentences. */
  rootCause: string;
  /** Concrete fix proposals (may be empty if Claude can't pinpoint files). */
  suggestedFixes: SuggestedFix[];
  /** Convenience: the paths from `suggestedFixes` deduped. */
  patchablePaths: string[];
}

export interface CiHealerTickSummary {
  considered: number;
  healed: number;
  gaveUp: number;
  skipped: number;
}

/**
 * Claude's response shape. Kept loose so we tolerate minor schema drift.
 */
interface ClaudeCiResponse {
  rootCause?: string;
  fixable?: boolean;
  suggestedFixes?: Array<{
    path?: string;
    description?: string;
    severity?: string;
  }>;
  /** Optional: Claude's reason it gave up. We just persist it for ops. */
  unfixableReason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…(truncated)";
}

function normaliseSeverity(s: unknown): SuggestedFix["severity"] | undefined {
  if (typeof s !== "string") return undefined;
  const v = s.toLowerCase();
  if (v === "low" || v === "medium" || v === "high" || v === "critical") {
    return v;
  }
  return undefined;
}

/**
 * Map our AI-derived `SuggestedFix` set onto the
 * `GateTestFinding[]` shape that `generatePatchForGateTestFinding`
 * already accepts. The patch generator only needs `{path, description,
 * severity}` — exactly what we already have. Each fix becomes one
 * candidate finding; the generator stops at the first one that produces a
 * non-empty patch set so a bad suggestion doesn't drown a good one.
 */
export function fixesToFindings(
  fixes: SuggestedFix[],
  runShortId: string
): GateTestFinding[] {
  return fixes
    .filter((f) => f.path && f.path.trim().length > 0)
    .map((f, i) => ({
      id: `ci-heal-${runShortId}-${i}`,
      ruleId: "ci-failure",
      path: f.path.trim(),
      severity: f.severity || "high",
      title: "CI failure auto-heal",
      description: f.description || "CI failure",
    }));
}

/**
 * Build the Claude prompt. Pure function so tests can pin the shape.
 */
export function buildCiHealPrompt(args: {
  repoFullName: string;
  commitSha: string;
  workflowYaml: string;
  failedJobs: Array<{ name: string; conclusion: string | null; logs: string }>;
}): string {
  const jobsBlock = args.failedJobs
    .map(
      (j) =>
        `### Job: ${j.name} (${j.conclusion || "failure"})\n\`\`\`\n${truncate(
          j.logs,
          LOG_SNIPPET_BYTES
        )}\n\`\`\``
    )
    .join("\n\n");
  return [
    "You are GlueCron's CI healer. A workflow run just failed. Decide whether the failure is a code bug fixable in THIS repository, and if so propose concrete file edits.",
    "",
    `**Repository:** ${args.repoFullName}`,
    `**Commit:** ${args.commitSha.slice(0, 12)}`,
    "",
    "## Workflow YAML",
    "```yaml",
    truncate(args.workflowYaml, 4_000),
    "```",
    "",
    "## Failed job logs",
    jobsBlock || "(no failed-job logs available)",
    "",
    "Respond ONLY with JSON of this exact shape:",
    "{",
    '  "rootCause": "1-3 sentence diagnosis (what failed, why)",',
    '  "fixable": true | false,',
    '  "suggestedFixes": [',
    '    { "path": "src/foo.ts", "description": "what to change", "severity": "high" }',
    "  ],",
    '  "unfixableReason": "(only if fixable=false) why the human must intervene"',
    "}",
    "",
    "Rules:",
    "- `fixable` MUST be false if the failure is an env/infra/external-service problem (missing secret, registry down, network, GitHub Actions runner image, etc.) — anything you can't fix by editing files in this repo.",
    "- `suggestedFixes` must be empty when fixable=false.",
    "- Only suggest paths you can identify with high confidence from the logs or YAML. Do not guess at random files.",
    "- Keep `description` short — the patch generator will be invoked with this finding to produce the actual diff.",
  ].join("\n");
}

interface FailedJobRow {
  name: string;
  conclusion: string | null;
  logs: string;
}

async function loadFailedJobs(runId: string): Promise<FailedJobRow[]> {
  try {
    const rows = await db
      .select({
        name: workflowJobs.name,
        conclusion: workflowJobs.conclusion,
        logs: workflowJobs.logs,
        status: workflowJobs.status,
      })
      .from(workflowJobs)
      .where(eq(workflowJobs.runId, runId));
    return rows
      .filter((r) => r.status === "failure" || r.conclusion === "failure")
      .map((r) => ({
        name: r.name,
        conclusion: r.conclusion,
        logs: r.logs || "",
      }));
  } catch (err) {
    console.error("[ai-ci-healer] loadFailedJobs failed:", err);
    return [];
  }
}

/**
 * Has this run already been processed (success or give-up)? We use the
 * audit log as the marker store so we don't need a schema change.
 */
async function hasMarker(runId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "workflow_run"),
          eq(auditLog.targetId, runId),
          sql`${auditLog.action} IN ('ai.ci.healed', 'ai.ci.gave_up')`
        )
      )
      .limit(1);
    return !!row;
  } catch (err) {
    console.warn("[ai-ci-healer] hasMarker query failed:", err);
    // Fail closed — if we can't check, skip to avoid duplicate work.
    return true;
  }
}

// ---------------------------------------------------------------------------
// analyzeFailedWorkflowRun — public entry point #1
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  /** Test-only Anthropic client injection. */
  client?: Pick<Anthropic, "messages">;
}

/**
 * Diagnose a failed run. Returns `null` when:
 *   - The run doesn't exist or isn't actually a failure.
 *   - ANTHROPIC_API_KEY is unset AND no client was injected.
 *   - Claude says the failure isn't fixable from this repo (env/infra).
 *   - Any DB / network step blows up (logged, swallowed).
 */
export async function analyzeFailedWorkflowRun(
  runId: string,
  opts: AnalyzeOptions = {}
): Promise<CiHealAnalysis | null> {
  // Resolve client lazily — tests inject, production reads env.
  let client: Pick<Anthropic, "messages">;
  if (opts.client) {
    client = opts.client;
  } else {
    if (!isAiAvailable()) return null;
    try {
      client = getAnthropic();
    } catch {
      return null;
    }
  }

  // Load run row.
  let run: typeof workflowRuns.$inferSelect | null = null;
  try {
    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    run = row || null;
  } catch (err) {
    console.error("[ai-ci-healer] loadRun failed:", err);
    return null;
  }
  if (!run || run.status !== "failure") return null;

  // Load workflow + repo (for YAML + naming context).
  let workflowYaml = "";
  let repoFullName = "unknown/unknown";
  try {
    const [w] = await db
      .select({ yaml: workflows.yaml })
      .from(workflows)
      .where(eq(workflows.id, run.workflowId))
      .limit(1);
    if (w?.yaml) workflowYaml = w.yaml;
  } catch (err) {
    console.warn("[ai-ci-healer] load workflow failed:", err);
  }
  try {
    const [r] = await db
      .select({
        name: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .where(eq(repositories.id, run.repositoryId))
      .limit(1);
    if (r) {
      repoFullName = `${r.ownerId.slice(0, 8)}/${r.name}`;
    }
  } catch (err) {
    console.warn("[ai-ci-healer] load repo failed:", err);
  }

  const failedJobs = await loadFailedJobs(runId);

  // Ask Claude.
  let parsed: ClaudeCiResponse | null = null;
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: buildCiHealPrompt({
            repoFullName,
            commitSha: run.commitSha || "(unknown)",
            workflowYaml,
            failedJobs,
          }),
        },
      ],
    });
    try {
      const { recordAiCost, extractUsage } = await import("./ai-cost-tracker");
      const usage = extractUsage(message);
      await recordAiCost({
        repositoryId: run.repositoryId ?? null,
        model: MODEL_SONNET,
        inputTokens: usage.input,
        outputTokens: usage.output,
        category: "ci_healer",
        sourceId: runId,
        sourceKind: "workflow_run",
      });
    } catch {
      /* swallow — best-effort */
    }
    parsed = parseJsonResponse<ClaudeCiResponse>(extractText(message));
  } catch (err) {
    console.warn(
      "[ai-ci-healer] Claude call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
  if (!parsed) return null;

  const rootCause =
    typeof parsed.rootCause === "string" && parsed.rootCause.trim()
      ? parsed.rootCause.trim()
      : "(no root cause provided)";

  // "Not fixable" branch — return null so the caller can mark `ai.ci.gave_up`.
  if (parsed.fixable === false) {
    return null;
  }

  const rawFixes = Array.isArray(parsed.suggestedFixes)
    ? parsed.suggestedFixes
    : [];
  const suggestedFixes: SuggestedFix[] = rawFixes
    .filter(
      (f): f is { path: string; description?: string; severity?: string } =>
        !!f && typeof f.path === "string" && f.path.trim().length > 0
    )
    .map((f) => ({
      path: f.path.trim(),
      description:
        typeof f.description === "string" && f.description.trim()
          ? f.description.trim()
          : rootCause,
      severity: normaliseSeverity(f.severity),
    }));

  // Claude said fixable but produced zero usable paths → treat as
  // unfixable so we don't loop.
  if (suggestedFixes.length === 0) return null;

  const patchablePaths = Array.from(new Set(suggestedFixes.map((f) => f.path)));

  return { rootCause, suggestedFixes, patchablePaths };
}

// ---------------------------------------------------------------------------
// healOneRun — drives one run end-to-end. Public so callers (autopilot,
// tests, manual retrigger) share the same pipeline.
// ---------------------------------------------------------------------------

export interface HealOneOptions extends AnalyzeOptions {
  /** Test override — pin the patch generator output. */
  generatePatch?: typeof generatePatchForGateTestFinding;
}

export interface HealOneResult {
  outcome: "healed" | "gave_up" | "skipped";
  prNumber?: number;
  branch?: string;
  reason?: string;
}

export async function healOneRun(
  runId: string,
  opts: HealOneOptions = {}
): Promise<HealOneResult> {
  if (process.env.AUTOPILOT_DISABLED === "1") {
    return { outcome: "skipped", reason: "autopilot disabled" };
  }
  if (!opts.client && !isAiAvailable()) {
    return { outcome: "skipped", reason: "ANTHROPIC_API_KEY missing" };
  }

  // Skip if already processed (audit marker present).
  if (await hasMarker(runId)) {
    return { outcome: "skipped", reason: "already processed" };
  }

  const analysis = await analyzeFailedWorkflowRun(runId, {
    client: opts.client,
  });

  // Look up the run for audit metadata (repo + sha).
  let repositoryId: string | null = null;
  let commitSha: string | null = null;
  try {
    const [row] = await db
      .select({
        repositoryId: workflowRuns.repositoryId,
        commitSha: workflowRuns.commitSha,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (row) {
      repositoryId = row.repositoryId;
      commitSha = row.commitSha;
    }
  } catch (err) {
    console.warn("[ai-ci-healer] post-analyze run lookup failed:", err);
  }

  if (!analysis) {
    await audit({
      userId: null,
      repositoryId,
      action: "ai.ci.gave_up",
      targetType: "workflow_run",
      targetId: runId,
      metadata: { commitSha, reason: "unfixable or analysis returned null" },
    });
    return { outcome: "gave_up", reason: "unfixable" };
  }

  if (!repositoryId || !commitSha) {
    // No base sha → can't seed a patch branch. Mark gave_up so we don't loop.
    await audit({
      userId: null,
      repositoryId,
      action: "ai.ci.gave_up",
      targetType: "workflow_run",
      targetId: runId,
      metadata: {
        commitSha,
        reason: "missing repositoryId or commitSha for patch branch",
      },
    });
    return { outcome: "gave_up", reason: "missing base sha" };
  }

  const generator = opts.generatePatch ?? generatePatchForGateTestFinding;
  const findings = fixesToFindings(analysis.suggestedFixes, runId.slice(0, 8));

  const patch = await generator({
    repositoryId,
    baseSha: commitSha,
    findings,
    client: opts.client,
  });

  if (!patch) {
    await audit({
      userId: null,
      repositoryId,
      action: "ai.ci.gave_up",
      targetType: "workflow_run",
      targetId: runId,
      metadata: {
        commitSha,
        reason: "patch generator returned null",
        rootCause: analysis.rootCause,
        patchablePaths: analysis.patchablePaths,
      },
    });
    return { outcome: "gave_up", reason: "patch generator returned null" };
  }

  await audit({
    userId: null,
    repositoryId,
    action: "ai.ci.healed",
    targetType: "workflow_run",
    targetId: runId,
    metadata: {
      commitSha,
      rootCause: analysis.rootCause,
      patchablePaths: analysis.patchablePaths,
      prNumber: patch.prNumber,
      branch: patch.branch,
    },
  });

  return {
    outcome: "healed",
    prNumber: patch.prNumber,
    branch: patch.branch,
  };
}

// ---------------------------------------------------------------------------
// runCiHealerTick — public autopilot entry point
// ---------------------------------------------------------------------------

export interface CiHealerTickDeps {
  /** Inject a candidate finder for tests. */
  findCandidates?: (limit: number) => Promise<{ id: string }[]>;
  /** Inject the per-run handler for tests. */
  healOne?: (runId: string) => Promise<HealOneResult>;
  /** Inject the per-tick cap. */
  cap?: number;
}

/**
 * Find failed workflow runs that:
 *   - finished at least HEAL_MIN_AGE_MS ago (let the runner flush logs)
 *   - finished less than HEAL_MAX_AGE_MS ago (don't chase ancient failures)
 *   - do NOT yet have an ai.ci.healed / ai.ci.gave_up audit marker
 *
 * The `hasMarker` filter is applied per-row in `healOneRun` rather than
 * the SQL select — keeps the query simple and the index on (status,
 * createdAt) doing most of the work.
 */
async function defaultFindCandidates(
  limit: number
): Promise<{ id: string }[]> {
  const now = Date.now();
  const cutoffNew = new Date(now - HEAL_MIN_AGE_MS);
  const cutoffOld = new Date(now - HEAL_MAX_AGE_MS);
  try {
    const rows = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, "failure"),
          lt(workflowRuns.createdAt, cutoffNew),
          gte(workflowRuns.createdAt, cutoffOld)
        )
      )
      .orderBy(desc(workflowRuns.createdAt))
      .limit(limit);
    return rows;
  } catch (err) {
    console.error("[ai-ci-healer] candidate query failed:", err);
    return [];
  }
}

/**
 * One autopilot tick: scan recent failures, heal what we can. Returns a
 * counts summary. Never throws.
 *
 * No-op when:
 *   - AUTOPILOT_DISABLED=1
 *   - ANTHROPIC_API_KEY is unset
 */
export async function runCiHealerTick(
  deps: CiHealerTickDeps = {}
): Promise<CiHealerTickSummary> {
  if (process.env.AUTOPILOT_DISABLED === "1") {
    return { considered: 0, healed: 0, gaveUp: 0, skipped: 0 };
  }
  if (!isAiAvailable()) {
    return { considered: 0, healed: 0, gaveUp: 0, skipped: 0 };
  }

  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const healOne = deps.healOne ?? ((id: string) => healOneRun(id));
  const cap = deps.cap ?? HEAL_CAP_PER_TICK;

  let candidates: { id: string }[] = [];
  try {
    candidates = await findCandidates(cap);
  } catch (err) {
    console.error("[ai-ci-healer] findCandidates threw:", err);
    return { considered: 0, healed: 0, gaveUp: 0, skipped: 0 };
  }

  let healed = 0;
  let gaveUp = 0;
  let skipped = 0;
  for (const cand of candidates) {
    try {
      const res = await healOne(cand.id);
      if (res.outcome === "healed") healed += 1;
      else if (res.outcome === "gave_up") gaveUp += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(
        `[ai-ci-healer] per-run failure for run=${cand.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { considered: candidates.length, healed, gaveUp, skipped };
}

// ---------------------------------------------------------------------------
// Test-only re-exports
// ---------------------------------------------------------------------------

export const __test = {
  loadFailedJobs,
  hasMarker,
  defaultFindCandidates,
  normaliseSeverity,
  truncate,
  HEAL_MIN_AGE_MS,
  HEAL_MAX_AGE_MS,
  HEAL_CAP_PER_TICK,
};

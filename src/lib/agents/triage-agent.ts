/**
 * Block K4 — Autonomous triage agent.
 *
 * Runs on top of the Wave 1 agent-runtime substrate. On issue / PR open we:
 *
 *   1. Open an `agent_runs` row (kind = "triage").
 *   2. Ask Claude Haiku for a structured classification.
 *   3. Post a **single** comment on the issue or PR summarising the triage.
 *
 * Non-destructive: we never apply labels, close, or assign. We only comment.
 * When the caller's repo hasn't wired up an ANTHROPIC_API_KEY we still record
 * the run and post a minimal deterministic "manual triage required" comment —
 * so the audit trail is complete either way.
 *
 * Style mirrors src/lib/ai-incident.ts (the D4 cleanest-example) and the pre-
 * existing `triagePullRequest` in src/lib/ai-generators.ts which this upgrades.
 * Never throws; all DB / Anthropic errors are caught and become a "failed" run.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  issueComments,
  issues,
  prComments,
  pullRequests,
  repositories,
} from "../../db/schema";
import {
  MODEL_HAIKU,
  extractText,
  getAnthropic,
  isAiAvailable,
  parseJsonResponse,
} from "../ai-client";
import {
  executeAgentRun,
  startAgentRun,
  type AgentExecutorContext,
} from "../agent-runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriageItemKind = "issue" | "pr";

export type TriageCategory =
  | "bug"
  | "feature"
  | "question"
  | "docs"
  | "chore"
  | "security";

export type TriageComplexity = "small" | "medium" | "large" | "unknown";

export type TriagePriority =
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "unknown";

export interface TriageClassification {
  category: TriageCategory;
  labels: string[];
  complexity: TriageComplexity;
  priority: TriagePriority;
  riskArea: string;
  reasoning: string;
  suggestedReviewers: string[];
}

export interface RunTriageAgentArgs {
  kind: TriageItemKind;
  repositoryId: string;
  itemId: string;
  itemNumber: number;
  title: string;
  body: string;
  authorId?: string;
}

export interface RunTriageAgentResult {
  ok: boolean;
  summary: string;
  runId: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (fully unit-testable)
// ---------------------------------------------------------------------------

const ALLOWED_CATEGORIES: ReadonlySet<TriageCategory> = new Set([
  "bug",
  "feature",
  "question",
  "docs",
  "chore",
  "security",
]);

const ALLOWED_COMPLEXITY: ReadonlySet<TriageComplexity> = new Set([
  "small",
  "medium",
  "large",
  "unknown",
]);

const ALLOWED_PRIORITY: ReadonlySet<TriagePriority> = new Set([
  "low",
  "medium",
  "high",
  "critical",
  "unknown",
]);

const DEFAULT_CLASSIFICATION: TriageClassification = {
  category: "chore",
  labels: [],
  complexity: "unknown",
  priority: "unknown",
  riskArea: "unknown",
  reasoning: "No AI backend configured; manual triage required.",
  suggestedReviewers: [],
};

const LABEL_MAX_LEN = 32;
const LABELS_MAX = 6;
const REVIEWERS_MAX = 3;
const REASONING_MAX = 1200;
const RISK_AREA_MAX = 80;

/** Trim + cap a free-form string to `max` chars. */
function capString(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t.length <= max ? t : t.slice(0, max);
}

/**
 * Coerce an arbitrary JSON blob from Claude into the strict
 * TriageClassification shape. Any unknown keys are dropped; out-of-vocab
 * values are replaced with defaults. Pure — no I/O.
 */
export function normaliseTriagePayload(
  raw: unknown
): TriageClassification {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CLASSIFICATION };
  }
  const r = raw as Record<string, unknown>;

  const category = ALLOWED_CATEGORIES.has(r.category as TriageCategory)
    ? (r.category as TriageCategory)
    : DEFAULT_CLASSIFICATION.category;

  const complexity = ALLOWED_COMPLEXITY.has(r.complexity as TriageComplexity)
    ? (r.complexity as TriageComplexity)
    : "unknown";

  const priority = ALLOWED_PRIORITY.has(r.priority as TriagePriority)
    ? (r.priority as TriagePriority)
    : "unknown";

  const labels = Array.isArray(r.labels)
    ? r.labels
        .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
        .map((l) => l.trim().toLowerCase().slice(0, LABEL_MAX_LEN))
        .filter((l, i, arr) => arr.indexOf(l) === i)
        .slice(0, LABELS_MAX)
    : [];

  const suggestedReviewers = Array.isArray(r.suggestedReviewers)
    ? r.suggestedReviewers
        .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        .map((u) => u.trim().slice(0, 64))
        .filter((u, i, arr) => arr.indexOf(u) === i)
        .slice(0, REVIEWERS_MAX)
    : [];

  return {
    category,
    labels,
    complexity,
    priority,
    riskArea: capString(r.riskArea, RISK_AREA_MAX) || "unknown",
    reasoning:
      capString(r.reasoning, REASONING_MAX) ||
      "(no reasoning supplied by model)",
    suggestedReviewers,
  };
}

/** Validate caller args before we touch the DB. */
export function validateTriageArgs(
  args: RunTriageAgentArgs
): { ok: true } | { ok: false; reason: string } {
  if (!args) return { ok: false, reason: "missing args" };
  if (args.kind !== "issue" && args.kind !== "pr") {
    return { ok: false, reason: "invalid kind" };
  }
  if (!args.repositoryId || typeof args.repositoryId !== "string") {
    return { ok: false, reason: "missing repositoryId" };
  }
  if (!args.itemId || typeof args.itemId !== "string") {
    return { ok: false, reason: "missing itemId" };
  }
  if (!Number.isFinite(args.itemNumber) || args.itemNumber <= 0) {
    return { ok: false, reason: "invalid itemNumber" };
  }
  if (typeof args.title !== "string" || args.title.trim().length === 0) {
    return { ok: false, reason: "empty title" };
  }
  return { ok: true };
}

/**
 * Haiku pricing (per BUILD_BIBLE §5.3):
 *   input  ≈ $0.25 / 1M tokens
 *   output ≈ $1.25 / 1M tokens
 * We round UP to whole cents so a zero-cost run at least records the attempt.
 */
export function estimateHaikuCents(
  inputTokens: number,
  outputTokens: number
): number {
  const dIn = Math.max(0, inputTokens | 0);
  const dOut = Math.max(0, outputTokens | 0);
  const dollars = (dIn * 0.25 + dOut * 1.25) / 1_000_000;
  return Math.ceil(dollars * 100);
}

/** Render the comment body. Exported so tests can assert on its shape. */
export function renderTriageComment(
  kind: TriageItemKind,
  classification: TriageClassification,
  aiAvailable: boolean
): string {
  const heading = "## Triage";
  const botLine = aiAvailable
    ? "_Posted by GlueCron triage agent (suggestion only — no labels applied)._"
    : "_Posted by GlueCron triage agent — no AI backend configured; manual triage required._";

  const lines: string[] = [
    heading,
    "",
    botLine,
    "",
    `- **Category:** \`${classification.category}\``,
    `- **Complexity:** \`${classification.complexity}\``,
    `- **Priority:** \`${classification.priority}\``,
    `- **Risk area:** ${classification.riskArea || "unknown"}`,
  ];
  if (classification.labels.length) {
    lines.push(
      `- **Suggested labels:** ${classification.labels
        .map((l) => `\`${l}\``)
        .join(", ")}`
    );
  }
  if (
    kind === "pr" &&
    classification.suggestedReviewers.length > 0
  ) {
    lines.push(
      `- **Suggested reviewers:** ${classification.suggestedReviewers
        .map((u) => `@${u.replace(/^@/, "")}`)
        .join(", ")}`
    );
  }
  lines.push("", "### Reasoning", classification.reasoning);
  lines.push(
    "",
    "---",
    "_This is a non-destructive suggestion. A maintainer must apply any labels, assignments, or state changes._"
  );
  return lines.join("\n");
}

/** Short human sentence for the `agent_runs.summary` column. */
export function buildRunSummary(
  classification: TriageClassification,
  aiAvailable: boolean
): string {
  if (!aiAvailable) {
    return "no AI backend configured; manual triage required";
  }
  return `classified as ${classification.category}, complexity ${classification.complexity}`;
}

// ---------------------------------------------------------------------------
// Internal: Claude call
// ---------------------------------------------------------------------------

function buildPrompt(args: RunTriageAgentArgs): string {
  const kindLabel = args.kind === "pr" ? "pull request" : "issue";
  const body = (args.body || "(no body)").slice(0, 4000);
  return `You are GlueCron's triage agent. Classify this newly opened ${kindLabel}.

Respond ONLY with JSON of this exact shape (no prose, no code fences):
{
  "category": "bug" | "feature" | "question" | "docs" | "chore" | "security",
  "labels": ["short-label", ...],
  "complexity": "small" | "medium" | "large" | "unknown",
  "priority": "low" | "medium" | "high" | "critical" | "unknown",
  "riskArea": "short phrase, e.g. 'auth/session handling'",
  "reasoning": "2-4 sentences explaining your classification.",
  "suggestedReviewers": ["username", ...]
}

Rules:
- "labels" must be 0-6 short kebab-case strings (<= 32 chars each).
- "suggestedReviewers" is optional; at most 3 usernames. Omit the field if you have no suggestions.
- Use "unknown" for complexity/priority when the text is too thin to judge.
- Use category "security" for anything involving auth, credentials, or vulnerability reports.

Title: ${args.title}
Body:
${body}
`;
}

async function askClaudeForTriage(
  args: RunTriageAgentArgs,
  ctx: AgentExecutorContext
): Promise<{
  classification: TriageClassification;
  inputTokens: number;
  outputTokens: number;
} | null> {
  try {
    const client = getAnthropic();
    const prompt = buildPrompt(args);
    const message = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractText(message);
    const parsed = parseJsonResponse<unknown>(text);
    const classification = normaliseTriagePayload(parsed);

    // Anthropic SDK surfaces token usage on `usage`. Fall back to rough
    // heuristic if the field isn't present so we always record *something*.
    const usage = (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    const inputTokens =
      typeof usage?.input_tokens === "number"
        ? usage.input_tokens
        : Math.ceil(prompt.length / 4);
    const outputTokens =
      typeof usage?.output_tokens === "number"
        ? usage.output_tokens
        : Math.ceil(text.length / 4);

    await ctx.appendLog(
      `[triage] haiku returned ${text.length} chars; tokens in=${inputTokens} out=${outputTokens}`
    );
    return { classification, inputTokens, outputTokens };
  } catch (err) {
    await ctx.appendLog(
      `[triage] anthropic call failed: ${(err as Error).message}`
    );
    console.error("[triage-agent] askClaudeForTriage:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Comment author resolution
//
// issueComments.authorId and prComments.authorId are NOT NULL — we need a real
// user row. Preference order:
//   1. the caller-supplied authorId (typically the item's creator),
//   2. the item's own author (looked up from the DB),
//   3. the repository owner (last resort).
// This mirrors ai-incident.ts and the existing ai-review path in pulls.tsx.
// ---------------------------------------------------------------------------

async function resolveCommentAuthorId(
  args: RunTriageAgentArgs
): Promise<string | null> {
  if (args.authorId) return args.authorId;
  try {
    if (args.kind === "issue") {
      const [row] = await db
        .select({ authorId: issues.authorId })
        .from(issues)
        .where(eq(issues.id, args.itemId))
        .limit(1);
      if (row?.authorId) return row.authorId;
    } else {
      const [row] = await db
        .select({ authorId: pullRequests.authorId })
        .from(pullRequests)
        .where(eq(pullRequests.id, args.itemId))
        .limit(1);
      if (row?.authorId) return row.authorId;
    }
  } catch (err) {
    console.error("[triage-agent] resolveCommentAuthorId item lookup:", err);
  }
  try {
    const [row] = await db
      .select({ ownerId: repositories.ownerId })
      .from(repositories)
      .where(eq(repositories.id, args.repositoryId))
      .limit(1);
    if (row?.ownerId) return row.ownerId;
  } catch (err) {
    console.error("[triage-agent] resolveCommentAuthorId owner lookup:", err);
  }
  return null;
}

/**
 * Have we already triaged this item? We rely on the marker line from the
 * heading — "## Triage" is unique enough. This avoids stacking duplicate
 * comments if a caller fires the trigger twice (e.g. retry after 500).
 */
async function alreadyTriaged(
  kind: TriageItemKind,
  itemId: string
): Promise<boolean> {
  try {
    if (kind === "issue") {
      const rows = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, itemId));
      return rows.some((r) => (r.body || "").startsWith("## Triage"));
    }
    const rows = await db
      .select({ body: prComments.body })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, itemId),
          eq(prComments.isAiReview, true)
        )
      );
    return rows.some((r) => (r.body || "").startsWith("## Triage"));
  } catch (err) {
    console.error("[triage-agent] alreadyTriaged:", err);
    return false; // on failure, prefer to post rather than silently skip
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Kick off a triage run for a newly-opened issue or PR. Non-destructive.
 * Never throws. Always returns `{ ok, summary, runId }` — even when input
 * validation fails or the DB is unavailable, in which case `runId` is null.
 */
export async function runTriageAgent(
  args: RunTriageAgentArgs
): Promise<RunTriageAgentResult> {
  // 1. Validate eagerly — we don't want to open an agent_runs row for a
  //    clearly-malformed caller (which is almost certainly a dev bug).
  const check = validateTriageArgs(args);
  if (!check.ok) {
    return { ok: false, summary: `invalid args: ${check.reason}`, runId: null };
  }

  // 2. Open the run. If the DB is down this returns null and we give up —
  //    there's nowhere to record logs without the row.
  const run = await startAgentRun({
    repositoryId: args.repositoryId,
    kind: "triage",
    trigger: args.kind === "issue" ? "issue.opened" : "pr.opened",
    triggerRef: String(args.itemNumber),
  });
  if (!run) {
    return {
      ok: false,
      summary: "could not open agent_runs row",
      runId: null,
    };
  }

  let finalSummary = "no AI backend configured; manual triage required";

  await executeAgentRun(run.id, async (ctx) => {
    await ctx.appendLog(
      `[triage] classifying ${args.kind} #${args.itemNumber} "${args.title.slice(0, 120)}"`
    );

    // Skip if we've already commented on this item. The run still succeeds —
    // double-firing is not an error from the caller's perspective.
    if (await alreadyTriaged(args.kind, args.itemId)) {
      await ctx.appendLog("[triage] already triaged; skipping comment");
      finalSummary = "already triaged; skipped";
      return { ok: true, summary: finalSummary };
    }

    const aiAvailable = isAiAvailable();
    let classification: TriageClassification = { ...DEFAULT_CLASSIFICATION };

    if (aiAvailable) {
      const ai = await askClaudeForTriage(args, ctx);
      if (ai) {
        classification = ai.classification;
        const cents = estimateHaikuCents(ai.inputTokens, ai.outputTokens);
        await ctx.recordCost(ai.inputTokens, ai.outputTokens, cents);
      } else {
        await ctx.appendLog(
          "[triage] AI call failed — falling back to deterministic comment"
        );
        classification = {
          ...DEFAULT_CLASSIFICATION,
          reasoning:
            "AI classifier was unreachable. A maintainer should triage this manually.",
        };
      }
    } else {
      await ctx.appendLog("[triage] no ANTHROPIC_API_KEY; deterministic path");
    }

    const commentBody = renderTriageComment(
      args.kind,
      classification,
      aiAvailable
    );
    const authorId = await resolveCommentAuthorId(args);
    if (!authorId) {
      await ctx.appendLog(
        "[triage] no viable author_id for comment; aborting insert"
      );
      finalSummary = "no author_id available; comment not posted";
      return { ok: false, summary: finalSummary };
    }

    try {
      if (args.kind === "issue") {
        await db.insert(issueComments).values({
          issueId: args.itemId,
          authorId,
          body: commentBody,
        });
      } else {
        await db.insert(prComments).values({
          pullRequestId: args.itemId,
          authorId,
          body: commentBody,
          isAiReview: true,
        });
      }
    } catch (err) {
      await ctx.appendLog(
        `[triage] comment insert failed: ${(err as Error).message}`
      );
      finalSummary = `comment insert failed: ${(err as Error).message}`;
      return { ok: false, summary: finalSummary };
    }

    finalSummary = buildRunSummary(classification, aiAvailable);
    await ctx.appendLog(`[triage] posted comment; ${finalSummary}`);
    return { ok: true, summary: finalSummary };
  });

  return { ok: true, summary: finalSummary, runId: run.id };
}

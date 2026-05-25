/**
 * Per-call AI cost tracker. Every Claude caller in the codebase pipes a
 * single line through `recordAiCost(...)` after a successful response so
 * the /billing/usage dashboard can attribute spend back to a user, repo,
 * agent session, and feature category.
 *
 * Design notes:
 *
 *   - Best-effort. The caller wraps `recordAiCost` in try/catch and the
 *     function itself never throws — a DB blip or a malformed usage
 *     object must NOT escape into the request path.
 *
 *   - Cents are computed at insert time from a hardcoded pricing table
 *     and persisted on the row, so historical aggregates stay stable
 *     across price changes. Operators can override the table at runtime
 *     by editing `MODEL_PRICING` and re-deploying, or by calling
 *     `setPricingOverride(model, prices)` from a future admin surface
 *     (system-config-backed; intentionally not wired here).
 *
 *   - Per-1k pricing matches Anthropic's published Claude rates. Numbers
 *     are in CENTS for downstream arithmetic safety — Postgres `int`s
 *     avoid float drift over a month of rollups.
 *
 *   - Summary helpers (`summarizeCostsForUser`, ...ForRepo, ...ForAgent)
 *     return the shape consumed by `routes/billing-usage.tsx` and by the
 *     `/api/v2/usage/*` JSON endpoints, so the UI and API never diverge.
 */

import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { aiCostEvents } from "../db/schema";
import type { AiCostEvent } from "../db/schema";

/**
 * Canonical Claude pricing table (cents per 1k tokens). Keep this aligned
 * with https://www.anthropic.com/pricing. The keys match the model IDs we
 * pass to `client.messages.create({ model })`. Unknown models fall back to
 * `DEFAULT_PRICING` so a new release never silently records $0.
 */
export interface ModelPrice {
  /** USD cents per 1k input tokens. */
  inputCentsPer1k: number;
  /** USD cents per 1k output tokens. */
  outputCentsPer1k: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Sonnet 4 (May 2025) — $3 / $15 per 1M tokens.
  "claude-sonnet-4-20250514": { inputCentsPer1k: 0.3, outputCentsPer1k: 1.5 },
  // Newer Sonnet 4 family checkpoints (4.5, 4.6, 4.7) — same price tier.
  "claude-sonnet-4-5": { inputCentsPer1k: 0.3, outputCentsPer1k: 1.5 },
  "claude-sonnet-4-6": { inputCentsPer1k: 0.3, outputCentsPer1k: 1.5 },
  "claude-sonnet-4-7": { inputCentsPer1k: 0.3, outputCentsPer1k: 1.5 },
  // Haiku 4.5 — $1 / $5 per 1M tokens.
  "claude-haiku-4-5-20251001": {
    inputCentsPer1k: 0.1,
    outputCentsPer1k: 0.5,
  },
  "claude-haiku-4-5": { inputCentsPer1k: 0.1, outputCentsPer1k: 0.5 },
  // Opus 4 family — $15 / $75 per 1M tokens.
  "claude-opus-4": { inputCentsPer1k: 1.5, outputCentsPer1k: 7.5 },
  "claude-opus-4-7": { inputCentsPer1k: 1.5, outputCentsPer1k: 7.5 },
};

/** Fallback pricing if we get a model id we don't recognise. Conservative
 * "Sonnet-tier" estimate so unknown spend is at least visible in $$. */
export const DEFAULT_PRICING: ModelPrice = {
  inputCentsPer1k: 0.3,
  outputCentsPer1k: 1.5,
};

/** Runtime override slot — future /admin/integrations surface can call
 * this without touching the source file. Not currently wired to a UI. */
export function setPricingOverride(model: string, prices: ModelPrice): void {
  MODEL_PRICING[model] = prices;
}

/** Recognised feature buckets. The dashboard groups + colours by this. */
export type AiCostCategory =
  | "ai_review"
  | "ai_patch"
  | "ci_healer"
  | "spec_to_pr"
  | "standup"
  | "chat"
  | "voice"
  | "test_gen"
  | "refactor"
  | "other";

const CATEGORIES: readonly AiCostCategory[] = [
  "ai_review",
  "ai_patch",
  "ci_healer",
  "spec_to_pr",
  "standup",
  "chat",
  "voice",
  "test_gen",
  "refactor",
  "other",
];

/**
 * Compute a cost estimate in CENTS (rounded UP to the next cent so a
 * tiny call still registers as >0¢ in the dashboard). Pure function;
 * exported so tests can pin the arithmetic.
 */
export function computeCentsForCall(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const price = MODEL_PRICING[model] || DEFAULT_PRICING;
  const inT = Math.max(0, Math.floor(inputTokens || 0));
  const outT = Math.max(0, Math.floor(outputTokens || 0));
  const cents =
    (inT / 1000) * price.inputCentsPer1k +
    (outT / 1000) * price.outputCentsPer1k;
  if (cents <= 0) return 0;
  return Math.max(1, Math.ceil(cents));
}

export interface RecordAiCostArgs {
  ownerUserId?: string | null;
  repositoryId?: string | null;
  agentSessionId?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  category: AiCostCategory;
  sourceId?: string | null;
  sourceKind?: string | null;
}

/**
 * Insert one cost row. Never throws — DB failures are logged at debug
 * level and swallowed so the calling AI feature continues unaffected.
 */
export async function recordAiCost(args: RecordAiCostArgs): Promise<void> {
  try {
    const cents = computeCentsForCall(
      args.model,
      args.inputTokens,
      args.outputTokens
    );
    const category: AiCostCategory = CATEGORIES.includes(
      args.category as AiCostCategory
    )
      ? args.category
      : "other";
    await db.insert(aiCostEvents).values({
      ownerUserId: args.ownerUserId ?? null,
      repositoryId: args.repositoryId ?? null,
      agentSessionId: args.agentSessionId ?? null,
      model: args.model || "unknown",
      inputTokens: Math.max(0, Math.floor(args.inputTokens || 0)),
      outputTokens: Math.max(0, Math.floor(args.outputTokens || 0)),
      centsEstimate: cents,
      category,
      sourceId: args.sourceId ?? null,
      sourceKind: args.sourceKind ?? null,
    });
  } catch (err) {
    // Swallow. The dashboard is observational; missing rows are not a
    // user-visible failure mode.
    if (process.env.DEBUG_AI_COST === "1") {
      console.warn(
        "[ai-cost-tracker] insert failed:",
        err instanceof Error ? err.message : err
      );
    }
  }
}

/**
 * Convenience: read `.usage` from an Anthropic message response and call
 * `recordAiCost`. Tolerant of unknown shapes — extracts whatever it can
 * find, defaults the rest to 0.
 */
export async function recordFromAnthropicResponse(
  message: unknown,
  rest: Omit<RecordAiCostArgs, "inputTokens" | "outputTokens" | "model"> & {
    model: string;
  }
): Promise<void> {
  const usage = extractUsage(message);
  await recordAiCost({
    ...rest,
    inputTokens: usage.input,
    outputTokens: usage.output,
  });
}

/** Best-effort usage extractor. Anthropic SDK shape:
 * `{ usage: { input_tokens, output_tokens, ... } }`. Returns zeros on
 * anything unexpected. */
export function extractUsage(message: unknown): {
  input: number;
  output: number;
} {
  if (!message || typeof message !== "object") return { input: 0, output: 0 };
  const m = message as Record<string, unknown>;
  const usage = m.usage as Record<string, unknown> | undefined;
  if (!usage) return { input: 0, output: 0 };
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return { input, output };
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

export interface CostSummary {
  totalCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byCategory: Array<{
    category: string;
    cents: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byModel: Array<{
    model: string;
    cents: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byRepo: Array<{
    repositoryId: string | null;
    cents: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byAgent: Array<{
    agentSessionId: string | null;
    cents: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byDay: Array<{
    day: string; // YYYY-MM-DD UTC
    cents: number;
  }>;
}

export interface SummaryWindow {
  fromDate?: Date;
  toDate?: Date;
}

/** Pure aggregator — kept separate from the DB read so tests can pin it
 * deterministically against synthetic rows. */
export function aggregateEvents(
  rows: Pick<
    AiCostEvent,
    | "occurredAt"
    | "model"
    | "category"
    | "repositoryId"
    | "agentSessionId"
    | "centsEstimate"
    | "inputTokens"
    | "outputTokens"
  >[]
): CostSummary {
  const byCat = new Map<
    string,
    { cents: number; inputTokens: number; outputTokens: number }
  >();
  const byModel = new Map<
    string,
    { cents: number; inputTokens: number; outputTokens: number }
  >();
  const byRepo = new Map<
    string | null,
    { cents: number; inputTokens: number; outputTokens: number }
  >();
  const byAgent = new Map<
    string | null,
    { cents: number; inputTokens: number; outputTokens: number }
  >();
  const byDay = new Map<string, number>();
  let totalCents = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const r of rows) {
    const cents = r.centsEstimate || 0;
    const inT = r.inputTokens || 0;
    const outT = r.outputTokens || 0;
    totalCents += cents;
    totalIn += inT;
    totalOut += outT;
    const bucketAdd = (
      map: Map<string | null, { cents: number; inputTokens: number; outputTokens: number }>,
      key: string | null
    ) => {
      const cur = map.get(key) || { cents: 0, inputTokens: 0, outputTokens: 0 };
      cur.cents += cents;
      cur.inputTokens += inT;
      cur.outputTokens += outT;
      map.set(key, cur);
    };
    bucketAdd(byCat as Map<string | null, { cents: number; inputTokens: number; outputTokens: number }>, r.category);
    bucketAdd(byModel as Map<string | null, { cents: number; inputTokens: number; outputTokens: number }>, r.model);
    bucketAdd(byRepo, r.repositoryId ?? null);
    bucketAdd(byAgent, r.agentSessionId ?? null);
    const day = toUtcDayKey(r.occurredAt);
    byDay.set(day, (byDay.get(day) || 0) + cents);
  }
  return {
    totalCents,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    byCategory: Array.from(byCat.entries())
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.cents - a.cents),
    byModel: Array.from(byModel.entries())
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cents - a.cents),
    byRepo: Array.from(byRepo.entries())
      .map(([repositoryId, v]) => ({ repositoryId, ...v }))
      .sort((a, b) => b.cents - a.cents),
    byAgent: Array.from(byAgent.entries())
      .map(([agentSessionId, v]) => ({ agentSessionId, ...v }))
      .sort((a, b) => b.cents - a.cents),
    byDay: Array.from(byDay.entries())
      .map(([day, cents]) => ({ day, cents }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
  };
}

/** Render a Date as a YYYY-MM-DD UTC key. Stable across timezones so day
 * rollups don't double-count rows around midnight. */
export function toUtcDayKey(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function loadEvents(
  whereSql: ReturnType<typeof and> | ReturnType<typeof eq>
): Promise<AiCostEvent[]> {
  try {
    const rows = await db
      .select()
      .from(aiCostEvents)
      .where(whereSql)
      .orderBy(asc(aiCostEvents.occurredAt));
    return rows as AiCostEvent[];
  } catch (err) {
    if (process.env.DEBUG_AI_COST === "1") {
      console.warn(
        "[ai-cost-tracker] loadEvents failed:",
        err instanceof Error ? err.message : err
      );
    }
    return [];
  }
}

function rangeClause(field: typeof aiCostEvents.occurredAt, win: SummaryWindow) {
  const clauses = [] as Array<ReturnType<typeof gte> | ReturnType<typeof lte>>;
  if (win.fromDate) clauses.push(gte(field, win.fromDate));
  if (win.toDate) clauses.push(lte(field, win.toDate));
  return clauses;
}

export async function summarizeCostsForUser(
  userId: string,
  win: SummaryWindow = {}
): Promise<CostSummary> {
  const rows = await loadEvents(
    and(eq(aiCostEvents.ownerUserId, userId), ...rangeClause(aiCostEvents.occurredAt, win))
  );
  return aggregateEvents(rows);
}

export async function summarizeCostsForRepo(
  repoId: string,
  win: SummaryWindow = {}
): Promise<CostSummary> {
  const rows = await loadEvents(
    and(eq(aiCostEvents.repositoryId, repoId), ...rangeClause(aiCostEvents.occurredAt, win))
  );
  return aggregateEvents(rows);
}

export async function summarizeCostsForAgent(
  sessionId: string,
  win: SummaryWindow = {}
): Promise<CostSummary> {
  const rows = await loadEvents(
    and(
      eq(aiCostEvents.agentSessionId, sessionId),
      ...rangeClause(aiCostEvents.occurredAt, win)
    )
  );
  return aggregateEvents(rows);
}

// ---------------------------------------------------------------------------
// Dashboard-level helpers (month rollups, projections, budget reads).
// ---------------------------------------------------------------------------

/** UTC month start, e.g. 2026-05-01 00:00:00Z for a 2026-05-25 input. */
export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** Project month-end cents from elapsed days vs days in the month. */
export function projectMonthEndCents(
  centsSoFar: number,
  now: Date
): number {
  const start = startOfUtcMonth(now);
  const elapsedMs = Math.max(1, now.getTime() - start.getTime());
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  const totalMs = next.getTime() - start.getTime();
  return Math.round((centsSoFar * totalMs) / elapsedMs);
}

/** Daily average across the elapsed portion of the month. */
export function dailyAverageCents(centsSoFar: number, now: Date): number {
  const start = startOfUtcMonth(now);
  const elapsedDays = Math.max(
    1,
    Math.floor((now.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1
  );
  return Math.round(centsSoFar / elapsedDays);
}

/** Render integer cents as a $1.23 (or $0.04) USD string. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString()}.${String(remainder).padStart(2, "0")}`;
}

/** Quick token formatter — adds thousand separators. */
export function formatTokens(n: number): string {
  return Math.max(0, Math.floor(n || 0)).toLocaleString();
}

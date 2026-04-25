/**
 * AI flywheel — telemetry + live feed for every AI invocation.
 *
 * Two responsibilities:
 *   1. Persist a row into `ai_activity` for every AI call (model, latency,
 *      success, summary, optional repo/user/PR anchors).
 *   2. Publish a small JSON event onto two SSE topics so the live dashboard
 *      and any per-repo "AI in action" panels can render the work in motion:
 *
 *        ai:global               → every AI event in the system
 *        ai:repo:<repositoryId>  → events anchored to that repo
 *
 * NEVER throws into the request path. Telemetry failures must not break AI
 * features — every DB call and every publish is wrapped. Callers can use
 * either:
 *
 *   await recordAi({...meta}, async () => callAnthropic(...))
 *
 * or, for fire-and-forget logging without a wrapped call:
 *
 *   logAiEvent({...meta, latencyMs, success: true})
 */

import { db } from "../db";
import { aiActivity, type NewAiActivity } from "../db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { publish } from "./sse";

export type AiActionType =
  | "review"
  | "repair"
  | "completion"
  | "incident"
  | "triage"
  | "explain"
  | "test"
  | "changelog"
  | "chat"
  | "spec"
  | "commit-message"
  | "pr-summary"
  | "issue-triage"
  | "merge-resolve"
  | "security-scan"
  | "dep-update"
  | "semantic-index"
  | "other";

export interface AiEventMeta {
  actionType: AiActionType;
  model: string;
  summary: string;
  repositoryId?: string | null;
  userId?: string | null;
  pullRequestId?: string | null;
  issueId?: string | null;
  commitSha?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface AiEvent extends AiEventMeta {
  id: string;
  latencyMs: number;
  success: boolean;
  error?: string | null;
  createdAt: string;
}

/**
 * Wrap an AI call so its outcome is persisted + published. The callback may
 * return any value — the wrapper passes it through. On throw, telemetry is
 * still recorded with success=false and the error is rethrown so callers can
 * keep their existing error-handling behaviour.
 */
export async function recordAi<T>(
  meta: AiEventMeta,
  fn: () => Promise<T>
): Promise<T> {
  const t0 = Date.now();
  try {
    const value = await fn();
    void persist({ ...meta, latencyMs: Date.now() - t0, success: true });
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void persist({
      ...meta,
      latencyMs: Date.now() - t0,
      success: false,
      error: redact(message),
    });
    throw err;
  }
}

/**
 * Fire-and-forget logger for callers that already have the result in hand
 * (e.g. cached completions where there was no real LLM call).
 */
export function logAiEvent(
  meta: AiEventMeta & {
    latencyMs: number;
    success?: boolean;
    error?: string | null;
  }
): void {
  void persist({
    ...meta,
    success: meta.success ?? true,
    error: meta.error ?? null,
  });
}

interface PersistArgs extends AiEventMeta {
  latencyMs: number;
  success: boolean;
  error?: string | null;
}

async function persist(args: PersistArgs): Promise<void> {
  let row: { id: string; createdAt: Date } | null = null;
  try {
    const insert: NewAiActivity = {
      actionType: args.actionType,
      model: args.model,
      summary: clamp(args.summary, 500),
      repositoryId: args.repositoryId ?? null,
      userId: args.userId ?? null,
      pullRequestId: args.pullRequestId ?? null,
      issueId: args.issueId ?? null,
      commitSha: args.commitSha ?? null,
      inputTokens: args.inputTokens ?? null,
      outputTokens: args.outputTokens ?? null,
      latencyMs: args.latencyMs,
      success: args.success,
      error: args.error ? clamp(args.error, 1000) : null,
      metadata: args.metadata ?? null,
    };
    const [inserted] = await db
      .insert(aiActivity)
      .values(insert)
      .returning({ id: aiActivity.id, createdAt: aiActivity.createdAt });
    if (inserted) row = inserted;
  } catch (err) {
    // DB writes are best-effort. We still publish so the live UI sees the
    // event even when we cannot persist (e.g. fresh deploy without migration).
    safeWarn("[ai-flywheel] persist failed:", err);
  }

  const event: AiEvent = {
    id: row?.id ?? cryptoId(),
    actionType: args.actionType,
    model: args.model,
    summary: args.summary,
    repositoryId: args.repositoryId ?? null,
    userId: args.userId ?? null,
    pullRequestId: args.pullRequestId ?? null,
    issueId: args.issueId ?? null,
    commitSha: args.commitSha ?? null,
    inputTokens: args.inputTokens ?? null,
    outputTokens: args.outputTokens ?? null,
    metadata: args.metadata ?? null,
    latencyMs: args.latencyMs,
    success: args.success,
    error: args.error ?? null,
    createdAt: (row?.createdAt ?? new Date()).toISOString(),
  };

  try {
    publish("ai:global", { event: "ai", data: event });
    if (event.repositoryId) {
      publish(`ai:repo:${event.repositoryId}`, { event: "ai", data: event });
    }
  } catch (err) {
    safeWarn("[ai-flywheel] publish failed:", err);
  }
}

export interface ListRecentOpts {
  limit?: number;
  repositoryId?: string;
}

export async function listRecentAiEvents(
  opts: ListRecentOpts = {}
): Promise<AiEvent[]> {
  const limit = clampInt(opts.limit ?? 50, 1, 200);
  try {
    const query = db
      .select()
      .from(aiActivity)
      .orderBy(desc(aiActivity.createdAt))
      .limit(limit);
    const rows = opts.repositoryId
      ? await query.where(eq(aiActivity.repositoryId, opts.repositoryId))
      : await query;
    return rows.map(rowToEvent);
  } catch (err) {
    safeWarn("[ai-flywheel] list failed:", err);
    return [];
  }
}

export interface RollupRow {
  actionType: string;
  total: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
}

export async function rollupByAction(sinceHours = 24): Promise<RollupRow[]> {
  try {
    const rows = await db
      .select({
        actionType: aiActivity.actionType,
        total: sql<number>`count(*)::int`,
        successes: sql<number>`sum(case when ${aiActivity.success} then 1 else 0 end)::int`,
        failures: sql<number>`sum(case when ${aiActivity.success} then 0 else 1 end)::int`,
        avgLatencyMs: sql<number>`coalesce(avg(${aiActivity.latencyMs}), 0)::int`,
      })
      .from(aiActivity)
      .where(sql`${aiActivity.createdAt} > now() - (${sinceHours} || ' hours')::interval`)
      .groupBy(aiActivity.actionType);
    return rows;
  } catch (err) {
    safeWarn("[ai-flywheel] rollup failed:", err);
    return [];
  }
}

function rowToEvent(row: typeof aiActivity.$inferSelect): AiEvent {
  return {
    id: row.id,
    actionType: row.actionType as AiActionType,
    model: row.model,
    summary: row.summary,
    repositoryId: row.repositoryId,
    userId: row.userId,
    pullRequestId: row.pullRequestId,
    issueId: row.issueId,
    commitSha: row.commitSha,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    latencyMs: row.latencyMs,
    success: row.success,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
function redact(msg: string): string {
  // Strip obvious bearer tokens / API keys before persisting. Patterns:
  //   sk-...    Anthropic / OpenAI keys
  //   glc_...   gluecron PAT
  //   glct_...  gluecron OAuth access token
  //   ghi_...   marketplace install token
  //   Bearer... any explicit bearer header value
  return msg.replace(
    /(?:sk-[A-Za-z0-9_-]{16,}|gl(?:c|ct)_[A-Za-z0-9_-]{12,}|ghi_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.\-]+)/g,
    "[REDACTED]"
  );
}
function cryptoId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function safeWarn(prefix: string, err: unknown): void {
  try {
    console.warn(prefix, err);
  } catch {
    /* ignore */
  }
}

export const __test = { redact, clamp, clampInt };

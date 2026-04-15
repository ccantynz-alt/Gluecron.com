/**
 * Block J29 — Pull request lead-time metric.
 *
 * Lead time = `mergedAt - createdAt` for merged PRs. For still-open PRs, we
 * report the "in-flight" age from now. Open-but-unmerged PRs are excluded
 * from the summary percentiles; they roll into a separate counter so the
 * KPIs aren't biased downward by ancient stale drafts.
 *
 * Reuses `parseWindow`, `VALID_WINDOWS`, `formatDuration` from the Block J25
 * response-time helpers to stay DRY + consistent.
 */

import {
  parseWindow as parseWindowJ25,
  VALID_WINDOWS as VALID_WINDOWS_J25,
  formatDuration as formatDurationJ25,
  DEFAULT_WINDOW_DAYS as DEFAULT_WINDOW_DAYS_J25,
} from "./response-time";

export const DEFAULT_WINDOW_DAYS = DEFAULT_WINDOW_DAYS_J25;
export const VALID_WINDOWS = VALID_WINDOWS_J25;
export const parseWindow = parseWindowJ25;
export const formatDuration = formatDurationJ25;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface PrLeadTimeInput {
  id: string;
  number: number;
  title: string;
  state: string; // "open" | "closed" | "merged" (+ anything else)
  isDraft?: boolean;
  createdAt: Date | string;
  mergedAt?: Date | string | null;
}

export interface PrLeadTimeStat {
  id: string;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  createdAt: number;
  mergedAt: number | null;
  leadMs: number | null; // null for unmerged
  inFlightMs: number | null; // null for merged/closed
}

export interface PrLeadTimeSummary {
  total: number;
  merged: number;
  openNonDraft: number;
  openDraft: number;
  closedUnmerged: number;
  medianMs: number | null;
  meanMs: number | null;
  p90Ms: number | null;
  fastestMs: number | null;
  slowestMs: number | null;
}

export interface PrLeadTimeBuckets {
  /** Merged ≤ 1 hour. */
  within1h: number;
  /** > 1h and ≤ 24h. */
  within1d: number;
  /** > 24h and ≤ 7d. */
  within1w: number;
  /** > 7d. */
  over1w: number;
}

export interface PrLeadTimeReport {
  windowDays: number;
  now: number;
  perPr: PrLeadTimeStat[];
  summary: PrLeadTimeSummary;
  buckets: PrLeadTimeBuckets;
  /** Oldest still-open (non-draft) PRs — id list, for the in-flight table. */
  oldestOpenIds: string[];
}

function toTime(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "string") {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function computeLeadTime(
  input: { createdAt: Date | string; mergedAt?: Date | string | null }
): number | null {
  const created = toTime(input.createdAt);
  const merged = toTime(input.mergedAt);
  if (created === null || merged === null) return null;
  return Math.max(0, merged - created);
}

export function computePrStats(
  prs: readonly PrLeadTimeInput[],
  windowDays: number,
  now: number
): PrLeadTimeStat[] {
  const cutoff =
    windowDays > 0 ? now - windowDays * DAY : Number.NEGATIVE_INFINITY;
  const out: PrLeadTimeStat[] = [];
  for (const pr of prs) {
    const created = toTime(pr.createdAt);
    if (created === null) continue; // unparseable → drop
    const merged = toTime(pr.mergedAt ?? null);
    // Window filter: anchor on mergedAt for merged PRs, createdAt for the rest.
    const anchor = merged ?? created;
    if (anchor < cutoff) continue;
    const leadMs =
      merged !== null ? Math.max(0, merged - created) : null;
    const isMerged = merged !== null;
    const inFlightMs =
      !isMerged && pr.state === "open" ? Math.max(0, now - created) : null;
    out.push({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: !!pr.isDraft,
      createdAt: created,
      mergedAt: merged,
      leadMs,
      inFlightMs,
    });
  }
  return out;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const w = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * w;
}

export function summariseLeadTimes(
  stats: readonly PrLeadTimeStat[]
): PrLeadTimeSummary {
  const merged = stats.filter(
    (s): s is PrLeadTimeStat & { leadMs: number } => s.leadMs !== null
  );
  const leadMs = merged.map((s) => s.leadMs).sort((a, b) => a - b);
  const openNonDraft = stats.filter(
    (s) => s.leadMs === null && s.state === "open" && !s.isDraft
  ).length;
  const openDraft = stats.filter(
    (s) => s.leadMs === null && s.state === "open" && s.isDraft
  ).length;
  const closedUnmerged = stats.filter(
    (s) => s.leadMs === null && s.state !== "open"
  ).length;
  const sum = leadMs.reduce((a, b) => a + b, 0);
  const mean = leadMs.length > 0 ? Math.round(sum / leadMs.length) : null;
  const med = percentile(leadMs, 50);
  const p90 = percentile(leadMs, 90);
  return {
    total: stats.length,
    merged: merged.length,
    openNonDraft,
    openDraft,
    closedUnmerged,
    medianMs: med === null ? null : Math.round(med),
    meanMs: mean,
    p90Ms: p90 === null ? null : Math.round(p90),
    fastestMs: leadMs.length > 0 ? leadMs[0]! : null,
    slowestMs: leadMs.length > 0 ? leadMs[leadMs.length - 1]! : null,
  };
}

export function bucketLeadTimes(
  stats: readonly PrLeadTimeStat[]
): PrLeadTimeBuckets {
  const out: PrLeadTimeBuckets = {
    within1h: 0,
    within1d: 0,
    within1w: 0,
    over1w: 0,
  };
  for (const s of stats) {
    if (s.leadMs === null) continue;
    if (s.leadMs <= HOUR) out.within1h++;
    else if (s.leadMs <= DAY) out.within1d++;
    else if (s.leadMs <= 7 * DAY) out.within1w++;
    else out.over1w++;
  }
  return out;
}

export interface BuildReportOptions {
  prs: readonly PrLeadTimeInput[];
  windowDays: number;
  now?: number;
}

export function buildLeadTimeReport(
  opts: BuildReportOptions
): PrLeadTimeReport {
  const now = opts.now ?? Date.now();
  const perPr = computePrStats(opts.prs, opts.windowDays, now);
  const open = perPr
    .filter((s) => s.leadMs === null && s.state === "open" && !s.isDraft)
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    windowDays: opts.windowDays,
    now,
    perPr,
    summary: summariseLeadTimes(perPr),
    buckets: bucketLeadTimes(perPr),
    oldestOpenIds: open.map((s) => s.id),
  };
}

export const __internal = {
  DEFAULT_WINDOW_DAYS,
  VALID_WINDOWS,
  parseWindow,
  formatDuration,
  computeLeadTime,
  computePrStats,
  summariseLeadTimes,
  bucketLeadTimes,
  buildLeadTimeReport,
  toTime,
};

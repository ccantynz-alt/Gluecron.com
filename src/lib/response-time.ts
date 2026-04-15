/**
 * Block J25 — Time-to-first-response metric.
 *
 * For each issue, the response time is the elapsed time between the
 * issue's creation and the first comment made by someone OTHER than the
 * issue author. "Responses" from the issue author themselves don't
 * count — that rule matches GitHub's own "time to first response"
 * metric used in Insights and Community Health.
 *
 * This module is pure. Inputs are plain shapes; outputs are plain
 * summaries. The route feeds in Drizzle rows + does the display.
 */

export interface ResponseIssueInput {
  id: string;
  createdAt: Date | string;
  authorId: string;
  state: "open" | "closed" | string;
  /** Only comments with `authorId !== issue.authorId` count. */
  comments: Array<{ authorId: string; createdAt: Date | string }>;
}

export interface IssueResponseStat {
  id: string;
  state: string;
  createdAt: number; // epoch ms
  responseMs: number | null; // null when no non-author response yet
}

export interface ResponseTimeSummary {
  total: number;
  responded: number;
  /** Open issues with zero non-author comments. */
  unresponded: number;
  medianMs: number | null;
  meanMs: number | null;
  p90Ms: number | null;
  fastestMs: number | null;
  slowestMs: number | null;
}

export interface ResponseTimeBuckets {
  /** ≤ 1 hour. */
  within1h: number;
  /** > 1h and ≤ 24h. */
  within1d: number;
  /** > 24h and ≤ 7d. */
  within1w: number;
  /** > 7d. */
  over1w: number;
}

export interface ResponseReport {
  /** Window in whole days, 0 means "all time". */
  windowDays: number;
  now: number;
  perIssue: IssueResponseStat[];
  summary: ResponseTimeSummary;
  buckets: ResponseTimeBuckets;
  /** Open issues with no non-author response yet, oldest first. */
  unrepliedIssueIds: string[];
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const DEFAULT_WINDOW_DAYS = 30;
export const VALID_WINDOWS = [0, 7, 30, 90, 365] as const;
export type ResponseWindow = (typeof VALID_WINDOWS)[number];

export function parseWindow(raw: unknown): ResponseWindow {
  if (typeof raw === "string" && raw.trim()) {
    const n = parseInt(raw, 10);
    if (VALID_WINDOWS.includes(n as ResponseWindow)) {
      return n as ResponseWindow;
    }
  }
  return DEFAULT_WINDOW_DAYS;
}

function toMs(v: Date | string): number {
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Returns elapsed ms from `issueCreatedAt` to the earliest comment NOT
 * authored by the issue author, or `null` when no such comment exists
 * or the inputs are unparseable. Negative differences (comment dated
 * before issue) are clamped to 0.
 */
export function computeTimeToFirstResponse(input: {
  issueCreatedAt: Date | string;
  issueAuthorId: string;
  comments: Array<{ authorId: string; createdAt: Date | string }>;
}): number | null {
  const base = toMs(input.issueCreatedAt);
  if (!Number.isFinite(base)) return null;

  let earliest: number | null = null;
  for (const c of input.comments) {
    if (c.authorId === input.issueAuthorId) continue;
    const t = toMs(c.createdAt);
    if (!Number.isFinite(t)) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  if (earliest === null) return null;
  return Math.max(0, earliest - base);
}

/**
 * Reduce a list of issues to per-issue stats. Filters by window (only
 * issues created within the last `windowDays` days) when `windowDays > 0`.
 */
export function computeIssueStats(
  issues: ResponseIssueInput[],
  windowDays: number,
  now: Date | number = Date.now()
): IssueResponseStat[] {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const cutoff = windowDays > 0 ? nowMs - windowDays * DAY : -Infinity;

  const out: IssueResponseStat[] = [];
  for (const i of issues) {
    const created = toMs(i.createdAt);
    if (!Number.isFinite(created)) continue;
    if (created < cutoff) continue;

    const responseMs = computeTimeToFirstResponse({
      issueCreatedAt: i.createdAt,
      issueAuthorId: i.authorId,
      comments: i.comments,
    });
    out.push({
      id: i.id,
      state: i.state,
      createdAt: created,
      responseMs,
    });
  }
  return out;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  // Linear interpolation (inclusive method).
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * frac);
}

export function summariseResponseTimes(
  stats: IssueResponseStat[]
): ResponseTimeSummary {
  const responded = stats
    .filter((s) => s.responseMs !== null)
    .map((s) => s.responseMs as number);
  const unresponded = stats.filter(
    (s) => s.responseMs === null && s.state === "open"
  ).length;
  responded.sort((a, b) => a - b);
  const total = stats.length;
  if (responded.length === 0) {
    return {
      total,
      responded: 0,
      unresponded,
      medianMs: null,
      meanMs: null,
      p90Ms: null,
      fastestMs: null,
      slowestMs: null,
    };
  }
  const sum = responded.reduce((a, b) => a + b, 0);
  return {
    total,
    responded: responded.length,
    unresponded,
    medianMs: percentile(responded, 50),
    meanMs: Math.round(sum / responded.length),
    p90Ms: percentile(responded, 90),
    fastestMs: responded[0],
    slowestMs: responded[responded.length - 1],
  };
}

export function bucketResponseTimes(
  stats: IssueResponseStat[]
): ResponseTimeBuckets {
  const buckets: ResponseTimeBuckets = {
    within1h: 0,
    within1d: 0,
    within1w: 0,
    over1w: 0,
  };
  for (const s of stats) {
    if (s.responseMs === null) continue;
    if (s.responseMs <= HOUR) buckets.within1h++;
    else if (s.responseMs <= DAY) buckets.within1d++;
    else if (s.responseMs <= WEEK) buckets.within1w++;
    else buckets.over1w++;
  }
  return buckets;
}

/**
 * Format a ms duration as a compact human string: "3h", "1d 4h",
 * "12m", "45s", "—" for null. Non-negative; rounds to the nearest
 * sensible unit.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "\u2014";
  if (ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.round(ms / (60 * 1000))}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms - h * HOUR) / (60 * 1000));
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.round((ms - d * DAY) / HOUR);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function buildResponseReport(opts: {
  issues: ResponseIssueInput[];
  windowDays: number;
  now?: Date | number;
}): ResponseReport {
  const nowMs =
    opts.now === undefined
      ? Date.now()
      : typeof opts.now === "number"
      ? opts.now
      : opts.now.getTime();
  const perIssue = computeIssueStats(opts.issues, opts.windowDays, nowMs);
  const summary = summariseResponseTimes(perIssue);
  const buckets = bucketResponseTimes(perIssue);
  const unrepliedIssueIds = perIssue
    .filter((s) => s.responseMs === null && s.state === "open")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s) => s.id);
  return {
    windowDays: opts.windowDays,
    now: nowMs,
    perIssue,
    summary,
    buckets,
    unrepliedIssueIds,
  };
}

export const __internal = {
  HOUR,
  DAY,
  WEEK,
  DEFAULT_WINDOW_DAYS,
  VALID_WINDOWS,
  parseWindow,
  computeTimeToFirstResponse,
  computeIssueStats,
  summariseResponseTimes,
  bucketResponseTimes,
  buildResponseReport,
  formatDuration,
  percentile,
};

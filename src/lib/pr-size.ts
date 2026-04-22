/**
 * Block J32 — PR size distribution metric.
 *
 * Pure rollup of "how big are our PRs?". Given a set of `{additions,
 * deletions, files}` records (optionally inside a time window), classifies
 * each PR into five well-known size classes (XS/S/M/L/XL), computes
 * p50/p90/mean/largest/smallest over the window, and emits a bucket
 * histogram + the N largest open PRs.
 *
 * Size thresholds follow the common "≤10 / ≤50 / ≤250 / ≤1000 / >1000"
 * heuristic. A PR's size is `additions + deletions` (binaries contribute
 * 0 lines — the numstat parser treats `-` as zero).
 */

export {
  DEFAULT_WINDOW_DAYS,
  VALID_WINDOWS,
  parseWindow,
} from "./response-time";

import { DEFAULT_WINDOW_DAYS } from "./response-time";

/** Inclusive-below boundaries: a PR with lines === max lands in the NEXT class. */
export const PR_SIZE_CLASSES = [
  { key: "xs", label: "XS", max: 10, description: "≤ 10 lines" },
  { key: "s", label: "S", max: 50, description: "11 – 50 lines" },
  { key: "m", label: "M", max: 250, description: "51 – 250 lines" },
  { key: "l", label: "L", max: 1000, description: "251 – 1000 lines" },
  {
    key: "xl",
    label: "XL",
    max: Number.POSITIVE_INFINITY,
    description: "> 1000 lines",
  },
] as const;

export type PrSizeClassKey = (typeof PR_SIZE_CLASSES)[number]["key"];

export const DEFAULT_TOP_N = 10;

export interface PrSizeInput {
  id: string;
  number: number;
  title: string;
  state: string; // open, closed, merged
  isDraft?: boolean;
  createdAt: Date | string;
  mergedAt?: Date | string | null;
  closedAt?: Date | string | null;
  additions: number;
  deletions: number;
  files: number;
}

export interface PrSizeStat extends PrSizeInput {
  linesChanged: number;
  sizeClass: PrSizeClassKey;
}

export interface PrSizeSummary {
  total: number;
  merged: number;
  open: number;
  medianLines: number;
  meanLines: number;
  p90Lines: number;
  largestLines: number;
  smallestLines: number;
  /** % of PRs classified `xs` or `s`, rounded to one decimal. */
  smallPrRatio: number;
}

export interface PrSizeBucket {
  key: PrSizeClassKey;
  label: string;
  description: string;
  count: number;
  bytes: number; // total lines changed in this bucket
}

export interface PrSizeReport {
  windowDays: number;
  now: number;
  perPr: PrSizeStat[];
  summary: PrSizeSummary;
  buckets: PrSizeBucket[];
  /** `N` largest PRs in the window, descending. */
  largest: PrSizeStat[];
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function classifyPrSize(linesChanged: number): PrSizeClassKey {
  if (!Number.isFinite(linesChanged) || linesChanged < 0) return "xs";
  for (const c of PR_SIZE_CLASSES) {
    if (linesChanged <= c.max) return c.key;
  }
  return "xl";
}

function safeLines(additions: number, deletions: number): number {
  const a = Number.isFinite(additions) && additions > 0 ? additions : 0;
  const d = Number.isFinite(deletions) && deletions > 0 ? deletions : 0;
  return a + d;
}

/** Window anchor: mergedAt for merged PRs, createdAt otherwise. */
function anchorTime(pr: PrSizeInput): number | null {
  if (pr.state === "merged" && pr.mergedAt) {
    return toTime(pr.mergedAt);
  }
  return toTime(pr.createdAt);
}

export function computePrSizeStats(
  prs: readonly PrSizeInput[],
  windowDays: number,
  now: number = Date.now()
): PrSizeStat[] {
  const cutoff = windowDays > 0 ? now - windowDays * 24 * 60 * 60 * 1000 : null;
  const out: PrSizeStat[] = [];
  for (const pr of prs) {
    const anchor = anchorTime(pr);
    if (anchor === null) continue;
    if (cutoff !== null && anchor < cutoff) continue;
    const linesChanged = safeLines(pr.additions, pr.deletions);
    out.push({
      ...pr,
      linesChanged,
      sizeClass: classifyPrSize(linesChanged),
    });
  }
  return out;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return Math.round(sortedAsc[lo]! + frac * (sortedAsc[hi]! - sortedAsc[lo]!));
}

export function summarisePrSizes(stats: readonly PrSizeStat[]): PrSizeSummary {
  const sizes = stats.map((s) => s.linesChanged).sort((a, b) => a - b);
  const n = sizes.length;
  const total = sizes.reduce((acc, v) => acc + v, 0);
  const merged = stats.filter((s) => s.state === "merged").length;
  const open = stats.filter(
    (s) => s.state === "open" && !s.isDraft
  ).length;
  const smallCount = stats.filter(
    (s) => s.sizeClass === "xs" || s.sizeClass === "s"
  ).length;

  return {
    total: n,
    merged,
    open,
    medianLines: n === 0 ? 0 : percentile(sizes, 50),
    meanLines: n === 0 ? 0 : Math.round(total / n),
    p90Lines: n === 0 ? 0 : percentile(sizes, 90),
    largestLines: n === 0 ? 0 : sizes[n - 1]!,
    smallestLines: n === 0 ? 0 : sizes[0]!,
    smallPrRatio: n === 0 ? 0 : Math.round((smallCount / n) * 1000) / 10,
  };
}

export function bucketPrSizes(stats: readonly PrSizeStat[]): PrSizeBucket[] {
  const out: PrSizeBucket[] = PR_SIZE_CLASSES.map((c) => ({
    key: c.key,
    label: c.label,
    description: c.description,
    count: 0,
    bytes: 0,
  }));
  for (const s of stats) {
    const b = out.find((x) => x.key === s.sizeClass)!;
    b.count++;
    b.bytes += s.linesChanged;
  }
  return out;
}

export function topLargestPrs(
  stats: readonly PrSizeStat[],
  limit: number = DEFAULT_TOP_N
): PrSizeStat[] {
  const n =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TOP_N;
  return stats
    .slice()
    .sort((a, b) => {
      if (a.linesChanged !== b.linesChanged) {
        return b.linesChanged - a.linesChanged;
      }
      return b.number - a.number;
    })
    .slice(0, n);
}

export interface BuildPrSizeReportOptions {
  prs: readonly PrSizeInput[];
  windowDays?: number;
  now?: number;
  topN?: number;
}

export function buildPrSizeReport(
  opts: BuildPrSizeReportOptions
): PrSizeReport {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const perPr = computePrSizeStats(opts.prs, windowDays, now);
  return {
    windowDays,
    now,
    perPr,
    summary: summarisePrSizes(perPr),
    buckets: bucketPrSizes(perPr),
    largest: topLargestPrs(perPr, opts.topN ?? DEFAULT_TOP_N),
  };
}

export const __internal = {
  PR_SIZE_CLASSES,
  DEFAULT_TOP_N,
  classifyPrSize,
  computePrSizeStats,
  summarisePrSizes,
  bucketPrSizes,
  topLargestPrs,
  buildPrSizeReport,
  toTime,
  anchorTime,
  percentile,
  safeLines,
};
